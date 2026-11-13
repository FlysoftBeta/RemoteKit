#pragma once
#include "media/output.hpp"
#include "media/pipeline.hpp"
#include "media/encoders.hpp"
#include "media/audio.hpp"
#include "auth/face.hpp"
#include "files/files.hpp"
#include "session/navigation_recovery.hpp"
#include "diagnostics/stats.hpp"
#include "diagnostics/timing.hpp"
#include "rtc/channel.hpp"
#include "session/views.hpp"
#include "session/clipboard.hpp"
#include "persistence/checkpoint_cache.hpp"
#include "persistence/checkpoint.hpp"
#include "persistence/snapshot_client.hpp"
namespace remotekit {
class Session {
 public:
  Session(media::Sdk&,
          const RuntimeOptions&,
          std::string tenant,
          std::string id,
          uint64_t placement_epoch,
          const cluster::Key& profile_key,
          ManagementLink&,
          objects::ObjectService&,
          media::FrameAdmission&,
          std::shared_ptr<objects::SessionObjects> access = {});
  ~Session();
  Result<void> Initialize();
  Result<void> StageDesired(const Json& document);
  Result<void> AuthorizeDesired(const Json& document, uint64_t generation);
  Result<Json> EventState() { return store.Events().State(); }
  Result<Json> PendingEvents(uint64_t after = 0) { return store.Events().Load(after); }
  Result<void> AcknowledgeEvents(const std::string& stream, uint64_t up_to) {
    return store.Events().Acknowledge(stream, up_to);
  }
  bool Running() const { return browser.Alive() && !browser.Stopping(); }
  const std::string& BrowserIncarnation() const { return browser.Incarnation(); }
  Json AuthorizationSnapshot() const;
  Json LockSnapshot() const;
  void SetOpenTiming(Json phases) { browser.SetOpenTiming(std::move(phases)); }
  Result<void> Stop();
  Result<void> Shutdown();
  Result<Json> Snapshot(bool output_diagnostics = false);
  Result<Json> StopAndCommit(const Json& request_id,
                             bool check_blockers = true,
                             PhaseClock::time_point deadline = PhaseClock::time_point::max(),
                             bool defer_commits = false);
  Result<void> MarkStopped();
  bool VersionDue(int64_t now, int64_t interval) const;
  Result<CheckpointPlan> CaptureVersion() const;
  Result<BuiltCheckpoint> BuildVersion(SnapshotClient& client,
                                       const Json& snapshot,
                                       const CheckpointPlan& plan);
  Result<Json> CommitVersion(const Json& snapshot, const BuiltCheckpoint& built);
  uint64_t PlacementEpoch() const { return config.placement_epoch; }
  const std::string& Id() const { return config.id; }
  void BeginManagementRequest(uint64_t generation) {
    generation_ = generation;
    channel.BeginManagementRequest(generation);
  }
  uint64_t ManagementGeneration() const { return generation_; }
  bool ManagementCurrent() const { return management.Current(generation_); }
  Result<void> ManagementLost(uint64_t generation) {
    files_applied_ = false;
    return authorization.ManagementLost(generation);
  }
  void MaintainRecovery() {
    browser.RecordCrash();
    navigation.MaintainRecovery();
    views.PollSignIn();
    checkpoint_cache.MaybeStage(context.objects, config.tenant);
  }
  void FlushSignals() { channel.FlushSignals(); }
  ViewController& Views() { return views; }
  FileController& Files() { return files; }
  MediaPipeline& Media() { return pipeline; }
  AuthorizationController& Authorization() { return authorization; }
  ChannelController& Channel() { return channel; }

 private:
  Result<void> CloseRuntime(bool graceful);
  void BindPeerResources(uint64_t handle);
  Result<void> StartPeerResources(uint64_t handle, const std::string& sdp);
  void StopPeerResources();
  void DrainPeerResources();
  const SessionConfig config;
  media::Sdk& sdk;
  ManagementLink& management;
  BrowserRuntime browser;
  SessionDb store;
  CheckpointCache checkpoint_cache;
  int64_t version_at_ = 0;
  const std::shared_ptr<media::ServerTrace> trace;
  ControllerContext context;
  std::atomic<uint64_t> generation_{0};
  std::atomic<bool> files_applied_{false};
  std::atomic<std::shared_ptr<const Json>> lock_state_{
      std::make_shared<const Json>(Json{{"leaseId", nullptr}, {"epoch", 0}, {"state", "locked"}})};
  ClipboardController clipboard;
  ConnectionTiming timing;
  AuthorizationController authorization;
  InputController input;
  ControlOutbox control_outbox;
  PresentationController presentation;
  PeerController peer_controller;
  OutputController output;
  MediaPipeline pipeline;
  EncoderRegistry registry;
  AudioOutput audio;
  FileController files;
  NavigationRecovery navigation;
  ViewController views;
  Diagnostics diagnostics;
  ChannelController channel;
};
}  // namespace remotekit
