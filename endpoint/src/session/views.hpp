#pragma once
#include "protocol/atlas_plan.hpp"
#include "protocol/atlas_dimensions.hpp"
#include "session/context.hpp"
#include "files/download_imports.hpp"
#include "files/file_upload.hpp"
namespace remotekit {
class PeerController;
class PresentationController;
class OutputController;
class EncoderRegistry;
class NavigationRecovery;
class Diagnostics;
class ViewController : private ControllerContext {
 public:
  ViewController(ControllerContext context,
                 PeerController& peer_controller,
                 PresentationController& presentation,
                 OutputController& output,
                 EncoderRegistry& registry,
                 NavigationRecovery& navigation,
                 Diagnostics& diagnostics)
      : ControllerContext(context),
        peer_controller(peer_controller),
        presentation(presentation),
        output(output),
        registry(registry),
        navigation(navigation),
        diagnostics(diagnostics),
        downloads(context.store.Downloads(), context.options.build_id),
        view_store(context.store.Views()),
        recovery_store(context.store.Recovery()) {}
  struct Geometry {
    int width = 16, height = 16;
    float scale = 1;
  };
  void SetStopRuntime(std::function<Result<void>()> stop) { stop_runtime = std::move(stop); }
  void SetBeforeViews(std::function<Result<void>()> callback) {
    before_views = std::move(callback);
  }
  void SetDownloadImport(DownloadImports::Import import) { downloads.SetImport(std::move(import)); }
  size_t PendingDownloads() const {
    return std::max(downloads.Pending(), size_t(download_reconciliation_failed));
  }
  void PollSignIn();
  Json SignInFailures() const;
  Result<void> Initialize();
  void Reset();
  bool Contains(const std::string& view) const { return desired.contains(view); }
  Json Desired(const std::string& view) const { return desired.at(view); }
  bool ReconciliationDue() const {
    return reconciliation_pending && QpcNow() >= next_reconciliation;
  }
  bool ReconciliationPending() const { return reconciliation_pending; }
  Result<void> StageDesired(const Json& document);
  Result<void> ConvergeDesired();
  Result<void> RecordClosed(const std::string& view, const std::string& reason);
  Result<void> AckClosed(const Json& views);
  Result<void> Start();

  Result<Geometry> DesiredGeometry();
  Result<void> GeometryConfig(const Geometry& value);
  Result<void> RefitOutput();
  Result<void> ReconcileOutput();
  static void NavigationOperation(Json& target, const Json& source);
  Result<Json> CreateView(const Json& config, bool recovering = false);
  Json RtcSnapshot() const;
  Result<Json> InactiveSnapshot();
  Result<Json> Snapshot(bool output_diagnostics = false);
  static void AddCloseRequest(Json& output, const Json& requests);
  Result<std::vector<std::string>> FileChooserAccept(const FileUploadStore::Binding&) const;
  Result<std::string> PrepareViewCommand(const Json& request);
  Result<Json> ManageSessionStorageImport(const Json& request);
  Result<Json> ManageSessionStorageImportStatus(const Json& request);
  Result<Json> ManageSessionIdentity(const Json& request);
  Result<Json> ApplySitePreferences(const Json& request);
  Result<Json> ManageViewNavigationAck(const Json& request);
  Result<Json> ManageViewAppInfo(const Json& request);
  Result<Json> ManageViewClose(const Json& request);
  Result<Json> ManageViewCloseReply(const Json& request);
  Result<Json> ManageViewPageReply(const Json& request);
  Result<Json> ManageViewPageExitFullscreen(const Json& request);
  Result<Json> ManageViewCommand(const Json& request);
  Result<Json> ManageViewLifecycle(const Json& request);
  Result<Json> ManageViewNavigate(const Json& request);

 private:
  friend class NativeErrorStateProbe;
  friend class NativeRetryOwnerProbe;
  std::function<Result<void>()> before_views;
  std::function<Result<void>()> stop_runtime;
  PeerController& peer_controller;
  PresentationController& presentation;
  OutputController& output;
  EncoderRegistry& registry;
  NavigationRecovery& navigation;
  Diagnostics& diagnostics;
  DownloadImports downloads;
  ViewStore view_store;
  RecoveryStore recovery_store;
  bool download_reconciliation_failed = false;
  std::map<std::string, Json> desired;
  std::vector<std::string> desired_order;
  std::set<std::string> restoring_views;
  std::map<std::string, std::string> resume_urls;
  mutable std::mutex chooser_mutex;
  std::map<std::string, Json> chooser_requests;
  int atlas_width = 1920, atlas_height = 1080;
  float atlas_scale = 1;
  Json site_preferences = Json::object();
  Json sign_in_acknowledged = Json::array();
  std::map<std::string, Json> sign_in_pending_;
  std::string sign_in_incarnation;
  RetryClock::time_point next_sign_in_poll{};
  using SignInAppend =
      std::function<Result<Json>(const Json&, const std::string&, const std::string&)>;
  void PollSignIn(const SignInAppend& append);
  void DeliverSignIn(const SignInAppend& append);
  RetryUnit sign_in_fetch_{"signin.fetch"};
  std::map<std::string, RetryUnit> sign_in_handoff_;
  RetryUnit output_retry_{"output.reconcile"};
  std::set<std::string> observed_closed;
  std::atomic<bool> reconciliation_pending{false};
  int64_t next_reconciliation = 0;
};
}  // namespace remotekit
