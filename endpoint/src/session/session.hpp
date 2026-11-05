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
namespace remotekit {
class Session {
 public:
  Session(media::Sdk&, const RuntimeOptions&, std::string tenant, std::string id, ManagementLink&);
  ~Session();
  Result<void> Initialize();
  Result<void> Stop();
  void BeginManagementRequest(uint64_t generation) {
    generation_ = generation;
    channel.BeginManagementRequest(generation);
  }
  uint64_t ManagementGeneration() const { return generation_; }
  bool ManagementCurrent() const { return management.Current(generation_); }
  Result<void> ManagementLost(uint64_t generation) {
    return authorization.ManagementLost(generation);
  }
  void MaintainRecovery() { navigation.MaintainRecovery(); }
  void FlushSignals() { channel.FlushSignals(); }
  ViewController& Views() { return views; }
  FileController& Files() { return files; }
  FaceController& Face() { return face; }
  MediaPipeline& Media() { return pipeline; }
  AuthorizationController& Authorization() { return authorization; }
  ChannelController& Channel() { return channel; }

 private:
  void BindPeerResources(uint64_t handle);
  Result<void> StartPeerResources(uint64_t handle, const std::string& sdp);
  void StopPeerResources();
  void DrainPeerResources();
  const SessionConfig config;
  media::Sdk& sdk;
  ManagementLink& management;
  BrowserRuntime browser;
  SessionStore store;
  const std::shared_ptr<media::ServerTrace> trace;
  ControllerContext context;
  uint64_t generation_ = 0;
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
