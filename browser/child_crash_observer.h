#pragma once

#include <map>

#include "content/public/browser/browser_child_process_observer.h"
#include "content/public/browser/render_process_host_creation_observer.h"
#include "content/public/browser/render_process_host_observer.h"
#include "content/public/common/child_process_id.h"

namespace remotekit::browser {
class ChildCrashObserver final : public content::RenderProcessHostCreationObserver,
                                 public content::RenderProcessHostObserver,
                                 public content::BrowserChildProcessObserver {
 public:
  ChildCrashObserver();
  ~ChildCrashObserver() override;
  void OnRenderProcessHostCreated(content::RenderProcessHost* host) override;
  void OnRenderProcessLaunched(content::RenderProcessHost* host) override;
  void OnRenderProcessHostCreationFailed(content::RenderProcessHost* host,
                                         const content::ChildProcessTerminationInfo& info) override;
  void RenderProcessExited(content::RenderProcessHost* host,
                           const content::ChildProcessTerminationInfo& info) override;
  void RenderProcessHostDestroyed(content::RenderProcessHost* host) override;
  void BrowserChildProcessLaunchedAndConnected(const content::ChildProcessData& data,
                                               const base::Process& process) override;
  void BrowserChildProcessHostDisconnected(const content::ChildProcessData& data) override;
  void BrowserChildProcessCrashed(const content::ChildProcessData& data,
                                  const content::ChildProcessTerminationInfo& info) override;
  void BrowserChildProcessKilled(const content::ChildProcessData& data,
                                 const content::ChildProcessTerminationInfo& info) override;
  void BrowserChildProcessExitedNormally(const content::ChildProcessData& data,
                                         const content::ChildProcessTerminationInfo& info) override;
  void BrowserChildProcessLaunchFailed(const content::ChildProcessData& data,
                                       const content::ChildProcessTerminationInfo& info) override;

 private:
  struct ProcessState {
    base::ProcessId pid = 0;
    bool reported = false;
  };
  ProcessState& Track(content::RenderProcessHost* host);
  void ChildExited(const content::ChildProcessData& data,
                   const content::ChildProcessTerminationInfo& info);
  std::map<content::RenderProcessHost*, ProcessState> renderers_;
  std::map<content::ChildProcessId, ProcessState> children_;
};
}  // namespace remotekit::browser
