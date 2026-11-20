#include "session/session.hpp"
#include "service.hpp"
#include "runtime_config_fixture.hpp"
#include "coordination_fixture.hpp"
#include "util/wire_error.hpp"
#include "documents/object_documents.hpp"
#include "native_retry_clock.hpp"
#include <cstring>
#include <fstream>
#include <iostream>

namespace remotekit {
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}
void Take(Result<void> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
}
class Link : public ManagementLink {
 public:
  std::optional<Error> failure;
  std::atomic<unsigned> requests{0};
  std::string connection;
  Disconnect disconnected;
  std::optional<ReadyState> ReadyConfiguration() override {
    if (connection.empty())
      return {};
    return ReadyState{1, Json::object(), connection};
  }
  bool Next(std::string&, uint64_t&, bool&) override { return false; }
  bool Current(uint64_t) override { return true; }
  bool SendReply(uint64_t, const Json&) override { return true; }
  bool SendEvent(const Json&, uint64_t, DeliveryFlag = {}) override { return true; }
  void OnDisconnect(Disconnect callback) override { disconnected = std::move(callback); }
  Result<Json> Request(const std::string&, Json) override {
    ++requests;
    return failure ? Result<Json>{*failure} : Result<Json>{Json{{"ok", true}}};
  }
};
std::function<Result<Json>(const Json&)> dispatch;
media::Sdk MakeSdk() {
  media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char*, uint64_t* handle) {
    *handle = 1;
    return 0;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  sdk.remotekit_sdk_control_request = [](uint64_t, const void* bytes, size_t size, void* output,
                                         size_t capacity, size_t* count, uint32_t) {
    const auto command =
        Json::parse(static_cast<const char*>(bytes), static_cast<const char*>(bytes) + size);
    auto result = dispatch(command);
    Json reply =
        result ? result.value() : Json{{"ok", false}, {"error", WireError(result.error())}};
    if (result)
      reply["ok"] = true;
    const auto encoded = reply.dump();
    Check(encoded.size() <= capacity, "fake reply capacity");
    std::memcpy(output, encoded.data(), encoded.size());
    *count = encoded.size();
    return 0;
  };
  return sdk;
}
}  // namespace
class NativeErrorStateProbe {
 public:
  static void Launch(BrowserRuntime& browser,
                     const fs::path& root,
                     const std::wstring& mode = L" --hold") {
    browser.crash_directory_ = root / "crashes";
    browser.logs_root_ = root;
    browser.session_id_ = "test";
    fs::create_directories(browser.crash_directory_);
    wchar_t executable[32768]{};
    GetModuleFileNameW(nullptr, executable, 32768);
    Take(browser.process_.Launch(executable, BrowserProcess::Quote(executable) + mode,
                                 browser.profile_key_));
    browser.incarnation_ = browser.process_incarnation_ = "browser";
    browser.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kRunning;
    browser.shutdown_dispatched_ = false;
  }
  static void BrowserState(const fs::path& root) {
    auto sdk = MakeSdk();
    cluster::Key key{};
    BrowserRuntime browser(sdk, key);
    Launch(browser, root);
    Take(browser.Rpc().Connect("fake"));
    unsigned requests = 0;
    dispatch = [&](const Json&) -> Result<Json> {
      ++requests;
      return Json::object();
    };
    for (const auto code :
         {ErrorCode::kUnavailable, ErrorCode::kInternal, ErrorCode::kOutcomeUnknown}) {
      auto stopped =
          browser.Shutdown([&]() -> Result<void> { return Error{code, "export failure"}; });
      Check(!stopped && stopped.error().code == code, "export error retained");
      Check(browser.Alive() && browser.Rpc().Control() && requests == 0,
            "failed export preserves Browser and dispatch ownership");
    }
    browser.Rpc().Invalidate();
    browser.control_channel_ = "late-listener";
    browser.startup_error_ = Error{ErrorCode::kUnavailable, "listener not ready"};
    Take(browser.HealthCheck());
    Check(browser.Alive() && browser.Rpc().Control() && !browser.startup_error_,
          "late control connection recovers retained process");
    Take(browser.Stop());
    browser.ReleaseExited();
    Launch(browser, root, L" --exit");
    browser.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kDispatched;
    Check(browser.process_.WaitCleanExit(2000), "observe a late clean process exit");
    Take(browser.Shutdown([&]() -> Result<void> {
      Check(false, "a dispatched shutdown cannot repeat navigation export");
      return {};
    }));
    Check(browser.CheckpointReady(), "late clean exit resolves the same unknown shutdown");
    browser.ReleaseExited();
    Launch(browser, root, L" --fail");
    browser.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kDispatched;
    browser.process_.WaitCleanExit(2000);
    Take(browser.Stop());
    Check(!browser.CheckpointReady(), "nonzero dispatched exit remains unclean");
    browser.ReleaseExited();
  }
  static void ServicePeerLookup(const fs::path& root) {
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    Service service(sdk, options, link, {}, "endpoint");
    service.fenced_generation_ = 1;
    for (const auto* method : {"service.close", "service.face.capabilities"}) {
      auto request = test::Rpc(method, {{"leaseId", "retired"}}, method);
      request["sessionId"] = request["placementEpoch"] = nullptr;
      const auto result = service.Dispatch(request, 1);
      Check(!result && result.error().code == ErrorCode::kConflict &&
                result.error().message == "Viewer service lease is retired" &&
                service.service_peers_.empty(),
            "an absent service lease never inserts an empty peer");
      link.disconnected(1);
    }
    auto peer =
        std::make_shared<ServicePeer>(sdk, options, link, service.objects_, "tenant", "current");
    service.service_peers_.emplace("tenant", std::make_pair("current", peer));
    auto request = test::Rpc("service.close", {{"leaseId", "retired"}}, "stale-close");
    request["sessionId"] = request["placementEpoch"] = nullptr;
    Check(!service.Dispatch(request, 1) && service.service_peers_.at("tenant").second == peer,
          "a retired lease leaves the current peer intact");
    link.disconnected(1);
  }
  static void StopRecovery(const fs::path& root) {
    for (const auto scenario :
         {"late", "persisted", "launch-failure", "shutdown-failure", "crash"}) {
      NativeRetryClock clock;
      Link link;
      auto sdk = MakeSdk();
      const auto options =
          Take(RuntimeOptions::FromConfig(TestConfig(), root / scenario, "dev", "test"));
      objects::ObjectService objects(options.data, link, {}, "test", "dev");
      Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                              {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
      media::FrameAdmission admission;
      const std::string id(32, 'a');
      const auto directory = options.data / "sessions" / id;
      {
        Session seed(sdk, options, "tenant", id, 1, {}, link, objects, admission);
        Take(seed.Initialize());
        Take(seed.store.Close());
      }
      auto execution = std::make_shared<SessionExecution>(sdk, options, link, objects, admission,
                                                          test::Placement(id), "endpoint");
      auto desired = test::Desired(id);
      desired["commit"] = "commit";
      desired["views"] = Json::array({TestView()});
      Take(execution->Authorize(desired, 1));
      Check(!Take(execution->Observe()).at("blockers").at("lifecycleUncertain").get<bool>(),
            "a persisted unclean copy is recoverable rather than blocked");
      const auto event_name =
          "Local\\RemoteKit-stop-" + std::to_string(GetCurrentProcessId()) + "-" + scenario;
      HANDLE exit_event = CreateEventA(nullptr, TRUE, FALSE, event_name.c_str());
      Check(exit_event != nullptr, "create controlled Browser exit");
      struct CloseEvent {
        HANDLE event;
        ~CloseEvent() { CloseHandle(event); }
      } close_event{exit_event};
      unsigned launches = 0, shutdowns = 0;
      dispatch = [&](const Json& command) -> Result<Json> {
        const auto method = command.at("method").get<std::string>();
        Check(method != "view.create" && method != "lifecycle" && method != "output.configure",
              "commit recovery never restores Viewer state");
        if (method == "snapshot")
          return Json{{"sessions", Json::array({{{"views", Json::array()}}})}};
        if (method == "clipboard.read" || method == "clipboard.write")
          return Json{{"sequence", "0"}, {"baseRevision", "0"}, {"text", ""}, {"html", ""}};
        if (method == "browser.shutdown") {
          ++shutdowns;
          SetEvent(exit_event);
        }
        return Json::object();
      };
      const auto prepare = [&](const Json& document) -> Result<void> {
        Take(execution->Prepare(document));
        auto session = execution->runtime_.load();
        session->views.launch_browser_ = [&, session = session.get()]() -> Result<void> {
          ++launches;
          if (std::string_view(scenario) == "launch-failure" && launches == 1) {
            session->browser.start_policy_ = BrowserStartPolicy();
            return Error{ErrorCode::kUnavailable, "injected launch failure"};
          }
          ResetEvent(exit_event);
          const bool fail = std::string_view(scenario) == "shutdown-failure" && launches == 1;
          const auto mode =
              Utf8Path(" --wait-event " + event_name + (fail ? " 3" : " 0")).wstring();
          Launch(session->browser, root / scenario, mode);
          session->browser.start_policy_ = BrowserStartPolicy();
          Take(session->browser.Rpc().Connect("fake"));
          return {};
        };
        return {};
      };
      if (std::string_view(scenario) == "late" || std::string_view(scenario) == "crash") {
        Take(prepare(desired));
        auto session = execution->runtime_.load();
        session->recovery_required_ = false;
        Launch(session->browser, root / scenario,
               Utf8Path(" --wait-event " + event_name + " 0").wstring());
        if (std::string_view(scenario) == "late")
          session->browser.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kDispatched;
        Check(!session->browser.process_.WaitCleanExit(0),
              "shutdown wait expires before Browser exit");
        SetEvent(exit_event);
        Check(session->browser.process_.WaitCleanExit(2000),
              "Browser exits after the wait deadline");
        Take(session->views.InactiveSnapshot());
        Check(session->browser.CheckpointReady() == (std::string_view(scenario) == "late"),
              "snapshot retirement classifies exit before releasing process handles");
      }
      std::optional<Result<Json>> result;
      unsigned attempts = 0;
      auto hooks = execution->Hooks();
      hooks.stop = [&](const Json& commit, bool) -> Result<Json> {
        ++attempts;
        result = execution->Stop(commit, true, PhaseClock::time_point::max(), false, prepare);
        return *result;
      };
      hooks.maintain = []() -> Result<void> { return {}; };
      std::atomic<uint64_t> sequence{0};
      SessionCoordinator coordinator(test::Placement(id), "endpoint", sequence, std::move(hooks));
      coordinator.Activate("connection", "1", 1);
      Take(coordinator.Publish(desired, 1));
      Take(coordinator.Execute([]() -> Result<Json> { return Json::object(); }));
      Check(result.has_value(), "coordinator attempts the pending commit");
      const bool failure = std::string_view(scenario) == "launch-failure" ||
                           std::string_view(scenario) == "shutdown-failure";
      if (failure) {
        Check(!*result && result->error().code == ErrorCode::kUnavailable &&
                  result->error().message == (std::string_view(scenario) == "launch-failure"
                                                  ? "injected launch failure"
                                                  : "unclean Browser shutdown"),
              "recovery reports its normal launch or shutdown error");
        const auto copy = Take(Checkpoints::Copy(directory));
        Check(copy.at("state") == "dirty" && copy.at("stoppedCleanly") == false,
              "failed recovery never publishes a clean copy");
        Take(coordinator.Execute([]() -> Result<Json> { return Json::object(); }));
        Check(attempts == 1, "unchanged recovery failure observes convergence backoff");
        clock.Advance(std::chrono::minutes(5));
        Take(coordinator.Execute([]() -> Result<Json> { return Json::object(); }));
        Check(attempts == 2,
              "the same pending commit retries through the existing convergence unit");
      }
      Take(std::move(*result));
      const auto copy = Take(Checkpoints::Copy(directory));
      Check(copy.at("state") == "clean" && copy.at("stoppedCleanly") == true &&
                copy.at("lastCommit").at("requestId") == "commit" && !execution->runtime_.load(),
            "recovery commits the same copy and retires the runtime");
      Check(launches == (std::string_view(scenario) == "late" ? 0u
                         : failure                            ? 2u
                                                              : 1u) &&
                shutdowns == (std::string_view(scenario) == "shutdown-failure" ? 2u
                              : std::string_view(scenario) == "late"           ? 0u
                                                                               : 1u),
            "recovery uses one Browser per attempt and one graceful shutdown per launch");
      dispatch = {};
    }
  }
  static void GeometryRecovery(const fs::path& root) {
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    objects::ObjectService objects(options.data, link, {}, "test", "dev");
    media::FrameAdmission admission;
    const std::string id(32, 'a');
    const auto directory = options.data / "sessions" / id;
    auto config = TestView();
    config["visible"] = true;
    config["occludedBottom"] = 200;
    config["occlusionRevision"] = "7";
    {
      SessionDb seed(directory);
      Take(seed.Open());
      Take(seed.Views().SaveDesired(Json::array({config}), 1, "1"));
      Take(seed.Close());
    }
    Session session(sdk, options, "tenant", id, 1, {}, link, objects, admission);
    Take(session.Initialize());
    const auto restored = session.views.Desired("1");
    Check(restored.at("visible") == false && restored.at("width") == 1 &&
              restored.at("height") == 1 && restored.at("occludedBottom") == 0 &&
              restored.at("occlusionRevision") == "0" &&
              restored.at("device").at("deviceScaleFactor") == 1,
          "restored topology starts hidden without recovered Viewer geometry");
    Check(!session.output.Visible(), "restored views cannot present before Viewer geometry");
    sqlite::Database inject;
    Take(inject.Open(directory / "session.db"));
    Take(
        inject.Execute("CREATE TRIGGER fail_geometry_commit BEFORE DELETE ON views BEGIN "
                       "SELECT RAISE(ABORT,'injected durable write'); END"));
    Json document{{"views", Json::array({config})},
                  {"placementEpoch", 1},
                  {"revision", "2"},
                  {"connectionEpoch", "1"},
                  {"lock", {{"state", "unlocked"}}}};
    Take(session.views.StageDesired(document));
    Check(session.views.Desired("1") == config,
          "Viewer geometry applies directly while durable writes fail");
    std::promise<void> writing, release;
    auto released = release.get_future();
    auto durable = std::async(std::launch::async, [&] {
      return session.store.Write([&]() -> Result<void> {
        writing.set_value();
        released.wait();
        return {};
      });
    });
    writing.get_future().wait();
    config["width"] = 800;
    config["device"]["deviceScaleFactor"] = 2;
    document["views"] = Json::array({config});
    document["revision"] = "3";
    auto geometry =
        std::async(std::launch::async, [&] { return session.views.StageDesired(document); });
    const bool independent =
        geometry.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    release.set_value();
    Take(durable.get());
    Take(geometry.get());
    Check(independent && session.views.Desired("1") == config,
          "geometry application never waits for the persistence transaction mutex");
    document["views"][0]["url"] = "https://example.test/new";
    document["revision"] = "4";
    Check(!session.views.StageDesired(document) && session.views.Desired("1") == config,
          "failed topology commit cannot publish partially staged desired state");
    Take(inject.Execute("DROP TRIGGER fail_geometry_commit"));
    Take(session.Stop());
  }
  static void ViewsAndOutput(const fs::path& root) {
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    objects::ObjectService objects(options.data, link, {}, "test", "dev");
    media::FrameAdmission admission;
    Session session(sdk, options, "tenant", std::string(32, 'a'), 1, {}, link, objects, admission);
    Take(session.Initialize());
    Launch(session.browser, root);
    Take(session.browser.Rpc().Connect("fake"));
    session.views.desired["1"] = {{"url", "https://example.test/"}};
    using Phase = NavigationRecovery::Recovery::Phase;
    for (const auto phase : {Phase::kUnload, Phase::kBegin, Phase::kChunks, Phase::kCommit,
                             Phase::kRestore, Phase::kWaiting}) {
      session.navigation.Begin("1");
      auto& task = session.navigation.recoveries.at("1");
      task.phase = phase;
      task.transfer = "transfer";
      session.navigation.FailRecovery("1", task, {ErrorCode::kOutcomeUnknown, "injected"});
      Check(task.phase == phase && task.reconcile && task.transfer == "transfer",
            "uncertain recovery preserves phase and operation identity");
      for (auto code : {ErrorCode::kInternal, ErrorCode::kInvalidRequest, ErrorCode::kForbidden,
                        ErrorCode::kUnauthenticated, ErrorCode::kLocked, ErrorCode::kRejected}) {
        session.navigation.Begin("1");
        auto& failed = session.navigation.recoveries.at("1");
        failed.phase = phase;
        session.navigation.FailRecovery("1", failed, {code, "injected"});
        Check(failed.phase == Phase::kFailed && !failed.Pending(),
              "terminal recovery faults without replacement");
      }
    }
    for (const auto code : {ErrorCode::kUnavailable, ErrorCode::kOutcomeUnknown}) {
      for (int operation = 0; operation < 3; ++operation) {
        session.navigation.Begin("1");
        dispatch = [&](const Json& request) -> Result<Json> {
          if (request.at("method") == "snapshot")
            return Json{
                {"sessions",
                 Json::array(
                     {{{"views",
                        Json::array({{{"view", "1"}, {"instance", "1"}, {"document", "1"}}})}}})}};
          return Error{code, "injected replacement failure"};
        };
        Json request{{"viewId", "1"}, {"browserIncarnation", "browser"}};
        Result<Json> result = Json();
        if (operation == 0) {
          request["url"] = "https://example.test/new";
          result = session.views.ManageViewNavigate(request);
        } else if (operation == 1) {
          request["command"] = "reload";
          result = session.views.ManageViewCommand(request);
        } else {
          result = session.views.ManageViewClose(request);
        }
        Check(!result && session.navigation.recoveries.contains("1"),
              "failed replacement retains recovery owner");
        const auto actual = session.navigation.recoveries.at("1").phase;
        Check(actual ==
                  (code == ErrorCode::kOutcomeUnknown ? Phase::kReplacementUnknown : Phase::kLoad),
              "replacement enters explicit unknown only after possible delivery");
      }
    }
    unsigned close_requests = 0;
    dispatch = [&](const Json& request) -> Result<Json> {
      if (request.at("method") == "snapshot")
        return Json{{"sessions", Json::array({{{"views", Json::array({{{"view", "1"},
                                                                       {"instance", "2"},
                                                                       {"document", "3"}}})}}})}};
      if (request.at("method") == "view.close") {
        ++close_requests;
        return Json{{"accepted", true}, {"completed", false}};
      }
      return Error{ErrorCode::kNotFound, "View retired after close acceptance"};
    };
    const auto closing =
        Take(session.views.ManageViewClose({{"viewId", "1"}, {"browserIncarnation", "browser"}}));
    Check(close_requests == 1 && closing == Json{{"accepted", true},
                                                 {"browserIncarnation", "browser"},
                                                 {"instance", "2"},
                                                 {"document", "3"}},
          "accepted close preserves identity without querying a retired view");
    Check(session.views.desired.contains("1") && !session.navigation.recoveries.contains("1"),
          "accepted close cancels recovery and awaits observed closure");

    dispatch = [&](const Json& request) -> Result<Json> {
      Check(!request.contains("session"),
            "Browser storage and identity requests have no session field");
      if (request.at("method") == "identity")
        return Json{{"userAgent", "test-agent"}, {"metadata", Json::object()}};
      Check(request.at("importId") == "import:0", "storage import retains job identity");
      return Json{{"importId", "import:0"},
                  {"state", "done"},
                  {"cookies", {{"applied", 1}, {"rejected", 0}}},
                  {"localStorage", {{"applied", 1}, {"rejected", 0}}}};
    };
    const auto imported = Take(session.views.ManageSessionStorageImport(
        {{"importId", "import:0"}, {"cookies", Json::array()}, {"localStorage", Json::array()}}));
    Check(imported ==
              Take(session.views.ManageSessionStorageImportStatus({{"importId", "import:0"}})),
          "storage import and status preserve the same result");
    Check(Take(session.views.ManageSessionIdentity(Json::object())).at("userAgent") == "test-agent",
          "Browser identity uses its strict request contract");

    unsigned output_closes = 0, output_configures = 0, output_revision = 0;
    dispatch = [&](const Json& request) -> Result<Json> {
      if (request.at("method") == "snapshot")
        return Json{{"sessions", Json::array({{{"views", Json::array()}}})}};
      if (request.at("method") == "output.close")
        ++output_closes;
      if (request.at("method") == "output.configure") {
        ++output_configures;
        ++output_revision;
      }
      return Json{{"layoutRevision", output_revision}, {"accepted", true}};
    };
    const auto configs = [](int width, int height, bool second = false) {
      return Json::array({{{"session", "1"},
                           {"view", second ? "2" : "1"},
                           {"width", width},
                           {"height", height},
                           {"visible", true},
                           {"device", "desktop"},
                           {"device_scale_factor", 1.f},
                           {"occludedBottom", 0},
                           {"occlusionRevision", "0"}}});
    };
    Take(session.output.Configure(648, 488, 1, configs(640, 480), true));
    output_closes = output_configures = 0;
    SharedAtlasFrame old_pixels{};
    old_pixels.layout_revision = session.output.layout_revision;
    old_pixels.view_count = 1;
    old_pixels.views[0].webview_id = 1;
    auto layout_lock = session.presentation.LockLayout();
    std::promise<void> observed;
    auto delayed = std::async(std::launch::async, [&] {
      observed.set_value();
      return session.pipeline.ObserveLayout(old_pixels).epoch;
    });
    observed.get_future().wait();
    Take(session.output.ConfigureForGeneration(808, 608, 1, configs(800, 600), true, 7));
    const auto resized_epoch = session.presentation.Epoch();
    layout_lock.unlock();
    Check(delayed.get() == 0 && session.presentation.Epoch() == resized_epoch,
          "a polled old frame cannot replace the geometry transaction after its boundary");
    Check(output_closes == 0 && output_configures == 1,
          "fixed-extent resize keeps the live output resources");
    Check(session.output.configuration.at("outputWidthPixels") == 648 &&
              session.output.configuration.at("outputHeightPixels") == 488,
          "logical atlas resizing preserves the aligned physical extent");
    Take(session.output.ConfigureForGeneration(808, 608, 1, configs(800, 600, true), true, 7));
    Check(output_closes == 0 && output_configures == 2,
          "visible-member replacement keeps the live output resources");
    const auto epoch = session.presentation.Epoch();
    auto keyboard = configs(800, 600, true);
    keyboard[0]["occludedBottom"] = 200;
    keyboard[0]["occlusionRevision"] = "1";
    Take(session.output.ConfigureForGeneration(808, 608, 1, keyboard, true, 7));
    Check(session.presentation.Epoch() == epoch && output_closes == 0 && output_configures == 2,
          "keyboard observation preserves the presentation epoch and output");
    Take(session.output.ConfigureForGeneration(808, 608, 2, configs(800, 600, true), true, 7));
    Check(output_closes == 1 && output_configures == 3,
          "DPR extent change crosses the full output reconfiguration boundary");
    Take(session.output.ConfigureForGeneration(16, 16, 2, Json::array(), false, 7));
    Check(output_closes == 1 && output_configures == 4,
          "an empty visible set preserves the configured extent and output");
    unsigned configure = 0;
    dispatch = [&](const Json& request) -> Result<Json> {
      if (request.at("method") == "output.configure") {
        ++configure;
        return Error{ErrorCode::kInternal, "injected output failure"};
      }
      return Json::object();
    };
    session.output.configuration = {
        {"method", "output.configure"},
        {"width", 64},
        {"height", 64},
        {"device_scale", 1.0f},
        {"allocation_alignment", RuntimeOptions::kAtlasAllocationAlignment},
        {"viewConfigs", Json::array()}};
    session.output.configuration_incarnation = "browser";
    session.output.Suspend();
    auto configured = session.output.Configure(64, 64, 1, Json::array(), true);
    Check(!configured && configure == 1 && session.output.configuration_incarnation.empty(),
          "cached configuration cannot publish stopped output as converged");
    Take(session.browser.Stop());
  }
  static void ShutdownOwnership(const fs::path& root) {
    NativeRetryClock clock;
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    Service service(sdk, options, link, {}, "endpoint");
    service.failed_ = true;
    const std::string bad(32, 'a'), good(32, 'b');
    const auto directory = options.data / "sessions";
    fs::create_directories(directory);
    std::ofstream(directory / (bad + ".copy.json")) << "invalid";
    for (const auto& [tenant, id] : std::array{std::pair{"bad", bad}, std::pair{"good", good}}) {
      auto target = test::Placement(id);
      target["tenantId"] = tenant;
      auto execution = std::make_shared<SessionExecution>(
          sdk, options, link, service.objects_, service.frame_admission_, target, "endpoint");
      auto coordinator = std::make_shared<SessionCoordinator>(
          target, "endpoint", service.observation_sequence_, execution->Hooks());
      service.sessions_[tenant] = {execution, coordinator};
    }
    const auto result = service.Clear();
    Check(!result && result.error().code == ErrorCode::kInternal, "shutdown reports failed commit");
    Check(service.sessions_.contains("bad") && !service.sessions_.contains("good"),
          "shutdown retains failed owner and retires independent successes");
    fs::remove(directory / (bad + ".copy.json"));
    Take(service.Clear());
    Check(service.sessions_.empty(), "retained shutdown owner can reconcile");
    service.failed_ = false;
    Take(service.objects_.Configure(
        {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
         {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
    const std::string uncertain_id(32, 'c');
    auto target = test::Placement(uncertain_id);
    auto execution = std::make_shared<SessionExecution>(
        sdk, options, link, service.objects_, service.frame_admission_, target, "endpoint");
    auto session =
        std::make_shared<Session>(sdk, options, "tenant", uncertain_id, 1, cluster::Key{}, link,
                                  service.objects_, service.frame_admission_);
    Take(session->Initialize());
    execution->runtime_.store(session);
    auto coordinator = std::make_shared<SessionCoordinator>(
        target, "endpoint", service.observation_sequence_, execution->Hooks());
    service.sessions_["tenant"] = {execution, coordinator};
    link.failure = Error{ErrorCode::kOutcomeUnknown, "injected commit reply loss"};
    auto uncertain = service.Clear();
    Check(!uncertain && uncertain.error().code == ErrorCode::kOutcomeUnknown &&
              service.sessions_.contains("tenant") && execution->runtime_.load() == session &&
              session->PersistenceClosed(),
          "uncertain commit retains the stopped Session and its reconciliation owner");
    link.failure.reset();
    const auto requests = link.requests.load();
    const auto waiting = service.Clear();
    Check(!waiting && waiting.error().code == ErrorCode::kOutcomeUnknown &&
              link.requests == requests && execution->runtime_.load() == session,
          "uncertain shutdown retains its owner without resending before backoff");
    clock.Advance(std::chrono::minutes(5));
    Take(service.Clear());
    Check(service.sessions_.empty() && !execution->runtime_.load(),
          "same shutdown identity resolves uncertainty");
  }
  static void ReaderPublication(const fs::path& root) {
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    objects::ObjectService objects(options.data, link, {}, "test", "dev");
    media::FrameAdmission admission;
    const std::string id(32, 'd');
    const auto directory = options.data / "sessions" / id;
    SessionDb database(directory);
    Take(database.Open());
    Take(database.Close());
    Take(Checkpoints::WriteCopy(directory, {{"version", 1},
                                            {"sessionId", id},
                                            {"placementEpoch", uint64_t(1)},
                                            {"base", nullptr},
                                            {"state", "dirty"},
                                            {"stoppedCleanly", true},
                                            {"changesAt", 0},
                                            {"lastCommit", nullptr}}));
    auto execution = std::make_shared<SessionExecution>(sdk, options, link, objects, admission,
                                                        test::Placement(id), "endpoint");
    HANDLE held = CreateFileW((directory / "session.db").c_str(), GENERIC_READ, 0, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    Check(held != INVALID_HANDLE_VALUE, "inject reader open failure");
    const auto failed = execution->EventState();
    CloseHandle(held);
    Check(!failed && !execution->reader_, "failed reader open never publishes an unusable reader");
    Take(execution->EventState());
    Check(bool(execution->reader_), "next read can publish a validated reader");
  }
  static void DocumentRetry(const fs::path& root) {
    Link link;
    objects::ObjectService objects(root / "objects", link, {}, "test", "dev");
    const std::string source(64, 'a');
    link.failure = Error{ErrorCode::kRejected, "injected conversion rejection"};
    const auto submit = [&](documents::ObjectDocuments& documents) {
      return documents.Submit(source, "tenant", root / "staging", "application/pdf").get();
    };
    {
      documents::ObjectDocuments documents(objects, root, "build-1");
      Check(!submit(documents) && link.requests == 1, "conversion reports terminal failure");
      Check(!submit(documents) && link.requests == 1, "unchanged conversion stays faulted");
    }
    {
      documents::ObjectDocuments documents(objects, root, "build-1");
      Check(!submit(documents) && link.requests == 1, "conversion fault survives restart");
    }
    {
      documents::ObjectDocuments documents(objects, root, "build-2");
      Check(!submit(documents) && link.requests == 2, "build change admits the same source again");
    }
    link.failure = Error{ErrorCode::kUnavailable, "injected conversion dependency failure", {}, 0};
    {
      documents::ObjectDocuments documents(objects, root, "build-3");
      Check(!submit(documents) && link.requests == 3, "transient conversion records retry state");
    }
    {
      documents::ObjectDocuments documents(objects, root, "build-3");
      Check(!submit(documents) && link.requests == 4, "transient conversion resumes after restart");
    }
    link.failure = Error{ErrorCode::kRejected, "injected conversion rejection"};
    const auto record = fs::directory_iterator(root / "documents/jobs")->path();
    HANDLE held = CreateFileW(record.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    Check(held != INVALID_HANDLE_VALUE, "inject conversion state publication failure");
    {
      documents::ObjectDocuments documents(objects, root, "build-4");
      Check(submit(documents).error().code == ErrorCode::kUnavailable && link.requests == 5,
            "failed publication retains a completed conversion separately");
      Check(!submit(documents) && link.requests == 5,
            "publication retry never repeats the conversion");
      CloseHandle(held);
      std::this_thread::sleep_for(std::chrono::milliseconds(1100));
      Check(submit(documents).error().code == ErrorCode::kRejected && link.requests == 5,
            "publication resumes the same terminal result");
      Check(documents.jobs_.begin()->second.retry.Status() == RetryUnit::State::kFaulted &&
                !documents.jobs_.begin()->second.pending_result,
            "durable publication commits the retained fault");
    }
    link.connection = "reconnected";
    {
      documents::ObjectDocuments documents(objects, root, "build-4");
      Check(!submit(documents) && link.requests == 6,
            "a new management connection changes the document job input");
    }
  }
  static void DraftRetirement(const fs::path& root) {
    Link link;
    objects::ObjectService objects(root / "objects", link, {}, "test", "dev");
    SessionDb database(root / "session");
    Take(database.Open());
    const auto directory = root / "session/file-library";
    FileLibrary library(directory, objects, "tenant", database.Library());
    Take(library.Initialize());
    const auto current = []() -> Result<void> { return {}; };
    const auto draft = Take(library.Begin(1, "operation", {"file.txt", "text/plain", 3}, current));
    const auto id = draft.at("uploadId").get<std::string>();
    const auto path = directory / "incoming" / id;
    HANDLE held = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    Check(held != INVALID_HANDLE_VALUE, "inject retired draft deletion failure");
    const auto retired = library.Cancel(1, id, current);
    Check(!retired && retired.error().code == ErrorCode::kUnavailable && fs::exists(path) &&
              Take(database.Library().Load(LibraryTable::kDrafts)).empty(),
          "retired draft retains cleanup ownership after its active row is removed");
    Check(!library.Cancel(1, id, current), "retirement cannot report success with a retained file");
    CloseHandle(held);
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    Take(library.Cancel(1, id, current));
    Check(!fs::exists(path), "the same retirement releases its file after recovery");
  }
  static void ColdDeletion(const fs::path& root) {
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    Service service(sdk, options, link, {}, "endpoint");
    const std::string failed(32, 'a'), healthy(32, 'b');
    const auto directory = options.data / "sessions";
    for (const auto& id : {failed, healthy}) {
      fs::create_directories(directory / id);
      std::ofstream(directory / id / "payload") << "data";
    }
    HANDLE held =
        CreateFileW((directory / failed / "payload").c_str(), GENERIC_READ, FILE_SHARE_READ,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    Check(held != INVALID_HANDLE_VALUE, "inject a cold deletion failure");
    const auto result = Take(service.DeleteCold(false));
    Check(result.at("deleted") == 1 && !fs::exists(directory / healthy) &&
              fs::exists(directory / failed),
          "cold deletion continues after an independent item fails");
    const auto failure =
        std::find_if(result.at("items").begin(), result.at("items").end(),
                     [&](const Json& item) { return item.at("sessionId") == failed; });
    Check(
        failure != result.at("items").end() && failure->at("error").at("code") == "outcome_unknown",
        "partial deletion records its unknown outcome by session");
    CloseHandle(held);
    auto& retry = service.cold_delete_retries_.at(failed);
    std::this_thread::sleep_until(retry.Until());
    Check(Take(service.DeleteCold(false)).at("deleted") == 1 && !fs::exists(directory / failed),
          "the same deletion identity reconciles after backoff");
  }
};
}  // namespace remotekit
int main(int argc, char** argv) {
  if (argc > 1 && std::string_view(argv[1]) == "--fail")
    return 3;
  if (argc >= 4 && std::string_view(argv[1]) == "--wait-event") {
    HANDLE event = OpenEventA(SYNCHRONIZE, FALSE, argv[2]);
    if (!event)
      return 4;
    const auto waited = WaitForSingleObject(event, 10000);
    CloseHandle(event);
    return waited == WAIT_OBJECT_0 ? std::stoi(argv[3]) : 5;
  }
  if (argc > 1 && std::string_view(argv[1]) == "--exit")
    return 0;
  if (argc > 1 && std::string_view(argv[1]) == "--hold") {
    Sleep(60000);
    return 0;
  }
  try {
    using namespace remotekit;
    Check(argc == 2, "evidence root required");
    const auto root =
        fs::absolute(argv[1]) / ("error-path-state-" + std::to_string(GetCurrentProcessId()));
    fs::create_directories(root);
    NativeErrorStateProbe::BrowserState(root / "browser");
    NativeErrorStateProbe::StopRecovery(root / "recovery");
    NativeErrorStateProbe::ServicePeerLookup(root / "service-peers");
    NativeErrorStateProbe::ViewsAndOutput(root / "views");
    NativeErrorStateProbe::GeometryRecovery(root / "geometry");
    NativeErrorStateProbe::ShutdownOwnership(root / "shutdown");
    NativeErrorStateProbe::ReaderPublication(root / "reader");
    NativeErrorStateProbe::DocumentRetry(root / "documents");
    NativeErrorStateProbe::DraftRetirement(root / "drafts");
    NativeErrorStateProbe::ColdDeletion(root / "cold");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
