#include "nvenc_encoder.hpp"

#include <nvEncodeAPI.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <deque>
#include <map>
#include <mutex>
#include <cstdio>
#include <utility>

namespace remotekit::media {
namespace {
using Microsoft::WRL::ComPtr;

// Never run static destructors over an unresolved driver session. The registry
// deliberately owns these resources for the entire Endpoint process lifetime.
// Admission is capped before any driver session is created, and the first
// quarantine permanently disables new NVENC admission in this process.
struct QuarantineRegistry {
  static constexpr size_t kMaximumSessions = 16;
  std::mutex mutex;
  size_t admitted = 0;
  bool unavailable = false;
  std::vector<std::shared_ptr<void>> sessions;
};
QuarantineRegistry& Quarantine() {
  static auto* registry = new QuarantineRegistry;
  return *registry;
}

class Nvenc final : public HardwareEncoder {
  struct Registration {
    ComPtr<ID3D11Texture2D> texture;
    NV_ENC_REGISTERED_PTR handle = nullptr;
  };
  struct Task {
    NV_ENC_OUTPUT_PTR output = nullptr;
    NV_ENC_INPUT_PTR mapped = nullptr;
    HANDLE event = nullptr;
    uint64_t cookie = 0;
    bool busy = false;
    bool signalled = false;
    std::chrono::steady_clock::time_point accepted{};
  };
  HMODULE module_ = nullptr;
  NV_ENCODE_API_FUNCTION_LIST api_{};
  void* encoder_ = nullptr;
  ComPtr<ID3D11Device> device_;
  NV_ENC_CONFIG config_{};
  NV_ENC_INITIALIZE_PARAMS init_{};
  EncoderSettings settings_{};
  std::map<ID3D11Texture2D*, Registration> registrations_;
  std::vector<Task> tasks_;
  std::deque<size_t> pending_;
  bool eos_ = false;
  HANDLE eos_event_ = nullptr;
  bool eos_registered_ = false, eos_completed_ = false, initialized_ = false;
  std::chrono::steady_clock::time_point eos_accepted_{};
  bool admitted_ = false;
  std::string terminal_error_;
  std::vector<std::shared_ptr<void>> held_inputs_;
  NvencTestHooks hooks_{
      [] { return std::chrono::steady_clock::now(); },
      [](HANDLE event, DWORD timeout) { return WaitForSingleObject(event, timeout); }};

  CodecResult Fail(std::string message, std::string& error) {
    if (terminal_error_.empty())
      terminal_error_ = std::move(message);
    error = terminal_error_;
    // Stop reconfiguration immediately, even before worker retirement.
    auto& registry = Quarantine();
    std::lock_guard lock(registry.mutex);
    registry.unavailable = true;
    return CodecResult::error;
  }
  void PreserveFailedSession() {
    struct RetiredSession {
      HMODULE module;
      NV_ENCODE_API_FUNCTION_LIST api;
      void* encoder;
      ComPtr<ID3D11Device> device;
      std::map<ID3D11Texture2D*, Registration> registrations;
      std::vector<Task> tasks;
      HANDLE eos_event;
      std::vector<std::shared_ptr<void>> inputs;
      std::string reason;
    };
    auto retired = std::make_shared<RetiredSession>(
        RetiredSession{module_, api_, encoder_, std::move(device_), std::move(registrations_),
                       std::move(tasks_), eos_event_, std::move(held_inputs_), terminal_error_});
    auto& registry = Quarantine();
    std::lock_guard lock(registry.mutex);
    registry.unavailable = true;
    registry.sessions.push_back(std::move(retired));
    fprintf(stderr, "NVENC session quarantined until Endpoint exit (%zu/%zu): %s\n",
            registry.sessions.size(), QuarantineRegistry::kMaximumSessions,
            terminal_error_.c_str());
    module_ = nullptr;
    encoder_ = nullptr;
    eos_event_ = nullptr;
    pending_.clear();
    admitted_ = false;
  }

  bool Check(NVENCSTATUS status, const char* operation, std::string& error) {
    if (status == NV_ENC_SUCCESS)
      return true;
    error = std::string("NVENC ") + operation + " failed (" +
            std::to_string(static_cast<int>(status)) + ")";
    if (encoder_ && api_.nvEncGetLastErrorString) {
      const char* detail = api_.nvEncGetLastErrorString(encoder_);
      if (detail && *detail)
        error += ": " + std::string(detail);
    }
    return false;
  }
  void Cleanup() {
    if (encoder_) {
      std::vector<AccessUnit> ignored;
      std::string error;
      if (initialized_)
        Drain(ignored, error);
      if (!terminal_error_.empty()) {
        // DestroyEncoder is not a timeout/cancellation API. Calling it with
        // unflushed work violates its contract and may wait indefinitely.
        PreserveFailedSession();
        return;
      }
      for (auto& task : tasks_) {
        if (encoder_) {
          if (task.mapped) {
            if (!Check(api_.nvEncUnmapInputResource(encoder_, task.mapped),
                       "UnmapInputResource(close)", error)) {
              Fail(error, error);
              PreserveFailedSession();
              return;
            }
            task.mapped = nullptr;
          }
          if (task.event) {
            NV_ENC_EVENT_PARAMS event{NV_ENC_EVENT_PARAMS_VER};
            event.completionEvent = task.event;
            if (!Check(api_.nvEncUnregisterAsyncEvent(encoder_, &event),
                       "UnregisterAsyncEvent(close)", error)) {
              Fail(error, error);
              PreserveFailedSession();
              return;
            }
          }
          if (task.output) {
            if (!Check(api_.nvEncDestroyBitstreamBuffer(encoder_, task.output),
                       "DestroyBitstreamBuffer(close)", error)) {
              Fail(error, error);
              PreserveFailedSession();
              return;
            }
            task.output = nullptr;
          }
        }
        if (task.event) {
          CloseHandle(task.event);
          task.event = nullptr;
        }
      }
      if (encoder_) {
        if (eos_registered_) {
          NV_ENC_EVENT_PARAMS event{NV_ENC_EVENT_PARAMS_VER};
          event.completionEvent = eos_event_;
          if (!Check(api_.nvEncUnregisterAsyncEvent(encoder_, &event),
                     "UnregisterAsyncEvent(EOS close)", error)) {
            Fail(error, error);
            PreserveFailedSession();
            return;
          }
          eos_registered_ = false;
        }
        for (auto& [texture, registration] : registrations_)
          if (!Check(api_.nvEncUnregisterResource(encoder_, registration.handle),
                     "UnregisterResource(close)", error)) {
            Fail(error, error);
            PreserveFailedSession();
            return;
          }
        if (!Check(api_.nvEncDestroyEncoder(encoder_), "DestroyEncoder(close)", error)) {
          Fail(error, error);
          PreserveFailedSession();
          return;
        }
        encoder_ = nullptr;
      }
    }
    registrations_.clear();
    tasks_.clear();
    pending_.clear();
    if (eos_event_) {
      CloseHandle(eos_event_);
      eos_event_ = nullptr;
    }
    device_.Reset();
    if (module_) {
      FreeLibrary(module_);
      module_ = nullptr;
    }
    eos_ = false;
    initialized_ = eos_registered_ = eos_completed_ = false;
    if (admitted_) {
      auto& registry = Quarantine();
      std::lock_guard lock(registry.mutex);
      --registry.admitted;
      admitted_ = false;
    }
  }

 public:
  Nvenc() = default;
  Nvenc(const NV_ENCODE_API_FUNCTION_LIST& api,
        void* session,
        HANDLE event,
        NV_ENC_OUTPUT_PTR output,
        NV_ENC_INPUT_PTR input,
        uint64_t cookie,
        NvencTestHooks hooks)
      : api_(api), encoder_(session), hooks_(std::move(hooks)) {
    // Test sessions reserve the same finite ownership slots, but may be created
    // after a previous injected failure to cover independent failure cases.
    auto& registry = Quarantine();
    std::lock_guard lock(registry.mutex);
    if (registry.admitted >= QuarantineRegistry::kMaximumSessions)
      std::terminate();
    ++registry.admitted;
    admitted_ = true;
    Task task;
    task.event = event;
    task.output = output;
    task.mapped = input;
    task.cookie = cookie;
    task.busy = true;
    task.accepted = hooks_.now();
    tasks_.push_back(task);
    pending_.push_back(0);
    settings_.async_depth = 1;
    eos_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    eos_registered_ = initialized_ = true;
  }
  ~Nvenc() override { Cleanup(); }
  bool CanReleaseInputs() const override { return terminal_error_.empty(); }
  void HoldInputsUntilProcessExit(std::shared_ptr<void> owner) override {
    // Multiple retirement batches may reach the same failed session. None of
    // them may replace an earlier batch's source references or pool leases.
    if (owner)
      held_inputs_.push_back(std::move(owner));
  }
  const char* Name() const override { return "NVENC D3D11 asynchronous"; }
  EncoderSettings ActualSettings() const override { return settings_; }
  bool Configure(ID3D11Device* device,
                 const EncoderSettings& settings,
                 std::string& error) override {
    Cleanup();
    if (!terminal_error_.empty()) {
      error = terminal_error_;
      return false;
    }
    if (!device || !settings.width || !settings.height || !settings.fps || !settings.bitrate ||
        !settings.async_depth || settings.async_depth > 16 || (settings.width & 1) ||
        (settings.height & 1)) {
      error = "NVENC invalid encoder settings";
      return false;
    }
    settings_ = settings;
    {
      auto& registry = Quarantine();
      std::lock_guard lock(registry.mutex);
      if (registry.unavailable || registry.admitted >= QuarantineRegistry::kMaximumSessions) {
        error = "NVENC unavailable: quarantined session or process session limit; restart Endpoint";
        return false;
      }
      ++registry.admitted;
      admitted_ = true;
    }
    device_ = device;
    // Driver API DLL only: no CUDA runtime or application-folder DLL search.
    module_ = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module_) {
      error = "NVENC unavailable: NVIDIA driver nvEncodeAPI64.dll is not installed";
      return false;
    }
    using CreateInstance = NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);
    auto create =
        reinterpret_cast<CreateInstance>(GetProcAddress(module_, "NvEncodeAPICreateInstance"));
    using GetVersion = NVENCSTATUS(NVENCAPI*)(uint32_t*);
    auto version =
        reinterpret_cast<GetVersion>(GetProcAddress(module_, "NvEncodeAPIGetMaxSupportedVersion"));
    uint32_t supported = 0;
    const uint32_t required = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
    if (!create || !version || version(&supported) != NV_ENC_SUCCESS || supported < required) {
      error = "NVENC unavailable: driver does not support the pinned NVENC API version";
      return false;
    }
    api_ = {};
    api_.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    if (!Check(create(&api_), "CreateInstance", error))
      return false;
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER};
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    open.device = device;
    open.apiVersion = NVENCAPI_VERSION;
    if (!Check(api_.nvEncOpenEncodeSessionEx(&open, &encoder_), "OpenEncodeSessionEx", error))
      return false;
    NV_ENC_CAPS_PARAM caps{NV_ENC_CAPS_PARAM_VER};
    caps.capsToQuery = NV_ENC_CAPS_ASYNC_ENCODE_SUPPORT;
    int asynchronous = 0;
    if (!Check(api_.nvEncGetEncodeCaps(encoder_, NV_ENC_CODEC_H264_GUID, &caps, &asynchronous),
               "GetEncodeCaps(async)", error) ||
        !asynchronous) {
      if (!asynchronous)
        error = "NVENC unavailable: D3D11 asynchronous WDDM encoding is unsupported";
      return false;
    }
    NV_ENC_PRESET_CONFIG preset{NV_ENC_PRESET_CONFIG_VER};
    preset.presetCfg.version = NV_ENC_CONFIG_VER;
    if (!Check(api_.nvEncGetEncodePresetConfigEx(encoder_, NV_ENC_CODEC_H264_GUID,
                                                 NV_ENC_PRESET_P1_GUID,
                                                 NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset),
               "GetEncodePresetConfigEx", error))
      return false;
    config_ = preset.presetCfg;
    config_.version = NV_ENC_CONFIG_VER;
    config_.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
    config_.gopLength = settings.gop ? settings.gop : NVENC_INFINITE_GOPLENGTH;
    config_.frameIntervalP = 1;  // I/P only; no reordering latency.
    config_.rcParams.rateControlMode = settings.vbr ? NV_ENC_PARAMS_RC_VBR : NV_ENC_PARAMS_RC_CBR;
    config_.rcParams.averageBitRate = settings.bitrate;
    config_.rcParams.maxBitRate =
        settings.vbr ? std::max(settings.bitrate, settings.max_bitrate) : settings.bitrate;
    config_.rcParams.vbvBufferSize = static_cast<uint32_t>(std::clamp<uint64_t>(
        uint64_t(settings.bitrate) * settings.buffer_ms / 1000, 1, UINT32_MAX));
    config_.rcParams.vbvInitialDelay = config_.rcParams.vbvBufferSize;
    config_.rcParams.enableLookahead = 0;
    config_.rcParams.lookaheadDepth = 0;
    config_.rcParams.zeroReorderDelay = 1;
    auto& h264 = config_.encodeCodecConfig.h264Config;
    h264.level = settings.level_idc;
    h264.idrPeriod = config_.gopLength;
    h264.repeatSPSPPS = 1;
    h264.disableSPSPPS = 0;
    h264.chromaFormatIDC = 1;
    h264.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;
    auto& vui = h264.h264VUIParameters;
    vui.videoSignalTypePresentFlag = 1;
    vui.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED;
    vui.videoFullRangeFlag = 0;
    vui.colourDescriptionPresentFlag = 1;
    vui.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
    vui.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709;
    vui.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT709;
    init_ = {};
    init_.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init_.encodeGUID = NV_ENC_CODEC_H264_GUID;
    init_.presetGUID = NV_ENC_PRESET_P1_GUID;
    init_.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    init_.encodeWidth = init_.darWidth = init_.maxEncodeWidth = settings.width;
    init_.encodeHeight = init_.darHeight = init_.maxEncodeHeight = settings.height;
    init_.frameRateNum = settings.fps;
    init_.frameRateDen = 1;
    init_.enableEncodeAsync = 1;
    init_.enablePTD = 1;
    init_.encodeConfig = &config_;
    if (!Check(api_.nvEncInitializeEncoder(encoder_, &init_), "InitializeEncoder", error))
      return false;
    initialized_ = true;
    eos_event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!eos_event_) {
      Fail("NVENC EOS CreateEvent failed", error);
      return false;
    }
    NV_ENC_EVENT_PARAMS eos_event{NV_ENC_EVENT_PARAMS_VER};
    eos_event.completionEvent = eos_event_;
    if (!Check(api_.nvEncRegisterAsyncEvent(encoder_, &eos_event), "RegisterAsyncEvent(EOS)",
               error)) {
      Fail(error, error);
      return false;
    }
    eos_registered_ = true;
    // NVIDIA recommends at least four I/O buffers. Logical in-flight depth is
    // still controlled by settings.async_depth, so latency experiments compare
    // actual outstanding pictures rather than allocation count.
    tasks_.resize(std::max(4u, settings.async_depth));
    for (auto& task : tasks_) {
      NV_ENC_CREATE_BITSTREAM_BUFFER output{NV_ENC_CREATE_BITSTREAM_BUFFER_VER};
      if (!Check(api_.nvEncCreateBitstreamBuffer(encoder_, &output), "CreateBitstreamBuffer",
                 error))
        return false;
      task.output = output.bitstreamBuffer;
      task.event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (!task.event) {
        error = "NVENC CreateEvent failed";
        return false;
      }
      NV_ENC_EVENT_PARAMS event{NV_ENC_EVENT_PARAMS_VER};
      event.completionEvent = task.event;
      if (!Check(api_.nvEncRegisterAsyncEvent(encoder_, &event), "RegisterAsyncEvent", error))
        return false;
    }
    return true;
  }
  CodecResult Submit(ID3D11Texture2D* texture,
                     bool keyframe,
                     uint64_t cookie,
                     std::string& error) override {
    if (!terminal_error_.empty()) {
      error = terminal_error_;
      return CodecResult::error;
    }
    if (!encoder_ || eos_ || !texture) {
      error = "NVENC encoder is not accepting frames";
      return CodecResult::error;
    }
    if (pending_.size() >= settings_.async_depth)
      return CodecResult::busy;
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    ComPtr<ID3D11Device> owner;
    texture->GetDevice(&owner);
    if (owner.Get() != device_.Get() || desc.Width < settings_.width ||
        desc.Height < settings_.height || desc.Format != DXGI_FORMAT_NV12 || desc.ArraySize != 1 ||
        desc.MipLevels != 1) {
      error = "NVENC requires same-device, single-surface NV12 input";
      return CodecResult::error;
    }
    auto slot = std::find_if(tasks_.begin(), tasks_.end(), [](const Task& t) { return !t.busy; });
    if (slot == tasks_.end())
      return CodecResult::busy;
    auto [it, inserted] = registrations_.try_emplace(texture);
    if (inserted) {
      NV_ENC_REGISTER_RESOURCE resource{NV_ENC_REGISTER_RESOURCE_VER};
      resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
      resource.resourceToRegister = texture;
      resource.width = desc.Width;
      resource.height = desc.Height;
      resource.subResourceIndex = 0;
      resource.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
      resource.bufferUsage = NV_ENC_INPUT_IMAGE;
      if (!Check(api_.nvEncRegisterResource(encoder_, &resource), "RegisterResource", error)) {
        registrations_.erase(it);
        return CodecResult::error;
      }
      it->second.texture = texture;
      it->second.handle = resource.registeredResource;
    }
    NV_ENC_MAP_INPUT_RESOURCE map{NV_ENC_MAP_INPUT_RESOURCE_VER};
    map.registeredResource = it->second.handle;
    if (!Check(api_.nvEncMapInputResource(encoder_, &map), "MapInputResource", error))
      return CodecResult::error;
    slot->mapped = map.mappedResource;
    ResetEvent(slot->event);
    NV_ENC_PIC_PARAMS picture{NV_ENC_PIC_PARAMS_VER};
    picture.inputBuffer = slot->mapped;
    picture.bufferFmt = map.mappedBufferFmt;
    picture.inputWidth = settings_.width;
    picture.inputHeight = settings_.height;
    picture.outputBitstream = slot->output;
    picture.completionEvent = slot->event;
    picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    picture.inputTimeStamp = cookie;
    if (keyframe)
      picture.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    const NVENCSTATUS status = api_.nvEncEncodePicture(encoder_, &picture);
    if (status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT) {
      if (status == NV_ENC_ERR_ENCODER_BUSY) {
        if (!Check(api_.nvEncUnmapInputResource(encoder_, slot->mapped), "UnmapInputResource(busy)",
                   error))
          return Fail(error, error);
        slot->mapped = nullptr;
        return CodecResult::busy;
      }
      Check(status, "EncodePicture", error);
      return Fail(error, error);  // Unknown partial acceptance: retain the map/session.
    }
    slot->busy = true;
    slot->cookie = cookie;
    slot->signalled = false;
    slot->accepted = hooks_.now();
    pending_.push_back(static_cast<size_t>(slot - tasks_.begin()));
    return CodecResult::accepted;
  }
  CodecResult Poll(uint32_t timeout_ms, AccessUnit& output, std::string& error) override {
    if (!terminal_error_.empty()) {
      error = terminal_error_;
      return CodecResult::error;
    }
    if (!encoder_) {
      error = "NVENC encoder is closed";
      return CodecResult::error;
    }
    if (pending_.empty())
      return CodecResult::pending;
    auto& task = tasks_[pending_.front()];
    const auto deadline = task.accepted + std::chrono::seconds(5);
    const auto expired = [&] { return hooks_.now() >= deadline; };
    const auto timed_out = [&] {
      return Fail("NVENC frame completion timed out (cookie " + std::to_string(task.cookie) +
                      "); GPU leases retained until Endpoint exit",
                  error);
    };
    if (expired())
      return timed_out();
    const auto remaining =
        std::chrono::ceil<std::chrono::milliseconds>(deadline - hooks_.now()).count();
    const DWORD wait =
        task.signalled
            ? WAIT_OBJECT_0
            : hooks_.wait(
                  task.event,
                  std::min(timeout_ms, static_cast<uint32_t>(std::max<int64_t>(0, remaining))));
    if (expired())
      return timed_out();
    if (wait == WAIT_TIMEOUT)
      return CodecResult::pending;
    if (wait != WAIT_OBJECT_0)
      return Fail("NVENC completion event wait failed", error);
    task.signalled = true;
    NV_ENC_LOCK_BITSTREAM bitstream{NV_ENC_LOCK_BITSTREAM_VER};
    bitstream.outputBitstream = task.output;
    bitstream.doNotWait = 1;
    const auto status = api_.nvEncLockBitstream(encoder_, &bitstream);
    if (status == NV_ENC_ERR_LOCK_BUSY) {
      // An already observed event must not reset the submission deadline or
      // turn the worker/drain loop into a hot spin while the driver is busy.
      if (timeout_ms) {
        const auto pause = hooks_.wait(task.event, std::min(timeout_ms, 1u));
        if (pause != WAIT_TIMEOUT && pause != WAIT_OBJECT_0)
          return Fail("NVENC completion event wait failed", error);
      }
      if (expired())
        return timed_out();
      return CodecResult::pending;
    }
    if (!Check(status, "LockBitstream", error))
      return Fail(error, error);
    output.frame_cookie = task.cookie;
    auto* bytes = static_cast<const uint8_t*>(bitstream.bitstreamBufferPtr);
    output.bytes.assign(bytes, bytes + bitstream.bitstreamSizeInBytes);
    output.keyframe = bitstream.pictureType == NV_ENC_PIC_TYPE_IDR;
    output.qp = static_cast<int>(bitstream.frameAvgQP);
    const auto unlock = api_.nvEncUnlockBitstream(encoder_, task.output);
    const auto unmap = api_.nvEncUnmapInputResource(encoder_, task.mapped);
    if (!Check(unlock, "UnlockBitstream", error) || !Check(unmap, "UnmapInputResource", error))
      return Fail(error, error);
    task.mapped = nullptr;
    task.busy = false;
    pending_.pop_front();
    return CodecResult::ready;
  }
  bool SetRates(uint32_t bitrate, uint32_t fps, std::string& error, uint32_t maximum = 0) override {
    if (!terminal_error_.empty()) {
      error = terminal_error_;
      return false;
    }
    if (!encoder_ || eos_ || !bitrate || !fps) {
      error = "NVENC invalid rate update";
      return false;
    }
    if (maximum)
      settings_.max_bitrate = maximum;
    auto next = config_;
    next.rcParams.averageBitRate = bitrate;
    next.rcParams.maxBitRate = settings_.vbr ? std::max(bitrate, settings_.max_bitrate) : bitrate;
    next.rcParams.vbvBufferSize = static_cast<uint32_t>(
        std::clamp<uint64_t>(uint64_t(bitrate) * settings_.buffer_ms / 1000, 1, UINT32_MAX));
    next.rcParams.vbvInitialDelay = next.rcParams.vbvBufferSize;
    auto initialization = init_;
    initialization.encodeConfig = &next;
    initialization.frameRateNum = fps;
    NV_ENC_RECONFIGURE_PARAMS reconfigure{NV_ENC_RECONFIGURE_PARAMS_VER};
    reconfigure.reInitEncodeParams = initialization;
    if (!Check(api_.nvEncReconfigureEncoder(encoder_, &reconfigure), "ReconfigureEncoder", error))
      return false;
    config_ = next;
    init_.frameRateNum = fps;
    settings_.bitrate = bitrate;
    settings_.fps = fps;
    return true;
  }
  bool Drain(std::vector<AccessUnit>& output, std::string& error) override {
    if (!terminal_error_.empty()) {
      error = terminal_error_;
      return false;
    }
    if (!encoder_)
      return true;
    if (!eos_) {
      NV_ENC_PIC_PARAMS eos{NV_ENC_PIC_PARAMS_VER};
      eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
      eos.completionEvent = eos_event_;
      if (!Check(api_.nvEncEncodePicture(encoder_, &eos), "EOS", error)) {
        Fail(error, error);
        return false;
      }
      eos_ = true;
      eos_accepted_ = hooks_.now();
    }
    while (!pending_.empty()) {
      AccessUnit unit;
      auto result = Poll(100, unit, error);
      if (result == CodecResult::ready)
        output.push_back(std::move(unit));
      else if (result == CodecResult::error)
        return false;
    }
    // Asynchronous EOS acceptance alone is not a flush completion proof.
    const auto deadline = eos_accepted_ + std::chrono::seconds(5);
    while (!eos_completed_) {
      if (hooks_.now() >= deadline) {
        Fail("NVENC EOS completion timed out; session retained until Endpoint exit", error);
        return false;
      }
      const auto remaining =
          std::chrono::ceil<std::chrono::milliseconds>(deadline - hooks_.now()).count();
      const auto wait =
          hooks_.wait(eos_event_, static_cast<DWORD>(std::clamp<int64_t>(remaining, 0, 100)));
      if (hooks_.now() >= deadline) {
        Fail("NVENC EOS completion timed out; session retained until Endpoint exit", error);
        return false;
      }
      if (wait == WAIT_OBJECT_0)
        eos_completed_ = true;
      else if (wait != WAIT_TIMEOUT) {
        Fail("NVENC EOS completion event wait failed", error);
        return false;
      }
    }
    return true;
  }
};
}  // namespace
std::unique_ptr<HardwareEncoder> CreateNvencEncoder() {
  return std::make_unique<Nvenc>();
}
std::unique_ptr<HardwareEncoder> CreateNvencEncoderForTest(const NV_ENCODE_API_FUNCTION_LIST& api,
                                                           void* session,
                                                           HANDLE event,
                                                           NV_ENC_OUTPUT_PTR output,
                                                           NV_ENC_INPUT_PTR input,
                                                           uint64_t cookie,
                                                           NvencTestHooks hooks) {
  return std::make_unique<Nvenc>(api, session, event, output, input, cookie, std::move(hooks));
}
NvencQuarantineInfo GetNvencQuarantineInfo() {
  auto& registry = Quarantine();
  std::lock_guard lock(registry.mutex);
  return {registry.sessions.size(), registry.unavailable};
}
}  // namespace remotekit::media
