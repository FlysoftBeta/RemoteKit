#include "runtime_config_fixture.hpp"
#include "rtc/data_router.hpp"
#include "rtc/outbox.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "media/presentation.hpp"
#include "input/input.hpp"
#include "session/session.hpp"
#include "management/methods.hpp"
#include "persistence/session_store.hpp"
#include <cstdlib>
#include <iostream>
#include <vector>

using namespace remotekit;
#define CHECK(value)                             \
  do {                                           \
    if (!(value)) {                              \
      std::cerr << __LINE__ << ": " #value "\n"; \
      std::exit(1);                              \
    }                                            \
  } while (false)

void RouterClassificationAndAdmission() {
  using Kind = DataRouter::Kind;
  const std::vector<std::pair<std::string, Kind>> kinds{{"product.action", Kind::kProduct},
                                                        {"media.presentation", Kind::kPresentation},
                                                        {"presentation.ready", Kind::kPresentation},
                                                        {"input", Kind::kInput},
                                                        {"focus", Kind::kInput},
                                                        {"files.request", Kind::kFiles},
                                                        {"clock.ping", Kind::kClock},
                                                        {"media.feedback", Kind::kFeedback},
                                                        {"media.refresh", Kind::kRefresh}};
  for (const auto& [type, kind] : kinds)
    CHECK(DataRouter::Classify({{"type", type}}).value() == kind);
  CHECK(!DataRouter::Classify(Json::array()));
  CHECK(!DataRouter::Classify({{"type", 7}}));
  CHECK(!DataRouter::Classify({{"type", "unknown"}}));
  Json touch = {{"type", "input"}, {"event", {{"type", "touch"}, {"gestureMode", "client-v1"}}}};
  CHECK(DataRouter::Classify(touch));
  touch["event"]["gestureMode"] = "legacy";
  CHECK(DataRouter::Classify(touch).error().code == ErrorCode::kInvalidRequest);
  touch["event"].erase("gestureMode");
  CHECK(!DataRouter::Classify(touch));
  Json selection = {
      {"type", "input"},
      {"event",
       {{"type", "selection_command"}, {"menu", "18446744073709551615"}, {"command", "copy"}}}};
  CHECK(DataRouter::Classify(selection));
  selection["event"]["menu"] = "01";
  CHECK(!DataRouter::Classify(selection));
  selection["event"]["menu"] = "1";
  selection["event"]["command"] = "delete";
  CHECK(!DataRouter::Classify(selection));
  Json long_press = {{"type", "input"},
                     {"event",
                      {{"type", "gesture"},
                       {"gestureMode", "client-v1"},
                       {"action", "longPress"},
                       {"sequenceId", "touch-1"},
                       {"sampleElapsedUs", 500000},
                       {"x", 10},
                       {"y", 20}}}};
  CHECK(DataRouter::Classify(long_press));
  long_press["event"]["sampleElapsedUs"] = 500000.5;
  CHECK(!DataRouter::Classify(long_press));
  long_press["event"]["sampleElapsedUs"] = 500000;
  long_press["event"].erase("x");
  CHECK(!DataRouter::Classify(long_press));
  uint64_t peer = 7, stamp = 11, epoch = 3;
  std::vector<std::string> dispatched;
  std::vector<Json> replies;
  const auto record = [&](const RtcEvent& event) { dispatched.push_back(event.message["type"]); };
  DataRouter router({.peer = [&] { return peer; },
                     .stamp = [&] { return stamp; },
                     .epoch = [&] { return epoch; },
                     .current =
                         [&](const RtcEvent& event) {
                           return event.peer == peer && stamp && event.authorization == stamp;
                         },
                     .product = record,
                     .presentation = record,
                     .input = record,
                     .files = record,
                     .feedback = record,
                     .refresh = record,
                     .data_state = [](const auto&) {},
                     .received = [](const auto&) {},
                     .send = [&](const Json& reply, uint64_t) { replies.push_back(reply); }});
  const auto receive = [&](Json message) {
    message["authEpoch"] = epoch;
    return router.Receive({0, message.dump(), "", 0, peer});
  };
  CHECK(receive({{"type", "product.action"}}));
  CHECK(dispatched.empty());
  stamp = 12;
  router.Drain();
  CHECK(dispatched.empty());
  CHECK(receive({{"type", "input"}, {"sequence", "4"}}));
  router.Drain();
  CHECK(dispatched == std::vector<std::string>{"input"});
  touch["sequence"] = "5";
  CHECK(!receive(touch));
  router.Drain();
  CHECK(replies.back()["type"] == "input.result");
  CHECK(replies.back()["clientSequence"] == "5");
  CHECK(replies.back()["ok"] == false && replies.back()["error"]["code"] == "invalid_request" &&
        replies.back()["error"]["message"].is_string());
  stamp = 0;
  CHECK(receive({{"type", "media.presentation"}}));
  CHECK(receive({{"type", "product.action"}}));
  router.Drain();
  CHECK(dispatched.back() == "media.presentation" && dispatched.size() == 2);
  stamp = 13;
  CHECK(receive({{"type", "files.request"}}));
  ++peer;
  router.Drain();
  CHECK(dispatched.size() == 2);
  CHECK(DataRouter::Boundary([]() -> Result<void> { throw std::runtime_error("private detail"); })
            .error()
            .message == "internal DataChannel error");
}

void OutboxPriorityAndEpoch() {
  ControlOutbox box;
  const ControlOutbox::Scope first{7, 11}, second{7, 12};
  box.Bind(first);
  bool busy = true;
  std::vector<std::string> sent;
  const auto send = [&](const std::string& bytes) {
    if (busy)
      return 8;
    sent.push_back(bytes);
    return 0;
  };
  box.Transient(first, "critical", send, false);
  box.Replace(first, "mode", "layout", "prepare");
  box.Flush(first, send);
  box.Transient(first, "frame", send);
  CHECK(sent.empty());
  busy = false;
  box.Flush(first, send);
  CHECK((sent == std::vector<std::string>{"mode", "layout", "prepare", "critical"}));
  busy = true;
  box.Transient(first, "obsolete", send, false);
  box.Bind(second);
  box.Transient(first, "late old producer", send, false);
  box.Replace(first, "old mode", "old layout", "old prepare");
  busy = false;
  box.Flush(second, send);
  CHECK(sent.size() == 4);
  box.Transient(second, "new critical", send, false);
  CHECK(sent.back() == "new critical");
}

void PresentationOwnership() {
  ControlOutbox outbox;
  ControlOutbox::Scope scope{7, 11};
  std::vector<Json> sent;
  const auto send = [&](const std::string& bytes) {
    sent.push_back(Json::parse(bytes));
    return 0;
  };
  outbox.Bind(scope);
  PresentationController presentation({.peer = [&] { return scope.peer; },
                                       .scope = [&] { return scope; },
                                       .admitted = [](const auto&) { return true; },
                                       .reset_input = [] {},
                                       .refresh = [] {},
                                       .flush = [&] { outbox.Flush(scope, send); },
                                       .refresh_editable = [] {},
                                       .outbox = [&]() -> ControlOutbox& { return outbox; },
                                       .sampling = [] { return MediaSampling{1280, 720, 1}; }});
  presentation.Bind(scope.peer);
  RtcEvent message{};
  message.peer = scope.peer;
  message.message = {{"type", "media.presentation"}, {"version", 1}, {"backend", "video"}};
  message.bytes = message.message.dump();
  CHECK(presentation.PresentationMessage(message));
  auto frame = std::make_unique<SharedAtlasFrame>();
  frame->generation = 3;
  frame->width_pixels = 1280;
  frame->height_pixels = 720;
  frame->view_count = 1;
  auto& view = frame->views[0];
  view.webview_id = 1;
  view.session_id = 2;
  view.width_pixels = 1280;
  view.height_pixels = 720;
  view.page_device_scale_factor = 1;
  view.atlas_pixels_per_dip = 1;
  const auto epoch = presentation.ObserveLayout(*frame);
  auto layout = presentation.Layout(*frame);
  layout["epoch"] = std::to_string(epoch);
  presentation.PublishLayout(layout, epoch);
  CHECK(presentation.Allows("1", epoch));
  CHECK(!presentation.Snapshot().contains("clientGestures"));
  CHECK(sent[sent.size() - 2]["type"] == "layout");
  CHECK(sent.back()["type"] == "presentation.prepare");
  bool published = false;
  presentation.Send(scope.peer, epoch, true, [&] {
    published = true;
    return true;
  });
  CHECK(!published);
  message.message = sent.back();
  message.message["type"] = "presentation.ready";
  message.bytes = message.message.dump();
  CHECK(presentation.PresentationMessage(message));
  presentation.Send(scope.peer, epoch, true, [&] {
    published = true;
    return true;
  });
  CHECK(published);
  ++scope.authorization;
  outbox.Bind(scope);
  presentation.QueueLayout();
  CHECK(sent[sent.size() - 2]["type"] == "presentation.mode");
  CHECK(sent.back()["type"] == "layout");
  presentation.InvalidateLayout("reconfigure");
  CHECK(presentation.Epoch() > epoch && !presentation.Allows("1", epoch));
}

void AuthorizationTokens() {
  media::Sdk sdk;
  sdk.remotekit_rtc_set_media_authorized = [](uint64_t, int) { return 0; };
  uint64_t peer = 7;
  unsigned revoked = 0, opened = 0;
  AuthorizationController auth(sdk, {.peer = [&] { return peer; },
                                     .connection = [] { return "connection"; },
                                     .files_closed = [] {},
                                     .revoked = [&] { ++revoked; },
                                     .wake = [] {},
                                     .opened = [&](uint64_t) { ++opened; },
                                     .files_opened = [](uint64_t) {}});
  auth.Bind();
  Json request = {{"connectionId", "connection"}, {"epoch", uint64_t(1)}, {"unlocked", true}};
  CHECK(auth.Authorize(request, 9, [] { return true; }));
  const auto token = auth.Admit();
  CHECK(auth.Current(token));
  CHECK(auth.Authorize(request, 9, [] { return true; }));
  CHECK(opened == 1);
  CHECK(auth.ManagementLost(8));
  CHECK(auth.Current(token));
  CHECK(auth.ManagementLost(9));
  CHECK(!auth.Current(token));
  request["epoch"] = uint64_t(2);
  CHECK(auth.Authorize(request, 10, [] { return true; }));
  CHECK(!auth.Current(token));
  const auto replacement = auth.Admit();
  CHECK(auth.Current(replacement));
  ++peer;
  CHECK(!auth.Current(replacement));
  auth.Close();
  CHECK(!auth.Stamp() && revoked >= 3);
}

struct PeerFixture {
  int fail = 0, closes = 0, stops_with_handle = 0;
  remotekit_rtc_options config{};
  std::vector<std::string> calls;
  bool av_sync = false, audio = true;
};

void SessionManagementRequests() {
  class Link final : public ManagementLink {
   public:
    bool Next(std::string&, uint64_t&, bool&) override { return false; }
    bool Current(uint64_t) override { return true; }
    bool SendReply(uint64_t, const Json&) override { return true; }
    bool SendEvent(const Json&, uint64_t) override { return true; }
    void OnDisconnect(Disconnect) override {}
    Result<Json> Request(const std::string&, Json) override {
      return Error{ErrorCode::kUnavailable, "test Control has no object responder"};
    }
  } link;
  const auto directory = fs::temp_directory_path() /
                         ("remotekit-media-policy-" + std::to_string(GetCurrentProcessId()) + "-" +
                          std::to_string(GetTickCount64()));
  struct Cleanup {
    fs::path directory;
    ~Cleanup() {
      std::error_code ignored;
      fs::remove_all(directory, ignored);
    }
  } cleanup{directory};
  auto parsed = RuntimeOptions::FromConfig(TestConfig(), directory, "dev", "test");
  CHECK(parsed);
  media::Sdk sdk;
  objects::ObjectService objects(parsed.value().data, link, cluster::Key{}, "test", "dev");
  Session session(sdk, parsed.value(), "tenant", "0123456789abcdef0123456789abcdef", 1,
                  cluster::Key{}, link, objects, objects::Keys{});
  const auto session_directory = parsed.value().data / "sessions" / session.Id();
  fs::create_directories(session_directory);
  CHECK(SessionStore(session_directory).Save("views.json", Json::array({Json{{"viewId", "1"}}})));
  CHECK(session.Views().Initialize());
  auto app_info = ManagementMethods::Find("view.appInfo");
  CHECK(app_info);
  const auto unknown_view = app_info(session, {{"viewId", "2"}});
  CHECK(!unknown_view && unknown_view.error().code == ErrorCode::kNotFound);
  const auto offline_view = app_info(session, {{"viewId", "1"}});
  CHECK(!offline_view && offline_view.error().code == ErrorCode::kUnavailable);
  CHECK(!session.Snapshot().value().at("running").get<bool>());
  for (const auto* field : {"cookies", "localStorage"}) {
    for (const auto& invalid : {Json(), Json(0), Json("array"), Json::object()}) {
      Json request = {{"cookies", Json::array()}, {"localStorage", Json::array()}};
      request[field] = invalid;
      auto result = session.Views().ManageSessionStorageImport(request);
      CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
    }
    Json missing = {{"cookies", Json::array()}, {"localStorage", Json::array()}};
    missing.erase(field);
    CHECK(session.Views().ManageSessionStorageImport(missing).error().code ==
          ErrorCode::kInvalidRequest);
  }
  for (const auto* field : {"job", "browserIncarnation"}) {
    Json missing = {{"job", "1"}, {"browserIncarnation", "old"}};
    missing.erase(field);
    CHECK(session.Views().ManageSessionStorageImportStatus(missing).error().code ==
          ErrorCode::kInvalidRequest);
    Json invalid = {{"job", "1"}, {"browserIncarnation", "old"}};
    invalid[field] = 1;
    CHECK(session.Views().ManageSessionStorageImportStatus(invalid).error().code ==
          ErrorCode::kInvalidRequest);
  }
  const auto stale = session.Views().ManageSessionStorageImportStatus(
      {{"job", "1"}, {"browserIncarnation", "old"}});
  CHECK(!stale && stale.error().code == ErrorCode::kConflict &&
        stale.error().message == "stale_browser_incarnation");
  const Json request = {{"maxFps", 30}, {"degradationPreference", "balanced"}, {"audio", false}};
  CHECK(session.Media().ManageSessionMediaPolicy(request));
  CHECK(!session.Media().Audio());
  CHECK(session.Media().Snapshot().at("mediaPolicy").at("requested") == request);
  for (const auto& invalid : {Json(), Json(0), Json("false"), Json::object()}) {
    auto bad = request;
    bad["audio"] = invalid;
    auto result = session.Media().ManageSessionMediaPolicy(bad);
    CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
    CHECK(!session.Media().Audio());
  }
  auto missing = request;
  missing.erase("audio");
  auto result = session.Media().ManageSessionMediaPolicy(missing);
  CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
  auto enabled = request;
  enabled["audio"] = true;
  CHECK(session.Media().ManageSessionMediaPolicy(enabled));
  CHECK(session.Media().Audio());
  for (const auto& invalid : {Json(), Json(0), Json("false")}) {
    auto bad = Json{{"connectionId", "connection"}, {"sdp", "offer"}, {"avSync", invalid}};
    auto rejected = session.Channel().ManageRtcOffer(bad);
    CHECK(!rejected && rejected.error().code == ErrorCode::kInvalidRequest);
  }
  CHECK(session.Channel()
            .ManageRtcOffer({{"connectionId", "connection"}, {"sdp", "offer"}})
            .error()
            .code == ErrorCode::kInvalidRequest);
}

void PeerFailureCleanup() {
  static PeerFixture* active;
  PeerFixture fixture;
  active = &fixture;
  media::Sdk sdk;
  sdk.remotekit_rtc_create = [](const remotekit_rtc_options* config, uint64_t* handle) {
    active->config = *config;
    *handle = 17;
    return active->fail == 1 ? 1 : 0;
  };
  sdk.remotekit_rtc_close = [](uint64_t) {
    ++active->closes;
    return 0;
  };
  sdk.remotekit_rtc_set_av_sync = [](uint64_t, int synced) {
    active->calls.push_back("avSync");
    active->av_sync = synced;
    return active->fail == 8 ? 1 : 0;
  };
  sdk.remotekit_rtc_set_audio_enabled = [](uint64_t, int enabled) {
    active->calls.push_back("audio");
    active->audio = enabled;
    return active->fail == 9 ? 1 : 0;
  };
  sdk.remotekit_rtc_set_degradation_preference = [](uint64_t, uint32_t) {
    return active->fail == 2 ? 1 : 0;
  };
  sdk.remotekit_rtc_set_source_max_fps = [](uint64_t, uint32_t) {
    return active->fail == 3 ? 1 : 0;
  };
  sdk.remotekit_rtc_set_playout_delay = [](uint64_t, int32_t, int32_t) {
    return active->fail == 4 ? 1 : 0;
  };
  sdk.remotekit_rtc_set_remote_description = [](uint64_t, int, const char*, size_t) {
    active->calls.push_back("remote");
    return active->fail == 5 ? 1 : 0;
  };
  sdk.remotekit_rtc_get_receive_level = [](uint64_t, uint32_t* level) {
    *level = 31;
    return active->fail == 6 ? 1 : 0;
  };
  auto parsed = RuntimeOptions::FromConfig(TestConfig(), fs::current_path(), "dev", "test");
  CHECK(parsed);
  const auto options = std::move(parsed).value();
  PeerController* owner = nullptr;
  std::vector<std::pair<uint64_t, Json>> signals;
  std::vector<RtcEvent> events;
  PeerController controller(
      sdk, options,
      {.bind = [](uint64_t, uint64_t) {},
       .started = [](uint64_t, const std::string&) -> Result<void> {
         if (active->fail == 7)
           return Error{ErrorCode::kUnavailable, "resource unavailable"};
         return {};
       },
       .stopping =
           [&] {
             if (owner->Handle())
               ++fixture.stops_with_handle;
           },
       .drained = [] {},
       .event = [&](const auto& event) { events.push_back(event); },
       .signal = [&](uint64_t generation,
                     const Json& signal) { signals.emplace_back(generation, signal); }});
  owner = &controller;
  Json offer = {{"connectionId", "connection"}, {"sdp", "video offer"}};
  for (int stage = 1; stage <= 9; ++stage) {
    fixture.fail = stage;
    CHECK(!controller.Offer(offer, 3, 60, 0, false, true));
    CHECK(fixture.closes == stage && fixture.stops_with_handle == stage);
    CHECK(controller.GetState() == PeerController::State::kNone);
    CHECK(!controller.Handle() && !controller.DataOpen() && controller.Connection().empty());
  }
  fixture.fail = 0;
  fixture.calls.clear();
  auto accepted = controller.Offer(offer, 3, 60, 0, false, true);
  CHECK(accepted && accepted.value().at("avSync") == true);
  CHECK((fixture.calls == std::vector<std::string>{"avSync", "audio", "remote"}));
  CHECK(fixture.av_sync && !fixture.audio && controller.AvSync());
  CHECK(controller.Policy(30, 0, true));
  CHECK(fixture.audio);
  CHECK(controller.GetState() == PeerController::State::kNegotiating);
  fixture.config.event(fixture.config.context, 17, REMOTEKIT_RTC_STATE, nullptr, 0, nullptr, 2);
  CHECK(controller.Connected());
  CHECK(events.back().connection_changed);
  fixture.config.event(fixture.config.context, 17, REMOTEKIT_RTC_STATE, nullptr, 0, nullptr, 2);
  CHECK(!events.back().connection_changed);
  fixture.config.event(fixture.config.context, 17, REMOTEKIT_RTC_STATE, nullptr, 0, nullptr, 1);
  CHECK(events.back().connection_changed && !controller.Connected());
  fixture.config.event(fixture.config.context, 17, REMOTEKIT_RTC_STATE, nullptr, 0, nullptr, 2);
  CHECK(events.back().connection_changed && controller.Connected());
  fixture.config.event(fixture.config.context, 17, REMOTEKIT_RTC_DATA_STATE, nullptr, 0, nullptr,
                       1);
  CHECK(controller.DataOpen());
  fixture.config.event(fixture.config.context, 17, REMOTEKIT_RTC_ICE_COMPLETE, nullptr, 0, nullptr,
                       0);
  CHECK(signals.empty());
  controller.FlushSignals();
  CHECK(signals.size() == 1 && signals[0].first == 3 && signals[0].second["type"] == "complete");
  controller.Close();
  CHECK(fixture.closes == 10 && fixture.stops_with_handle == 10);
  accepted = controller.Offer(offer, 3, 60, 0, true, false);
  CHECK(accepted && accepted.value().at("avSync") == false);
  CHECK(!fixture.av_sync && fixture.audio && !controller.AvSync());
  controller.Close();
  CHECK(fixture.closes == 11 && fixture.stops_with_handle == 11);
}

void OrderedTouchInput() {
  std::mutex mutex;
  std::condition_variable wake;
  std::vector<Json> replies, dispatched;
  std::atomic<unsigned> input_calls{0};
  InputController controller(
      "1", {.control = [] { return 3; },
            .input_stamp = [] { return 2; },
            .epoch = [] { return 5; },
            .admitted = [](const auto&) { return true; },
            .admission = [] { return AuthorizationController::AdmissionToken{1, 2, 1}; },
            .revalidate = [](const auto&) { return true; },
            .allows = [](const auto&, uint64_t) { return true; },
            .rpc = [&](Json request, uint64_t, uint32_t, bool,
                       const std::function<bool()>&) -> Result<Json> {
              CHECK(request.at("method") == "input");
              ++input_calls;
              dispatched.push_back(request);
              if (input_calls == 1)
                return Json{{"ok", false}, {"code", 6}, {"inputAdmitted", false}};
              return Json{{"ok", true}, {"inputAdmitted", true}};
            },
            .send =
                [&](const Json& reply, uint64_t) {
                  std::lock_guard lock(mutex);
                  replies.push_back(reply);
                  wake.notify_all();
                },
            .failed = [] { CHECK(false); },
            .trace = [] { return std::shared_ptr<media::ServerTrace>(); }});
  controller.Start(1);
  uint64_t serial = 0;
  const auto touch = [&](const char* sequence, const char* action, const char* epoch = "5") {
    RtcEvent event{};
    event.peer = 1;
    event.authorization = 2;
    event.message = {{"type", "input"},
                     {"session", "1"},
                     {"view", "2"},
                     {"instance", "3"},
                     {"document", "4"},
                     {"focus", "5"},
                     {"layoutEpoch", epoch},
                     {"sequence", std::to_string(++serial)},
                     {"event",
                      {{"type", "touch"},
                       {"gestureMode", "client-v1"},
                       {"sequenceId", sequence},
                       {"action", action}}}};
    controller.QueueInput(event);
  };
  touch("old", "start");
  touch("old", "end", "4");
  touch("next", "start");
  touch("next", "end");
  {
    std::unique_lock lock(mutex);
    CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return replies.size() == 4; }));
  }
  controller.Stop();
  CHECK(dispatched.size() == 4 && dispatched[0] == dispatched[1]);
  CHECK(dispatched[2].at("event").at("sequenceId") == "next");
  CHECK(dispatched[3].at("event").at("action") == "end");
  CHECK(replies[0].at("ok") == true);
  CHECK(replies[1].at("error").at("message") == "stale_layout_epoch");
  CHECK(replies[2].at("ok") == true && replies[3].at("ok") == true);
  for (size_t index = 0; index < replies.size(); ++index) {
    CHECK(replies[index].at("type") == "input.result");
    CHECK(replies[index].at("clientSequence") == std::to_string(index + 1));
    CHECK(!replies[index].contains("touchState"));
  }
  CHECK(controller.Snapshot().at("inputBusyRetries") == 1);
}

int main() {
  RouterClassificationAndAdmission();
  OutboxPriorityAndEpoch();
  PresentationOwnership();
  AuthorizationTokens();
  SessionManagementRequests();
  PeerFailureCleanup();
  OrderedTouchInput();
}
