#ifndef REMOTEKIT_BROWSER_NAVIGATION_STATE_H_
#define REMOTEKIT_BROWSER_NAVIGATION_STATE_H_

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "components/sessions/core/serialized_navigation_entry.h"
#include "content/public/browser/session_storage_namespace_handle.h"
#include "remotekit/browser/view_model.h"

namespace content {
class BrowserContext;
class WebContents;
}  // namespace content
namespace remotekit::browser {

// UI-sequence-only, move-only snapshot. Keeps every controller history entry
// and its last renderer-reported opaque PageState (no live DOM/JS heap snapshot
// or forced renderer-state flush). Strong namespace references preserve sessionStorage
// only within the same live BrowserContext/browser process. Export/import does
// not persist or reconstruct sessionStorage, cookies, IndexedDB, or permissions.
class NavigationState {
 public:
  NavigationState();
  ~NavigationState();
  NavigationState(NavigationState&&) noexcept;
  NavigationState& operator=(NavigationState&&) noexcept;
  NavigationState(const NavigationState&) = delete;
  NavigationState& operator=(const NavigationState&) = delete;
  int entry_count() const;
  int selected_index() const { return selected_index_; }
  bool retains_session_storage() const { return !namespaces_.empty(); }

 private:
  friend Result<NavigationState> CaptureNavigationState(content::WebContents&);
  friend Status ValidateNavigationState(const NavigationState&);
  friend Status CheckAutomaticNavigationRestore(const NavigationState&);
  friend Result<std::string> ExportNavigationState(const NavigationState&);
  friend Result<NavigationState> ImportNavigationState(std::string_view);
  friend Result<std::unique_ptr<content::WebContents>>
  CreateRestoredWebContents(content::BrowserContext*, NavigationState&, bool);
  std::vector<sessions::SerializedNavigationEntry> entries_;
  std::vector<std::vector<GURL>> redirect_chains_;
  int selected_index_{-1};
  content::SessionStorageNamespaceHandleMap namespaces_;
  content::BrowserContext* namespace_context_{};
  // Reuse is forbidden until this owner is destroyed. Set again on restore,
  // so one snapshot cannot create two simultaneously live namespace owners.
  base::WeakPtr<content::WebContents> namespace_owner_;
};

Result<NavigationState> CaptureNavigationState(content::WebContents&);
Status ValidateNavigationState(const NavigationState&);
// Rejects POST in any history/frame entry: there is no repost-confirmation UI.
Status CheckAutomaticNavigationRestore(const NavigationState&);
// Versioned opaque binary, bounded to 64 MiB / 1024 entries / 16 MiB per entry.
// Includes full PageState; callers decide where/how to protect persisted data.
Result<std::string> ExportNavigationState(const NavigationState&);
Result<NavigationState> ImportNavigationState(std::string_view);
// Creates an unused controller, attaches retained namespaces only after the
// previous owner was destroyed, and calls Restore. Does NOT start navigation:
// observe the returned WebContents before calling controller.LoadIfNecessary.
Result<std::unique_ptr<content::WebContents>> CreateRestoredWebContents(content::BrowserContext*,
                                                                        NavigationState&,
                                                                        bool initially_hidden);

}  // namespace remotekit::browser
#endif
