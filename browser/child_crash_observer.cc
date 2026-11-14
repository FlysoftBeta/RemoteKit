#include "browser/child_crash_observer.h"

#include "base/command_line.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/task/thread_pool.h"
#include "base/threading/platform_thread.h"
#include "browser/diagnostic_log.h"
#include "content/public/browser/child_process_data.h"
#include "content/public/browser/browser_child_process_host.h"
#include "content/public/browser/child_process_termination_info.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/common/process_type.h"
#include "content/public/common/result_codes.h"

namespace remotekit::browser {
namespace {
const char* Reason(base::TerminationStatus status) {
  switch (status) {
    case base::TERMINATION_STATUS_PROCESS_CRASHED:
      return "crashed";
    case base::TERMINATION_STATUS_OOM:
      return "oom";
    case base::TERMINATION_STATUS_LAUNCH_FAILED:
      return "launch_failed";
    case base::TERMINATION_STATUS_ABNORMAL_TERMINATION:
      return "abnormal_exit";
    case base::TERMINATION_STATUS_PROCESS_WAS_KILLED:
      return "killed";
    case base::TERMINATION_STATUS_INTEGRITY_FAILURE:
      return "integrity_failure";
    default:
      return nullptr;
  }
}

const char* CodeName(uint32_t code) {
  switch (code) {
    case 0xC0000005:
      return "EXCEPTION_ACCESS_VIOLATION";
    case 0xC00000FD:
      return "EXCEPTION_STACK_OVERFLOW";
    case 0xC0000374:
      return "STATUS_HEAP_CORRUPTION";
    case 0xC0000409:
      return "STATUS_STACK_BUFFER_OVERRUN";
    case 0x80000003:
      return "EXCEPTION_BREAKPOINT";
    case 0xE0000008:
      return "STATUS_NO_MEMORY";
    case 0xC0000017:
      return "STATUS_NO_MEMORY";
    case 0xC000001D:
      return "EXCEPTION_ILLEGAL_INSTRUCTION";
    default:
      return nullptr;
  }
}

void FindDumpAndLog(base::DictValue fields,
                    base::Time observed,
                    base::FilePath crash_directory,
                    base::FilePath log_root) {
  const auto deadline = base::TimeTicks::Now() + base::Milliseconds(1900);
  if (!crash_directory.empty()) {
    do {
      base::FilePath newest;
      base::Time newest_time;
      base::FileEnumerator files(crash_directory, true, base::FileEnumerator::FILES,
                                 FILE_PATH_LITERAL("*.dmp"));
      for (auto path = files.Next(); !path.empty(); path = files.Next()) {
        if (base::TimeTicks::Now() >= deadline)
          break;
        base::File::Info info;
        if (base::GetFileInfo(path, &info) && info.creation_time >= observed &&
            info.creation_time > newest_time) {
          newest = path;
          newest_time = info.creation_time;
        }
      }
      if (!newest.empty()) {
        base::FilePath relative;
        if (log_root.AppendRelativePath(newest, &relative))
          fields.Set("dump", relative.NormalizePathSeparatorsTo(L'/').AsUTF8Unsafe());
        break;
      }
      if (base::TimeTicks::Now() + base::Milliseconds(100) > deadline)
        break;
      base::PlatformThread::Sleep(base::Milliseconds(100));
    } while (base::TimeTicks::Now() < deadline);
  }
  LogEvent("error", "process.crashed", std::move(fields));
}

void RecordExit(std::string process,
                base::ProcessId pid,
                const content::ChildProcessTerminationInfo& info) {
  const auto* reason = Reason(info.status);
  if (!reason)
    return;
  // Content uses these exit codes when it explicitly terminates a child.
  if (info.status != base::TERMINATION_STATUS_LAUNCH_FAILED &&
      (info.exit_code == content::RESULT_CODE_NORMAL_EXIT ||
       info.exit_code == content::RESULT_CODE_HUNG ||
       info.exit_code == content::RESULT_CODE_KILLED_BAD_MESSAGE))
    return;
  const auto observed = base::Time::Now();
  base::DictValue fields;
  fields.Set("process", std::move(process));
  fields.Set("pid", static_cast<double>(pid));
  fields.Set("code", static_cast<double>(static_cast<uint32_t>(info.exit_code)));
  fields.Set("reason", reason);
  if (const auto* name = CodeName(static_cast<uint32_t>(info.exit_code)))
    fields.Set("codeName", name);
  const auto& command = *base::CommandLine::ForCurrentProcess();
  base::ThreadPool::PostTask(FROM_HERE,
                             {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN},
                             base::BindOnce(FindDumpAndLog, std::move(fields), observed,
                                            command.GetSwitchValuePath("crash-dir"),
                                            command.GetSwitchValuePath("log-dir")));
}

std::string ProcessName(int type) {
  switch (type) {
    case content::PROCESS_TYPE_GPU:
      return "gpu";
    case content::PROCESS_TYPE_UTILITY:
      return "utility";
    default:
      return content::GetProcessTypeNameInEnglish(type);
  }
}
}  // namespace

ChildCrashObserver::ChildCrashObserver() {
  Add(this);
}

ChildCrashObserver::~ChildCrashObserver() {
  Remove(this);
  for (const auto& [host, renderer] : renderers_)
    host->RemoveObserver(this);
}

ChildCrashObserver::ProcessState& ChildCrashObserver::Track(content::RenderProcessHost* host) {
  auto [it, inserted] = renderers_.try_emplace(host);
  if (inserted)
    host->AddObserver(this);
  return it->second;
}

void ChildCrashObserver::OnRenderProcessHostCreated(content::RenderProcessHost* host) {
  Track(host) = {};
}

void ChildCrashObserver::OnRenderProcessLaunched(content::RenderProcessHost* host) {
  Track(host).pid = host->GetProcess().Pid();
}

void ChildCrashObserver::OnRenderProcessHostCreationFailed(
    content::RenderProcessHost* host,
    const content::ChildProcessTerminationInfo& info) {
  RenderProcessExited(host, info);
}

void ChildCrashObserver::RenderProcessExited(content::RenderProcessHost* host,
                                             const content::ChildProcessTerminationInfo& info) {
  auto& renderer = Track(host);
  if (renderer.reported || host->ShutdownRequested() || host->FastShutdownStarted())
    return;
  renderer.reported = true;
  RecordExit("renderer", renderer.pid, info);
}

void ChildCrashObserver::RenderProcessHostDestroyed(content::RenderProcessHost* host) {
  host->RemoveObserver(this);
  renderers_.erase(host);
}

void ChildCrashObserver::BrowserChildProcessLaunchedAndConnected(
    const content::ChildProcessData& data,
    const base::Process& process) {
  children_[data.GetChildProcessId()].pid = process.Pid();
}

void ChildCrashObserver::BrowserChildProcessHostDisconnected(
    const content::ChildProcessData& data) {
  children_.erase(data.GetChildProcessId());
}

void ChildCrashObserver::ChildExited(const content::ChildProcessData& data,
                                     const content::ChildProcessTerminationInfo& info) {
  auto& child = children_[data.GetChildProcessId()];
  if (child.reported)
    return;
  child.reported = true;
  if (!child.pid) {
    auto* host = content::BrowserChildProcessHost::FromID(data.GetChildProcessId());
    if (host && host->GetProcess().IsValid())
      child.pid = host->GetProcess().Pid();
  }
  RecordExit(ProcessName(data.process_type), child.pid, info);
}

void ChildCrashObserver::BrowserChildProcessCrashed(
    const content::ChildProcessData& data,
    const content::ChildProcessTerminationInfo& info) {
  ChildExited(data, info);
}

void ChildCrashObserver::BrowserChildProcessKilled(
    const content::ChildProcessData& data,
    const content::ChildProcessTerminationInfo& info) {
  ChildExited(data, info);
}

void ChildCrashObserver::BrowserChildProcessExitedNormally(
    const content::ChildProcessData& data,
    const content::ChildProcessTerminationInfo& info) {
  // Content also delivers OOM and integrity failures through this callback.
  ChildExited(data, info);
}

void ChildCrashObserver::BrowserChildProcessLaunchFailed(
    const content::ChildProcessData& data,
    const content::ChildProcessTerminationInfo& info) {
  ChildExited(data, info);
}
}  // namespace remotekit::browser
