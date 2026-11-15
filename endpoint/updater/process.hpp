#pragma once
#include "platform.hpp"
#include "util/log.hpp"
#include <thread>
namespace remotekit::updater {
class ChildProcess {
 public:
  ChildProcess(const fs::path& executable,
               const std::wstring& arguments,
               const fs::path& root,
               std::string child,
               bool job,
               const std::wstring& environment = L"",
               bool capture_stdout = true);
  ~ChildProcess();
  ChildProcess(const ChildProcess&) = delete;
  ChildProcess& operator=(const ChildProcess&) = delete;
  HANDLE handle() const { return child_.value; }
  DWORD ExitCode() const;
  DWORD Pid() const { return GetProcessId(child_.value); }
  // Closes stdin and waits for a graceful exit; killing it after the timeout is abnormal.
  void Stop(DWORD timeout);
  // Ends the child immediately as its intended way of stopping.
  void Terminate();

 private:
  enum class Ending { kSelf, kTerminated, kStopTimedOut };
  void Kill();

  Handle child_, input_, output_, error_, job_;
  Ending ending_ = Ending::kSelf;
  std::string child_name_;
  std::thread forwarding_, errors_;
};
}  // namespace remotekit::updater
