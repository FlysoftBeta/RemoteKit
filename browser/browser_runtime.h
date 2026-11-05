#pragma once
#include <memory>
#include <set>
#include <vector>
#include "base/functional/callback.h"
#include "base/timer/timer.h"
#include "browser/browser_context.h"
#include "browser/closed_views.h"
#include "browser/control_dispatcher.h"
#include "browser/control_server.h"
#include "browser/layout_transaction.h"
#include "browser/navigation_transfer.h"
#include "browser/osr_renderer.h"
#include "browser/popup_registry.h"
#include "browser/view_registry.h"
#include "content/public/browser/browser_main_parts.h"
#include "content/public/browser/gpu_data_manager_observer.h"
#include "ui/display/screen.h"
namespace remotekit::browser {
class BrowserRuntime : public content::GpuDataManagerObserver {
 public:
  BrowserRuntime();
  ~BrowserRuntime();
  void OnGpuInfoUpdate() override;
  void RemoveView(WebViewId);
  void DrainClosed();
  Status CanDiscard(WebViewId) const;
  void UpdateOutput();
  mojo::ScopedMessagePipeHandle TakeControlAttachment(const base::DictValue&,
                                                      const base::DictValue&);
  void OnControlClosed();
  bool shutting_down = false;
  std::unique_ptr<display::Screen> screen;
  ViewModel view_model;
  ViewRegistry views;
  LayoutTransaction layout_transaction{views};
  ClosedViews closed;
  PopupRegistry popups{shutting_down};
  SessionId session_id = 0;
  std::vector<ProfileId> profiles;
  std::vector<std::unique_ptr<BrowserContext>> contexts;
  std::unique_ptr<ControlServer> control;
  std::unique_ptr<OsrRenderer> output;
  std::unique_ptr<ControlDispatcher> dispatcher;
  base::RepeatingTimer output_timer;
  std::set<WebViewId> paused_output;
  bool output_enabled = true;
  uint64_t output_generation = 0;
  NavigationTransfer navigation_transfers;
  base::RepeatingClosure quit;
};
class RemoteKitMainParts final : public content::BrowserMainParts {
 public:
  RemoteKitMainParts();
  ~RemoteKitMainParts() override;
  void PostCreateMainMessageLoop() override;
  int PostCreateThreads() override;
  int PreMainMessageLoopRun() override;
  void WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>&) override;
  void PostMainMessageLoopRun() override;

 private:
  std::unique_ptr<BrowserRuntime> state_;
};
}  // namespace remotekit::browser
