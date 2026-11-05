#include "remotekit/browser/render_channel.h"
#include "remotekit/protocol/render_wire.h"
#include <vector>
#include "base/check.h"
#include "base/compiler_specific.h"
#include "base/functional/bind.h"
#include "mojo/public/cpp/system/message_pipe.h"
namespace remotekit::browser {
RenderChannel::RenderChannel(mojo::ScopedMessagePipeHandle pipe,
                             Handler handler,
                             StopHandler stop_handler,
                             base::OnceClosure disconnected)
    : handler_(std::move(handler)),
      stop_handler_(std::move(stop_handler)),
      disconnected_(std::move(disconnected)),
      pipe_(std::move(pipe)),
      watcher_(FROM_HERE, mojo::SimpleWatcher::ArmingPolicy::AUTOMATIC) {
  CHECK(pipe_.is_valid());
  CHECK_EQ(watcher_.Watch(pipe_.get(), MOJO_HANDLE_SIGNAL_READABLE,
                          base::BindRepeating(&RenderChannel::OnReadable, base::Unretained(this))),
           MOJO_RESULT_OK);
}
RenderChannel::~RenderChannel() {
  // Owner teardown may already have released its last shared reference.
  // Only a live channel closing can notify that owner.
  disconnected_.Reset();
  Close();
}
void RenderChannel::Close() {
  watcher_.Cancel();
  pipe_.reset();
  if (disconnected_)
    std::move(disconnected_).Run();
}
bool RenderChannel::Reject(const RenderIdentity& identity, RenderRejectReason reason) {
  if (!pipe_.is_valid())
    return false;
  if (generation_state_.stopped()) {
    Close();
    return false;
  }
  RenderWireMessage message;
  message.type = RenderWireType::kReject;
  message.reason = static_cast<uint32_t>(reason);
  message.begin.identity = identity;
  const auto bytes = EncodeRenderWire(message);
  if (!bytes || mojo::WriteMessageRaw(pipe_.get(), bytes->data(), bytes->size(), nullptr, 0,
                                      MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    Close();
    return false;
  }
  if (reason == RenderRejectReason::kIdle)
    wake_state_.RecordIdle(identity);
  return true;
}
bool RenderChannel::Wake(const RenderIdentity& identity) {
  if (!pipe_.is_valid() || !generation_state_.CanBegin(identity.generation))
    return false;
  const auto observed = wake_state_.Observe(identity);
  if (observed == RenderWakeResult::kInvalid)
    return false;
  if (observed == RenderWakeResult::kDuplicate)
    return true;
  RenderWireMessage message;
  message.type = RenderWireType::kWake;
  message.begin.identity = identity;
  const auto bytes = EncodeRenderWire(message);
  if (!bytes || mojo::WriteMessageRaw(pipe_.get(), bytes->data(), bytes->size(), nullptr, 0,
                                      MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    Close();
    return false;
  }
  return true;
}
bool RenderChannel::Stopped(uint64_t generation) {
  if (!pipe_.is_valid() || !generation_state_.RecordStopped(generation))
    return false;
  RenderWireMessage message;
  message.type = RenderWireType::kStopped;
  message.begin.identity.generation = generation;
  const auto bytes = EncodeRenderWire(message);
  if (!bytes || mojo::WriteMessageRaw(pipe_.get(), bytes->data(), bytes->size(), nullptr, 0,
                                      MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    Close();
    return false;
  }
  return true;
}
void RenderChannel::OnReadable(MojoResult result) {
  if (result != MOJO_RESULT_OK) {
    Close();
    return;
  }
  for (int count = 0; count < 4; ++count) {
    std::vector<uint8_t> bytes;
    std::vector<mojo::ScopedHandle> handles;
    const auto read =
        mojo::ReadMessageRaw(pipe_.get(), &bytes, &handles, MOJO_READ_MESSAGE_FLAG_NONE);
    if (read == MOJO_RESULT_SHOULD_WAIT)
      return;
    const auto decoded = DecodeRenderWire(bytes, handles.size());
    if (read != MOJO_RESULT_OK || !decoded) {
      Close();
      return;
    }
    const auto& message = *decoded;
    const auto weak = weak_factory_.GetWeakPtr();
    if (message.type == RenderWireType::kStop) {
      if (!generation_state_.RecordStop(message.begin.identity.generation)) {
        Close();
        return;
      }
      stop_handler_.Run(message.begin.identity.generation);
    } else {
      if (message.type != RenderWireType::kBegin || message.begin.identity.value <= last_value_ ||
          !generation_state_.RecordBegin(message.begin.identity.generation)) {
        Close();
        return;
      }
      last_value_ = message.begin.identity.value;
      handler_.Run(message.begin);
    }
    if (!weak || !pipe_.is_valid())
      return;
  }
}
}  // namespace remotekit::browser
