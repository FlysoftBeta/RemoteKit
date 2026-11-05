#pragma once
#include "common.hpp"
#include "remotekit/error.hpp"
#include <windows.h>

namespace remotekit {
class BrowserProcess {
 public:
  enum class State { kStopped, kLaunching, kRunning, kStopping, kExited };
  ~BrowserProcess();
  Result<void> Launch(const fs::path& executable, std::wstring command);
  Result<void> Terminate();
  void ReleaseExited();
  bool Alive() const;
  bool Exited() const;
  bool Present() const { return process_ || job_; }
  DWORD Pid() const { return process_ ? GetProcessId(process_) : 0; }
  State state() const;
  std::string Diagnostic() const;
  static std::wstring Quote(const std::wstring& value);

 private:
  HANDLE process_ = nullptr, job_ = nullptr;
  bool assigned_ = false;
  mutable State state_ = State::kStopped;
};
}  // namespace remotekit
