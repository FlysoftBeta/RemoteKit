#include "util/log.hpp"
#include "qsv_encoder.hpp"
#include "gpu_device.hpp"
#include "qsv_rate_controller.hpp"
#include <vpl/mfxbrc.h>
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
#include <limits>
#include <thread>
#include <utility>
namespace remotekit::media {
remotekit::Result<void> ValidateQsvGeometry(const EncoderSettings& requested,
                                            uint32_t width,
                                            uint32_t height,
                                            uint32_t crop_width,
                                            uint32_t crop_height) {
  const auto aligned_width = (requested.width + 15) & ~15u;
  const auto aligned_height = (requested.height + 15) & ~15u;
  if (width == aligned_width && height == aligned_height && crop_width == requested.width &&
      crop_height == requested.height)
    return {};
  return remotekit::Error{remotekit::ErrorCode::kUnavailable,
                          "QSV unavailable: requested geometry " + std::to_string(aligned_width) +
                              "x" + std::to_string(aligned_height) + " crop " +
                              std::to_string(requested.width) + "x" +
                              std::to_string(requested.height) + "; actual " +
                              std::to_string(width) + "x" + std::to_string(height) + " crop " +
                              std::to_string(crop_width) + "x" + std::to_string(crop_height)};
}
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
    mfxExtEncodedFrameInfo frame_info{};
    mfxExtBuffer* frame_info_extension = nullptr;
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
  std::array<mfxExtBuffer*, 5> extensions_{};
  mfxFrameAllocator allocator_{};
  std::map<mfxMemId, std::unique_ptr<Memory>> allocations_;
  std::map<uint64_t, std::unique_ptr<Task>> jobs_;
  std::deque<std::unique_ptr<Packet>> packets_;
  std::vector<std::unique_ptr<Packet>> failed_packets_;
  std::unique_ptr<Packet> flush_packet_;
  std::string deferred_error_;
  EncoderSettings settings_;
  std::unique_ptr<QsvRateController> controller_;
  mfxExtBRC external_brc_{};
  uint32_t frame_order_ = 0;
  QsvLowPowerInfo low_power_;
  std::optional<QsvRateControlInfo> rate_control_;
  bool initialized_ = false;
  static mfxStatus MFX_CDECL BrInit(mfxHDL, mfxVideoParam*) { return MFX_ERR_NONE; }
  static mfxStatus MFX_CDECL BrReset(mfxHDL context, mfxVideoParam*) {
    auto* self = static_cast<Qsv*>(context);
    RK_SERVER_TRACE(self->trace_, "mfx_reset_return", TraceIds{},
                    rk_record.encoder = self->trace_encoder_;);
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL BrClose(mfxHDL) { return MFX_ERR_NONE; }
  void TraceBrc(const char* event, const RateTelemetry& sample) {
    RK_SERVER_TRACE(trace_, event, TraceIds{}, rk_record.encoder = trace_encoder_;
                    rk_record.cookie = sample.frame.cookie; rk_record.brc = sample;);
  }
  static mfxStatus MFX_CDECL BrGet(mfxHDL context,
                                   mfxBRCFrameParam* frame,
                                   mfxBRCFrameCtrl* control) {
    auto* self = static_cast<Qsv*>(context);
    const auto sample = self->controller_->GetFrameCtrl(frame->EncodedOrder, frame->NumRecode,
                                                        (frame->FrameType & MFX_FRAMETYPE_I) != 0);
    control->QpY = sample.qp;
    self->TraceBrc("brc_get", sample);
    return MFX_ERR_NONE;
  }
  static mfxStatus MFX_CDECL BrUpdate(mfxHDL context,
                                      mfxBRCFrameParam* frame,
                                      mfxBRCFrameCtrl*,
                                      mfxBRCFrameStatus* status) {
    auto* self = static_cast<Qsv*>(context);
    const auto result =
        self->controller_->Update(frame->EncodedOrder, frame->NumRecode, frame->CodedFrameSize);
    status->BRCStatus = static_cast<mfxU16>(result.recode ? MFX_BRC_BIG_FRAME : MFX_BRC_OK);
    self->TraceBrc(result.recode ? "brc_recode" : "brc_update", result.telemetry);
    return MFX_ERR_NONE;
  }
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
    // ExtBRC owns frame limits; driver readbacks must not become explicit budgets.
    options_.MaxFrameSize = 0;
    options3_.MaxFrameSizeI = 0;
    options3_.MaxFrameSizeP = 0;
    options3_.LowDelayBRC = MFX_CODINGOPTION_UNKNOWN;
  }
  void ReadRateControl() {
    rate_control_ = QsvRateControlInfo{options3_.LowDelayBRC,      options_.MaxFrameSize,
                                       options3_.MaxFrameSizeI,    options3_.MaxFrameSizeP,
                                       params_.mfx.BufferSizeInKB, params_.mfx.InitialDelayInKB};
    LogEvent(LogLevel::kInfo, "qsv.frame_budget",
             {{"lowDelayBrc", rate_control_->low_delay_brc},
              {"maxFrameSize", rate_control_->max_frame_size},
              {"maxFrameSizeI", rate_control_->max_frame_size_i},
              {"maxFrameSizeP", rate_control_->max_frame_size_p},
              {"bufferSizeKb", rate_control_->buffer_size_kb},
              {"initialDelayKb", rate_control_->initial_delay_kb}});
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
  static bool MatchesFrameRate(const mfxFrameInfo& frame, uint32_t fps) {
    return frame.FrameRateExtD == 1 && frame.FrameRateExtN == fps;
  }
  std::unique_ptr<Packet> NewPacket() const {
    auto packet = std::make_unique<Packet>();
    packet->frame_info.Header = {MFX_EXTBUFF_ENCODED_FRAME_INFO, sizeof(packet->frame_info)};
    packet->frame_info.QP = std::numeric_limits<mfxU16>::max();
    packet->frame_info_extension = &packet->frame_info.Header;
    packet->bitstream.ExtParam = &packet->frame_info_extension;
    packet->bitstream.NumExtParam = 1;
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
  EncoderSettings ActualSettings() const override {
    auto value = settings_;
    value.width = params_.mfx.FrameInfo.CropW;
    value.height = params_.mfx.FrameInfo.CropH;
    value.fps = params_.mfx.FrameInfo.FrameRateExtD
                    ? params_.mfx.FrameInfo.FrameRateExtN / params_.mfx.FrameInfo.FrameRateExtD
                    : 0;
    const auto rates = controller_->Snapshot();
    value.bitrate = rates.target;
    value.max_bitrate = rates.maximum;
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
    LogEvent(
        LogLevel::kInfo, "qsv.runtime",
        {{"major", version.Major}, {"minor", version.Minor}, {"implementation", implementation}});
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
    controller_ = std::make_unique<QsvRateController>(settings.bitrate, settings.max_bitrate);
    frame_order_ = 0;
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
    info.RateControlMethod = MFX_RATECONTROL_VBR;
    info.TargetKbps = static_cast<mfxU16>(std::max(1u, settings.bitrate / 1000));
    info.MaxKbps = static_cast<mfxU16>(std::max(1u, settings.max_bitrate / 1000));
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
    frame.FrameRateExtN = 60;
    frame.FrameRateExtD = 1;
    frame.PicStruct = MFX_PICSTRUCT_PROGRESSIVE;
    options_.Header.BufferId = MFX_EXTBUFF_CODING_OPTION2;
    options_.Header.BufferSz = sizeof(options_);
    options_.LookAheadDepth = 0;
    options_.ExtBRC = MFX_CODINGOPTION_ON;
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
    external_brc_.Header = {MFX_EXTBUFF_BRC, sizeof(external_brc_)};
    external_brc_.pthis = this;
    external_brc_.Init = BrInit;
    external_brc_.Reset = BrReset;
    external_brc_.Close = BrClose;
    external_brc_.GetFrameCtrl = BrGet;
    external_brc_.Update = BrUpdate;
    extensions_[4] = &external_brc_.Header;
    params_.ExtParam = extensions_.data();
    params_.NumExtParam = static_cast<mfxU16>(extensions_.size());
    mfxExtEncodedFrameInfo frame_info{};
    frame_info.Header = {MFX_EXTBUFF_ENCODED_FRAME_INFO, sizeof(frame_info)};
    mfxExtBuffer* frame_info_extension = &frame_info.Header;
    mfxVideoParam capabilities{};
    capabilities.mfx.CodecId = MFX_CODEC_AVC;
    capabilities.ExtParam = &frame_info_extension;
    capabilities.NumExtParam = 1;
    if (!Exact(MFXVideoENCODE_Query(session_, nullptr, &capabilities),
               "MFX H264 encoded frame info Query", error))
      return false;
    const auto query_status = MFXVideoENCODE_Query(session_, &params_, &params_);
    low_power_.query_status = query_status;
    if (query_status >= 0)
      low_power_.queried = params_.mfx.LowPower;
    LogEvent(LogLevel::kInfo, "qsv.low_power_queried",
             {{"requested", settings.qsv_low_power},
              {"queried", low_power_.queried.value_or(-1)},
              {"status", query_status}});
    if (!Status(query_status, "MFX H264 Query", error))
      return false;
    if (settings.qsv_low_power && params_.mfx.LowPower != settings.qsv_low_power) {
      error =
          "QSV Query changed explicit LowPower request to " + std::to_string(params_.mfx.LowPower);
      return false;
    }
    if (options_.ExtBRC != MFX_CODINGOPTION_ON ||
        params_.mfx.RateControlMethod != MFX_RATECONTROL_VBR) {
      error = "QSV Query did not accept external VBR";
      return false;
    }
    if (params_.mfx.GopRefDist != 1) {
      error = "QSV unexpectedly enabled B frames";
      return false;
    }
    ClearFrameBudgetReadback();
    const auto init_status = MFXVideoENCODE_Init(session_, &params_);
    low_power_.init_status = init_status;
    LogEvent(LogLevel::kInfo, "qsv.low_power_initialized", {{"status", init_status}});
    if (!Status(init_status, "MFX H264 Init", error))
      return false;
    initialized_ = true;
    const auto get_status = MFXVideoENCODE_GetVideoParam(session_, &params_);
    low_power_.get_video_param_status = get_status;
    if (get_status >= 0)
      low_power_.initialized = params_.mfx.LowPower;
    LogEvent(LogLevel::kInfo, "qsv.parameters_read",
             {{"lowPower", low_power_.initialized.value_or(-1)}, {"status", get_status}});
    if (!Status(get_status, "MFX GetVideoParam", error))
      return false;
    const auto& actual_frame = params_.mfx.FrameInfo;
    auto geometry = ValidateQsvGeometry(settings, actual_frame.Width, actual_frame.Height,
                                        actual_frame.CropW, actual_frame.CropH);
    if (!geometry) {
      error = geometry.error().message;
      return false;
    }
    ReadRateControl();
    if (!MatchesFrameRate(params_.mfx.FrameInfo, 60)) {
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
    LogEvent(LogLevel::kInfo, "qsv.vui",
             {{"fullRange", signal_.VideoFullRange},
              {"description", signal_.ColourDescriptionPresent},
              {"primaries", signal_.ColourPrimaries},
              {"transfer", signal_.TransferCharacteristics},
              {"matrix", signal_.MatrixCoefficients}});
    LogEvent(LogLevel::kInfo, "qsv.hrd",
             {{"nalConformance", hrd_options_.NalHrdConformance},
              {"nalVui", hrd_options_.VuiNalHrdParameters},
              {"vclVui", hrd_options_.VuiVclHrdParameters}});
    if (params_.mfx.CodecLevel > settings.level_idc) {
      error = "QSV actual H264 level " + std::to_string(params_.mfx.CodecLevel) +
              " exceeds negotiated level " + std::to_string(settings.level_idc);
      return false;
    }
    LogEvent(LogLevel::kInfo, "qsv.level", {{"level", settings.level_idc}});
    LogEvent(LogLevel::kInfo, "qsv.parameters",
             {{"width", params_.mfx.FrameInfo.CropW},
              {"height", params_.mfx.FrameInfo.CropH},
              {"fpsNumerator", params_.mfx.FrameInfo.FrameRateExtN},
              {"fpsDenominator", params_.mfx.FrameInfo.FrameRateExtD},
              {"targetUsage", params_.mfx.TargetUsage},
              {"rateControl", params_.mfx.RateControlMethod},
              {"targetKbps", params_.mfx.TargetKbps},
              {"maxKbps", params_.mfx.MaxKbps},
              {"bufferSizeKb", params_.mfx.BufferSizeInKB},
              {"asyncDepth", params_.AsyncDepth},
              {"gop", params_.mfx.GopPicSize},
              {"referenceDistance", params_.mfx.GopRefDist},
              {"profile", params_.mfx.CodecProfile},
              {"level", params_.mfx.CodecLevel}});
    return true;
  }

 public:
  CodecResult Submit(ID3D11Texture2D* texture,
                     bool key,
                     uint64_t cookie,
                     std::string& error,
                     FrameContext context) override {
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
    task->surface.Data.FrameOrder = frame_order_;
    controller_->Prepare(
        frame_order_,
        {cookie, static_cast<int64_t>(context.begin_qpc * (1000000.0 / QpcFrequency())),
         context.keepalive, key});
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
      controller_->Cancel(frame_order_);
      return CodecResult::busy;
    }
    ++frame_order_;
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
    if (packet.frame_info.QP > 51) {
      error = "QSV returned an invalid frame QP";
      deferred_error_ = error;
      return CodecResult::error;
    }
    output.qp = packet.frame_info.QP;
    const auto decision = controller_->Complete(task.surface.Data.FrameOrder);
    output.brc_recodes = decision.recodes;
    output.brc_cap_hits = decision.cap_hits;
    jobs_.erase(found);
    packets_.pop_front();
    return CodecResult::ready;
  }
  bool SetRates(uint32_t bitrate, uint32_t, std::string& error, uint32_t maximum = 0) override {
    if (!bitrate) {
      error = "QSV invalid rate update";
      return false;
    }
    const auto level = remotekit::H264RateLimits(settings_.level_idc);
    const auto next_max = std::min(maximum ? maximum : settings_.max_bitrate,
                                   level.bitrate_bps ? level.bitrate_bps : UINT32_MAX);
    controller_->SetRates(bitrate, next_max);
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
