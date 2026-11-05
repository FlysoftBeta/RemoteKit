#include "remotekit/browser/sdk/sdk_internal.h"
#include "remotekit/protocol/render_wire.h"
#include "remotekit/browser/sdk/sdk_resources.h"

using namespace remotekit::sdk;
namespace remotekit::sdk {
void RenderReader(std::shared_ptr<RenderConnection> channel) {
  while (!channel->closed.load(std::memory_order_acquire)) {
    std::vector<uint8_t> bytes;
    std::vector<mojo::ScopedHandle> handles;
    const auto result = channel->failed.load(std::memory_order_acquire)
                            ? MOJO_RESULT_FAILED_PRECONDITION
                            : mojo::ReadMessageRaw(channel->pipe.get(), &bytes, &handles,
                                                   MOJO_READ_MESSAGE_FLAG_NONE);
    if (result == MOJO_RESULT_SHOULD_WAIT) {
      base::PlatformThread::Sleep(base::Milliseconds(1));
      continue;
    }
    remotekit_sdk_render_event event{};
    event.struct_size = sizeof(event);
    event.type = REMOTEKIT_SDK_RENDER_FATAL;
    const auto decoded = remotekit::DecodeRenderWire(bytes, handles.size());
    if (result == MOJO_RESULT_OK && decoded) {
      const auto& message = *decoded;
      if (message.type == remotekit::RenderWireType::kReject) {
        event.type = REMOTEKIT_SDK_RENDER_REJECT;
        event.reason = message.reason;
        event.generation = message.begin.identity.generation;
        event.value = message.begin.identity.value;
        event.slot = message.begin.identity.slot;
      } else if (message.type == remotekit::RenderWireType::kWake) {
        std::lock_guard lock(channel->lock);
        const auto observed = channel->wake_state.Observe(message.begin.identity);
        if (observed != remotekit::RenderWakeResult::kInvalid) {
          // Stop may have crossed an already queued inbound Wake. Ignore that
          // known wake without treating it as a fresh demand or GPU completion.
          if (channel->generation_state.stopping() ||
              observed == remotekit::RenderWakeResult::kDuplicate)
            continue;
          event.type = REMOTEKIT_SDK_RENDER_WAKE;
          event.generation = message.begin.identity.generation;
          event.value = message.begin.identity.value;
          event.slot = message.begin.identity.slot;
        }
      } else if (message.type == remotekit::RenderWireType::kStopped) {
        std::lock_guard lock(channel->lock);
        if (channel->generation_state.RecordStopped(message.begin.identity.generation)) {
          event.type = REMOTEKIT_SDK_RENDER_STOPPED;
          event.generation = message.begin.identity.generation;
        }
      }
    }
    if (event.type == REMOTEKIT_SDK_RENDER_REJECT) {
      std::lock_guard lock(channel->lock);
      auto& pending = channel->pending[event.slot];
      if (channel->generation_state.stopped() || !pending ||
          pending->generation != event.generation || pending->value != event.value) {
        event = {};
        event.struct_size = sizeof(event);
        event.type = REMOTEKIT_SDK_RENDER_FATAL;
      } else {
        if (event.reason == REMOTEKIT_SDK_RENDER_IDLE)
          channel->wake_state.RecordIdle(*pending);
        pending.reset();
      }
    }
    // Serialize Wake delivery with Stop, including a reentrant Stop from the
    // callback worker. Stop returning must not permit a later Wake callback.
    std::lock_guard callback_lock(channel->callback_lock);
    if (event.type == REMOTEKIT_SDK_RENDER_WAKE) {
      std::lock_guard lock(channel->lock);
      if (channel->generation_state.stopping())
        continue;
    }
    // close joins this thread before returning, including any active callback.
    if (channel->closed.load(std::memory_order_acquire))
      break;
    const bool fatal = event.type == REMOTEKIT_SDK_RENDER_FATAL;
    if (fatal)
      channel->closed.store(true, std::memory_order_release);
    channel->callback(channel->context, &event);
    if (fatal)
      break;
  }
}
}  // namespace remotekit::sdk
int remotekit_sdk_render_connect(const char* name_utf8,
                                 remotekit_sdk_render_callback callback,
                                 void* context,
                                 uint64_t* handle) {
  if (!handle)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *handle = 0;
  if (!name_utf8 || !callback)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  size_t length = 0;
  for (; length <= 128; ++length) {
    const unsigned char ch = UNSAFE_BUFFERS(name_utf8[length]);
    if (!ch)
      break;
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
          ch == '_' || ch == '-' || ch == '.'))
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
  }
  if (!length || length > 128)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_INVALID_STATE;
  const auto token = UNSAFE_BUFFERS(std::string_view(name_utf8, length));
  auto channel = std::make_shared<RenderConnection>();
  channel->callback = callback;
  channel->context = context;
  auto& state = State();
  std::lock_guard lock(state.lock);
  if (state.stopping || !state.next_handle)
    return REMOTEKIT_SDK_INVALID_STATE;
  // The opaque token is scoped to its original live Control connection. Claim
  // is atomic with control close/retire/new-open and consumes it exactly once.
  for (auto& [control_id, control] : state.channels) {
    if (!control->closed.load(std::memory_order_acquire) &&
        control->pending_render.Matches(token)) {
      channel->pipe = control->pending_render.Claim(token);
      break;
    }
  }
  if (!channel->pipe.is_valid())
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  const uint64_t id = state.next_handle++;
  state.render_channels.emplace(id, channel);
  channel->reader = std::thread(RenderReader, channel);
  channel->reader_id = channel->reader.get_id();
  *handle = id;
  return REMOTEKIT_SDK_OK;
}
int remotekit_sdk_render_begin(uint64_t handle, const struct remotekit_sdk_render_request* begin) {
  if (!begin)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  remotekit::RenderWireMessage message;
  message.begin.identity.generation = begin->generation;
  message.begin.identity.value = begin->value;
  message.begin.identity.slot = begin->slot;
  message.begin.interval_us = begin->interval_us;
  message.begin.force = begin->force;
  if (!remotekit::ValidRenderBegin(message.begin))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<RenderConnection> channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.render_channels.find(handle);
    if (found == state.render_channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = found->second;
  }
  std::lock_guard lock(channel->lock);
  if (channel->closed.load(std::memory_order_acquire))
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  if (channel->generation_state.stopping())
    return REMOTEKIT_SDK_INVALID_STATE;
  if (!channel->generation_state.CanBegin(begin->generation))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  if (begin->value <= channel->last_value)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  auto& pending = channel->pending[begin->slot];
  if (pending)
    return REMOTEKIT_SDK_BUSY;
  const auto bytes = remotekit::EncodeRenderWire(message);
  if (!bytes || mojo::WriteMessageRaw(channel->pipe.get(), bytes->data(), bytes->size(), nullptr, 0,
                                      MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    channel->failed.store(true, std::memory_order_release);
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  }
  channel->generation_state.RecordBegin(begin->generation);
  pending = message.begin.identity;
  channel->last_value = begin->value;
  return REMOTEKIT_SDK_OK;
}
int remotekit_sdk_render_observe_signal(uint64_t handle,
                                        const struct remotekit_sdk_render_identity* identity) {
  if (!identity)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  remotekit::RenderIdentity value;
  value.generation = identity->generation;
  value.value = identity->value;
  value.slot = identity->slot;
  value.reserved = identity->reserved;
  if (!remotekit::ValidRenderIdentity(value))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<RenderConnection> channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.render_channels.find(handle);
    if (found == state.render_channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = found->second;
  }
  std::lock_guard lock(channel->lock);
  if (channel->closed.load(std::memory_order_acquire))
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  auto& pending = channel->pending[value.slot];
  if (!pending || pending->generation != value.generation || pending->value != value.value)
    return REMOTEKIT_SDK_DATA_MISMATCH;
  pending.reset();
  return REMOTEKIT_SDK_OK;
}
int remotekit_sdk_render_stop(uint64_t handle, uint64_t generation) {
  if (!generation)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<RenderConnection> channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.render_channels.find(handle);
    if (found == state.render_channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = found->second;
  }
  // Same mutex as Begin establishes the wire FIFO boundary without queued tasks.
  // Lock callback first, matching the reader's Wake delivery gate.
  std::lock_guard callback_lock(channel->callback_lock);
  std::lock_guard lock(channel->lock);
  if (channel->closed.load(std::memory_order_acquire))
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  if (!channel->generation_state.CanStop(generation))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  if (channel->generation_state.stopping())
    return REMOTEKIT_SDK_OK;
  remotekit::RenderWireMessage message;
  message.type = remotekit::RenderWireType::kStop;
  message.begin.identity.generation = generation;
  const auto bytes = remotekit::EncodeRenderWire(message);
  if (!bytes || mojo::WriteMessageRaw(channel->pipe.get(), bytes->data(), bytes->size(), nullptr, 0,
                                      MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    channel->failed.store(true, std::memory_order_release);
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  }
  channel->generation_state.RecordStop(generation);
  return REMOTEKIT_SDK_OK;
}
int remotekit_sdk_render_close(uint64_t handle) {
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<RenderConnection> channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.render_channels.find(handle);
    if (found == state.render_channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = found->second;
    if (channel->reader_id == std::this_thread::get_id())
      return REMOTEKIT_SDK_INVALID_STATE;
    // Keep registered until join finishes, preventing shutdown from destroying
    // Mojo while the callback barrier is still active.
  }
  std::lock_guard close_lock(channel->close_lock);
  {
    std::lock_guard lock(channel->lock);
    channel->closed.store(true, std::memory_order_release);
    for (auto& pending : channel->pending)
      pending.reset();
  }
  if (channel->reader.joinable())
    channel->reader.join();
  {
    auto& state = State();
    std::lock_guard state_lock(state.lock);
    state.render_channels.erase(handle);
  }
  return REMOTEKIT_SDK_OK;
}
