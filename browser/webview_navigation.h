#pragma once
#include "browser/webview.h"

namespace remotekit::browser {
class NavigationCoordinator {
 public:
  using Completion = WebView::Completion;
  explicit NavigationCoordinator(WebView& owner);
  ~NavigationCoordinator();
  Result<std::string> ExportNavigation() const;
  Status ImportNavigation(std::string_view bytes);
  Status Navigate(const GURL& url, std::optional<NavigationOperations::Identity> operation);
  Status NavigationCommand(const std::string& action,
                           std::optional<NavigationOperations::Identity> operation);
  std::optional<Status> ExistingNavigationOperation(
      const GURL& url,
      const std::optional<NavigationOperations::Identity>& operation);
  NavigationOperations ReleaseNavigationOperations();
  void RestoreNavigationOperations(NavigationOperations operations);
  Status AcknowledgeNavigation(const NavigationOperations::Identity& identity);
  base::ListValue NavigationOperationSnapshot() const;
  Status RunNavigation(const std::string& action,
                       const GURL& url,
                       std::optional<NavigationOperations::Identity> identity);
  void DidStartNavigation(content::NavigationHandle*);
  void DidFinishNavigation(content::NavigationHandle*);
  void PrimaryMainFrameRenderProcessGone();
  void BindNavigation(content::NavigationHandle* navigation, bool started);
  void PollNavigationOperations();
  void BeforeUnloadDialogCancelled();
  void DidRedirectNavigation(content::NavigationHandle* navigation);
  void NavigationEntryCommitted(const content::LoadCommittedDetails&);
  void NavigationEntryChanged(const content::EntryChangedDetails&);
  void NavigationListPruned(const content::PrunedDetails&);

 private:
  friend class WebView;
  friend class WebViewExecution;
  friend class DeviceConfiguration;
  friend class InputController;
  friend class TouchController;
  friend class LifecycleCoordinator;
  WebView& owner_;
  std::uint64_t navigation_revision_ = 1;
  NavigationOperations navigation_operations_;
  std::optional<NavigationOperations::Identity> issuing_navigation_;
  std::map<std::int64_t, base::WeakPtr<content::NavigationHandle>> navigation_handles_;
  base::RepeatingTimer navigation_operation_timer_;
  base::WeakPtrFactory<NavigationCoordinator> weak_factory_{this};
};
}  // namespace remotekit::browser
