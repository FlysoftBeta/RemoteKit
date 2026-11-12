#include "runtime_config_fixture.hpp"
#include "rtc/data_router.hpp"
#include "rtc/outbox.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "media/presentation.hpp"
#include "input/input.hpp"
#include "input/wire_validation.hpp"
#include "session/session.hpp"
#include "session/signin.hpp"
#include "management/methods.hpp"
#include "persistence/durable_json.hpp"
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
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
  const std::vector<std::pair<std::string, Kind>> kinds{{"media.presentation", Kind::kPresentation},
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
  Json dismiss = {{"type", "editing.dismiss"}, {"target", "5"}, {"revision", "7"}};
  CHECK(DataRouter::Classify(dismiss).value() == Kind::kInput);
  dismiss["target"] = "01";
  CHECK(!DataRouter::Classify(dismiss));
  dismiss["target"] = "5";
  dismiss["revision"] = "0";
  CHECK(!DataRouter::Classify(dismiss));
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
  selection["event"]["command"] = "contextMenu";
  CHECK(DataRouter::Classify(selection));
  Json context_command = selection;
  context_command["event"]["type"] = "context_command";
  for (const auto* command : {"undo", "redo", "cut", "copy", "paste", "selectAll",
                              "copyLinkAddress", "copyImage", "copyImageAddress", "dismiss"}) {
    context_command["event"]["command"] = command;
    CHECK(DataRouter::Classify(context_command));
  }
  context_command["event"]["menu"] = "0";
  CHECK(!DataRouter::Classify(context_command));
  context_command["event"]["menu"] = "01";
  CHECK(!DataRouter::Classify(context_command));
  context_command["event"]["menu"] = "18446744073709551616";
  CHECK(!DataRouter::Classify(context_command));
  context_command["event"]["menu"] = "1";
  context_command["event"]["command"] = "contextMenu";
  CHECK(!DataRouter::Classify(context_command));
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
  CHECK(receive({{"type", "clock.ping"}}));
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
  CHECK(receive({{"type", "clock.ping"}}));
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
  const std::vector<std::pair<std::function<void()>, std::string>> invalid_arguments{
      {[] { Required(Json::object(), "name"); }, "required string: name"},
      {[] { Required({{"name", nullptr}}, "name"); }, "required string: name"},
      {[] { ViewId({{"viewId", "01"}}); }, "viewId must be nonzero uint64 decimal"},
      {[] { DecodedSize("!"); }, "invalid navigation base64"},
      {[] { LibraryController::FileUnsigned(nullptr); }, "invalid_file_integer"}};
  for (const auto& [operation, message] : invalid_arguments) {
    const auto result = DataRouter::Boundary([&]() -> Result<void> {
      operation();
      return {};
    });
    CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
    CHECK(result.error().message == message);
  }
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
  const auto messages = sent.size();
  view.page_height_dip = 360;
  view.occlusion_revision = 2;
  CHECK(presentation.ObserveLayout(*frame) == epoch);
  auto occluded = presentation.Layout(*frame);
  occluded["epoch"] = std::to_string(epoch);
  CHECK(occluded == presentation.Snapshot());
  published = false;
  CHECK(presentation.Send(scope.peer, epoch, false, [&] {
    published = true;
    return true;
  }));
  CHECK(published && sent.size() == messages && presentation.Allows("1", epoch));
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
  for (const auto* field : {"epoch", "unlocked"}) {
    auto invalid = request;
    invalid.erase(field);
    CHECK(auth.Authorize(invalid, 9, [] { return true; }).error().code ==
          ErrorCode::kInvalidRequest);
    invalid[field] = nullptr;
    CHECK(auth.Authorize(invalid, 9, [] { return true; }).error().code ==
          ErrorCode::kInvalidRequest);
    CHECK(opened == 0 && revoked == 0);
  }
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
    bool SendEvent(const Json&, uint64_t, remotekit::DeliveryFlag delivery = {}) override {
      if (delivery)
        delivery->MarkWritten();
      return true;
    }
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
                  cluster::Key{}, link, objects);
  const auto session_directory = parsed.value().data / "sessions" / session.Id();
  fs::create_directories(session_directory);
  CHECK(session.Initialize());
  SessionDb persisted(session_directory);
  CHECK(persisted.Open());
  const Json valid_views = Json::array({Json{{"viewId", "1"}}});
  CHECK(persisted.Views().Save(valid_views));
  CHECK(session.Views().Initialize());
  for (const auto& invalid : {Json::array({nullptr}), Json::array({{{"viewId", "01"}}}),
                              Json::array({{{"viewId", "1"}, {"device", nullptr}}})}) {
    CHECK(!persisted.Views().Save(invalid));
    CHECK(persisted.Views().Load().value() == valid_views);
    CHECK(session.Views().Contains("1"));
  }
  const Json handler = {
      {"protocol", "web+notes"}, {"url", "https://example.test/open?url=%s"}, {"allowed", true}};
  const Json site = {{"tabletUa", true},
                     {"permissions",
                      {{"geolocation", "allow"},
                       {"clipboard_read", "allow"},
                       {"local_fonts", "allow"},
                       {"window_management", "block"},
                       {"midi_sysex", "allow"},
                       {"idle_detection", "block"}}},
                     {"protocolHandlers", Json::array({handler})}};
  const Json preferences = {{"sites", {{"https://example.test", site}}}};
  CHECK(session.Views().ApplySitePreferences(preferences));
  CHECK(!fs::exists(session_directory / "site-preferences.json"));
  auto normalized_handler = handler;
  normalized_handler["url"] = "HTTPS://EXAMPLE.TEST:443/?%s";
  CHECK(session.Views().ApplySitePreferences(
      {{"sites",
        {{"https://example.test", {{"protocolHandlers", Json::array({normalized_handler})}}}}}}));
  const Json local_handler = {
      {"protocol", "mailto"}, {"url", "http://localhost:8080/?%s"}, {"allowed", false}};
  const Json local_site = {{"protocolHandlers", Json::array({local_handler})}};
  CHECK(session.Views().ApplySitePreferences({{"sites", {{"http://localhost:8080", local_site}}}}));
  CHECK(session.Views().ApplySitePreferences({{"sites",
                                               {{"http://127.0.0.1", {{"tabletUa", true}}},
                                                {"https://[::1]:8443", {{"tabletUa", true}}}}}}));
  const auto invalid_preferences = [&](const Json& request) {
    const auto result = session.Views().ApplySitePreferences(request);
    CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
  };
  invalid_preferences(Json::object());
  invalid_preferences({{"sites", Json::array()}});
  invalid_preferences({{"sites", Json::object()}, {"extra", true}});
  for (const auto* origin :
       {"https://example.test/path", "https://example.test/", "https://EXAMPLE.test",
        "https://example.test:443", "http://example.test:80", "https://user@example.test",
        "https://example.test:99999", "file://example.test", "https://127.1", "https://[not-ip]"})
    invalid_preferences({{"sites", {{origin, site}}}});
  invalid_preferences({{"sites", {{"https://" + std::string(2048, 'a'), site}}}});
  for (const auto& invalid :
       {Json(), Json(false), Json::array(), Json::object(), Json{{"unknown", true}},
        Json{{"tabletUa", false}}, Json{{"tabletUa", 1}}, Json{{"permissions", Json::object()}},
        Json{{"permissions", Json::array()}}, Json{{"permissions", {{"camera", "allow"}}}},
        Json{{"permissions", {{"notifications", "allow"}}}},
        Json{{"permissions", {{"geolocation", "ask"}}}},
        Json{{"permissions", {{"geolocation", true}}}}, Json{{"protocolHandlers", Json::array()}},
        Json{{"protocolHandlers", Json::object()}},
        Json{{"protocolHandlers", Json::array({Json::object()})}}})
    invalid_preferences({{"sites", {{"https://example.test", invalid}}}});
  for (const auto* key : {"protocol", "url", "allowed"}) {
    auto missing = handler;
    missing.erase(key);
    invalid_preferences(
        {{"sites", {{"https://example.test", {{"protocolHandlers", Json::array({missing})}}}}}});
    auto wrong = handler;
    wrong[key] = 1;
    invalid_preferences(
        {{"sites", {{"https://example.test", {{"protocolHandlers", Json::array({wrong})}}}}}});
  }
  for (const auto* protocol : {"https", "web+", "web+Notes", "web+notes1", "mailto:"}) {
    auto wrong = handler;
    wrong["protocol"] = protocol;
    invalid_preferences(
        {{"sites", {{"https://example.test", {{"protocolHandlers", Json::array({wrong})}}}}}});
  }
  for (const auto& url :
       {std::string("https://other.test/?%s"), std::string("https://example.test.evil/?%s"),
        std::string("https://example.test@evil.test/?%s"),
        std::string("https://example.test/no-placeholder"), std::string("http://example.test/?%s"),
        std::string("/relative?%s"), std::string("https://example.test/\n?%s"),
        std::string("https://example.test/") + std::string(2048, 'a') + "%s"}) {
    auto wrong = handler;
    wrong["url"] = url;
    invalid_preferences(
        {{"sites", {{"https://example.test", {{"protocolHandlers", Json::array({wrong})}}}}}});
  }
  auto extra_handler = handler;
  extra_handler["extra"] = true;
  invalid_preferences(
      {{"sites",
        {{"https://example.test", {{"protocolHandlers", Json::array({extra_handler})}}}}}});
  Json too_many = Json::array();
  for (int i = 0; i < 33; ++i)
    too_many.push_back(handler);
  invalid_preferences({{"sites", {{"https://example.test", {{"protocolHandlers", too_many}}}}}});
  Json many_sites = Json::object();
  for (int i = 0; i < 4097; ++i)
    many_sites["https://site" + std::to_string(i) + ".test"] = {{"tabletUa", true}};
  invalid_preferences({{"sites", many_sites}});
  CHECK(session.Views().ApplySitePreferences({{"sites", Json::object()}}));
  auto app_info = ManagementMethods::Find("view.appInfo");
  CHECK(app_info);
  const auto unknown_view = app_info(session, {{"viewId", "2"}});
  CHECK(!unknown_view && unknown_view.error().code == ErrorCode::kNotFound);
  const auto offline_view = app_info(session, {{"viewId", "1"}});
  CHECK(!offline_view && offline_view.error().code == ErrorCode::kUnavailable);
  CHECK(!session.Snapshot().value().at("running").get<bool>());
  for (const auto* field : {"cookies", "localStorage"}) {
    for (const auto& invalid : {Json(), Json(0), Json("array"), Json::object()}) {
      Json request = {
          {"importId", "record:0"}, {"cookies", Json::array()}, {"localStorage", Json::array()}};
      request[field] = invalid;
      auto result = session.Views().ManageSessionStorageImport(request);
      CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
    }
    Json missing = {
        {"importId", "record:0"}, {"cookies", Json::array()}, {"localStorage", Json::array()}};
    missing.erase(field);
    CHECK(session.Views().ManageSessionStorageImport(missing).error().code ==
          ErrorCode::kInvalidRequest);
  }
  for (const auto& value : {Json(), Json(1), Json(""), Json(std::string(129, 'x'))}) {
    CHECK(session.Views().ManageSessionStorageImportStatus({{"importId", value}}).error().code ==
          ErrorCode::kInvalidRequest);
  }
  CHECK(session.Views().ManageSessionStorageImportStatus(Json::object()).error().code ==
        ErrorCode::kInvalidRequest);
  CHECK(session.Views().ManageSessionStorageImportStatus({{"importId", "record:0"}}).error().code ==
        ErrorCode::kNotFound);
  const Json request = {{"maxFps", 30}, {"degradationPreference", "balanced"}, {"audio", false}};
  CHECK(session.Media().ApplyMediaPolicy(request));
  CHECK(!session.Media().Audio());
  CHECK(session.Media().Snapshot().at("mediaPolicy").at("requested") == request);
  for (const auto& invalid : {Json(), Json(0), Json("false"), Json::object()}) {
    auto bad = request;
    bad["audio"] = invalid;
    auto result = session.Media().ApplyMediaPolicy(bad);
    CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
    CHECK(!session.Media().Audio());
  }
  auto missing = request;
  missing.erase("audio");
  auto result = session.Media().ApplyMediaPolicy(missing);
  CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
  missing = request;
  missing.erase("maxFps");
  result = session.Media().ApplyMediaPolicy(missing);
  CHECK(!result && result.error().code == ErrorCode::kInvalidRequest);
  CHECK(result.error().message == "invalid media policy maxFps");
  auto enabled = request;
  enabled["audio"] = true;
  CHECK(session.Media().ApplyMediaPolicy(enabled));
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
  auto download_store = persisted.Downloads();
  CHECK(download_store.Save({{"records", Json::array({{
                                             {"eventId", "download-test"},
                                             {"incarnation", "browser"},
                                             {"download",
                                              {{"guid", "guid"},
                                               {"eventId", "event"},
                                               {"fileReference", "downloads/page.txt"},
                                               {"name", "page.txt"},
                                               {"mimeType", "text/plain"},
                                               {"size", "8"},
                                               {"origin", ""}}},
                                         }})}}));
  CHECK(session.Views().Initialize());
  CHECK(session.Snapshot().value().at("stopBlockers").at("pendingDownloadImports") == 1);
  CHECK(session.StopAndCommit("controller-test").error().message ==
        "stop blocked: pendingDownloadImports");
  CHECK(session.Shutdown().error().code == ErrorCode::kConflict);
  CHECK(download_store.Save({{"records", Json::array()}}));
  CHECK(session.Views().Initialize());
  CHECK(session.Snapshot().value().at("stopBlockers").at("pendingDownloadImports") == 0);
  const Json imported = {{"type", "download.imported"},
                         {"eventId", "download-test"},
                         {"assetId", std::string(64, 'a')},
                         {"name", "page.txt"},
                         {"mimeType", "text/plain"},
                         {"size", "8"},
                         {"origin", ""}};
  CHECK(download_store.Save({{"records", Json::array({{{"eventId", "download-test"},
                                                       {"incarnation", "browser"},
                                                       {"download",
                                                        {{"guid", "guid"},
                                                         {"eventId", "event"},
                                                         {"fileReference", "downloads/page.txt"},
                                                         {"name", "page.txt"},
                                                         {"mimeType", "text/plain"},
                                                         {"size", "8"},
                                                         {"origin", ""}}},
                                                       {"result", imported}}})}}));
  CHECK(session.Views().Initialize());
  CHECK(download_store.Complete("download-test"));
  CHECK(session.PendingEvents().value().size() == 1);
  const auto event_state = session.EventState().value();
  CHECK(session.AcknowledgeEvents(event_state.at("streamId"),
                                  std::stoull(event_state.at("lastSeq").get<std::string>())));
  CHECK(download_store.Load().value().at("records").empty());
  CHECK(session.PendingEvents().value().empty());
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
  CHECK(controller.ReplaySignals("connection", 4));
  controller.FlushSignals();
  CHECK(signals.size() == 2 && signals.back().first == 4 &&
        signals.back().second["type"] == "complete");
  CHECK(!controller.ReplaySignals("replaced", 4));
  CHECK(fixture.closes == 9);
  controller.Close();
  CHECK(!controller.ReplaySignals("connection", 4));
  CHECK(fixture.closes == 10 && fixture.stops_with_handle == 10);
  accepted = controller.Offer(offer, 3, 60, 0, true, false);
  CHECK(accepted && accepted.value().at("avSync") == false);
  CHECK(!fixture.av_sync && fixture.audio && !controller.AvSync());
  controller.Close();
  CHECK(fixture.closes == 11 && fixture.stops_with_handle == 11);
  sdk.remotekit_rtc_get_receive_level = [](uint64_t, uint32_t* level) {
    *level = 0;
    return 0;
  };
  unsigned started = 0;
  PeerController service(sdk, options,
                         {.bind = [](uint64_t, uint64_t) {},
                          .started = [&](uint64_t, const std::string&) -> Result<void> {
                            ++started;
                            return {};
                          },
                          .stopping = [] {},
                          .drained = [] {},
                          .event = [](const RtcEvent&) {},
                          .signal = [](uint64_t, const Json&) {}},
                         PeerController::Role::kService);
  fixture.calls.clear();
  CHECK(service.Offer({{"connectionId", "service"}, {"sdp", "data-only offer"}}, 3, 60, 0, false,
                      false));
  CHECK(started == 1 && service.ReceiveLevel() == 0);
  CHECK((fixture.calls == std::vector<std::string>{"avSync", "remote"}));
  CHECK(fixture.config.encoder.create(fixture.config.context, service.Handle(), 1) ==
        REMOTEKIT_SDK_INVALID_STATE);
  service.Close();
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
                return Json{{"ok", false},
                            {"error", {{"code", "busy"}, {"message", "Input queue full"}}},
                            {"inputAdmitted", false}};
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

void DismissalDuringLayout() {
  std::mutex mutex;
  std::condition_variable wake;
  std::vector<Json> replies;
  Json dispatched;
  InputController controller(
      "1", {.control = [] { return 3; },
            .input_stamp = [] { return 0; },
            .epoch = [] { return 9; },
            .admitted = [](const auto&) { return true; },
            .admission = [] { return AuthorizationController::AdmissionToken{1, 2, 1}; },
            .revalidate = [](const auto&) { return true; },
            .allows = [](const auto&, uint64_t) { return false; },
            .rpc = [&](Json request, uint64_t, uint32_t, bool,
                       const std::function<bool()>& admitted) -> Result<Json> {
              CHECK(admitted());
              dispatched = std::move(request);
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
  RtcEvent event{};
  event.peer = 1;
  event.authorization = 2;
  event.message = {
      {"type", "editing.dismiss"}, {"session", "1"}, {"view", "2"},     {"instance", "3"},
      {"document", "4"},           {"focus", "5"},   {"sequence", "1"}, {"layoutEpoch", "1"},
      {"outputGeneration", "7"},   {"target", "8"},  {"revision", "9"}};
  controller.QueueInput(event);
  {
    std::unique_lock lock(mutex);
    CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return replies.size() == 1; }));
    CHECK(replies.back().at("ok") == true);
    CHECK(dispatched.at("method") == "input" && dispatched.at("sequence") == "1");
    CHECK(!dispatched.contains("output_generation") && !dispatched.contains("layoutEpoch"));
    CHECK(dispatched.at("event") ==
          Json({{"type", "editing.dismiss"}, {"target", "8"}, {"revision", "9"}}));
  }
  controller.QueueInput(event);
  {
    std::unique_lock lock(mutex);
    CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return replies.size() == 2; }));
    CHECK(replies.back().at("error").at("code") == "conflict");
  }
  event.message["sequence"] = "2";
  event.message["session"] = "other";
  controller.QueueInput(event);
  {
    std::unique_lock lock(mutex);
    CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return replies.size() == 3; }));
    CHECK(replies.back().at("error").at("code") == "forbidden");
  }
  controller.Stop();
}
void ClipboardSynchronization() {
  uint64_t sequence = 0;
  std::string incarnation = "browser";
  bool ready = false, reject = false, copy_after_write = false;
  Json contents{{"baseRevision", "0"}, {"text", ""}, {"html", ""}};
  std::vector<Json> events;
  unsigned writes = 0;
  ClipboardController clipboard(
      "tenant", "session",
      {
          .ready = [&] { return ready; },
          .incarnation = [&] { return incarnation; },
          .read = [&]() -> Result<Json> {
            auto value = contents;
            value["sequence"] = std::to_string(sequence);
            return value;
          },
          .write = [&](const Json& value) -> Result<Json> {
            ++writes;
            contents = {{"baseRevision", value["revision"]},
                        {"text", value["text"]},
                        {"html", value["html"]}};
            Json result{{"sequence", std::to_string(sequence)},
                        {"baseRevision", value["revision"]}};
            if (copy_after_write) {
              copy_after_write = false;
              ++sequence;
              contents["text"] = "copied after write";
            }
            return result;
          },
          .sequence = [&]() -> std::optional<uint64_t> { return sequence; },
          .send =
              [&](const Json& event) {
                if (reject)
                  return false;
                events.push_back(event);
                return true;
              },
      });
  CHECK(clipboard.Seed({{"revision", "7"}, {"text", "seed"}, {"html", ""}}));
  CHECK(writes == 0);
  ready = true;
  CHECK(clipboard.BeforeViews());
  CHECK(writes == 1 && contents["baseRevision"] == "7");
  CHECK(clipboard.BeforeViews());
  CHECK(writes == 1);
  ++sequence;
  contents["text"] = "native";
  CHECK(clipboard.Poll());
  CHECK(events.size() == 1 && events.back()["baseRevision"] == "7");
  ++sequence;
  contents["text"] = "concurrent native";
  CHECK(clipboard.Write({{"revision", "8"}, {"text", "device"}, {"html", ""}}));
  CHECK(events.size() == 2 && events.back()["text"] == "concurrent native" &&
        events.back()["baseRevision"] == "7");
  CHECK(contents["text"] == "device" && contents["baseRevision"] == "8");
  copy_after_write = true;
  CHECK(clipboard.Write({{"revision", "9"}, {"text", "device next"}, {"html", ""}}));
  CHECK(clipboard.Poll());
  CHECK(events.size() == 3 && events.back()["text"] == "copied after write" &&
        events.back()["baseRevision"] == "9");
  ++sequence;
  contents["text"] = "durable outbox retry";
  reject = true;
  CHECK(!clipboard.Poll());
  reject = false;
  CHECK(clipboard.Poll());
  CHECK(events.size() == 4 && events.back()["text"] == "durable outbox retry");
  CHECK(!clipboard.Seed({{"revision", "8"}, {"text", "old"}, {"html", ""}}));
  CHECK(!clipboard.Seed({{"revision", "9"}, {"text", "conflicting"}, {"html", ""}}));
  incarnation = "replacement";
  sequence = 0;
  contents = {{"baseRevision", "0"}, {"text", ""}, {"html", ""}};
  CHECK(clipboard.BeforeViews());
  CHECK(contents["baseRevision"] == "9" && contents["text"] == "device next");
  ++sequence;
  contents["text"] = std::string(1024 * 1024, '\x01');
  CHECK(clipboard.Poll());
  CHECK(events.back()["oversize"] == true && events.back()["baseRevision"] == "9");
  for (const auto* invalid : {"01", "-1", "18446744073709551616"})
    CHECK(!ClipboardController::Valid({{"revision", invalid}, {"text", ""}, {"html", ""}}));
}
void InputFidelityValidation() {
  const auto nan = std::numeric_limits<double>::quiet_NaN();
  const auto infinity = std::numeric_limits<double>::infinity();
  for (uint32_t bit = 1; bit; bit <<= 1) {
    KeyInput key;
    MouseInput mouse;
    WheelInput wheel;
    key.modifiers = mouse.modifiers = wheel.modifiers = bit;
    CHECK(bool(ValidateInput(key)) == bool(bit & kInputModifiers));
    CHECK(bool(ValidateInput(mouse)) == bool(bit & kInputModifiers));
    CHECK(bool(ValidateInput(wheel)) == bool(bit & kInputModifiers));
    for (const auto* type : {"key", "mouse", "wheel"}) {
      Json event = {{"type", type}, {"modifiers", bit}};
      CHECK(bool(ValidateInputFidelity(event)) == bool(bit & kInputModifiers));
    }
  }
  for (const auto& invalid :
       {Json(-1), Json(0.5), Json("512"), Json(nullptr), Json(uint64_t{1} << 32)})
    CHECK(!ValidateInputFidelity({{"type", "key"}, {"modifiers", invalid}}));
  MouseInput mouse;
  mouse.pen = PenInput{UINT32_MAX, 1, -90, 90, 359, true};
  CHECK(ValidateInput(mouse));
  Json pen = {{"id", UINT32_MAX}, {"pressure", 1}, {"tiltX", -90},
              {"tiltY", 90},      {"twist", 359},  {"eraser", true}};
  CHECK(ParsePen(pen));
  CHECK(ParsePen(pen).value().id == UINT32_MAX);
  for (const auto* field : {"id", "pressure", "tiltX", "tiltY", "twist", "eraser"}) {
    auto invalid = pen;
    invalid.erase(field);
    CHECK(!ParsePen(invalid));
    invalid[field] = "bad";
    CHECK(!ParsePen(invalid));
  }
  for (const auto& [field, value] :
       std::vector<std::pair<std::string, double>>{{"id", -1},
                                                   {"id", 0.5},
                                                   {"id", 4294967296.0},
                                                   {"pressure", -0.1},
                                                   {"pressure", 1.1},
                                                   {"tiltX", -91},
                                                   {"tiltX", 91},
                                                   {"tiltY", -91},
                                                   {"tiltY", 91},
                                                   {"twist", -1},
                                                   {"twist", 360},
                                                   {"pressure", nan},
                                                   {"tiltX", infinity},
                                                   {"tiltY", nan},
                                                   {"twist", infinity}}) {
    auto invalid = pen;
    invalid[field] = value;
    CHECK(!ParsePen(invalid));
    CHECK(!DataRouter::Classify(
        {{"type", "input"}, {"event", {{"type", "mouse"}, {"pen", invalid}}}}));
  }
  CHECK(!ParsePen(nullptr));
  CHECK(DataRouter::Classify({{"type", "input"}, {"event", {{"type", "mouse"}, {"pen", pen}}}}));
  mouse.pen->pressure = nan;
  CHECK(!ValidateInput(mouse));

  TouchInput touch{TouchInput::Action::move, {{1, 10, 20, 0.5, 0, 1000}}};
  touch.clock = TouchInput::Clock{"1", false, 10, 0};
  touch.samples = {{5, touch.points}};
  CHECK(ValidateInput(touch));
  for (const auto size : {-1.0, 1000.1, nan, infinity}) {
    touch.points[0].width = size;
    CHECK(!ValidateInput(touch));
    touch.points[0].width = 0;
    touch.samples[0].points[0].height = size;
    CHECK(!ValidateInput(touch));
    touch.samples[0].points[0].height = 1000;
  }
  for (const auto& size :
       {Json(-1), Json(1000.1), Json(nan), Json(infinity), Json("10"), Json(nullptr)}) {
    for (const auto* field : {"width", "height"}) {
      Json event = {{"type", "touch"},
                    {"gestureMode", "client-v1"},
                    {"points", {{{"id", 1}, {field, size}}}}};
      CHECK(!ValidateInputFidelity(event));
      CHECK(!DataRouter::Classify({{"type", "input"}, {"event", event}}));
      event["samples"] = {{{"points", event["points"]}}};
      event["points"][0].erase(field);
      CHECK(!ValidateInputFidelity(event));
    }
  }
  CHECK(ValidateInputFidelity({{"type", "touch"}, {"points", {{{"width", 0}, {"height", 1000}}}}}));

  Json layout = {
      {"type", "keyboard.layout"},
      {"entries", Json::array({Json::array({"KeyA", "q"}), Json::array({"KeyE", "馃榾馃榾"})})}};
  CHECK(ParseKeyboardLayout(layout));
  CHECK(ParseKeyboardLayout(layout).value().entries[1].second.size() == 4);
  CHECK(DataRouter::Classify(layout).value() == DataRouter::Kind::kInput);
  for (const auto& entry :
       {Json::array(), Json::array({"KeyA"}), Json::array({"KeyA", "a", "b"}),
        Json::array({1, "a"}), Json::array({"KeyA", 1}), Json::array({"", "a"}),
        Json::array({"Bad-Code", "a"}), Json::array({std::string(33, 'A'), "a"}),
        Json::array({"KeyA", ""}), Json::array({"KeyA", "abcde"}),
        Json::array({"KeyA", "馃榾馃榾a"}), Json::array({"KeyA", std::string("\xff")})}) {
    layout["entries"] = Json::array({entry});
    CHECK(!ParseKeyboardLayout(layout));
    CHECK(!DataRouter::Classify(layout));
  }
  layout["entries"] = Json::array();
  CHECK(ParseKeyboardLayout(layout));
  for (int index = 0; index < 256; ++index)
    layout["entries"].push_back({"Key" + std::to_string(index), "a"});
  CHECK(ParseKeyboardLayout(layout));
  layout["entries"].push_back({"KeyExtra", "a"});
  CHECK(!ParseKeyboardLayout(layout));
  CHECK(!ParseKeyboardLayout({{"entries", nullptr}}));
}

void InputFidelityForwarding() {
  std::mutex mutex;
  std::condition_variable wake;
  std::vector<Json> dispatched;
  std::atomic<uint64_t> input_stamp{0};
  InputController controller(
      "tenant-session",
      {.control = [] { return 3; },
       .input_stamp = [&] { return input_stamp.load(); },
       .epoch = [] { return 5; },
       .admitted = [](const auto&) { return true; },
       .admission = [] { return AuthorizationController::AdmissionToken{1, 2, 1}; },
       .revalidate = [](const auto&) { return true; },
       .allows = [](const auto&, uint64_t) { return true; },
       .rpc = [&](Json request, uint64_t control, uint32_t, bool,
                  const std::function<bool()>& admitted) -> Result<Json> {
         CHECK(control == 3 && admitted());
         CHECK(request["method"] == "input" && request["session"] == "tenant-session");
         std::lock_guard lock(mutex);
         dispatched.push_back(request);
         wake.notify_all();
         return Json{{"ok", true}};
       },
       .send = [](const Json&, uint64_t) {},
       .failed = [] { CHECK(false); },
       .trace = [] { return std::shared_ptr<media::ServerTrace>(); }});
  controller.Start(1);
  const Json layout = {{"type", "keyboard.layout"},
                       {"entries", Json::array({Json::array({"KeyA", "q"})})},
                       {"authEpoch", 1}};
  const Json pen = {{"type", "mouse"},
                    {"action", "down"},
                    {"x", 10},
                    {"y", 20},
                    {"button", 1},
                    {"modifiers", (1 << 9) | (1 << 10)},
                    {"click_count", 1},
                    {"pen",
                     {{"id", 7},
                      {"pressure", 0.5},
                      {"tiltX", -20},
                      {"tiltY", 30},
                      {"twist", 90},
                      {"eraser", true}}}};
  const Json point = {{"id", 1},         {"x", 10},     {"y", 20},
                      {"pressure", 0.5}, {"width", 18}, {"height", 20}};
  auto history_point = point;
  history_point["width"] = 16;
  history_point["height"] = 18;
  const Json sample = {{"sampleElapsedUs", 5}, {"points", Json::array({history_point})}};
  const Json touch = {{"type", "touch"},
                      {"action", "move"},
                      {"gestureMode", "client-v1"},
                      {"points", Json::array({point})},
                      {"samples", Json::array({sample})}};
  uint64_t sequence = 0;
  for (const auto& message : {layout, pen, touch}) {
    RtcEvent event{};
    event.peer = 1;
    event.authorization = 2;
    event.message = message == layout ? message
                                      : Json{{"type", "input"},
                                             {"session", "tenant-session"},
                                             {"view", "2"},
                                             {"layoutEpoch", "5"},
                                             {"sequence", std::to_string(++sequence)},
                                             {"event", message}};
    CHECK(DataRouter::Classify(event.message));
    controller.QueueInput(event);
    if (message == layout) {
      std::unique_lock lock(mutex);
      CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return dispatched.size() == 1; }));
      input_stamp = 2;
    }
  }
  {
    std::unique_lock lock(mutex);
    CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return dispatched.size() == 3; }));
  }
  controller.Stop();
  CHECK(dispatched[0] ==
        Json({{"method", "input"},
              {"session", "tenant-session"},
              {"event", {{"type", "keyboard.layout"}, {"entries", layout["entries"]}}}}));
  CHECK(dispatched[1]["event"] == pen && dispatched[2]["event"] == touch);
  CHECK(dispatched[1]["sequence"] == "1" && dispatched[2]["sequence"] == "2");
}

void SignInValidation() {
  CHECK(ValidateSignIn(Json::object()));
  CHECK(ValidateSignIn({{"signIn", "xinjiaoyu"}}));
  CHECK(ValidateSignIn({{"signIn", "changyan"}}));
  for (const auto& purpose : {Json(""), Json("unknown"), Json(1), Json(nullptr)})
    CHECK(!ValidateSignIn({{"signIn", purpose}}));
  CHECK(!ValidateSignIn({{"method", "view.adopt"}, {"signIn", "changyan"}}));
  Json event = {{"type", "view.signIn"},
                {"version", 1},
                {"eventId", "event"},
                {"webviewId", "1"},
                {"provider", "changyan"},
                {"result",
                 {{"lot_number", "lot"},
                  {"captcha_output", "output"},
                  {"pass_token", "token"},
                  {"gen_time", "1"}}}};
  CHECK(ValidSignInEvent(event));
  event["result"]["cookies"] = "forbidden";
  CHECK(!ValidSignInEvent(event));
  event["result"].erase("cookies");
  event["result"]["pass_token"] = "";
  CHECK(!ValidSignInEvent(event));
  event["result"]["pass_token"] = std::string(8192, 'x');
  CHECK(!ValidSignInEvent(event));
  event["provider"] = "xinjiaoyu";
  event["result"] = {{"authorization", "JBY example"}, {"accesstoken", "example"}};
  CHECK(!ValidSignInEvent(event));
  event["result"]["clientsession"] = "page-client";
  event["result"]["device"] = "mobile";
  event["result"]["devicetype"] = "Other";
  CHECK(ValidSignInEvent(event));
  event["result"]["clientsession"] = "";
  CHECK(!ValidSignInEvent(event));
  event["result"]["clientsession"] = "page-client";
  event["result"]["cookie"] = "forbidden";
  CHECK(!ValidSignInEvent(event));
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--signin") {
    SignInValidation();
    return 0;
  }
  SignInValidation();
  if (argc == 2 && std::string_view(argv[1]) == "--input-validation") {
    InputFidelityValidation();
    InputFidelityForwarding();
    OrderedTouchInput();
    DismissalDuringLayout();
    return 0;
  }
  InputFidelityValidation();
  InputFidelityForwarding();
  ClipboardSynchronization();
  RouterClassificationAndAdmission();
  OutboxPriorityAndEpoch();
  PresentationOwnership();
  AuthorizationTokens();
  SessionManagementRequests();
  PeerFailureCleanup();
  OrderedTouchInput();
  DismissalDuringLayout();
}
