#include "session/browser.hpp"
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
