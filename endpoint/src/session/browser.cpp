#include "session/browser.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include "diagnostics/log_files.hpp"
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
  const auto dumps = RecentCrashDumps(log_.parent_path() / "crashes");
  const Json event = {{"event", "browser_crashed"},
                      {"timestamp", std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::system_clock::now().time_since_epoch())
                                        .count()},
                      {"pid", Pid()},
                      {"browserIncarnation", process_incarnation_},
                      {"exitCode", *code},
                      {"exitCodeDescription", DescribeExitCode(*code)},
                      {"fatal", fatal.empty() ? Json(nullptr) : Json(fatal)},
                      {"dumpPath", dumps.empty() ? Json(nullptr) : Json(Utf8(dumps.front()))}};
  const auto encoded = event.dump();
  fprintf(stderr, "%s\n", encoded.c_str());
  const auto directory = log_.parent_path() / "crashes";
  std::error_code error;
  fs::create_directories(directory, error);
  std::ofstream events(directory / "events.jsonl", std::ios::binary | std::ios::app);
  events << encoded << '\n';
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
        Error{ErrorCode::kUnavailable,
              "Browser 进程退出，退出码 " + DescribeExitCode(*code) + "；日志 " + Utf8(log_)};
  if (!start_policy_.Admit(double(QpcNow()) / QpcFrequency())) {
    std::string message = start_policy_.attempts() >= 3 ? "Browser 启动连续失败，已停止自动重启"
                                                        : "Browser 启动失败，正在等待重试退避";
    if (last_failure_)
      message += "；最近一次失败：" + last_failure_->message;
    return Unavailable(std::move(message));
  }
  startup_error_.reset();
  return {};
}
Result<void> BrowserRuntime::HealthCheck() {
  if (startup_error_)
    return startup_error_->reason == ErrorReason::kNone ? Unavailable(startup_error_->message)
                                                        : *startup_error_;
  if (!rpc_.Control())
    return Unavailable("Browser 进程仍在运行，控制管道尚未就绪");
  if (rpc_.NeedsHealthCheck()) {
    // A bounded health check never authorizes killing a live connected Browser.
    auto reply = rpc_.Request({{"method", "snapshot"}}, 0, 1000);
    if (!reply)
      return reply.error();
  }
  const auto now = QpcNow();
  if (now >= next_health_check_) {
    next_health_check_ = now + QpcFrequency();
    auto status = rpc_.Request({{"method", "output.status"}}, 0, 1000);
    if (!status && status.error().code == ErrorCode::kOutcomeUnknown)
      return status.error();
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
  process_incarnation_ = incarnation_;
  crash_recorded_ = false;
  auto launched = process_.Launch(executable, std::move(command), profile_key_);
  if (!launched)
    return launched.error();
  clean_shutdown_ = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (process_.Alive() && std::chrono::steady_clock::now() < deadline) {
    auto connected = rpc_.Connect(channel);
    if (connected)
      return {};
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (!process_.Alive()) {
    const auto code = process_.ExitCode();
    startup_error_ = Error{ErrorCode::kUnavailable, "Browser 进程在控制管道就绪前退出，退出码 " +
                                                        (code ? DescribeExitCode(*code) : "未知") +
                                                        "；日志 " + Utf8(log_)};
  } else {
    startup_error_ =
        Error{ErrorCode::kUnavailable, "Browser 控制管道在 15 秒内未就绪；保留仍在运行的进程，" +
                                           process_.Diagnostic() + "；日志 " + Utf8(log_)};
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
  if (!process_.Present()) {
    if (!clean_shutdown_)
      return Error{ErrorCode::kUnavailable, "unclean Browser shutdown"};
    return {};
  }
  bool clean = false;
  if (process_.Alive() && rpc_.Control()) {
    const auto exported = export_navigation();
    const auto shutdown = rpc_.Request({{"method", "browser.shutdown"}}, 0, 1000);
    clean = process_.WaitCleanExit(30000) && bool(exported) && bool(shutdown);
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
}  // namespace remotekit

namespace remotekit {
Result<void> BrowserRuntime::Launch(const RuntimeOptions& options,
                                    const std::string& id,
                                    const fs::path& directory,
                                    const StreamingAdapter& adapter,
                                    const std::shared_ptr<media::ServerTrace>& trace) {
  log_ = directory / "browser.log";
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
  append(L"--atlas-width=1920");
  append(L"--atlas-height=1080");
  if (!options.browser_trace_directory.empty()) {
    RK_RETURN_IF_ERROR(CreateDirectories(options.browser_trace_directory));
    const auto file = options.browser_trace_directory /
                      ("session-" + id + "-" + std::to_string(QpcNow()) + ".json");
    append(
        L"--trace-startup=gpu.capture,viz,gpu,toplevel,toplevel.flow,disabled-by-default-gpu."
        L"service,disabled-by-default-gpu.device");
    append(L"--trace-startup-duration=16");
    append(L"--trace-startup-format=json");
    append(L"--trace-startup-file=" + file.wstring());
    append(L"--trace-startup-record-mode=record-until-full");
    append(L"--default-trace-buffer-size-limit-in-kb=32768");
  }
  fprintf(stderr, "session %s browser command %s\n", id.c_str(), Utf8(fs::path(command)).c_str());
  auto started = Start(options.browser, std::move(command), channel);
  if (!started)
    return started.error();
  Rpc().SetTrace(trace, Pid());

  return {};
}
}  // namespace remotekit
