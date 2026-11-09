#include "rtc/channel.hpp"
#include "auth/face.hpp"
#include "util/wire_error.hpp"
#include "diagnostics/timing.hpp"
#include "files/files.hpp"
#include "input/input.hpp"
#include "media/encoders.hpp"
#include "media/output.hpp"
#include "media/pipeline.hpp"
#include "media/presentation.hpp"
#include "rtc/authorization.hpp"
#include "rtc/data_router.hpp"
#include "rtc/outbox.hpp"
#include "rtc/peer.hpp"
#include "session/views.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
bool ChannelController::ProductCurrent(const Event& event) const {
  return event.peer == peer_controller.Handle() && authorization.Current(event.authorization);
}

void ChannelController::HandlePeerEvent(const RtcEvent& event) {
  if (event.type == REMOTEKIT_RTC_AUTH_DATA_STATE || event.type == REMOTEKIT_RTC_AUTH_DATA) {
    face.Receive(event);
    return;
  }
  if (event.type == REMOTEKIT_RTC_SDP_ANSWER)
    timing.MarkConnection(ConnectionPhase::answer);
  else if (event.type == REMOTEKIT_RTC_ICE)
    timing.MarkConnection(ConnectionPhase::first_candidate);
  else if (event.type == REMOTEKIT_RTC_ICE_COMPLETE)
    timing.MarkConnection(ConnectionPhase::gather_complete);
  else if (event.type == REMOTEKIT_RTC_STATE && event.value == 2)
    timing.MarkConnection(ConnectionPhase::connected);
  else if (event.type == REMOTEKIT_RTC_DATA_STATE && event.value == 1)
    timing.MarkConnection(ConnectionPhase::data_open);
  if (event.type == REMOTEKIT_RTC_DATA) {
    auto routed = data_router.Receive(event);
    if (!routed)
      fprintf(stderr, "DataChannel receive: %s\n", routed.error().message.c_str());
    return;
  }
  if (event.type == REMOTEKIT_RTC_DATA_STATE) {
    data_router.DataState(event);
    return;
  }
  if (event.type == REMOTEKIT_RTC_STATS) {
    auto sample = Json::parse(event.bytes, nullptr, false);
    if (sample.is_object())
      registry.SenderStats(std::move(sample));
  } else if (event.type == REMOTEKIT_RTC_STATE || event.type == REMOTEKIT_RTC_REFRESH_REQUEST) {
    pipeline.Queue(event);
  } else if (event.type == REMOTEKIT_RTC_ERROR) {
    fprintf(stderr, "RTC %s: %s\n", id.c_str(), event.bytes.c_str());
  }
}

void ChannelController::FlushSignals() {
  std::deque<RtcEvent> incoming;
  {
    std::lock_guard lock(event_mutex);
    incoming.swap(events);
  }
  for (const auto& event : incoming) {
    if (!ProductCurrent(event))
      continue;
    auto message = Json::parse(event.bytes, nullptr, false);
    if (message.is_object())
      Send(message, event.authorization);
  }
  const auto stamp = authorization.Stamp();
  if (stamp)
    direct_services.DispatchPending(
        peer_controller.Handle(), 1000.0 * QpcNow() / QpcFrequency(),
        [&](const Json& message, DeliveryFlag delivery) {
          if (!authorization.Current(stamp))
            return false;
          return management.SendEvent(Json({{"event", "client.action"},
                                            {"tenantId", tenant},
                                            {"connectionId", peer_controller.Connection()},
                                            {"authEpoch", authorization.Epoch()},
                                            {"operationGeneration", message["operationGeneration"]},
                                            {"operationId", message["operationId"]},
                                            {"action", message["action"]}}),
                                      authorization.ManagementGeneration(), std::move(delivery));
        });
  data_router.Drain();
  peer_controller.FlushSignals();
  direct_services.Editable(peer_controller.Handle(), output.Slots().LatestMetadata(),
                           output.Suspended());
  direct_services.Selection(peer_controller.Handle(), output.Slots().LatestMetadata(),
                            presentation.Epoch(), output.Suspended());
  if (stamp && authorization.Current(stamp)) {
    const auto peer = peer_controller.Handle();
    direct_services.ContextMenu(
        peer, output.Slots().LatestMetadata(), output.Suspended(),
        [&](const Json& identity) -> Json {
          if (!authorization.Current(stamp) || !browser.Alive() || !browser.Rpc().Control())
            return nullptr;
          auto reply = browser.Rpc().Request({{"method", "page.contextMenu"},
                                              {"session", id},
                                              {"view", identity["view"]["id"]},
                                              {"menu", identity["menu"]}});
          if (!reply || !authorization.Current(stamp))
            return nullptr;
          return reply.value().value("menu", Json());
        },
        [&] {
          return authorization.Current(stamp)
                     ? DirectServices::ContextMenuIdentity(output.Slots().LatestMetadata(),
                                                           output.Suspended())
                     : Json();
        });
  }
  FlushControl();
  FlushServices();
}

int ChannelController::SendData(uint64_t handle, uint64_t stamp, const std::string& encoded) {
  const auto token = authorization.Admit();
  if (handle != token.peer || stamp != token.stamp || !authorization.Current(token))
    return 1;
  // All outboxes serialize objects. Append the active wire epoch at actual
  // admission, while the queue's local generation still owns this send.
  if (encoded.size() < 2 || encoded.front() != '{' || encoded.back() != '}')
    return 1;
  std::string wire = encoded.substr(0, encoded.size() - 1);
  if (wire.size() > 1)
    wire += ',';
  wire += "\"authEpoch\":" + std::to_string(token.epoch) + "}";
  return authorization.Current(token)
             ? sdk.remotekit_rtc_send_data(handle, wire.data(), wire.size(), 0)
             : 1;
}

void ChannelController::Send(const Json& message, uint64_t expected_stamp) {
  const auto stamp = authorization.Stamp();
  auto handle = peer_controller.Handle();
  if (!stamp || (expected_stamp && stamp != expected_stamp) || !handle ||
      !peer_controller.DataOpen() || stamp != authorization.Frame())
    return;
  FlushControl();
  control_outbox.Transient(
      {handle, stamp}, message.dump(),
      [&](const std::string& encoded) { return SendData(handle, stamp, encoded); },
      message.value("type", std::string()) == "frame" ||
          message.value("type", std::string()) == "stats");
}

void ChannelController::FlushControl() {
  const auto stamp = authorization.Stamp();
  const auto handle = peer_controller.Handle();
  if (!stamp || !handle || !peer_controller.DataOpen() || stamp != authorization.Frame())
    return;
  control_outbox.Flush({handle, stamp}, [&](const std::string& encoded) {
    return SendData(handle, stamp, encoded);
  });
}

void ChannelController::FlushServices() {
  const auto stamp = authorization.Stamp();
  const auto handle = peer_controller.Handle();
  if (!stamp || !handle || !peer_controller.DataOpen() || stamp != authorization.Frame())
    return;
  // Layout and prepare always have admission priority over service replies.
  control_outbox.Transient({handle, stamp}, std::string(), [&](const std::string&) {
    direct_services.Flush(
        handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    return 0;
  });
  control_outbox.Transient({handle, stamp}, std::string(), [&](const std::string&) {
    files.Flush(handle,
                [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    return 0;
  });
}

bool ChannelController::ServiceMessage(const Event& event) {
  const auto& message = event.message;
  auto admission = authorization.LockAdmission();
  if (!ProductCurrent(event))
    return true;
  if (!remotekit::ProductActionEnvelope(message, event.bytes.size()))
    return true;
  const bool accepted =
      direct_services.Admit(event.peer, message, 1000.0 * QpcNow() / QpcFrequency());
  admission.unlock();
  if (!accepted)
    Send({{"type", "product.result"},
          {"version", 1},
          {"operationId", message["operationId"]},
          {"connectionId", peer_controller.Connection()},
          {"operationGeneration", message["operationGeneration"]},
          {"ok", false},
          {"error", WireError({ErrorCode::kBusy, "endpoint_backpressure"})}},
         event.authorization);
  return true;
}

Result<Json> ChannelController::Offer(const Json& request, uint64_t generation) {
  if (!request.contains("avSync") || !request.at("avSync").is_boolean())
    return Error{ErrorCode::kInvalidRequest, "invalid RTC avSync"};
  const bool av_sync = request.at("avSync").get<bool>();
  auto started = views.Start();
  if (!started)
    return started.error();
  pipeline.Rates(options.encoding.bitrate, pipeline.MaxFps());
  return peer_controller.Offer(request, generation, pipeline.MaxFps(), pipeline.Degradation(),
                               pipeline.Audio(), av_sync);
}

Result<Json> ChannelController::ManageRtcActionResult(const Json& request) {
  if (request.value("connectionId", std::string()) != peer_controller.Connection() ||
      !peer_controller.Handle() || !authorization.Stamp())
    return Json{{"accepted", false}};
  if (request.value("authEpoch", Json()) != authorization.Epoch())
    return Json{{"accepted", false}};
  if (!request.contains("operationId") ||
      !remotekit::BoundedServiceId(request["operationId"], 36) ||
      !request.contains("operationGeneration") ||
      !remotekit::BoundedServiceId(request["operationGeneration"]) || !request.contains("result") ||
      !request["result"].is_object())
    return Error{ErrorCode::kInvalidRequest, "invalid action result"};
  Json result = {{"connectionId", peer_controller.Connection()},
                 {"operationId", request["operationId"]},
                 {"operationGeneration", request["operationGeneration"]},
                 {"result", request["result"]}};

  const bool accepted = direct_services.Result(peer_controller.Handle(), result);
  pipeline.Wake();
  return Json{{"accepted", accepted}};
}

Result<Json> ChannelController::ManageRtcOffer(const Json& request) {
  auto offer_result = Offer(request, request_generation_);
  if (!offer_result)
    return offer_result.error();
  auto result = std::move(offer_result).value();
  if (!management.Current(request_generation_)) {
    {
      auto management_lost_result = authorization.ManagementLost(request_generation_);
      if (!management_lost_result)
        return management_lost_result.error();
    }
    return Error{ErrorCode::kOutcomeUnknown, "Management disconnected after applying RTC offer"};
  }
  return result;
}

Result<Json> ChannelController::ManageRtcClose(const Json& request) {
  if (request.value("connectionId", std::string()) == peer_controller.Connection())
    peer_controller.Close();
  return Json{{"closed", true}};
}

Result<Json> ChannelController::ManageRtcIce(const Json& request) {
  return peer_controller.Ice(request);
}
}  // namespace remotekit

namespace remotekit {
DataRouter::Hooks ChannelController::MakeRouterHooks() {
  return DataRouter::Hooks{
      .peer = [this] { return peer_controller.Handle(); },
      .stamp = [this] { return authorization.Stamp(); },
      .epoch = [this] { return authorization.Epoch(); },
      .current = [this](const RtcEvent& event) { return ProductCurrent(event); },
      .product = [this](const RtcEvent& event) { ServiceMessage(event); },
      .presentation = [this](const RtcEvent& event) { presentation.PresentationMessage(event); },
      .input = [this](const RtcEvent& event) { input.QueueInput(event); },
      .files = [this](const RtcEvent& event) { files.Admit(event); },
      .feedback =
          [this](const RtcEvent& event) {
            presentation.ReceiveFeedback(event.peer, event.message, QpcNow(), event.bytes.size());
          },
      .refresh = [this](const RtcEvent& event) { pipeline.RequestRefresh(event); },
      .data_state =
          [this](const RtcEvent& event) {
            if (event.value != 1) {
              input.Stop();
              CloseMenus();
            } else {
              input.Start(event.peer);
              pipeline.Refresh();
              presentation.QueueLayout();
              direct_services.RefreshEditable();
            }
          },
      .received =
          [this](const RtcEvent& event) {
            if (event.message.value("type", Json()) != "input" || !event.trace_input_sequence)
              return;
            RK_SERVER_TRACE(
                trace, "input_dc_received", TraceIds{}, rk_record.qpc = event.received_qpc;
                rk_record.peer = event.peer; rk_record.client_sequence = event.trace_input_sequence;
                DataRouter::Number(event.message, "view", rk_record.view);
                DataRouter::Number(event.message, "instance", rk_record.instance);
                DataRouter::Number(event.message, "document", rk_record.document);
                DataRouter::Number(event.message, "focus", rk_record.focus););
          },
      .send = [this](const Json& message, uint64_t stamp) { Send(message, stamp); }};
}
void ChannelController::Queue(const RtcEvent& event) {
  std::lock_guard lock(event_mutex);
  if (events.size() < 1024)
    events.push_back(event);
}
void ChannelController::QueueMessage(Json message) {
  Queue(RtcEvent{0x10000, message.dump(), "", 0, peer_controller.Handle(), authorization.Stamp()});
}
void ChannelController::Bind(uint64_t handle) {
  control_outbox.Bind({handle, authorization.Stamp()});
}
void ChannelController::CloseMenus() {
  if (!browser.Alive() || !browser.Rpc().Control())
    return;
  auto response = browser.Rpc().Request({{"method", "input"},
                                         {"session", BrowserRuntime::kSessionId},
                                         {"event", {{"type", "menus.close"}}}});
  if (!response)
    fprintf(stderr, "menu cleanup: %s\n", response.error().message.c_str());
}
void ChannelController::Clear() {
  CloseMenus();
  data_router.Clear();
  direct_services.Bind(0);
  control_outbox.Bind({});
  std::lock_guard lock(event_mutex);
  events.clear();
}
void ChannelController::Revoke() {
  direct_services.Bind(0);
  input.Stop();
  CloseMenus();
  control_outbox.Bind({});
}
void ChannelController::Opened(uint64_t handle) {
  input.Start(handle);
  direct_services.Bind(handle, peer_controller.Connection());
  control_outbox.Bind({handle, authorization.Stamp()});
  presentation.QueueLayout();
}
void ChannelController::RefreshEditable() {
  direct_services.RefreshEditable();
}

}  // namespace remotekit
