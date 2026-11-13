#include "rtc/service_peer.hpp"
#include "util/result_macros.hpp"
#include "util/log.hpp"
#include "protocol/limits.hpp"

namespace remotekit {
ServicePeer::ServicePeer(media::Sdk& sdk,
                         const RuntimeOptions& options,
                         ManagementLink& management,
                         objects::ObjectService& objects,
                         std::string tenant,
                         std::string lease)
    : sdk_(sdk),
      management_(management),
      tenant_(std::move(tenant)),
      lease_(std::move(lease)),
      authorization_(
          sdk,
          {.peer = [this] { return peer_.Handle(); },
           .connection = [this] { return peer_.Connection(); },
           .files_closed = [this] { files_.Bind(0); },
           .revoked = [this] { face_.Cancel(); },
           .wake = [] {},
           .opened = [](uint64_t) {},
           .files_opened = [this](uint64_t peer) { files_.Bind(peer, peer_.Connection()); }}),
      files_(options.data / "services" / tenant_, objects, tenant_),
      face_(sdk, tenant_, lease_, authorization_),
      peer_(sdk,
            options,
            {.bind = [this](uint64_t, uint64_t) { authorization_.Bind(); },
             .started = [this](uint64_t peer, const std::string&) -> Result<void> {
               face_.Start(peer);
               return {};
             },
             .stopping =
                 [this] {
                   authorization_.Close();
                   face_.Stop();
                 },
             .drained = [] {},
             .event = [this](const RtcEvent& event) { Receive(event); },
             .signal =
                 [this](uint64_t generation, const Json& signal) {
                   management_.SendEvent({{"event", "rtc.signal"},
                                          {"tenantId", tenant_},
                                          {"connectionId", peer_.Connection()},
                                          {"signal", signal}},
                                         generation);
                 },
             .log_fields = {{"tenantId", tenant_}, {"leaseId", lease_}}},
            PeerController::Role::kService) {}

ServicePeer::~ServicePeer() {
  stop_ = true;
  if (worker_.joinable())
    worker_.join();
  peer_.Close();
}

Result<Json> ServicePeer::Command(const std::string& method,
                                  const Json& request,
                                  uint64_t generation) {
  std::lock_guard lock(mutex_);
  if (request.value("leaseId", std::string()) != lease_)
    return Error{ErrorCode::kConflict, "Viewer service lease is retired"};
  if (!management_.Current(generation))
    return Error{ErrorCode::kUnavailable, "Management is disconnected"};
  if (method == "service.offer") {
    const auto sdp = Required(request, "sdp");
    if (sdp.size() > limits::serviceOfferSdpBytes) {
      LogEvent(LogLevel::kWarn, "rtc.service_offer_limit",
               {{"tenantId", tenant_},
                {"leaseId", lease_},
                {"bytes", sdp.size()},
                {"limit", limits::serviceOfferSdpBytes}});
      return Error{ErrorCode::kInvalidRequest, "Service offer SDP exceeds serviceOfferSdpBytes"};
    }
    if (sdp.find("m=video ") != std::string::npos || sdp.find("m=audio ") != std::string::npos)
      return Error{ErrorCode::kInvalidRequest, "Service peer requires data channels only"};
    if (!worker_.joinable()) {
      RK_RETURN_IF_ERROR(files_.Start());
      worker_ = std::thread([this] {
        RunThread(
            "service-peer",
            [this] {
              while (!stop_) {
                {
                  std::lock_guard guard(mutex_);
                  Flush();
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
              }
            },
            [this] { stop_ = true; });
      });
    }
    RK_ASSIGN_OR_RETURN(result, peer_.Offer(request, generation, 60, 1, false, false));
    RK_RETURN_IF_ERROR(authorization_.Authorize(
        request, generation, [this, generation] { return management_.Current(generation); }));
    if (authorization_.Stamp())
      RK_RETURN_IF_ERROR(files_.Authorize(peer_.Connection()));
    return result;
  }
  if (Required(request, "connectionId") != peer_.Connection())
    return Error{ErrorCode::kConflict, "Service peer is retired"};
  if (method == "service.close") {
    peer_.Close();
    return Json{{"closed", true}};
  }
  if (method == "service.ice")
    return peer_.Ice(request);
  if (method == "service.authorize") {
    RK_ASSIGN_OR_RETURN(result, authorization_.Authorize(request, generation, [this, generation] {
      return management_.Current(generation);
    }));
    if (authorization_.Stamp())
      RK_RETURN_IF_ERROR(files_.Authorize(peer_.Connection()));
    return result;
  }
  if (method == "service.asset.describe") {
    if (!authorization_.Stamp())
      return Error{ErrorCode::kLocked, "Viewer is locked"};
    return files_.Describe(Required(request, "assetId"));
  }
  if (method == "service.face.capabilities")
    return face_.FaceCapabilities();
  if (method.starts_with("service.face."))
    return face_.FaceCommand("auth" + method.substr(7), request, generation,
                             [this, generation] { return management_.Current(generation); });
  return Error{ErrorCode::kInvalidRequest, "Unknown service peer method"};
}

void ServicePeer::ManagementLost(uint64_t generation) {
  std::lock_guard lock(mutex_);
  auto result = authorization_.ManagementLost(generation);
}

void ServicePeer::Receive(const RtcEvent& event) {
  if (event.type == REMOTEKIT_RTC_AUTH_DATA || event.type == REMOTEKIT_RTC_AUTH_DATA_STATE) {
    face_.Receive(event);
    return;
  }
  if (event.type != REMOTEKIT_RTC_DATA || event.bytes.size() > 65536)
    return;
  auto admission = authorization_.LockAdmission();
  const auto token = authorization_.Admit();
  if (event.peer != token.peer || !authorization_.Current(token))
    return;
  auto message = Json::parse(event.bytes, nullptr, false);
  if (!message.is_object() || message.value("authEpoch", Json()) != token.epoch)
    return;
  auto request = event;
  request.message = std::move(message);
  files_.Admit(request);
}

void ServicePeer::Flush() {
  peer_.FlushSignals();
  const auto token = authorization_.Admit();
  if (!peer_.DataOpen() || !authorization_.Current(token))
    return;
  files_.Flush(token.peer, [this, token](const std::string& encoded) {
    // SDK sends wait for the signaling thread, which can be admitting incoming chunks.
    if (!authorization_.Current(token))
      return 1;
    auto message = Json::parse(encoded);
    message["authEpoch"] = token.epoch;
    const auto wire = message.dump();
    return sdk_.remotekit_rtc_send_data(token.peer, wire.data(), wire.size(), 0);
  });
}
}  // namespace remotekit
