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
          std::shared_ptr<objects::SessionObjects> access = {});
  ~Session();
  Result<void> Initialize();
  Result<Json> WriteClipboard(const Json& request);
  void SetOpenTiming(Json phases) { browser.SetOpenTiming(std::move(phases)); }
  Result<void> Stop();
  Result<void> Shutdown();
  Result<Json> Snapshot(bool output_diagnostics = false);
  // Raw log windows for diagnostics: this Session's Browser log and the
  // node's Endpoint log (current and first rotated file).
  Result<Json> ReadLog(const Json& request) const;
  Result<Json> Hibernate(objects::ObjectService& objects);
  uint64_t PlacementEpoch() const { return config.placement_epoch; }
  Result<Json> Open(const Json& request);
  Result<Json> Ensure(const Json& request);
  const std::string& Id() const { return config.id; }
  void BeginManagementRequest(uint64_t generation) {
    generation_ = generation;
    channel.BeginManagementRequest(generation);
  }
  uint64_t ManagementGeneration() const { return generation_; }
  bool ManagementCurrent() const { return management.Current(generation_); }
  Result<void> ManagementLost(uint64_t generation) {
    return authorization.ManagementLost(generation);
  }
  void MaintainRecovery() {
    browser.RecordCrash();
    navigation.MaintainRecovery();
    views.PollSignIn(generation_.load());
    checkpoint_cache.MaybeStage(context.objects, config.tenant);
  }
  void FlushSignals() { channel.FlushSignals(); }
  ViewController& Views() { return views; }
  FileController& Files() { return files; }
  FaceController& Face() { return face; }
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
  SessionStore store;
  CheckpointCache checkpoint_cache;
  const std::shared_ptr<media::ServerTrace> trace;
  ControllerContext context;
  std::atomic<uint64_t> generation_{0};
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
  FaceController face;
  FileController files;
  NavigationRecovery navigation;
  ViewController views;
  Diagnostics diagnostics;
  ChannelController channel;
};
}  // namespace remotekit
