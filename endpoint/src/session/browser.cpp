#include "util/log.hpp"
#include "session/browser.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include "diagnostics/log_files.hpp"
#include "persistence/phase_timing.hpp"
#include <fstream>
#include <sstream>
#include <chrono>
#include <objbase.h>
#include <thread>

namespace remotekit {
void BrowserRuntime::RecordCrash() {
  const auto code = process_.ExitCode();
  if (!code || *code == 0 || crash_recorded_)
    return;
  crash_recorded_ = true;
  std::ifstream log(log_, std::ios::binary);
  log.seekg(0, std::ios::end);
  const auto size = log.tellg();
  if (size > 0)
    log.seekg(std::max<std::streamoff>(0, std::streamoff(size) - 16 * 1024 * 1024));
  std::string fatal, line;
  while (std::getline(log, line)) {
    if (line.find("FATAL") != std::string::npos || line.find("Check failed") != std::string::npos)
      fatal = line.substr(0, 16384);
  }
  const auto dumps = RecentCrashDumps(crash_directory_);
  const Json event = {{"timestamp", std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::system_clock::now().time_since_epoch())
                                        .count()},
                      {"pid", Pid()},
                      {"browserIncarnation", process_incarnation_},
                      {"exitCode", *code},
                      {"exitCodeDescription", DescribeExitCode(*code)},
                      {"fatal", fatal.empty() ? Json(nullptr) : Json(fatal)},
                      {"dumpPath", dumps.empty() ? Json(nullptr) : Json(Utf8(dumps.front()))}};
  const auto encoded = FormatLogRecord(LogLevel::kError, "browser.crashed", event);
  LogEvent(LogLevel::kError, "browser.crashed", event);
  const auto directory = crash_directory_;
  std::error_code error;
  fs::create_directories(directory, error);
  std::ofstream events(directory / "events.jsonl", std::ios::binary | std::ios::app);
  events << encoded;
}

Error BrowserRuntime::Unavailable(std::string detail) const {
  const auto code = process_.ExitCode();
  return {ErrorCode::kUnavailable, std::move(detail),
          crash_recorded_ || (code && *code != 0) ? ErrorReason::kBrowserCrashed
                                                  : ErrorReason::kBrowserRestarting};
}

Result<void> BrowserRuntime::AdmitLaunch() {
  RecordCrash();
  if (const auto code = process_.ExitCode(); code && *code != 0)
    last_failure_ =
        Error{ErrorCode::kUnavailable, "Browser process exited with code " +
                                           DescribeExitCode(*code) + "; log: " + Utf8(log_)};
  if (!start_policy_.Admit(double(QpcNow()) / QpcFrequency())) {
    std::string message = start_policy_.attempts() >= 3 ? "Browser restart attempts exhausted"
                                                        : "Browser restart backoff pending";
    if (last_failure_)
      message += "; last failure: " + last_failure_->message;
    return Unavailable(std::move(message));
  }
  startup_error_.reset();
  return {};
}
Result<void> BrowserRuntime::HealthCheck() {
  if (startup_error_)
    return *startup_error_;
  if (!rpc_.Control())
    return Unavailable("Browser process is alive; control channel is not ready");
  if (rpc_.NeedsHealthCheck()) {
    // A bounded health check never authorizes killing a live connected Browser.
    auto reply = rpc_.Request({{"method", "snapshot"}}, 0, 1000);
    if (!reply)
      return Unavailable("Browser health probe failed: " + reply.error().message);
  }
  const auto now = QpcNow();
  if (now >= next_health_check_) {
    next_health_check_ = now + QpcFrequency();
    auto status = rpc_.Request({{"method", "output.status"}}, 0, 1000);
    if (!status && status.error().code == ErrorCode::kOutcomeUnknown)
      return Unavailable("Browser output health probe failed: " + status.error().message);
    if (status && status.value().contains("output")) {
      const auto& output = status.value()["output"];
      if (!output.value("error", std::string()).empty()) {
        startup_error_ = Error{ErrorCode::kUnavailable,
                               output.value("message", output["error"].get<std::string>()),
                               ErrorReason::kOutputFailed};
        last_failure_ = startup_error_;
        return *startup_error_;
      }
    }
  }
  start_policy_.Healthy(double(now) / QpcFrequency());
  return {};
}
Result<void> BrowserRuntime::NewIncarnation() {
  if (process_.Present())
    return Error{ErrorCode::kConflict, "browser process is retained"};
  initialized_ = false;
  GUID value{};
  if (FAILED(CoCreateGuid(&value)))
    return Error{ErrorCode::kUnavailable, "browser incarnation generation failed"};
  const auto* bytes = reinterpret_cast<const unsigned char*>(&value);
  incarnation_.clear();
  for (size_t i = 0; i < sizeof(value); ++i) {
    incarnation_ += "0123456789abcdef"[bytes[i] >> 4];
    incarnation_ += "0123456789abcdef"[bytes[i] & 15];
  }
  return {};
}
Result<void> BrowserRuntime::Start(const fs::path& executable,
                                   std::wstring command,
                                   const std::string& channel) {
  const auto started = PhaseClock::now();
  launch_started_ = QpcNow();
  {
    std::lock_guard lock(presented_mutex_);
    restored_views_.clear();
    wake_tenant_ = open_timing_.value("tenantId", std::string());
  }
  process_incarnation_ = incarnation_;
  crash_recorded_ = false;
  auto launched = process_.Launch(executable, std::move(command), profile_key_);
  if (!launched)
    return launched.error();
  clean_shutdown_ = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (process_.Alive() && std::chrono::steady_clock::now() < deadline) {
    auto connected = rpc_.Connect(channel);
    if (connected) {
      OpenPhase("browserLaunch", PhaseMs(started));
      return {};
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (!process_.Alive()) {
    const auto code = process_.ExitCode();
    startup_error_ =
        Error{ErrorCode::kUnavailable,
              "Browser exited before control channel became ready; exit code " +
                  (code ? DescribeExitCode(*code) : "unknown") + "; log: " + Utf8(log_)};
  } else {
    startup_error_ = Error{
        ErrorCode::kUnavailable,
        "Browser control channel did not become ready within 15 seconds; retained live process: " +
            process_.Diagnostic() + "; log: " + Utf8(log_)};
  }
  last_failure_ = startup_error_;
  RecordCrash();
  return Unavailable(startup_error_->message);
}
Result<void> BrowserRuntime::Stop() {
  RecordCrash();
  if (process_.Present())
    clean_shutdown_ = false;
  incarnation_.clear();
  rpc_.Invalidate();
  return process_.Terminate();
}
Result<void> BrowserRuntime::Shutdown(const std::function<Result<void>()>& export_navigation) {
  shutdown_timing_ = Json::object();
  if (!process_.Present()) {
    if (!clean_shutdown_)
      return Error{ErrorCode::kUnavailable, "unclean Browser shutdown"};
    return {};
  }
  bool clean = false;
  if (process_.Alive() && rpc_.Control()) {
    auto start = PhaseClock::now();
    const auto exported = export_navigation();
    shutdown_timing_["navigationExport"] = PhaseMs(start);
    start = PhaseClock::now();
    const auto shutdown = rpc_.Request({{"method", "browser.shutdown"}}, 0, 1000);
    shutdown_timing_["shutdownRpc"] = PhaseMs(start);
    start = PhaseClock::now();
    clean = process_.WaitCleanExit(30000, &shutdown_timing_) && bool(exported) && bool(shutdown);
    shutdown_timing_["processExitWait"] = PhaseMs(start);
  }
  if (!clean) {
    auto stopped = Stop();
    if (!stopped)
      return stopped.error();
    return Error{ErrorCode::kUnavailable, "unclean Browser shutdown"};
  }
  incarnation_.clear();
  rpc_.Invalidate();
  clean_shutdown_ = true;
  return {};
}
void BrowserRuntime::RestoredView(const std::string& view) {
  std::lock_guard lock(presented_mutex_);
  if (!wake_tenant_.empty())
    restored_views_.try_emplace(view, QpcNow());
}
void BrowserRuntime::Presented(const std::string& view, int64_t at) {
  std::lock_guard lock(presented_mutex_);
  const auto found = restored_views_.find(view);
  if (found == restored_views_.end())
    return;
  const Json event = {{"tenantId", wake_tenant_},
                      {"viewId", view},
                      {"ms", double(at - found->second) * 1000 / QpcFrequency()}};
  LogEvent(LogLevel::kInfo, "session.open.presented", event);
  restored_views_.erase(found);
}
void BrowserRuntime::MarkInitialized() {
  initialized_ = true;
  if (!open_timing_.empty()) {
    const auto now = QpcNow();
    open_timing_["browserReady"] = double(now - launch_started_) * 1000 / QpcFrequency() -
                                   open_timing_.value("browserLaunch", 0.0);
    open_timing_["total"] =
        double(now - open_timing_.value("startedQpc", launch_started_)) * 1000 / QpcFrequency();
    open_timing_.erase("startedQpc");
    {
      const auto event = open_timing_.value("event", std::string("session.open.timing"));
      open_timing_.erase("event");
      LogEvent(LogLevel::kInfo, event, open_timing_);
    }
    open_timing_ = Json::object();
  }
}
}  // namespace remotekit

namespace remotekit {
Result<void> BrowserRuntime::Launch(const RuntimeOptions& options,
                                    const std::string& id,
                                    const fs::path& directory,
                                    const StreamingAdapter& adapter,
                                    const std::shared_ptr<media::ServerTrace>& trace) {
  log_ = options.node_root / "logs/browser" / (id + ".log");
  crash_directory_ = options.node_root / "logs/crashes" / id;
  RK_RETURN_IF_ERROR(CreateDirectories(log_.parent_path()));
  RK_RETURN_IF_ERROR(CreateDirectories(crash_directory_));
  RK_ASSIGN_OR_RETURN(log_exists, FileExists(log_));
  if (log_exists) {
    RK_ASSIGN_OR_RETURN(log_size, FileSize(log_));
    if (log_size > 16 * 1024 * 1024) {
      const auto rotated = fs::path(log_.wstring() + L".1");
      if (!MoveFileExW(log_.c_str(), rotated.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        return WithOsError(ErrorCode::kUnavailable, "cannot rotate Browser log",
                           OsError::Kind::kWin32, GetLastError());
    }
  }
  const auto luid = AdapterLuid(adapter.luid);
  std::string channel = "RemoteKit.service." + std::to_string(GetCurrentProcessId()) + "." + id +
                        "." + std::to_string(QpcNow());
  auto incarnation = NewIncarnation();
  if (!incarnation)
    return incarnation.error();
  std::wstring command = BrowserProcess::Quote(options.browser.wstring());
  auto append = [&](std::wstring arg) { command += L" " + BrowserProcess::Quote(arg); };
  append(L"--use-adapter-luid=" + std::wstring(luid.begin(), luid.end()));
  append(L"--control-channel=" + std::wstring(channel.begin(), channel.end()));
  append(L"--browser-incarnation=" + std::wstring(Incarnation().begin(), Incarnation().end()));
  append(L"--session-id=1");
  append(L"--tenant-id=" + std::wstring(id.begin(), id.end()));
  append(L"--data-path=" + directory.wstring());
  append(L"--log-file=" + log_.wstring());
  append(L"--crash-dir=" + crash_directory_.wstring());
  append(L"--atlas-width=1920");
  append(L"--atlas-height=1080");
#ifndef NDEBUG
  const auto trace_directory = Utf8Path(Env("REMOTEKIT_BROWSER_TRACE_DIR"));
  if (!trace_directory.empty()) {
    if (!trace_directory.is_absolute())
      return Error{ErrorCode::kInvalidRequest,
                   "REMOTEKIT_BROWSER_TRACE_DIR must be an absolute directory"};
    RK_RETURN_IF_ERROR(CreateDirectories(trace_directory));
    const auto file =
        trace_directory / ("session-" + id + "-" + std::to_string(QpcNow()) + ".json");
    append(
        L"--trace-startup=gpu.capture,viz,gpu,toplevel,toplevel.flow,disabled-by-default-gpu."
        L"service,disabled-by-default-gpu.device");
    append(L"--trace-startup-duration=16");
    append(L"--trace-startup-format=json");
    append(L"--trace-startup-file=" + file.wstring());
    append(L"--trace-startup-record-mode=record-until-full");
    append(L"--default-trace-buffer-size-limit-in-kb=32768");
  }
#endif
  LogEvent(LogLevel::kInfo, "browser.launched",
           {{"sessionId", id}, {"command", Utf8(fs::path(command))}});
  auto started = Start(options.browser, std::move(command), channel);
  if (!started)
    return started.error();
  Rpc().SetTrace(trace, Pid());

  return {};
}
}  // namespace remotekit
