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
  std::optional<ReadyState> ReadyConfiguration() override {
    if (connection.empty())
      return {};
    return ReadyState{1, Json::object(), connection};
  }
  bool Next(std::string&, uint64_t&, bool&) override { return false; }
  bool Current(uint64_t) override { return true; }
  bool SendReply(uint64_t, const Json&) override { return true; }
  bool SendEvent(const Json&, uint64_t, DeliveryFlag = {}) override { return true; }
  void OnDisconnect(Disconnect) override {}
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
  static void Launch(BrowserRuntime& browser, const wchar_t* mode = L" --hold") {
    wchar_t executable[32768]{};
    GetModuleFileNameW(nullptr, executable, 32768);
    Take(browser.process_.Launch(executable, BrowserProcess::Quote(executable) + mode,
                                 browser.profile_key_));
    browser.incarnation_ = browser.process_incarnation_ = "browser";
    browser.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kRunning;
  }
  static void BrowserState() {
    auto sdk = MakeSdk();
    cluster::Key key{};
    BrowserRuntime browser(sdk, key);
    Launch(browser);
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
    Launch(browser, L" --exit");
    browser.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kDispatched;
    Check(browser.process_.WaitCleanExit(2000), "observe a late clean process exit");
    Take(browser.Shutdown([&]() -> Result<void> {
      Check(false, "a dispatched shutdown cannot repeat navigation export");
      return {};
    }));
    Check(browser.CheckpointReady(), "late clean exit resolves the same unknown shutdown");
  }
  static void ViewsAndOutput(const fs::path& root) {
    Link link;
    auto sdk = MakeSdk();
    const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
    objects::ObjectService objects(options.data, link, {}, "test", "dev");
    media::FrameAdmission admission;
    Session session(sdk, options, "tenant", std::string(32, 'a'), 1, {}, link, objects, admission);
    Take(session.Initialize());
    Launch(session.browser);
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
    NativeErrorStateProbe::BrowserState();
    NativeErrorStateProbe::ViewsAndOutput(root / "views");
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
