#include "hardware_encoder.hpp"
#include "qsv_cadence_policy.hpp"
#include "server_trace.hpp"
#include "media/sampling.hpp"
#include <vpl/mfxdispatcher.h>
#include <vpl/mfxvideo.h>
#include <wrl/client.h>
#include <d3d10.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <thread>
#include <utility>
namespace remotekit::media {
namespace {
using Microsoft::WRL::ComPtr;
struct Memory {
  ComPtr<ID3D11Texture2D> texture;
  UINT index = 0;
};
class Qsv final : public HardwareEncoder {
  enum class Stage { encode_pending, encode_held };
  struct Packet {
    uint64_t submit_cookie = 0;
    mfxBitstream bitstream{};
    std::vector<mfxU8> storage;
    mfxSyncPoint sync = nullptr;
  };
  struct Task {
    uint64_t cookie = 0;
    Memory memory;
    mfxFrameSurface1 surface{};
    mfxEncodeCtrl control{};
    Stage stage = Stage::encode_pending;
    std::chrono::steady_clock::time_point accepted = std::chrono::steady_clock::now();
    std::unique_ptr<Packet> pending_packet;
  };
  ComPtr<ID3D11Device> device_;
  mfxLoader loader_ = nullptr;
  mfxSession session_ = nullptr;
  mfxVideoParam params_{};
  mfxExtCodingOption2 options_{};
  mfxExtCodingOption3 options3_{};
  mfxExtVideoSignalInfo signal_{};
  mfxExtCodingOption hrd_options_{};
  std::array<mfxExtBuffer*, 4> extensions_{};
  mfxFrameAllocator allocator_{};
  std::map<mfxMemId, std::unique_ptr<Memory>> allocations_;
  std::map<uint64_t, std::unique_ptr<Task>> jobs_;
  std::deque<std::unique_ptr<Packet>> packets_;
  std::vector<std::unique_ptr<Packet>> failed_packets_;
  std::unique_ptr<Packet> flush_packet_;
  std::string deferred_error_;
  EncoderSettings settings_;
  QsvCadencePolicy cadence_{0};
  QsvLowPowerInfo low_power_;
  std::optional<QsvRateControlInfo> rate_control_;
  bool initialized_ = false, keyframe_requested_ = false;
  mfxU16 allocated_buffer_kb_ = 0;
  static bool Status(mfxStatus status, const char* operation, std::string& error) {
    if (status >= 0)
      return true;
    error = std::string(operation) + " (MFX " + std::to_string(status) + ")";
    return false;
  }
  bool CheckSignal(std::string& error) const {
    if (signal_.VideoFullRange || !signal_.ColourDescriptionPresent ||
        signal_.ColourPrimaries != 1 || signal_.TransferCharacteristics != 1 ||
        signal_.MatrixCoefficients != 1) {
      error = "QSV did not accept BT.709 limited-range color metadata";
      return false;
    }
    return true;
  }
  void ClearFrameBudgetReadback() {
    // Query/GetVideoParam may synthesize budgets from the old timebase. Never
    // feed those readbacks into a later Init/Reset as explicit frame limits.
    options_.MaxFrameSize = 0;
    options3_.MaxFrameSizeI = 0;
    options3_.MaxFrameSizeP = 0;
    options3_.LowDelayBRC = MFX_CODINGOPTION_UNKNOWN;
  }
  void ReadRateControl() {
    rate_control_ = QsvRateControlInfo{options3_.LowDelayBRC,      options_.MaxFrameSize,
                                       options3_.MaxFrameSizeI,    options3_.MaxFrameSizeP,
                                       params_.mfx.BufferSizeInKB, params_.mfx.InitialDelayInKB};
    fprintf(stderr,
            "QSV actual frame budget: LowDelayBRC=%u MaxFrameSize=%u I=%u P=%u VBV_KB=%u "
            "InitialDelay_KB=%u\n",
            rate_control_->low_delay_brc, rate_control_->max_frame_size,
            rate_control_->max_frame_size_i, rate_control_->max_frame_size_p,
            rate_control_->buffer_size_kb, rate_control_->initial_delay_kb);
  }
  static mfxStatus MFX_CDECL Allocate(mfxHDL context,
                                      mfxFrameAllocRequest* request,
                                      mfxFrameAllocResponse* response) {
    auto* self = static_cast<Qsv*>(context);
    if (request->Info.FourCC != MFX_FOURCC_NV12)
      return MFX_ERR_UNSUPPORTED;
    const UINT count = request->NumFrameSuggested;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = request->Info.Width;
    desc.Height = request->Info.Height;
    desc.MipLevels = 1;
    desc.ArraySize = count;
    desc.Format = DXGI_FORMAT_NV12;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_DECODER;
    ComPtr<ID3D11Texture2D> array;
    if (FAILED(self->device_->CreateTexture2D(&desc, nullptr, &array)))
      return MFX_ERR_MEMORY_ALLOC;
    auto* ids = new mfxMemId[count];
    for (UINT i = 0; i < count; ++i) {
      auto memory = std::make_unique<Memory>();
      memory->texture = array;
      memory->index = i;
      ids[i] = memory.get();
      self->allocations_.emplace(ids[i], std::move(memory));
    }
    response->mids = ids;
    response->NumFrameActual = static_cast<mfxU16>(count);
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL Free(mfxHDL context, mfxFrameAllocResponse* response) {
    auto* self = static_cast<Qsv*>(context);
    for (UINT i = 0; i < response->NumFrameActual; ++i)
      self->allocations_.erase(response->mids[i]);
    delete[] response->mids;
    response->mids = nullptr;
    response->NumFrameActual = 0;
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL Lock(mfxHDL, mfxMemId, mfxFrameData*) { return MFX_ERR_LOCK_MEMORY; }
  static mfxStatus MFX_CDECL Unlock(mfxHDL, mfxMemId, mfxFrameData*) { return MFX_ERR_NONE; }
  static mfxStatus MFX_CDECL Handle(mfxHDL, mfxMemId id, mfxHDL* output) {
    if (!id || !output)
      return MFX_ERR_NULL_PTR;
    auto* memory = static_cast<Memory*>(id);
    auto* pair = reinterpret_cast<mfxHDLPair*>(output);
    pair->first = memory->texture.Get();
    pair->second = reinterpret_cast<mfxHDL>(static_cast<uintptr_t>(memory->index));
    // D3D11 allocator ABI returns a borrowed texture/index pair. The session and
    // task each retain the owning COM reference through hardware completion.
    return MFX_ERR_NONE;
  }
  static bool Exact(mfxStatus status, const char* operation, std::string& error) {
    if (status == MFX_ERR_NONE)
      return true;
    error = std::string(operation) + " (MFX " + std::to_string(status) + ")";
    return false;
  }
  static bool SameGeometry(const mfxFrameInfo& a, const mfxFrameInfo& b) {
    return a.FourCC == b.FourCC && a.Width == b.Width && a.Height == b.Height &&
           a.CropX == b.CropX && a.CropY == b.CropY && a.CropW == b.CropW && a.CropH == b.CropH &&
           a.ChromaFormat == b.ChromaFormat && a.PicStruct == b.PicStruct;
  }
  static bool MatchesFrameRate(const mfxFrameInfo& frame, uint32_t fps) {
    return frame.FrameRateExtD && frame.FrameRateExtN == uint64_t{fps} * frame.FrameRateExtD;
  }
  std::unique_ptr<Packet> NewPacket() const {
    auto packet = std::make_unique<Packet>();
    packet->storage.resize(
        std::max({size_t(4 * 1024 * 1024), size_t(settings_.width) * settings_.height * 2,
                  size_t(params_.mfx.BufferSizeInKB) * 1000 + 65536}));
    packet->bitstream.Data = packet->storage.data();
    packet->bitstream.MaxLength = static_cast<mfxU32>(packet->storage.size());
    return packet;
  }
  mfxStatus Encode(Task* task, Packet& packet) {
    mfxStatus status;
    do {
      status = MFXVideoENCODE_EncodeFrameAsync(session_, task ? &task->control : nullptr,
                                               task ? &task->surface : nullptr, &packet.bitstream,
                                               &packet.sync);
      if (status != MFX_ERR_NOT_ENOUGH_BUFFER || packet.storage.size() >= 64 * 1024 * 1024)
        break;
      packet.storage.resize(std::min<size_t>(64 * 1024 * 1024, packet.storage.size() * 2));
      packet.bitstream.Data = packet.storage.data();
      packet.bitstream.MaxLength = static_cast<mfxU32>(packet.storage.size());
    } while (true);
    return status;
  }
  bool SubmitEncode(Task& task, std::string& error) {
    if (!task.pending_packet)
      task.pending_packet = NewPacket();
    auto& packet = task.pending_packet;
    packet->submit_cookie = task.cookie;
    RK_SERVER_TRACE(trace_, "mfx_submit_begin", TraceIds{}, rk_record.cookie = task.cookie;
                    rk_record.encoder = trace_encoder_;);
    const auto status = Encode(&task, *packet);
    RK_SERVER_TRACE(trace_, "mfx_submit_return", TraceIds{}, rk_record.cookie = task.cookie;
                    rk_record.encoder = trace_encoder_; rk_record.status = status;);
    if (status == MFX_WRN_DEVICE_BUSY)
      return true;  // task remains encode_pending
    if (status == MFX_ERR_MORE_DATA) {
      task.stage = Stage::encode_held;
      packet.reset();
      return true;
    }
    if (status < 0 || !packet->sync) {
      Status(status, "MFX EncodeFrameAsync", error);
      if (error.empty())
        error = "QSV accepted encoding without a synchronization point";
      failed_packets_.push_back(std::move(packet));
      return false;
    }
    // Input ownership and output packets are independent: a returned packet
    // may encode an older cookie. Every accepted input remains held until its
    // own timestamp completes, including inputs whose call returned a sync.
    task.stage = Stage::encode_held;
    packets_.push_back(std::move(packet));
    return true;
  }

 public:
  State GetState() const override {
    if (!deferred_error_.empty())
      return State::kFailed;
    if (flush_packet_)
      return State::kDraining;
    return initialized_ ? State::kReady : State::kStopped;
  }

  std::optional<QsvLowPowerInfo> LowPowerInfo() const override { return low_power_; }
  std::optional<QsvRateControlInfo> RateControlInfo() const override { return rate_control_; }
  ~Qsv() override {
    if (session_) {
      // Close is the hardware cancellation/drain boundary even on device error.
      if (initialized_)
        MFXVideoENCODE_Close(session_);
      MFXClose(session_);
    }
    packets_.clear();
    failed_packets_.clear();
    flush_packet_.reset();
    jobs_.clear();
    allocations_.clear();
    if (loader_)
      MFXUnload(loader_);
  }
  const char* Name() const override { return "qsv"; }
  bool TakeKeyframeRequest() override { return std::exchange(keyframe_requested_, false); }
  EncoderSettings ActualSettings() const override {
    auto value = settings_;
    value.width = params_.mfx.FrameInfo.CropW;
    value.height = params_.mfx.FrameInfo.CropH;
    value.fps = params_.mfx.FrameInfo.FrameRateExtD
                    ? params_.mfx.FrameInfo.FrameRateExtN / params_.mfx.FrameInfo.FrameRateExtD
                    : 0;
    value.bitrate = params_.mfx.TargetKbps * 1000u;
    value.max_bitrate = params_.mfx.MaxKbps * 1000u;
    value.async_depth = params_.AsyncDepth;
    value.gop = params_.mfx.GopPicSize;
    value.target_usage = params_.mfx.TargetUsage;
    value.level_idc = params_.mfx.CodecLevel;
    value.qsv_low_power = static_cast<uint32_t>(low_power_.initialized.value_or(0));
    return value;
  }
  bool Configure(ID3D11Device* device,
                 const EncoderSettings& requested,
                 std::string& error) override {
    EncoderSettings settings = requested;
    if (!device || !settings.width || !settings.height || !settings.fps || !settings.async_depth) {
      error = "QSV requires a device, nonzero dimensions, fps and async depth";
      return false;
    }
    const auto level_budget = remotekit::H264RateLimits(settings.level_idc);
    if (level_budget.bitrate_bps) {
      settings.max_bitrate = std::min(settings.max_bitrate, level_budget.bitrate_bps);
      settings.bitrate = std::min(settings.bitrate, settings.max_bitrate);
    }
    if (session_) {
      error = "QSV already configured";
      return false;
    }
    device_ = device;
    settings_ = settings;
    cadence_ = QsvCadencePolicy(settings.fps);
    low_power_.requested = static_cast<int>(settings.qsv_low_power);
    ComPtr<ID3D10Multithread> multithread;
    if (SUCCEEDED(device_.As(&multithread)))
      multithread->SetMultithreadProtected(TRUE);
    loader_ = MFXLoad();
    if (!loader_) {
      error = "oneVPL dispatcher unavailable";
      return false;
    }
    auto filter = [&](const char* name, mfxU32 value) {
      auto config = MFXCreateConfig(loader_);
      mfxVariant property{};
      property.Type = MFX_VARIANT_TYPE_U32;
      property.Data.U32 = value;
      return MFXSetConfigFilterProperty(config, reinterpret_cast<const mfxU8*>(name), property);
    };
    if (!Status(filter("mfxImplDescription.Impl", MFX_IMPL_TYPE_HARDWARE), "oneVPL hardware filter",
                error) ||
        !Status(filter("mfxImplDescription.AccelerationMode", MFX_ACCEL_MODE_VIA_D3D11),
                "oneVPL D3D11 filter", error))
      return false;
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC adapter_desc{};
    if (FAILED(device_.As(&dxgi)) || FAILED(dxgi->GetAdapter(&adapter)) ||
        FAILED(adapter->GetDesc(&adapter_desc))) {
      error = "QSV D3D11 adapter identity unavailable";
      return false;
    }
    // The dispatcher also synthesizes the extended LUID for legacy Media SDK
    // implementations on Windows. A session with no matching identity fails.
    auto adapter_config = MFXCreateConfig(loader_);
    if (!adapter_config) {
      error = "oneVPL adapter filter config unavailable";
      return false;
    }
    mfxVariant adapter_property{};
    adapter_property.Type = MFX_VARIANT_TYPE_PTR;
    adapter_property.Data.Ptr = &adapter_desc.AdapterLuid;
    if (!Status(
            MFXSetConfigFilterProperty(
                adapter_config, reinterpret_cast<const mfxU8*>("mfxExtendedDeviceId.DeviceLUID"),
                adapter_property),
            "oneVPL adapter LUID filter", error) ||
        !Status(MFXCreateSession(loader_, 0, &session_),
                "MFXCreateSession hardware D3D11 for adapter", error))
      return false;
    mfxVersion version{};
    mfxIMPL implementation{};
    if (!Status(MFXQueryVersion(session_, &version), "MFX version", error) ||
        !Status(MFXQueryIMPL(session_, &implementation), "MFX implementation", error))
      return false;
    if (MFX_IMPL_BASETYPE(implementation) == MFX_IMPL_SOFTWARE) {
      error = "software MFX implementation rejected";
      return false;
    }
    fprintf(stderr, "QSV runtime API %u.%u implementation=0x%x\n", version.Major, version.Minor,
            implementation);
    if (!Status(MFXVideoCORE_SetHandle(session_, MFX_HANDLE_D3D11_DEVICE, device_.Get()),
                "MFX SetHandle", error))
      return false;
    allocator_.pthis = this;
    allocator_.Alloc = Allocate;
    allocator_.Free = Free;
    allocator_.Lock = Lock;
    allocator_.Unlock = Unlock;
    allocator_.GetHDL = Handle;
    if (!Status(MFXVideoCORE_SetFrameAllocator(session_, &allocator_), "MFX allocator", error))
      return false;
    return InitEncode(settings, error);
  }

 private:
  bool InitEncode(const EncoderSettings& settings, std::string& error) {
    const auto level_budget = remotekit::H264RateLimits(settings.level_idc);
    params_ = {};
    options_ = {};
    options3_ = {};
    signal_ = {};
    hrd_options_ = {};
    rate_control_.reset();
    low_power_.queried.reset();
    low_power_.initialized.reset();
    low_power_.init_status.reset();
    low_power_.get_video_param_status.reset();
    params_.AsyncDepth = static_cast<mfxU16>(settings.async_depth);
    params_.IOPattern = MFX_IOPATTERN_IN_VIDEO_MEMORY;
    auto& info = params_.mfx;
    info.LowPower = static_cast<mfxU16>(settings.qsv_low_power);
    info.CodecId = MFX_CODEC_AVC;
    info.CodecProfile = MFX_PROFILE_AVC_CONSTRAINED_BASELINE;
    info.CodecLevel = static_cast<mfxU16>(settings.level_idc);
    info.TargetUsage = static_cast<mfxU16>(settings.target_usage);
    info.RateControlMethod = settings.vbr ? MFX_RATECONTROL_VBR : MFX_RATECONTROL_CBR;
    info.TargetKbps = static_cast<mfxU16>(std::max(1u, settings.bitrate / 1000));
    info.MaxKbps = static_cast<mfxU16>(
        std::max(1u, (settings.vbr ? settings.max_bitrate : settings.bitrate) / 1000));
    info.BufferSizeInKB = static_cast<mfxU16>(std::min<uint64_t>(
        level_budget.cpb_kb ? level_budget.cpb_kb : 65535,
        uint64_t(std::max(settings.bitrate, settings.max_bitrate)) * settings.buffer_ms / 8000000));
    info.GopPicSize = static_cast<mfxU16>(settings.gop);
    info.GopRefDist = 1;
    info.IdrInterval = 0;
    info.NumRefFrame = 1;
    info.EncodedOrder = 0;
    auto& frame = info.FrameInfo;
    frame.FourCC = MFX_FOURCC_NV12;
    frame.ChromaFormat = MFX_CHROMAFORMAT_YUV420;
    frame.Width = static_cast<mfxU16>((settings.width + 15) & ~15u);
    frame.Height = static_cast<mfxU16>((settings.height + 15) & ~15u);
    frame.CropW = static_cast<mfxU16>(settings.width);
    frame.CropH = static_cast<mfxU16>(settings.height);
    frame.FrameRateExtN = settings.fps;
    frame.FrameRateExtD = 1;
    frame.PicStruct = MFX_PICSTRUCT_PROGRESSIVE;
    options_.Header.BufferId = MFX_EXTBUFF_CODING_OPTION2;
    options_.Header.BufferSz = sizeof(options_);
    options_.LookAheadDepth = 0;
    options_.ExtBRC = MFX_CODINGOPTION_OFF;
    options_.MBBRC = MFX_CODINGOPTION_OFF;
    options_.RepeatPPS = MFX_CODINGOPTION_ON;
    options3_.Header.BufferId = MFX_EXTBUFF_CODING_OPTION3;
    options3_.Header.BufferSz = sizeof(options3_);
    ClearFrameBudgetReadback();
    signal_.Header.BufferId = MFX_EXTBUFF_VIDEO_SIGNAL_INFO;
    signal_.Header.BufferSz = sizeof(signal_);
    signal_.VideoFormat = 5;
    signal_.VideoFullRange = 0;
    signal_.ColourDescriptionPresent = 1;
    signal_.ColourPrimaries = 1;
    signal_.TransferCharacteristics = 1;
    signal_.MatrixCoefficients = 1;
    extensions_[0] = reinterpret_cast<mfxExtBuffer*>(&options_);
    extensions_[1] = reinterpret_cast<mfxExtBuffer*>(&signal_);
    hrd_options_.Header.BufferId = MFX_EXTBUFF_CODING_OPTION;
    hrd_options_.Header.BufferSz = sizeof(hrd_options_);
    hrd_options_.NalHrdConformance = MFX_CODINGOPTION_OFF;
    hrd_options_.VuiNalHrdParameters = MFX_CODINGOPTION_OFF;
    hrd_options_.VuiVclHrdParameters = MFX_CODINGOPTION_OFF;
    extensions_[2] = reinterpret_cast<mfxExtBuffer*>(&hrd_options_);
    extensions_[3] = reinterpret_cast<mfxExtBuffer*>(&options3_);
    params_.ExtParam = extensions_.data();
    params_.NumExtParam = static_cast<mfxU16>(extensions_.size());
    const auto query_status = MFXVideoENCODE_Query(session_, &params_, &params_);
    low_power_.query_status = query_status;
    if (query_status >= 0)
      low_power_.queried = params_.mfx.LowPower;
    fprintf(stderr, "QSV LowPower: requested=%u queried=%d queryStatus=%d\n",
            settings.qsv_low_power, low_power_.queried.value_or(-1), query_status);
    if (!Status(query_status, "MFX H264 Query", error))
      return false;
    if (settings.qsv_low_power && params_.mfx.LowPower != settings.qsv_low_power) {
      error =
          "QSV Query changed explicit LowPower request to " + std::to_string(params_.mfx.LowPower);
      return false;
    }
    if (params_.mfx.GopRefDist != 1) {
      error = "QSV unexpectedly enabled B frames";
      return false;
    }
    ClearFrameBudgetReadback();
    const auto init_status = MFXVideoENCODE_Init(session_, &params_);
    low_power_.init_status = init_status;
    fprintf(stderr, "QSV LowPower: initStatus=%d\n", init_status);
    if (!Status(init_status, "MFX H264 Init", error))
      return false;
    initialized_ = true;
    const auto get_status = MFXVideoENCODE_GetVideoParam(session_, &params_);
    low_power_.get_video_param_status = get_status;
    if (get_status >= 0)
      low_power_.initialized = params_.mfx.LowPower;
    fprintf(stderr, "QSV LowPower: initialized=%d getVideoParamStatus=%d\n",
            low_power_.initialized.value_or(-1), get_status);
    if (!Status(get_status, "MFX GetVideoParam", error))
      return false;
    ReadRateControl();
    if (!MatchesFrameRate(params_.mfx.FrameInfo, settings.fps)) {
      error = "QSV initialization did not apply configured frame rate";
      return false;
    }
    if (settings.qsv_low_power && params_.mfx.LowPower != settings.qsv_low_power) {
      error = "QSV initialized with a different LowPower value: " +
              std::to_string(params_.mfx.LowPower);
      return false;
    }
    if (!CheckSignal(error))
      return false;
    fprintf(stderr,
            "QSV actual VUI: fullRange=%u description=%u primaries=%u transfer=%u matrix=%u\n",
            signal_.VideoFullRange, signal_.ColourDescriptionPresent, signal_.ColourPrimaries,
            signal_.TransferCharacteristics, signal_.MatrixCoefficients);
    fprintf(stderr, "QSV actual HRD: nalConformance=%u nalVui=%u vclVui=%u\n",
            hrd_options_.NalHrdConformance, hrd_options_.VuiNalHrdParameters,
            hrd_options_.VuiVclHrdParameters);
    allocated_buffer_kb_ = params_.mfx.BufferSizeInKB;
    if (params_.mfx.CodecLevel > settings.level_idc) {
      error = "QSV actual H264 level " + std::to_string(params_.mfx.CodecLevel) +
              " exceeds negotiated level " + std::to_string(settings.level_idc);
      return false;
    }
    fprintf(stderr, "QSV negotiated level=%u\n", settings.level_idc);
    fprintf(stderr,
            "QSV actual: %ux%u %u/%u fps TU=%u RC=%u TargetKbps=%u MaxKbps=%u VBV_KB=%u "
            "AsyncDepth=%u Gop=%u RefDist=%u Profile=%u Level=%u\n",
            params_.mfx.FrameInfo.CropW, params_.mfx.FrameInfo.CropH,
            params_.mfx.FrameInfo.FrameRateExtN, params_.mfx.FrameInfo.FrameRateExtD,
            params_.mfx.TargetUsage, params_.mfx.RateControlMethod, params_.mfx.TargetKbps,
            params_.mfx.MaxKbps, params_.mfx.BufferSizeInKB, params_.AsyncDepth,
            params_.mfx.GopPicSize, params_.mfx.GopRefDist, params_.mfx.CodecProfile,
            params_.mfx.CodecLevel);
    return true;
  }

 public:
  CodecResult Submit(ID3D11Texture2D* texture,
                     bool key,
                     uint64_t cookie,
                     std::string& error) override {
    if (!deferred_error_.empty()) {
      error = deferred_error_;
      return CodecResult::error;
    }
    if (jobs_.size() >= settings_.async_depth)
      return CodecResult::busy;
    if (!texture || jobs_.contains(cookie)) {
      error = "invalid QSV input/cookie";
      return CodecResult::error;
    }
    auto task = std::make_unique<Task>();
    task->cookie = cookie;
    task->memory.texture = texture;
    task->surface.Info = params_.mfx.FrameInfo;
    task->surface.Data.MemId = &task->memory;
    task->surface.Data.TimeStamp = cookie;
    if (key)
      task->control.FrameType = MFX_FRAMETYPE_I | MFX_FRAMETYPE_IDR | MFX_FRAMETYPE_REF;
    bool earlier_pending = false;
    for (auto& [id, earlier] : jobs_)
      earlier_pending |= earlier->stage == Stage::encode_pending;
    auto* accepted = task.get();
    jobs_.emplace(cookie, std::move(task));
    if (!earlier_pending && deferred_error_.empty() && accepted->stage == Stage::encode_pending &&
        !SubmitEncode(*accepted, error)) {
      deferred_error_ = error;
    }
    if (deferred_error_.empty() && accepted->stage == Stage::encode_pending) {
      jobs_.erase(cookie);
      return CodecResult::busy;
    }
    // Accepted input remains owned until final Sync/Close.
    return CodecResult::accepted;
  }
  CodecResult Poll(uint32_t timeout, AccessUnit& output, std::string& error) override {
    if (!deferred_error_.empty()) {
      error = deferred_error_;
      return CodecResult::error;
    }
    for (auto& [cookie, task] : jobs_) {
      if (std::chrono::steady_clock::now() - task->accepted > std::chrono::seconds(5)) {
        error = "QSV frame completion timed out";
        deferred_error_ = error;
        return CodecResult::error;
      }
      if (task->stage == Stage::encode_pending && !SubmitEncode(*task, error)) {
        deferred_error_ = error;
        return CodecResult::error;
      }
      if (task->stage == Stage::encode_pending)
        break;  // Keep submission order on busy.
    }
    if (packets_.empty() && !jobs_.empty()) {
      // NULL means end-of-sequence: retry pending input before flushing held input.
      bool held = false, pending = false;
      for (auto& [cookie, task] : jobs_) {
        held |= task->stage == Stage::encode_held;
        pending |= task->stage == Stage::encode_pending;
      }
      if (held && !pending) {
        if (!flush_packet_)
          flush_packet_ = NewPacket();
        for (auto& [cookie, task] : jobs_)
          if (task->stage == Stage::encode_held) {
            flush_packet_->submit_cookie = cookie;
            break;
          }
        const auto status = Encode(nullptr, *flush_packet_);
        if (status == MFX_WRN_DEVICE_BUSY) {
          if (timeout)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
          return CodecResult::pending;
        }
        if (status < 0 || !flush_packet_->sync) {
          error = "QSV flush has outstanding input without output; MFX " + std::to_string(status);
          deferred_error_ = error;
          return CodecResult::error;
        }
        packets_.push_back(std::move(flush_packet_));
      }
    }
    if (packets_.empty()) {
      if (timeout)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      return CodecResult::pending;
    }
    auto& packet = *packets_.front();
    RK_SERVER_TRACE(trace_, "mfx_sync_begin", TraceIds{}, rk_record.cookie = packet.submit_cookie;
                    rk_record.encoder = trace_encoder_;);
    const auto status = MFXVideoCORE_SyncOperation(session_, packet.sync, timeout);
    RK_SERVER_TRACE(trace_, "mfx_sync_return", TraceIds{}, rk_record.cookie = packet.submit_cookie;
                    rk_record.encoder = trace_encoder_; rk_record.status = status;);
    if (status == MFX_WRN_IN_EXECUTION)
      return CodecResult::pending;
    if (!Exact(status, "MFX SyncOperation", error)) {
      deferred_error_ = error;
      return CodecResult::error;
    }
    const uint64_t cookie = packet.bitstream.TimeStamp;
    const auto found = jobs_.find(cookie);
    if (cookie == MFX_TIMESTAMP_UNKNOWN || found == jobs_.end()) {
      error = "QSV output timestamp does not identify an outstanding input";
      deferred_error_ = error;
      return CodecResult::error;
    }
    auto& task = *found->second;
    if (task.surface.Data.Locked) {
      error = "QSV final encode Sync still owns the input";
      deferred_error_ = error;
      return CodecResult::error;
    }
    if (packet.bitstream.DataOffset > packet.bitstream.MaxLength ||
        packet.bitstream.DataLength > packet.bitstream.MaxLength - packet.bitstream.DataOffset ||
        !packet.bitstream.DataLength) {
      error = "QSV returned an invalid or empty bitstream";
      deferred_error_ = error;
      return CodecResult::error;
    }
    output.frame_cookie = cookie;
    output.bytes.assign(
        packet.bitstream.Data + packet.bitstream.DataOffset,
        packet.bitstream.Data + packet.bitstream.DataOffset + packet.bitstream.DataLength);
    output.keyframe = (packet.bitstream.FrameType & MFX_FRAMETYPE_IDR) != 0;
    output.qp = -1;
    jobs_.erase(found);
    packets_.pop_front();
    return CodecResult::ready;
  }
  std::optional<std::chrono::steady_clock::time_point> RateUpdateDeadline() const override {
    return cadence_.Deadline();
  }
  void CancelPendingRateUpdate() override { cadence_.Cancel(); }
  bool SetRates(uint32_t bitrate,
                uint32_t observed_fps,
                std::string& error,
                uint32_t maximum = 0) override {
    if (!bitrate || !observed_fps) {
      error = "QSV invalid rate update";
      return false;
    }
    if (!jobs_.empty() || !packets_.empty()) {
      error = "QSV rate reset requires drained queue";
      return false;
    }
    const auto next_max = maximum ? maximum : settings_.max_bitrate;
    bitrate = std::min(bitrate, next_max);
    const auto fps = cadence_.Select(settings_.fps, observed_fps, std::chrono::steady_clock::now());
    const bool cadence_changed = fps != settings_.fps;
    if (bitrate / 1000 == settings_.bitrate / 1000 && next_max == settings_.max_bitrate &&
        !cadence_changed)
      return true;
    auto next = params_;
    next.mfx.FrameInfo.FrameRateExtN = fps;
    next.mfx.FrameInfo.FrameRateExtD = 1;
    next.mfx.TargetKbps = static_cast<mfxU16>(std::max(1u, bitrate / 1000));
    next.mfx.MaxKbps =
        static_cast<mfxU16>(std::max(1u, (settings_.vbr ? next_max : bitrate) / 1000));
    next.mfx.BufferSizeInKB = allocated_buffer_kb_;
    ClearFrameBudgetReadback();
    mfxExtEncoderResetOption reset{};
    reset.Header.BufferId = MFX_EXTBUFF_ENCODER_RESET_OPTION;
    reset.Header.BufferSz = sizeof(reset);
    // A changed H264 VUI/HRD timebase needs a new sequence. Pure bitrate
    // changes retain the existing sequence and do not manufacture an IDR.
    reset.StartNewSequence = cadence_changed ? MFX_CODINGOPTION_ON : MFX_CODINGOPTION_OFF;
    std::array<mfxExtBuffer*, 5> reset_extensions = {extensions_[0], extensions_[1], extensions_[2],
                                                     extensions_[3],
                                                     reinterpret_cast<mfxExtBuffer*>(&reset)};
    next.ExtParam = reset_extensions.data();
    next.NumExtParam = static_cast<mfxU16>(reset_extensions.size());
    RK_SERVER_TRACE(trace_, "mfx_reset_begin", TraceIds{}, rk_record.encoder = trace_encoder_;);
    const auto status = MFXVideoENCODE_Reset(session_, &next);
    RK_SERVER_TRACE(trace_, "mfx_reset_return", TraceIds{}, rk_record.encoder = trace_encoder_;
                    rk_record.status = status;);
    const bool reinitialize = status == MFX_ERR_INCOMPATIBLE_VIDEO_PARAM;
    if (reinitialize) {
      // Reset cannot grow the initial allocation (for example, VBV at 1 FPS).
      // The worker has drained accepted jobs. Keep the same session and device
      // while rebuilding the encode component from the requested settings.
      const auto geometry = params_.mfx.FrameInfo;
      fprintf(stderr, "QSV rate Reset requires reinit: requested=%u fps=%u status=%d\n", bitrate,
              fps, status);
      if (!Exact(MFXVideoENCODE_Close(session_), "MFX Encode Close for rate reinit", error))
        return false;
      initialized_ = false;
      auto requested = settings_;
      requested.bitrate = bitrate;
      requested.fps = fps;
      requested.max_bitrate = next_max;
      if (!InitEncode(requested, error))
        return false;
      if (!SameGeometry(geometry, params_.mfx.FrameInfo)) {
        error = "QSV rate reinit changed required geometry";
        return false;
      }
    } else {
      if (!Status(status, "MFX rate Reset", error))
        return false;
      next.ExtParam = extensions_.data();
      next.NumExtParam = static_cast<mfxU16>(extensions_.size());
      params_ = next;
      RK_SERVER_TRACE(trace_, "mfx_get_params_begin", TraceIds{},
                      rk_record.encoder = trace_encoder_;);
      const auto get_status = MFXVideoENCODE_GetVideoParam(session_, &params_);
      RK_SERVER_TRACE(trace_, "mfx_get_params_return", TraceIds{},
                      rk_record.encoder = trace_encoder_;
                      rk_record.status = get_status;);
      low_power_.get_video_param_status = get_status;
      low_power_.initialized.reset();
      if (get_status >= 0)
        low_power_.initialized = params_.mfx.LowPower;
      if (!Status(get_status, "MFX GetVideoParam after rate update", error))
        return false;
      ReadRateControl();
    }
    if (settings_.qsv_low_power && params_.mfx.LowPower != settings_.qsv_low_power) {
      error = "QSV rate update changed explicit LowPower value";
      return false;
    }
    if (!MatchesFrameRate(params_.mfx.FrameInfo, fps)) {
      error = "QSV rate update did not apply requested frame rate";
      return false;
    }
    if (!CheckSignal(error))
      return false;
    if (params_.mfx.CodecLevel > settings_.level_idc) {
      error = "QSV rate update exceeded negotiated H264 level";
      return false;
    }
    settings_.bitrate = bitrate;
    settings_.fps = fps;
    settings_.max_bitrate = next_max;
    if (cadence_changed || reinitialize)
      keyframe_requested_ = true;
    fprintf(stderr, "QSV rate %s: requested=%u actual=%u fps=%u/%u newSequence=%s status=%d\n",
            reinitialize ? "reinit" : "Reset", bitrate, params_.mfx.TargetKbps * 1000u,
            params_.mfx.FrameInfo.FrameRateExtN, params_.mfx.FrameInfo.FrameRateExtD,
            (cadence_changed || reinitialize) ? "ON" : "OFF", status);
    return true;
  }
  bool Drain(std::vector<AccessUnit>& result, std::string& error) override {
    if (!initialized_)
      return true;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!jobs_.empty() || !packets_.empty()) {
      AccessUnit output;
      auto status = Poll(100, output, error);
      if (status == CodecResult::error)
        return false;
      if (status == CodecResult::ready)
        result.push_back(std::move(output));
      if (std::chrono::steady_clock::now() > deadline) {
        error = "QSV drain timed out";
        return false;
      }
      if (status == CodecResult::pending)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!deferred_error_.empty()) {
      error = deferred_error_;
      return false;
    }
    if (!flush_packet_)
      flush_packet_ = NewPacket();
    mfxStatus status;
    do {
      status = Encode(nullptr, *flush_packet_);
      if (status != MFX_WRN_DEVICE_BUSY)
        break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while (std::chrono::steady_clock::now() < deadline);
    if (status == MFX_ERR_MORE_DATA && !flush_packet_->sync) {
      flush_packet_.reset();
      return true;
    }
    error = "QSV encode drain returned an unaccounted output/status (MFX " +
            std::to_string(status) + ")";
    return false;
  }
};
}  // namespace
std::unique_ptr<HardwareEncoder> CreateQsvEncoder() {
  return std::make_unique<Qsv>();
}
}  // namespace remotekit::media
