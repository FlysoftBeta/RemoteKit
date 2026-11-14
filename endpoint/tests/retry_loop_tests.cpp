#include "retry_owner_drivers.hpp"
#include "retry_loop_registry.hpp"
#include "retry_loop_instances.hpp"
#include "retry_input_driver.hpp"
#include "retry_coordinator_driver.hpp"
#include "retry_admission_driver.hpp"
#include "retry_peer_driver.hpp"
#include "retry_final_export_driver.hpp"
#include "retry_service_driver.hpp"
#include "retry_execution_driver.hpp"
#include "retry_signin_driver.hpp"
#include "retry_cleanup_driver.hpp"
#include "retry_snapshot_driver.hpp"
#include "retry_driver_guard.hpp"
#include "persistence/document_job_formats.hpp"
#include <fstream>
#include <iostream>
#include <regex>
#include <io.h>
#include <share.h>

using namespace remotekit;
using namespace remotekit::retry_test;
using namespace std::chrono_literals;
namespace {
void VerifyOwnerCoverage();
void Check(bool condition, const std::string& message) {
  if (!condition)
    throw std::runtime_error(message);
}
std::string Read(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  Check(bool(input), "open source " + path.string());
  return {std::istreambuf_iterator<char>(input), {}};
}
std::set<std::string> DeclaredUnits(const std::string& text) {
  std::set<std::string> result;
  const std::regex literal(R"unit("([a-z_]+\.[a-z_]+)")unit");
  const std::regex declaration(R"unit(\bRetryUnit\s+[a-zA-Z_]\w*\s*(?:[({=][^;]*;|;))unit");
  const std::regex factory(
      R"unit((?:try_emplace|make_shared<RetryUnit>)\([^;]*?"([a-z_]+\.[a-z_]+)")unit");
  for (auto i = std::sregex_iterator(text.begin(), text.end(), declaration);
       i != std::sregex_iterator(); ++i) {
    const auto statement = i->str();
    bool named = false;
    for (auto j = std::sregex_iterator(statement.begin(), statement.end(), literal);
         j != std::sregex_iterator(); ++j) {
      result.insert((*j)[1]);
      named = true;
    }
    if (!named)
      result.insert("<unnamed>");
  }
  for (auto i = std::sregex_iterator(text.begin(), text.end(), factory);
       i != std::sregex_iterator(); ++i)
    result.insert((*i)[1]);
  return result;
}
std::map<std::string, unsigned> Instances(const std::string& text, const std::string& source) {
  std::map<std::string, unsigned> instances;
  const auto add = [&](const std::string& storage, const std::string& name) {
    ++instances[source + ":" + storage + ":" + name];
  };
  const std::regex declarations(R"(\bRetryUnit\s+\w+\s*(?:[({=][^;]*;|;))");
  const std::regex field(R"unit((\w+)\s*[({]\s*"([a-z_]+\.[a-z_]+)")unit");
  const std::regex factories(R"unit((\w+)\s*\.try_emplace\([^;]*?"([a-z_]+\.[a-z_]+)")unit");
  const std::regex shared(
      R"unit((\w+)\s*=\s*std::make_shared<RetryUnit>\("([a-z_]+\.[a-z_]+)")unit");
  for (auto i = std::sregex_iterator(text.begin(), text.end(), declarations);
       i != std::sregex_iterator(); ++i) {
    const auto statement = i->str();
    bool named = false;
    for (auto j = std::sregex_iterator(statement.begin(), statement.end(), field);
         j != std::sregex_iterator(); ++j) {
      add((*j)[1], (*j)[2]);
      named = true;
    }
    Check(named, "unnamed native retry instance in " + source);
  }
  for (const auto& pattern : {factories, shared})
    for (auto i = std::sregex_iterator(text.begin(), text.end(), pattern);
         i != std::sregex_iterator(); ++i)
      add((*i)[1], (*i)[2]);
  return instances;
}
void RegistryGuard(const fs::path& repository) {
  VerifyOwnerCoverage();
  std::set<std::string> registered;
  for (const auto& loop : kLoops)
    Check(registered.insert(loop.name).second, "duplicate registry entry");
  Check(DeclaredUnits("RetryUnit added{\"unregistered.loop\"};").contains("unregistered.loop"),
        "source guard recognizes a new unit");
  Check(!registered.contains("unregistered.loop"), "source guard rejects unregistered fixture");
  Check(DeclaredUnits("RetryUnit implicit;").contains("<unnamed>"),
        "source guard rejects an unnamed default-constructed unit");
  Check(DirectPrimitiveDriver("RetryUnit fake{\"unit\"}; fake.Fail(error);"),
        "driver guard rejects standalone units");
  Check(DirectPrimitiveDriver("auto unit = std::make_shared<RetryUnit>();"),
        "driver guard rejects heap construction");
  Check(DirectPrimitiveDriver("unit->Fail(error);"), "driver guard rejects pointer mutation");
  Check(DirectPrimitiveDriver("using Unit = RetryUnit;"), "driver guard rejects aliases");
  Check(!DirectPrimitiveDriver("// unit.Fail(error);\nconst char* example = \"RetryUnit unit;\";"),
        "driver guard ignores comments and literal examples");
  for (const auto& file : fs::directory_iterator(repository / "endpoint/tests")) {
    const auto name = file.path().filename().string();
    if ((name.starts_with("retry_") &&
         (name.ends_with("_driver.hpp") || name.ends_with("_drivers.hpp"))) ||
        name == "retry_loop_tests.cpp")
      Check(!DirectPrimitiveDriver(Read(file.path())), "driver invokes owner: " + name);
  }
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_owner_drivers.hpp")),
        "matrix drivers must invoke owners, never mutate retry units");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_input_driver.hpp")),
        "input matrix must invoke InputController");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_coordinator_driver.hpp")),
        "coordinator matrix must invoke SessionCoordinator");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_admission_driver.hpp")),
        "admission matrix must invoke receipt owners");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_peer_driver.hpp")),
        "source matrix must invoke the real object peer client");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_final_export_driver.hpp")),
        "final export matrix must invoke NavigationRecovery");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_service_driver.hpp")),
        "service matrix must invoke Service");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_execution_driver.hpp")),
        "execution matrix must invoke SessionExecution");
  Check(!DirectPrimitiveDriver(Read(repository / "endpoint/tests/retry_signin_driver.hpp")),
        "sign-in matrix must invoke ViewController");
  std::map<std::string, unsigned> expected, actual;
  for (const auto& entry : kRetryInstances) {
    Check(registered.contains(entry.name), "instance missing from loop inventory");
    expected[std::string(entry.source) + ":" + entry.storage + ":" + entry.name] = entry.sites;
  }
  auto modified =
      Instances("RetryUnit extra{\"navigation.export\"};", "session/navigation_export.hpp");
  Check(!expected.contains(modified.begin()->first),
        "a second instance with an existing loop name still requires registration");
  for (const auto& entry : fs::recursive_directory_iterator(repository / "endpoint/src")) {
    if (entry.path().extension() != ".hpp" && entry.path().extension() != ".cpp")
      continue;
    if (entry.path().filename() == "retry_unit.hpp")
      continue;
    const auto source = fs::relative(entry.path(), repository / "endpoint/src").generic_string();
    actual.merge(Instances(Read(entry.path()), source));
    for (const auto& name : DeclaredUnits(Read(entry.path())))
      Check(registered.contains(name),
            "unregistered native retry instance: " + name + " in " + entry.path().string());
  }
  Check(actual == expected,
        "native RetryUnit declarations or factories changed without registration");
}
class Capture {
 public:
  explicit Capture(const fs::path& path) : path_(path), original_(_dup(_fileno(stderr))) {
    file_ = _wfsopen(path.c_str(), L"wb", _SH_DENYNO);
    Check(file_ && original_ >= 0, "capture logs");
    Check(_dup2(_fileno(file_), _fileno(stderr)) == 0, "redirect logs");
  }
  ~Capture() { Finish(); }
  void Finish() {
    if (!file_)
      return;
    fflush(stderr);
    _dup2(original_, _fileno(stderr));
    _close(original_);
    fclose(file_);
    file_ = nullptr;
  }
  unsigned Count(const std::string& event) {
    Finish();
    unsigned count = 0;
    std::ifstream input(path_);
    std::string line;
    while (std::getline(input, line)) {
      const auto value = Json::parse(line, nullptr, false);
      if (value.is_object() && value.value("ev", "") == event)
        ++count;
    }
    return count;
  }

 private:
  fs::path path_;
  int original_;
  FILE* file_ = nullptr;
};
struct Entry {
  const char* name;
  const char* boundary;
  std::function<OwnerDriver(const fs::path&)> create;
  bool sdk_send = false;
  bool readiness_busy = false;
  bool health_probe = false;
};
const Entry kOwners[] = {
    {"placement.reconcile", "checkpoint filesystem preparation",
     [](const fs::path& root) { return SnapshotDriver(root, "placement.reconcile"); }},
    {"snapshot.schedule", "coordinator version eligibility",
     [](const fs::path& root) { return SnapshotDriver(root, "snapshot.schedule"); }},
    {"snapshot.take", "snapshot named pipe",
     [](const fs::path& root) { return SnapshotDriver(root, "snapshot.take"); }},
    {"snapshot.worker", "snapshot scheduler job",
     [](const fs::path& root) { return SnapshotDriver(root, "snapshot.worker"); }},
    {"browser.exit_cleanup", "Browser-exit file retirement",
     [](const fs::path& root) { return CleanupDriver(root, "browser.exit_cleanup"); }},
    {"selection.watch", "Browser page.fileStatus RPC",
     [](const fs::path& root) { return CleanupDriver(root, "selection.watch"); }},
    {"upload.cleanup", "upload filesystem removal",
     [](const fs::path& root) { return CleanupDriver(root, "upload.cleanup"); }},
    {"files.draft_cleanup", "draft filesystem removal",
     [](const fs::path& root) { return CleanupDriver(root, "files.draft_cleanup"); }},
    {"files.staging_cleanup", "staging filesystem removal",
     [](const fs::path& root) { return CleanupDriver(root, "files.staging_cleanup"); }},
    {"object.commit", "management object.committed.batch RPC", CommitDriver},
    {"signin.handoff", "session event-store append", SignInDriver},
    {"session.sample", "Browser session snapshot",
     [](const fs::path& root) { return ExecutionDriver(root, false); }},
    {"session.events", "management event publication",
     [](const fs::path& root) { return ExecutionDriver(root, true); }},
    {"session.cold_cleanup", "cold-session filesystem enumeration",
     [](const fs::path& root) { return ColdDriver(root, false); }},
    {"session.cold_delete", "cold-session filesystem removal",
     [](const fs::path& root) { return ColdDriver(root, true); }},
    {"checkpoint.journal", "checkpoint journal filesystem",
     [](const fs::path& root) { return CacheWorkerDriver(root, true); }},
    {"checkpoint.staging", "object pre-stage queue",
     [](const fs::path& root) { return CacheWorkerDriver(root, false); }},
    {"peer.accept", "TCP listener accept", AcceptDriver, false, true},
    {"navigation.final_export", "Browser final export RPC", FinalExportDriver},
    {"object.source", "encrypted object peer", SourceDriver},
    {"browser.connection", "SDK Browser connect",
     [](const fs::path& root) { return SessionDriver(root, "browser.connection"); }, true},
    {"session.convergence", "session execution stop",
     [](const fs::path&) { return CoordinatorDriver("session.convergence"); }},
    {"session.maintenance", "session execution maintenance",
     [](const fs::path&) { return CoordinatorDriver("session.maintenance"); }},
    {"session.observation", "session execution observation",
     [](const fs::path&) { return CoordinatorDriver("session.observation"); }},
    {"session.signals", "session execution signal flush",
     [](const fs::path&) { return CoordinatorDriver("session.signals"); }},
    {"camera.delivery", "SDK camera send", [](const fs::path&) { return CameraDriver(); }, true},
    {"clipboard.sync", "Browser clipboard poll",
     [](const fs::path& root) { return SessionDriver(root, "clipboard.sync"); }},
    {"output.reconcile", "Browser output configure RPC",
     [](const fs::path& root) { return SessionDriver(root, "output.reconcile"); }},
    {"node.metrics", "management metrics publisher", MetricsDriver},
    {"download.persistence", "download journal store",
     [](const fs::path&) { return DownloadPersistenceDriver(false); }},
    {"download.failure_handoff", "download failure outbox transaction",
     [](const fs::path&) { return DownloadPersistenceDriver(true); }},
    {"document.persistence", "document job record store", DocumentPersistenceDriver},
    {"checkpoint.claims", "management object.claims.refresh RPC",
     [](const fs::path& root) { return CacheDriver(root, true); }},
    {"checkpoint.prestage", "management object.committed.batch RPC",
     [](const fs::path& root) { return CacheDriver(root, false); }},
    {"cluster.reconnect", "management connector",
     [](const fs::path&) { return ReconnectDriver(); }},
    {"control.delivery", "SDK control send",
     [](const fs::path&) { return DeliveryDriver("control.delivery"); }, true},
    {"files.delivery", "SDK file send",
     [](const fs::path&) { return DeliveryDriver("files.delivery"); }, true},
    {"surface.delivery", "SDK surface send",
     [](const fs::path&) { return DeliveryDriver("surface.delivery"); }, true},
    {"files.maintenance", "file-service sweep",
     [](const fs::path&) { return MaintenanceDriver(); }},
    {"navigation.recovery", "Browser import/status RPC",
     [](const fs::path& root) { return SessionDriver(root, "navigation.recovery"); }},
    {"storage.scavenge", "Browser storage RPC",
     [](const fs::path& root) { return SessionDriver(root, "storage.scavenge"); }},
    {"signin.fetch", "Browser sign-in poll RPC",
     [](const fs::path& root) { return SessionDriver(root, "signin.fetch"); }},
    {"browser.health", "Browser output status RPC",
     [](const fs::path& root) { return SessionDriver(root, "browser.health"); }, false, false,
     true},
    {"navigation.export", "Browser navigation RPC",
     [](const fs::path&) { return ExportDriver(false); }},
    {"navigation.transfer_cleanup", "Browser cancellation RPC",
     [](const fs::path&) { return ExportDriver(true); }},
    {"download.import", "immutable object import",
     [](const fs::path& root) { return DownloadDriver(root, false); }},
    {"download.cleanup", "Browser download remove/ack RPC",
     [](const fs::path& root) { return DownloadDriver(root, true); }},
    {"document.convert", "management object.derivation RPC", DocumentDriver},
    {"context_menu.fetch", "Browser context-menu RPC",
     [](const fs::path&) { return MenuDriver(); }},
};
void VerifyOwnerCoverage() {
  std::set<std::string> owners{"input.admission", "files.admission", "rpc.admission"};
  for (const auto& entry : kOwners) {
    Check(bool(entry.create), std::string(entry.name) + ": owner driver required");
    Check(owners.insert(entry.name).second, std::string(entry.name) + ": duplicate owner driver");
  }
  std::string missing;
  for (const auto& entry : kLoops)
    if (!owners.contains(entry.name))
      missing += std::string(entry.name) + " ";
  Check(missing.empty(), "native loops without real owner drivers: " + missing);
}
void Matrix(const Entry& entry, const fs::path& root) {
  for (const auto code : {ErrorCode::kBusy, ErrorCode::kRateLimited, ErrorCode::kUnavailable,
                          ErrorCode::kConflict, ErrorCode::kOutcomeUnknown, ErrorCode::kNotFound,
                          ErrorCode::kInvalidRequest, ErrorCode::kInternal, ErrorCode::kRejected,
                          ErrorCode::kLimitExceeded, ErrorCode::kForbidden, ErrorCode::kLocked,
                          ErrorCode::kUnauthenticated, ErrorCode::kCanceled}) {
    if (entry.health_probe && code != ErrorCode::kUnavailable && code != ErrorCode::kOutcomeUnknown)
      continue;
    if (entry.sdk_send && !SdkSendCode(code)) {
      for (int status = REMOTEKIT_SDK_INVALID_ARGUMENT; status <= REMOTEKIT_SDK_REFUSED; ++status)
        Check(SdkErrorCode(status) != code, std::string(entry.name) + ": unreachable SDK code");
      continue;
    }
    NativeRetryClock clock;
    const auto name = std::string(entry.name) + ":" + std::string(ErrorCodeName(code));
    auto driver = entry.create(root / name.substr(name.find(':') + 1));
    const Error injected{code, "injected owner boundary failure"};
    driver.boundary->Inject(injected);
    Capture logs(root / (std::string(ErrorCodeName(code)) + ".jsonl"));
    driver.tick();
    Check(driver.boundary->Attempts().size() == 1, name + ": first real boundary attempt");
    const auto identity = driver.boundary->Attempts().front().identity;
    if (entry.readiness_busy && code == ErrorCode::kBusy) {
      Check(driver.state().Status() == RetryUnit::State::kIdle,
            "readiness timeout does not start a failure streak");
      driver.tick();
      Check(driver.boundary->Attempts().size() == 2,
            "listener continues transport readiness progress");
      Check(logs.Count(std::string(entry.name) + "_failed") == 0,
            "readiness progress is not logged as failure");
      continue;
    }
    const auto retryable = RetryDelay(injected, 0).has_value();
    if (driver.retired()) {
      Check(!retryable, name + ": transient work must remain owned");
      continue;
    }
    Check(driver.surfaced(), name + ": failure is recorded by owner");
    const auto first_state = driver.state().Status();
    Check(driver.state().Attempt() == 1, name + ": owner records first failure");
    if (retryable) {
      Check(first_state == RetryUnit::State::kWaiting, name + ": waiting");
      auto deadline = driver.state().Until();
      const auto first_delay = deadline - RetryClock::now();
      clock.Set(deadline - 1ms);
      driver.tick();
      Check(driver.boundary->Attempts().size() == 1, name + ": no attempt before deadline");
      clock.Set(deadline);
      driver.tick();
      Check(driver.boundary->Attempts().size() == 2, name + ": attempt at deadline");
      Check(driver.boundary->Attempts().back().at == deadline, name + ": mocked clock boundary");
      if (code == ErrorCode::kOutcomeUnknown) {
        auto actual = driver.boundary->Attempts().back().identity;
        auto expected = identity;
        if (entry.name == std::string_view("navigation.export") ||
            entry.name == std::string_view("navigation.final_export")) {
          actual.erase("method");
          expected.erase("method");
        }
        Check(actual == expected, name + ": uncertain operation retains identity");
      }
      Check(driver.state().Until() - deadline >= first_delay,
            name + ": retry delay grows or honors fixed hint");
      deadline = driver.state().Until();
      clock.Set(deadline);
      driver.tick();
      Check(driver.boundary->Attempts().size() == 3, name + ": third owner attempt");
      clock.Set(driver.state().Until());
    } else {
      Check(first_state == (code == ErrorCode::kNotFound || code == ErrorCode::kCanceled
                                ? RetryUnit::State::kDropped
                                : RetryUnit::State::kFaulted),
            name + ": final owner disposition");
      clock.Advance(24h);
      driver.tick();
      Check(driver.boundary->Attempts().size() == 1, name + ": final failure cannot loop");
      driver.boundary->Inject({});
      driver.change();
    }
    driver.boundary->Inject({});
    const auto calls = driver.boundary->Attempts().size();
    for (unsigned phase = 0; phase < 5; ++phase)
      driver.tick();
    Check(driver.boundary->Attempts().size() > calls, name + ": owner recovers");
    if (!driver.retired())
      Check(driver.state().Attempt() == 0, name + ": success resets owner attempts");
    if (retryable) {
      const auto event = entry.name == std::string_view("download.cleanup") ? "download.import"
                         : entry.name == std::string_view("navigation.final_export")
                             ? "navigation.export"
                             : entry.name;
      Check(logs.Count(std::string(event) + "_failed") == 1, name + ": one failure log per streak");
      Check(logs.Count(std::string(event) + "_recovered") == 1, name + ": one recovered log");
    }
  }
}
void PreviousDocumentJob() {
  const Json previous{{"version", 1},
                      {"buildId", "build"},
                      {"retry",
                       {{"state", "faulted"},
                        {"attempt", 1},
                        {"retryAt", 0},
                        {"input", "source:tenant:build"},
                        {"error", {{"code", "rejected"}, {"message", "unsupported"}}}}}};
  Check(Take(document_job_formats::Decode(previous.dump())) == previous,
        "existing document-job format decodes through migration module");
}
void BrowserHealthReplies(const fs::path& root) {
  NativeRetryClock clock;
  SessionFixture fixture(root, "browser.health");
  Capture healthy_logs(root / "application-replies.jsonl");
  for (const auto code : {ErrorCode::kBusy, ErrorCode::kRateLimited, ErrorCode::kConflict,
                          ErrorCode::kNotFound, ErrorCode::kInvalidRequest, ErrorCode::kInternal,
                          ErrorCode::kRejected, ErrorCode::kLimitExceeded, ErrorCode::kForbidden,
                          ErrorCode::kLocked, ErrorCode::kUnauthenticated, ErrorCode::kCanceled}) {
    NativeRetryOwnerProbe::HealthProbeDue(fixture.owner);
    browser_dispatch = [code](Json request) -> Result<Json> {
      Check(request.at("method") == "output.status", "real health probe boundary");
      return Error{code, code == ErrorCode::kConflict ? "output_not_open" : "application reply"};
    };
    Check(bool(NativeRetryOwnerProbe::Health(fixture.owner)),
          "application reply proves Browser health");
    Check(fixture.Status().Status() == RetryUnit::State::kIdle && fixture.Status().Attempt() == 0,
          "application reply does not start health retry streak");
  }
  Check(healthy_logs.Count("browser.health_failed") == 0 &&
            healthy_logs.Count("browser.health_recovered") == 0,
        "application replies produce no health retry logs");
  NativeRetryOwnerProbe::HealthProbeDue(fixture.owner);
  browser_dispatch = [](Json) -> Result<Json> {
    return Json{{"output", {{"error", "gpu_failed"}, {"message", "output failed"}}}};
  };
  const auto failed = NativeRetryOwnerProbe::Health(fixture.owner);
  Check(!failed && failed.error().reason == ErrorReason::kOutputFailed,
        "success envelope output.error remains an output failure");
  Check(fixture.Status().Status() == RetryUnit::State::kWaiting,
        "output failure starts health backoff");
}
}  // namespace
int main(int argc, char** argv) try {
  if (argc > 1 && std::string_view(argv[1]) == "--hold") {
    Sleep(60000);
    return 0;
  }
  Check(argc == 3 || argc == 4, "evidence directory and repository root required");
  RegistryGuard(fs::absolute(argv[2]));
  const std::string_view selected = argc == 4 ? argv[3] : "";
  if (selected == "--registry")
    return 0;
  const auto root =
      fs::absolute(argv[1]) / ("retry-owners-" + std::to_string(GetCurrentProcessId()));
  fs::create_directories(root);
  PreviousDocumentJob();
  if (selected.empty() || selected == "browser.health")
    BrowserHealthReplies(root / "health-replies");
  for (const auto code : {ErrorCode::kBusy, ErrorCode::kRateLimited, ErrorCode::kUnavailable,
                          ErrorCode::kConflict, ErrorCode::kOutcomeUnknown, ErrorCode::kNotFound,
                          ErrorCode::kInvalidRequest, ErrorCode::kInternal, ErrorCode::kRejected,
                          ErrorCode::kLimitExceeded, ErrorCode::kForbidden, ErrorCode::kLocked,
                          ErrorCode::kUnauthenticated, ErrorCode::kCanceled}) {
    if (!selected.empty() && selected != "input.admission" && selected != "rpc.admission" &&
        selected != "files.admission")
      break;
    Capture logs(root / ("input-" + std::string(ErrorCodeName(code)) + ".jsonl"));
    InputOwnerCase(code);
    if (code == ErrorCode::kBusy) {
      Check(logs.Count("input.admission_failed") == 1, "one BUSY input failure log per streak");
      Check(logs.Count("input.admission_recovered") == 1, "one BUSY input recovery log");
    }
    logs.Finish();
    for (const bool files : {false, true}) {
      const std::string unit = files ? "files.admission" : "rpc.admission";
      Capture receipts(root / (unit + "-" + std::string(ErrorCodeName(code)) + ".jsonl"));
      ReceiptOwnerCase(files, code);
      Check(receipts.Count(unit + "_failed") == (code == ErrorCode::kCanceled ? 0 : 1),
            "one admission failure log per streak");
      if (code == ErrorCode::kBusy || code == ErrorCode::kRateLimited ||
          code == ErrorCode::kUnavailable)
        Check(receipts.Count(unit + "_recovered") == 1, "one admission recovery log");
    }
  }
  for (const auto& entry : kOwners) {
    if (!selected.empty() && selected != entry.name)
      continue;
    fs::create_directories(root / entry.name);
    Matrix(entry, root / entry.name);
  }
  fs::remove_all(root);
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
