#pragma once
#include "logging.hpp"
#include <thread>
namespace remotekit::updater {
class ChildProcess {
 public:
  ChildProcess(const fs::path& executable,
               const std::wstring& arguments,
               const fs::path& root,
               Log& log,
               bool job,
               const std::wstring& environment = L"");
  ~ChildProcess();
  ChildProcess(const ChildProcess&) = delete;
  ChildProcess& operator=(const ChildProcess&) = delete;
  HANDLE handle() const { return child_.value; }
  DWORD ExitCode() const;
  void Stop(DWORD timeout);

 private:
  Handle child_, input_, output_, job_;
  std::thread forwarding_;
};
}  // namespace remotekit::updater
