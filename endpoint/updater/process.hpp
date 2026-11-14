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
  void Stop(DWORD timeout);

 private:
  Handle child_, input_, output_, error_, job_;
  std::string child_name_;
  std::thread forwarding_, errors_;
};
}  // namespace remotekit::updater
