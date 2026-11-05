#include "session/browser.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include <chrono>
#include <objbase.h>
#include <thread>

namespace remotekit {
Result<void> BrowserRuntime::NewIncarnation() {
  if (process_.Present())
    return Error{ErrorCode::kConflict, "browser process is retained"};
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
  auto launched = process_.Launch(executable, std::move(command));
  if (!launched)
    return launched.error();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (process_.Alive() && std::chrono::steady_clock::now() < deadline) {
    auto connected = rpc_.Connect(channel);
    if (connected)
      return {};
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  return Error{ErrorCode::kUnavailable, "browser control connect failed " + process_.Diagnostic()};
}
Result<void> BrowserRuntime::Stop() {
  incarnation_.clear();
  rpc_.Invalidate();
  return process_.Terminate();
}
}  // namespace remotekit

namespace remotekit {
Result<void> BrowserRuntime::Launch(const RuntimeOptions& options,
                                    const std::string& id,
                                    const fs::path& directory,
                                    const StreamingAdapter& adapter,
                                    const std::shared_ptr<media::ServerTrace>& trace) {
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
  append(L"--session-id=" + std::wstring(id.begin(), id.end()));
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
