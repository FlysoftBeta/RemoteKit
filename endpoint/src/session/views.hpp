#pragma once
#include "protocol/atlas_plan.hpp"
#include "protocol/atlas_dimensions.hpp"
#include "session/context.hpp"
#include "files/download_imports.hpp"
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
        downloads(context.store) {}
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
  Json Events() const {
    auto events = durable_events;
    for (const auto& event : downloads.Events()) {
      if (events.size() >= 256)
        break;
      events.push_back(event);
    }
    return events;
  }
  Result<void> Initialize();
  void Reset();
  bool Contains(const std::string& view) const { return desired.contains(view); }
  Json Desired(const std::string& view) const { return desired.at(view); }
  bool ReconciliationDue() const {
    return reconciliation_pending && QpcNow() >= next_reconciliation;
  }
  bool ReconciliationPending() const { return reconciliation_pending; }
  Result<void> Save();
  Result<void> RecordClosed(const std::string& view, const std::string& reason);
  Result<void> AckClosed(const Json& views);
  Result<void> Start();

  Result<Geometry> DesiredGeometry();
  Result<void> GeometryConfig(const Geometry& value);
  Result<void> RefitOutput();
  Result<void> ReconcileOutput();
  Result<Json> ApplyView(const Json& config, bool create, bool recovering = false);
  static void NavigationOperation(Json& target, const Json& source);
  Result<Json> CreateView(const Json& config, bool recovering = false);
  Json RtcSnapshot() const;
  Result<Json> InactiveSnapshot();
  Result<Json> Snapshot(bool output_diagnostics = false);
  static void AddCloseRequest(Json& output, const Json& requests);
  Result<std::string> PrepareViewCommand(const Json& request, const std::string& method);
  Result<Json> ManageSessionEnsure(const Json& request);
  Result<Json> ManageSessionStorageImport(const Json& request);
  Result<Json> ManageSessionStorageImportStatus(const Json& request);
  Result<Json> ManageSessionIdentity(const Json& request);
  Result<Json> ManageSessionEventsAck(const Json& request);
  Result<Json> ManageSessionSitePreferences(const Json& request);
  Result<Json> ManageViewNavigationAck(const Json& request);
  Result<Json> ManageViewEnsure(const Json& request);
  Result<Json> ManageViewAppInfo(const Json& request);
  Result<Json> ManageViewClose(const Json& request);
  Result<Json> ManageViewCloseReply(const Json& request);
  Result<Json> ManageViewPageReply(const Json& request);
  Result<Json> ManageViewPageExitFullscreen(const Json& request);
  Result<Json> ManageViewCommand(const Json& request);
  Result<Json> ManageViewLifecycle(const Json& request);
  Result<Json> ManageViewNavigate(const Json& request);
  Result<Json> ManageViewConfigure(const Json& request);

 private:
  std::function<Result<void>()> before_views;
  std::function<Result<void>()> stop_runtime;
  PeerController& peer_controller;
  PresentationController& presentation;
  OutputController& output;
  EncoderRegistry& registry;
  NavigationRecovery& navigation;
  Diagnostics& diagnostics;
  DownloadImports downloads;
  bool download_reconciliation_failed = false;
  std::map<std::string, Json> desired;
  int atlas_width = 1920, atlas_height = 1080;
  float atlas_scale = 1;
  Json site_preferences = Json::object();
  Json durable_events = Json::array();
  uint64_t next_event = 1;
  std::set<std::string> observed_closed;
  std::atomic<bool> reconciliation_pending{false};
  int64_t next_reconciliation = 0;
};
}  // namespace remotekit
