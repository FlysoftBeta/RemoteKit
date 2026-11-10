#include "rtc/peer.hpp"
#include "util/wire_error.hpp"
#include "rtc/data_router.hpp"
#include "media/server_trace.hpp"
#include "rtc/candidate_address.hpp"
#include <cstdio>
namespace remotekit {
PeerController::~PeerController() {
  if (Handle())
    Close();
}
Result<Json> PeerController::Offer(const Json& request,
                                   uint64_t generation,
                                   uint32_t fps,
                                   uint32_t degradation,
                                   bool audio,
                                   bool av_sync) {
  const auto connection = Required(request, "connectionId");
  const auto sdp = Required(request, "sdp");
  Close();
  {
    std::lock_guard lock(mutex_);
    connection_ = connection;
    signals_.clear();
    signal_overflow_ = false;
  }
  state_ = State::kNegotiating;
  management_generation_ = generation;
  remotekit_rtc_options config{};
  config.struct_size = sizeof(config);
  config.abi_version = REMOTEKIT_RTC_ABI_VERSION;
  config.auth_required = 1;
  config.context = this;
  config.event = EventCallback;
  config.encoder.struct_size = sizeof(config.encoder);
  config.encoder.create = [](void* p, uint64_t peer, uint64_t encoder) {
    return static_cast<PeerController*>(p)->hooks_.create_encoder(peer, encoder);
  };
  config.encoder.configure = [](void* p, uint64_t encoder,
                                const remotekit_rtc_encoder_config* value) {
    return static_cast<PeerController*>(p)->hooks_.configure_encoder(encoder, value);
  };
  config.encoder.encode = [](void* p, uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
    return static_cast<PeerController*>(p)->hooks_.encode(encoder, frame, key);
  };
  config.encoder.set_rates = [](void* p, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
    static_cast<PeerController*>(p)->hooks_.rates(encoder, bitrate, fps);
  };
  config.encoder.request_keyframe = [](void* p, uint64_t encoder) {
    static_cast<PeerController*>(p)->hooks_.keyframe(encoder);
  };
  config.encoder.destroy = [](void* p, uint64_t encoder) {
    static_cast<PeerController*>(p)->hooks_.destroy_encoder(encoder);
  };
  config.min_bitrate_bps = 500000;
  config.start_bitrate_bps = options_.encoding.bitrate;
  config.max_bitrate_bps = options_.encoding.max_bitrate;
  config.port_min = options_.rtc_port_min;
  config.port_max = options_.rtc_port_max;
  std::string advertised;
  if (!options_.rtc_address.empty()) {
    // An unresolvable public name still leaves same-network Viewers their direct candidates.
    if (auto ip = ResolveRtcAddress(options_.rtc_address))
      advertised = std::move(ip).value();
    else
      std::fprintf(stderr, "RTC address unavailable: %s\n", ip.error().message.c_str());
  }
  {
    std::lock_guard lock(mutex_);
    advertised_ip_ = std::move(advertised);
  }
  uint64_t handle = 0;
  const int status = sdk_.remotekit_rtc_create(&config, &handle);
  peer_ = handle;
  struct OfferExit {
    PeerController& owner;
    bool accepted = false;
    ~OfferExit() {
      if (!accepted)
        owner.Close();
    }
  } exit{*this};
  if (status != 0 || !handle)
    return Error{media::SdkErrorCode(status), "RTC create failed"};
  const int sync_status = sdk_.remotekit_rtc_set_av_sync(handle, av_sync);
  if (sync_status)
    return Error{media::SdkErrorCode(sync_status), "RTC AV sync failed"};
  av_sync_ = av_sync;
  hooks_.bind(handle, generation);
  auto policy = Policy(fps, degradation, audio);
  if (!policy)
    return policy.error();
  const int playout_status = sdk_.remotekit_rtc_set_playout_delay(
      handle, RuntimeOptions::kRtcPlayoutMinMs, RuntimeOptions::kRtcPlayoutMaxMs);
  if (playout_status)
    return Error{media::SdkErrorCode(playout_status), "RTC playout delay failed"};
  const int offer_status =
      sdk_.remotekit_rtc_set_remote_description(handle, 1, sdp.data(), sdp.size());
  if (offer_status)
    return Error{offer_status == REMOTEKIT_SDK_INVALID_ARGUMENT ? ErrorCode::kRejected
                                                                : media::SdkErrorCode(offer_status),
                 "RTC remote offer failed"};
  uint32_t level = 0;
  if (sdk_.remotekit_rtc_get_receive_level(handle, &level) != 0)
    return Error{ErrorCode::kOutcomeUnknown,
                 "Cannot inspect receiving H264 level after applying offer"};
  if (!level)
    return Error{ErrorCode::kRejected, "peer has no compatible receiving H264 level"};
  receive_level_ = level;
  auto started = hooks_.started(handle, sdp);
  if (!started)
    return Error{ErrorCode::kOutcomeUnknown,
                 "RTC offer applied before media startup failed: " + started.error().message};
  exit.accepted = true;
  return Json{
      {"accepted", true}, {"pending", true}, {"connectionId", connection}, {"avSync", av_sync}};
}
Result<void> PeerController::Policy(uint32_t fps, uint32_t degradation, bool audio) {
  const auto handle = Handle();
  if (!handle)
    return {};
  const int degradation_status = sdk_.remotekit_rtc_set_degradation_preference(handle, degradation);
  if (degradation_status)
    return Error{degradation_status == REMOTEKIT_SDK_INVALID_ARGUMENT
                     ? ErrorCode::kInvalidRequest
                     : media::SdkErrorCode(degradation_status),
                 "RTC degradation policy failed"};
  if (sdk_.remotekit_rtc_set_source_max_fps(handle, fps) != 0 ||
      sdk_.remotekit_rtc_set_audio_enabled(handle, audio) != 0)
    return Error{ErrorCode::kOutcomeUnknown, "RTC media policy partially applied"};
  return {};
}
Result<Json> PeerController::Ice(const Json& request) {
  if (!request.contains("candidate"))
    return Error{ErrorCode::kInvalidRequest, "Malformed ICE candidate"};
  if (!Handle() || Required(request, "connectionId") != Connection())
    return Error{ErrorCode::kConflict, "stale RTC connection"};
  const auto& ice = request.at("candidate");
  if (ice.is_null())
    return Json::object();
  if (!ice.is_object() || !ice.contains("candidate") || !ice["candidate"].is_string() ||
      (ice.contains("sdpMid") && !ice["sdpMid"].is_string()) ||
      (ice.contains("sdpMLineIndex") &&
       (!ice["sdpMLineIndex"].is_number_integer() || ice["sdpMLineIndex"] < 0)))
    return Error{ErrorCode::kInvalidRequest, "Malformed ICE candidate"};
  const auto candidate = ice.value("candidate", std::string());
  const auto mid = ice.value("sdpMid", std::string("0"));
  const int status = sdk_.remotekit_rtc_add_ice(
      Handle(), mid.c_str(), ice.value("sdpMLineIndex", 0), candidate.data(), candidate.size());
  if (status)
    return Error{status == REMOTEKIT_SDK_INVALID_ARGUMENT ? ErrorCode::kInvalidRequest
                                                          : media::SdkErrorCode(status),
                 "ICE candidate failed"};
  return Json::object();
}
void PeerController::Close() {
  state_ = State::kClosing;
  data_open_ = false;
  hooks_.stopping();
  if (const auto handle = peer_.exchange(0))
    sdk_.remotekit_rtc_close(handle);
  hooks_.drained();
  management_generation_ = 0;
  receive_level_ = 0;
  av_sync_ = false;
  {
    std::lock_guard lock(mutex_);
    connection_.clear();
    advertised_ip_.clear();
    signals_.clear();
    signal_overflow_ = false;
  }
  state_ = State::kNone;
}
void PeerController::EventCallback(void* context,
                                   uint64_t peer,
                                   uint32_t type,
                                   const void* bytes,
                                   size_t size,
                                   const char* auxiliary,
                                   int32_t value) {
  auto& self = *static_cast<PeerController*>(context);
  auto result = DataRouter::Boundary([&]() -> Result<void> {
    self.OnEvent(peer, type, bytes, size, auxiliary, value);
    return {};
  });
  if (!result)
    self.Failed();
}
void PeerController::OnEvent(uint64_t peer,
                             uint32_t type,
                             const void* bytes,
                             size_t size,
                             const char* auxiliary,
                             int32_t value) {
  auto& self = *this;
  if (peer != self.Handle() || self.GetState() == State::kClosing)
    return;
  if (type == REMOTEKIT_RTC_DATA && size > 65536)
    return;
  const bool was_connected = self.Connected();
  if (type == REMOTEKIT_RTC_STATE)
    self.state_ = value == 2 ? State::kConnected : State::kNegotiating;
  if (type == REMOTEKIT_RTC_DATA_STATE)
    self.data_open_ = value == 1;
  RtcEvent event{type, std::string(static_cast<const char*>(bytes ? bytes : ""), size),
                 auxiliary ? auxiliary : "", value, peer};
  LARGE_INTEGER received{};
  QueryPerformanceCounter(&received);
  event.received_qpc = received.QuadPart;
  event.connection_changed = type == REMOTEKIT_RTC_STATE && was_connected != (value == 2);
  event.management_generation = self.ManagementGeneration();
  if (type == REMOTEKIT_RTC_SDP_ANSWER || type == REMOTEKIT_RTC_ICE ||
      type == REMOTEKIT_RTC_ICE_COMPLETE || type == REMOTEKIT_RTC_ERROR) {
    std::lock_guard lock(self.mutex_);
    if (!self.signal_overflow_) {
      if (self.signals_.size() < 256)
        self.signals_.push_back(event);
      else {
        self.signals_.clear();
        self.signal_overflow_ = true;
        RtcEvent failure{REMOTEKIT_RTC_ERROR, "RTC signaling queue exceeded bound",
                         "outcome_unknown", 0, peer};
        failure.management_generation = event.management_generation;
        self.signals_.push_back(std::move(failure));
      }
    }
  }
  self.hooks_.event(event);
}
void PeerController::FlushSignals() {
  std::deque<RtcEvent> pending;
  std::string advertised;
  {
    std::lock_guard lock(mutex_);
    pending.swap(signals_);
    advertised = advertised_ip_;
  }
  for (const auto& event : pending) {
    if (!Handle() || event.peer != Handle())
      continue;
    Json signal;
    if (event.type == REMOTEKIT_RTC_SDP_ANSWER)
      signal = {{"type", "answer"}, {"sdp", event.bytes}};
    else if (event.type == REMOTEKIT_RTC_ICE)
      signal = {{"type", "ice"},
                {"candidate",
                 {{"candidate", event.bytes},
                  {"sdpMid", event.auxiliary},
                  {"sdpMLineIndex", event.value}}}};
    else if (event.type == REMOTEKIT_RTC_ICE_COMPLETE)
      signal = {{"type", "complete"}};
    else if (event.type == REMOTEKIT_RTC_ERROR)
      signal = {
          {"type", "error"},
          {"error", WireError({ParseErrorCode(event.auxiliary).value_or(ErrorCode::kOutcomeUnknown),
                               event.bytes})}};
    else
      continue;
    hooks_.signal(event.management_generation, signal);
    if (event.type != REMOTEKIT_RTC_ICE || advertised.empty())
      continue;
    if (auto copy = AdvertisedCandidate(event.bytes, advertised, options_.rtc_port_min,
                                        options_.rtc_port_max)) {
      signal["candidate"]["candidate"] = std::move(*copy);
      hooks_.signal(event.management_generation, signal);
    }
  }
}
}  // namespace remotekit
