#pragma once
#include "remotekit/dc_services.hpp"
#include "rtc/data_router.hpp"
#include "rtc/authorization.hpp"
#include "rtc/outbox.hpp"
#include "input/input.hpp"
#include "media/presentation.hpp"
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class AuthorizationController;
class ControlOutbox;
class PresentationController;
class InputController;
class FileController;
class FaceController;
class OutputController;
class MediaPipeline;
class EncoderRegistry;
class ViewController;
class ConnectionTiming;
class ChannelController : private ControllerContext {
 public:
  ChannelController(ControllerContext context,
                    PeerController& peer_controller,
                    AuthorizationController& authorization,
                    ControlOutbox& control_outbox,
                    PresentationController& presentation,
                    InputController& input,
                    FileController& files,
                    FaceController& face,
                    OutputController& output,
                    MediaPipeline& pipeline,
                    EncoderRegistry& registry,
                    ViewController& views,
                    ConnectionTiming& timing)
      : ControllerContext(context),
        peer_controller(peer_controller),
        authorization(authorization),
        control_outbox(control_outbox),
        presentation(presentation),
        input(input),
        files(files),
        face(face),
        output(output),
        pipeline(pipeline),
        registry(registry),
        views(views),
        timing(timing),
        data_router(MakeRouterHooks()) {}
  void QueueMessage(Json message);
  DataRouter::Hooks MakeRouterHooks();
  void Bind(uint64_t handle);
  void Clear();
  void Revoke();
  void Opened(uint64_t handle);
  void RefreshEditable();
  void Queue(const RtcEvent& event);
  void BeginManagementRequest(uint64_t generation) { request_generation_ = generation; }
  bool ProductCurrent(const RtcEvent& event) const;
  void HandlePeerEvent(const RtcEvent& event);
  void FlushSignals();
  int SendData(uint64_t handle, uint64_t stamp, const std::string& encoded);
  void Send(const Json& message, uint64_t expected_stamp = 0);
  void FlushControl();
  void FlushServices();
  bool ServiceMessage(const RtcEvent& event);
  Result<Json> Offer(const Json& request, uint64_t generation);
  Result<Json> ManageRtcActionResult(const Json& request);
  Result<Json> ManageRtcOffer(const Json& request);
  Result<Json> ManageRtcClose(const Json& request);
  Result<Json> ManageRtcIce(const Json& request);

 private:
  PeerController& peer_controller;
  AuthorizationController& authorization;
  ControlOutbox& control_outbox;
  PresentationController& presentation;
  InputController& input;
  FileController& files;
  FaceController& face;
  OutputController& output;
  MediaPipeline& pipeline;
  EncoderRegistry& registry;
  ViewController& views;
  ConnectionTiming& timing;
  remotekit::DirectServices direct_services;
  std::mutex event_mutex;
  std::deque<RtcEvent> events;
  DataRouter data_router;
  uint64_t request_generation_ = 0;
};
}  // namespace remotekit
