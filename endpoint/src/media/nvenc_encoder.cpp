#include "hardware_encoder.hpp"

#include <nvEncodeAPI.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <deque>
#include <map>
#include <utility>

namespace remotekit::media {
namespace {
using Microsoft::WRL::ComPtr;

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

  bool Check(NVENCSTATUS status, const char* operation, std::string& error) {
    if (status == NV_ENC_SUCCESS) return true;
    error = std::string("NVENC ") + operation + " failed (" +
            std::to_string(static_cast<int>(status)) + ")";
    if (encoder_ && api_.nvEncGetLastErrorString) {
      const char* detail = api_.nvEncGetLastErrorString(encoder_);
      if (detail && *detail) error += ": " + std::string(detail);
    }
    return false;
  }
  void Cleanup() {
    if (encoder_) {
      std::vector<AccessUnit> ignored;
      std::string error;
      Drain(ignored, error);
      // Drain completes GPU reads before registered resources are released.
      // If the device has failed, DestroyEncoder is the terminal driver fence.
      if (!pending_.empty()) {
        api_.nvEncDestroyEncoder(encoder_);
        encoder_ = nullptr;
      }
      for (auto& task : tasks_) {
        if (encoder_) {
          if (task.mapped) api_.nvEncUnmapInputResource(encoder_, task.mapped);
          if (task.event) {
            NV_ENC_EVENT_PARAMS event{NV_ENC_EVENT_PARAMS_VER};
            event.completionEvent = task.event;
            api_.nvEncUnregisterAsyncEvent(encoder_, &event);
          }
          if (task.output) api_.nvEncDestroyBitstreamBuffer(encoder_, task.output);
        }
        if (task.event) CloseHandle(task.event);
      }
      if (encoder_) {
        for (auto& [texture, registration] : registrations_)
          api_.nvEncUnregisterResource(encoder_, registration.handle);
        api_.nvEncDestroyEncoder(encoder_);
        encoder_ = nullptr;
      }
    }
    registrations_.clear();
    tasks_.clear();
    pending_.clear();
    device_.Reset();
    if (module_) { FreeLibrary(module_); module_ = nullptr; }
    eos_ = false;
  }
 public:
  ~Nvenc() override { Cleanup(); }
  const char* Name() const override { return "NVENC D3D11 asynchronous"; }
  EncoderSettings ActualSettings() const override { return settings_; }
  bool Configure(ID3D11Device* device, const EncoderSettings& settings,
                 std::string& error) override {
    Cleanup();
    if (!device || !settings.width || !settings.height || !settings.fps ||
        !settings.bitrate || !settings.async_depth || settings.async_depth > 16 ||
        (settings.width & 1) || (settings.height & 1)) {
      error = "NVENC invalid encoder settings"; return false;
    }
    settings_ = settings;
    device_ = device;
    // Driver API DLL only: no CUDA runtime or application-folder DLL search.
    module_ = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module_) { error = "NVENC unavailable: NVIDIA driver nvEncodeAPI64.dll is not installed"; return false; }
    using CreateInstance = NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);
    auto create = reinterpret_cast<CreateInstance>(
        GetProcAddress(module_, "NvEncodeAPICreateInstance"));
    using GetVersion = NVENCSTATUS(NVENCAPI*)(uint32_t*);
    auto version = reinterpret_cast<GetVersion>(
        GetProcAddress(module_, "NvEncodeAPIGetMaxSupportedVersion"));
    uint32_t supported = 0;
    const uint32_t required = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;
    if (!create || !version || version(&supported) != NV_ENC_SUCCESS || supported < required) {
      error = "NVENC unavailable: driver does not support the pinned NVENC API version";
      return false;
    }
    api_ = {}; api_.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    if (!Check(create(&api_), "CreateInstance", error)) return false;
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER};
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    open.device = device;
    open.apiVersion = NVENCAPI_VERSION;
    if (!Check(api_.nvEncOpenEncodeSessionEx(&open, &encoder_), "OpenEncodeSessionEx", error)) return false;
    NV_ENC_CAPS_PARAM caps{NV_ENC_CAPS_PARAM_VER};
    caps.capsToQuery = NV_ENC_CAPS_ASYNC_ENCODE_SUPPORT;
    int asynchronous = 0;
    if (!Check(api_.nvEncGetEncodeCaps(encoder_, NV_ENC_CODEC_H264_GUID,
        &caps, &asynchronous), "GetEncodeCaps(async)", error) || !asynchronous) {
      if (!asynchronous) error = "NVENC unavailable: D3D11 asynchronous WDDM encoding is unsupported";
      return false;
    }
    NV_ENC_PRESET_CONFIG preset{NV_ENC_PRESET_CONFIG_VER};
    preset.presetCfg.version = NV_ENC_CONFIG_VER;
    if (!Check(api_.nvEncGetEncodePresetConfigEx(encoder_, NV_ENC_CODEC_H264_GUID,
        NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset),
        "GetEncodePresetConfigEx", error)) return false;
    config_ = preset.presetCfg;
    config_.version = NV_ENC_CONFIG_VER;
    config_.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
    config_.gopLength = settings.gop ? settings.gop : NVENC_INFINITE_GOPLENGTH;
    config_.frameIntervalP = 1; // I/P only; no reordering latency.
    config_.rcParams.rateControlMode = settings.vbr ? NV_ENC_PARAMS_RC_VBR : NV_ENC_PARAMS_RC_CBR;
    config_.rcParams.averageBitRate = settings.bitrate;
    config_.rcParams.maxBitRate = settings.vbr ? std::max(settings.bitrate, settings.max_bitrate) : settings.bitrate;
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
    init_ = {}; init_.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init_.encodeGUID = NV_ENC_CODEC_H264_GUID;
    init_.presetGUID = NV_ENC_PRESET_P1_GUID;
    init_.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    init_.encodeWidth = init_.darWidth = init_.maxEncodeWidth = settings.width;
    init_.encodeHeight = init_.darHeight = init_.maxEncodeHeight = settings.height;
    init_.frameRateNum = settings.fps; init_.frameRateDen = 1;
    init_.enableEncodeAsync = 1; init_.enablePTD = 1;
    init_.encodeConfig = &config_;
    if (!Check(api_.nvEncInitializeEncoder(encoder_, &init_), "InitializeEncoder", error)) return false;
    // NVIDIA recommends at least four I/O buffers. Logical in-flight depth is
    // still controlled by settings.async_depth, so latency experiments compare
    // actual outstanding pictures rather than allocation count.
    tasks_.resize(std::max(4u, settings.async_depth));
    for (auto& task : tasks_) {
      NV_ENC_CREATE_BITSTREAM_BUFFER output{NV_ENC_CREATE_BITSTREAM_BUFFER_VER};
      if (!Check(api_.nvEncCreateBitstreamBuffer(encoder_, &output), "CreateBitstreamBuffer", error)) return false;
      task.output = output.bitstreamBuffer;
      task.event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (!task.event) { error = "NVENC CreateEvent failed"; return false; }
      NV_ENC_EVENT_PARAMS event{NV_ENC_EVENT_PARAMS_VER}; event.completionEvent = task.event;
      if (!Check(api_.nvEncRegisterAsyncEvent(encoder_, &event), "RegisterAsyncEvent", error)) return false;
    }
    return true;
  }
  CodecResult Submit(ID3D11Texture2D* texture, bool keyframe, uint64_t cookie,
                     std::string& error) override {
    if (!encoder_ || eos_ || !texture) { error = "NVENC encoder is not accepting frames"; return CodecResult::error; }
    if (pending_.size() >= settings_.async_depth) return CodecResult::busy;
    D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
    ComPtr<ID3D11Device> owner; texture->GetDevice(&owner);
    if (owner.Get() != device_.Get() || desc.Width < settings_.width ||
        desc.Height < settings_.height || desc.Format != DXGI_FORMAT_NV12 ||
        desc.ArraySize != 1 || desc.MipLevels != 1) {
      error = "NVENC requires same-device, single-surface NV12 input"; return CodecResult::error;
    }
    auto slot = std::find_if(tasks_.begin(), tasks_.end(), [](const Task& t) { return !t.busy; });
    if (slot == tasks_.end()) return CodecResult::busy;
    auto [it, inserted] = registrations_.try_emplace(texture);
    if (inserted) {
      NV_ENC_REGISTER_RESOURCE resource{NV_ENC_REGISTER_RESOURCE_VER};
      resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
      resource.resourceToRegister = texture;
      resource.width = desc.Width; resource.height = desc.Height;
      resource.subResourceIndex = 0;
      resource.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
      resource.bufferUsage = NV_ENC_INPUT_IMAGE;
      if (!Check(api_.nvEncRegisterResource(encoder_, &resource), "RegisterResource", error)) {
        registrations_.erase(it); return CodecResult::error;
      }
      it->second.texture = texture;
      it->second.handle = resource.registeredResource;
    }
    NV_ENC_MAP_INPUT_RESOURCE map{NV_ENC_MAP_INPUT_RESOURCE_VER};
    map.registeredResource = it->second.handle;
    if (!Check(api_.nvEncMapInputResource(encoder_, &map), "MapInputResource", error)) return CodecResult::error;
    slot->mapped = map.mappedResource;
    ResetEvent(slot->event);
    NV_ENC_PIC_PARAMS picture{NV_ENC_PIC_PARAMS_VER};
    picture.inputBuffer = slot->mapped;
    picture.bufferFmt = map.mappedBufferFmt;
    picture.inputWidth = settings_.width; picture.inputHeight = settings_.height;
    picture.outputBitstream = slot->output;
    picture.completionEvent = slot->event;
    picture.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    picture.inputTimeStamp = cookie;
    if (keyframe) picture.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    const NVENCSTATUS status = api_.nvEncEncodePicture(encoder_, &picture);
    if (status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT) {
      api_.nvEncUnmapInputResource(encoder_, slot->mapped); slot->mapped = nullptr;
      if (status == NV_ENC_ERR_ENCODER_BUSY) return CodecResult::busy;
      Check(status, "EncodePicture", error); return CodecResult::error;
    }
    slot->busy = true; slot->cookie = cookie;
    pending_.push_back(static_cast<size_t>(slot - tasks_.begin()));
    return CodecResult::accepted;
  }
  CodecResult Poll(uint32_t timeout_ms, AccessUnit& output, std::string& error) override {
    if (!encoder_) { error = "NVENC encoder is closed"; return CodecResult::error; }
    if (pending_.empty()) return CodecResult::pending;
    auto& task = tasks_[pending_.front()];
    const DWORD wait = WaitForSingleObject(task.event, timeout_ms);
    if (wait == WAIT_TIMEOUT) return CodecResult::pending;
    if (wait != WAIT_OBJECT_0) { error = "NVENC completion event wait failed"; return CodecResult::error; }
    NV_ENC_LOCK_BITSTREAM bitstream{NV_ENC_LOCK_BITSTREAM_VER};
    bitstream.outputBitstream = task.output; bitstream.doNotWait = 1;
    const auto status = api_.nvEncLockBitstream(encoder_, &bitstream);
    if (status == NV_ENC_ERR_LOCK_BUSY) { SetEvent(task.event); return CodecResult::pending; }
    if (!Check(status, "LockBitstream", error)) return CodecResult::error;
    output.frame_cookie = task.cookie;
    auto* bytes = static_cast<const uint8_t*>(bitstream.bitstreamBufferPtr);
    output.bytes.assign(bytes, bytes + bitstream.bitstreamSizeInBytes);
    output.keyframe = bitstream.pictureType == NV_ENC_PIC_TYPE_IDR;
    output.qp = static_cast<int>(bitstream.frameAvgQP);
    const auto unlock = api_.nvEncUnlockBitstream(encoder_, task.output);
    const auto unmap = api_.nvEncUnmapInputResource(encoder_, task.mapped);
    task.mapped = nullptr; task.busy = false; pending_.pop_front();
    if (!Check(unlock, "UnlockBitstream", error) || !Check(unmap, "UnmapInputResource", error))
      return CodecResult::error;
    return CodecResult::ready;
  }
  bool SetRates(uint32_t bitrate, uint32_t fps, std::string& error) override {
    if (!encoder_ || eos_ || !bitrate || !fps) { error = "NVENC invalid rate update"; return false; }
    auto next = config_;
    next.rcParams.averageBitRate = bitrate;
    next.rcParams.maxBitRate = settings_.vbr ? std::max(bitrate, settings_.max_bitrate) : bitrate;
    next.rcParams.vbvBufferSize = static_cast<uint32_t>(std::clamp<uint64_t>(
        uint64_t(bitrate) * settings_.buffer_ms / 1000, 1, UINT32_MAX));
    next.rcParams.vbvInitialDelay = next.rcParams.vbvBufferSize;
    auto initialization = init_;
    initialization.encodeConfig = &next;
    initialization.frameRateNum = fps;
    NV_ENC_RECONFIGURE_PARAMS reconfigure{NV_ENC_RECONFIGURE_PARAMS_VER};
    reconfigure.reInitEncodeParams = initialization;
    if (!Check(api_.nvEncReconfigureEncoder(encoder_, &reconfigure), "ReconfigureEncoder", error)) return false;
    config_ = next; init_.frameRateNum = fps;
    settings_.bitrate = bitrate; settings_.fps = fps;
    return true;
  }
  bool Drain(std::vector<AccessUnit>& output, std::string& error) override {
    if (!encoder_) return true;
    if (!eos_) {
      NV_ENC_PIC_PARAMS eos{NV_ENC_PIC_PARAMS_VER};
      eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
      if (!Check(api_.nvEncEncodePicture(encoder_, &eos), "EOS", error)) return false;
      eos_ = true;
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!pending_.empty()) {
      AccessUnit unit;
      auto result = Poll(100, unit, error);
      if (result == CodecResult::ready) output.push_back(std::move(unit));
      else if (result == CodecResult::error) return false;
      if (std::chrono::steady_clock::now() >= deadline) { error = "NVENC drain timed out"; return false; }
    }
    return true;
  }
};
}  // namespace
std::unique_ptr<HardwareEncoder> CreateNvencEncoder() { return std::make_unique<Nvenc>(); }
}  // namespace remotekit::media
