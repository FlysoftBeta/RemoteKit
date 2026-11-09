#pragma once
#include "session/navigation_export.hpp"
#include "session/context.hpp"
namespace remotekit {
class ViewController;
class NavigationRecovery : private ControllerContext {
 public:
  NavigationRecovery(ControllerContext context, ViewController& views)
      : ControllerContext(context), views(views) {}
  void Reset();
  void Begin(const std::string& view);
  void Forget(const std::string& view);
  void EraseRevision(const std::string& view);
  Json ViewStatus(const std::string& view) const;
  void Annotate(const std::string& view, Json& item) const;
  bool Recovering(const std::string& view) const;
  Json RecoverySnapshot() const;
  bool CancelRecovery(const std::string& view);
  void MaintainRecovery();
  void CaptureNavigation(const Json& browser_view);
  void MaintainNavigationExport();
  Result<void> FinalExport();

 private:
  ViewController& views;
  std::map<std::string, std::string> recovery_revisions;
  remotekit::NavigationExport navigation_export;
  bool export_turn = false;
  std::string scavenged_incarnation;
  Result<void> ExportTick(uint32_t timeout_ms = 10000);
  struct Recovery {
    enum class Phase {
      kLoad,
      kSettling,
      kUnload,
      kBegin,
      kChunks,
      kCommit,
      kRestore,
      kWaiting,
      kVisible,
      kComplete,
      kFallback,
      kFallbackStarted,
      kFailed
    };
    Phase phase = Phase::kLoad;
    std::optional<Error> error;
    std::string transfer;
    bool reconcile = false;
    unsigned attempts = 0;
    const char* PhaseName() const;

    Json saved;
    size_t chunk = 0;
    uint64_t offset = 0, buffer_bytes = 0;
    int64_t deadline = 0, next_poll = 0;
    bool Pending() const {
      return phase != Phase::kComplete && phase != Phase::kFallbackStarted &&
             phase != Phase::kFailed;
    }
  };
  std::map<std::string, Recovery> recoveries;
  std::string recovery_cursor;

  void FailRecovery(const std::string& view, Recovery& task, const Error& error);
  Json RecoveryStatus(const Recovery& recovery) const;
};
}  // namespace remotekit
