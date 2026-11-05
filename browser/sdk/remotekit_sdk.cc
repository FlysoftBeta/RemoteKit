#include "remotekit/sdk/include/remotekit_sdk.h"
#include "remotekit/endpoint/include/remotekit/shared_render_slots.h"
#include "remotekit/protocol/control.h"
#include "remotekit/browser/sdk/render_endpoint_pending.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>
#include <thread>
#include <cstring>
#include "remotekit/protocol/render_slots.h"

#include "base/at_exit.h"
#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_view_util.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "base/synchronization/waitable_event.h"
#include "base/threading/platform_thread.h"
#include "base/threading/thread.h"
#include "base/time/time.h"
#include "mojo/core/embedder/embedder.h"
#include "mojo/core/embedder/scoped_ipc_support.h"
#include "mojo/public/cpp/platform/named_platform_channel.h"
#include "mojo/public/cpp/system/isolated_connection.h"
#include "mojo/public/cpp/system/message_pipe.h"
#include "third_party/webrtc/rtc_base/time_utils.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/dom/keycode_converter.h"
#include "ui/events/keycodes/platform_key_map_win.h"

namespace {
struct ControlChannel {
  std::mutex request_lock;
  std::mutex open_lock;
  remotekit::sdk::PendingRenderEndpoint pending_render;
  std::atomic<bool> closed{false};
  mojo::IsolatedConnection connection;
  mojo::ScopedMessagePipeHandle pipe;
};

// Kept alive until explicit shutdown so a host controls DLL teardown order.
struct RenderConnection {
  std::atomic<bool> failed{false};
  std::mutex lock;
  std::mutex close_lock;
  std::recursive_mutex callback_lock;
  std::atomic<bool> closed{false};
  mojo::ScopedMessagePipeHandle pipe;
  std::thread reader;
  std::thread::id reader_id;
  uint64_t last_value = 0;
  remotekit::RenderGenerationState generation_state;
  remotekit::RenderWakeState wake_state;
  std::array<std::optional<remotekit::RenderIdentity>, 4> pending;
  remotekit_sdk_render_callback callback = nullptr;
  void* context = nullptr;
};
struct SDKState {
  std::mutex lock;
  std::unique_ptr<base::AtExitManager> at_exit;
  std::unique_ptr<base::Thread> io_thread;
  std::unique_ptr<mojo::core::ScopedIPCSupport> ipc_support;
  std::map<uint64_t, std::shared_ptr<ControlChannel>> channels;
  std::map<uint64_t, std::shared_ptr<RenderConnection>> render_channels;
  std::condition_variable idle;
  size_t operations = 0;
  bool stopping = false;
  uint64_t next_handle = 1;
  bool stopped = false;
  bool owns_thread_pool = false;
  size_t rtc_peers = 0;
};

SDKState& State() {
  static base::NoDestructor<SDKState> state;
  return *state;
}
// Declare before operation-owned Mojo objects: their destruction must finish
// before the last lease permits shutdown to tear down Mojo and base.
class OperationLease {
 public:
  OperationLease() {
    auto& state = State();
    std::lock_guard lock(state.lock);
    if (state.at_exit && !state.stopping && !state.stopped) {
      ++state.operations;
      acquired_ = true;
    }
  }
  ~OperationLease() {
    if (!acquired_)
      return;
    auto& state = State();
    std::lock_guard lock(state.lock);
    if (--state.operations == 0)
      state.idle.notify_all();
  }
  explicit operator bool() const { return acquired_; }
  OperationLease(const OperationLease&) = delete;
  OperationLease& operator=(const OperationLease&) = delete;

 private:
  bool acquired_ = false;
};

void RetireChannel(uint64_t handle, const std::shared_ptr<ControlChannel>& channel) {
  channel->closed.store(true, std::memory_order_release);
  auto& state = State();
  std::lock_guard lock(state.lock);
  channel->pending_render.Reset();
  // Handles are never reused; keep the comparison explicit for ownership.
  const auto found = state.channels.find(handle);
  if (found != state.channels.end() && found->second == channel)
    state.channels.erase(found);
}
constexpr size_t kMaxMessageSize = 1024 * 1024;
void RunPoolLifecycle(SDKState& state, bool start) {
  base::WaitableEvent done;
  state.io_thread->task_runner()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](bool start_pool, base::WaitableEvent* completed) {
                       if (start_pool) {
                         base::ThreadPoolInstance::CreateAndStartWithDefaultParams("RemoteKitSDK");
                       } else {
                         base::ThreadPoolInstance::Get()->Shutdown();
                         // Shutdown leaves Chromium workers alive; a loadable SDK requires
                         // the complete join barrier before DLL unload.
                         base::ThreadPoolInstance::Get()->JoinForTesting();
                         base::ThreadPoolInstance::Set(nullptr);
                       }
                       completed->Signal();
                     },
                     start, base::Unretained(&done)));
  done.Wait();
}
}  // namespace

// Internal lifetime handshake serializes peer creation/teardown with shutdown.
int RemoteKitSdkBeginRtc() {
  auto& state = State();
  std::lock_guard lock(state.lock);
  if (!state.at_exit || state.stopped || state.stopping)
    return REMOTEKIT_SDK_INVALID_STATE;
  ++state.rtc_peers;
  return REMOTEKIT_SDK_OK;
}
void RemoteKitSdkEndRtc() {
  auto& state = State();
  std::lock_guard lock(state.lock);
  --state.rtc_peers;
}

uint32_t remotekit_sdk_abi_version(void) {
  return REMOTEKIT_SDK_ABI_VERSION;
}

int remotekit_sdk_initialize(void) {
  auto& state = State();
  std::lock_guard<std::mutex> lock(state.lock);
  if (state.stopped || state.stopping)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (state.at_exit)
    return REMOTEKIT_SDK_OK;
  state.at_exit = std::make_unique<base::AtExitManager>();
  mojo::core::Configuration configuration;
  configuration.is_broker_process = true;
  mojo::core::Init(configuration);
  state.io_thread = std::make_unique<base::Thread>("RemoteKit SDK Mojo IO");
  base::Thread::Options options;
  options.message_pump_type = base::MessagePumpType::IO;
  if (!state.io_thread->StartWithOptions(std::move(options))) {
    state.io_thread.reset();
    mojo::core::ShutDown();
    state.at_exit.reset();
    state.stopped = true;
    return REMOTEKIT_SDK_INVALID_STATE;
  }
  if (!base::ThreadPoolInstance::Get()) {
    RunPoolLifecycle(state, true);
    state.owns_thread_pool = true;
  }
  state.ipc_support = std::make_unique<mojo::core::ScopedIPCSupport>(
      state.io_thread->task_runner(), mojo::core::ScopedIPCSupport::ShutdownPolicy::CLEAN);
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_shutdown(void) {
  auto& state = State();
  std::unique_lock lock(state.lock);
  if (!state.at_exit || state.stopping)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (state.rtc_peers || !state.render_channels.empty())
    return REMOTEKIT_SDK_INVALID_STATE;
  state.stopping = true;
  for (auto& [id, channel] : state.channels) {
    channel->closed.store(true, std::memory_order_release);
    channel->pending_render.Reset();
  }
  auto channels = std::move(state.channels);
  lock.unlock();
  // In-flight calls keep their channel alive and observe cancellation in the
  // receive loop. No thread closes a pipe while another is reading/writing it.
  channels.clear();
  lock.lock();
  state.idle.wait(lock, [&] { return state.operations == 0; });
  lock.unlock();
  state.ipc_support.reset();
  if (state.owns_thread_pool) {
    RunPoolLifecycle(state, false);
    state.owns_thread_pool = false;
  }
  state.io_thread->Stop();
  state.io_thread.reset();
  mojo::core::ShutDown();
  lock.lock();
  state.at_exit.reset();
  state.stopped = true;
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_mojo_roundtrip(const void* input,
                                 size_t size,
                                 void* output,
                                 size_t capacity,
                                 size_t* output_size) {
  if (!output_size)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *output_size = 0;
  if (size > kMaxMessageSize || capacity < size || (size && (!input || !output))) {
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  }
  // SAFETY: the C ABI requires input/output to designate buffers of the stated
  // sizes. The checks above reject null nonempty buffers and insufficient output
  // capacity. All subsequent comparison/copy operations remain bounded spans.
  const auto input_bytes = UNSAFE_BUFFERS(base::span(static_cast<const uint8_t*>(input), size));
  auto output_bytes = UNSAFE_BUFFERS(base::span(static_cast<uint8_t*>(output), size));
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_INVALID_STATE;
  mojo::ScopedMessagePipeHandle first;
  mojo::ScopedMessagePipeHandle second;
  if (mojo::CreateMessagePipe(nullptr, &first, &second) != MOJO_RESULT_OK)
    return REMOTEKIT_SDK_MOJO_ERROR;
  if (mojo::WriteMessageRaw(first.get(), input, size, nullptr, 0, MOJO_WRITE_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  std::vector<uint8_t> received;
  if (mojo::ReadMessageRaw(second.get(), &received, nullptr, MOJO_READ_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  if (base::span(received) != input_bytes) {
    return REMOTEKIT_SDK_DATA_MISMATCH;
  }
  if (mojo::WriteMessageRaw(second.get(), received.data(), received.size(), nullptr, 0,
                            MOJO_WRITE_MESSAGE_FLAG_NONE) != MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  std::vector<uint8_t> returned;
  if (mojo::ReadMessageRaw(first.get(), &returned, nullptr, MOJO_READ_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return REMOTEKIT_SDK_MOJO_ERROR;
  }
  if (base::span(returned) != input_bytes) {
    return REMOTEKIT_SDK_DATA_MISMATCH;
  }
  output_bytes.copy_from(returned);
  *output_size = size;
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_webrtc_time_millis(int64_t* value) {
  if (!value)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_INVALID_STATE;
  *value = webrtc::TimeMillis();
  return REMOTEKIT_SDK_OK;
}

int remotekit_sdk_control_connect(const char* name_utf8, uint64_t* handle) {
  if (!handle)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *handle = 0;
  if (!name_utf8)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  // SAFETY: name_utf8 is a NUL-terminated C ABI string. Copying/validation below
  // is bounded to 129 bytes, rejecting names longer than the documented limit.
  size_t length = 0;
  for (; length <= 128; ++length) {
    const unsigned char c = UNSAFE_BUFFERS(name_utf8[length]);
    if (c == 0)
      break;
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' ||
          c == '-' || c == '.')) {
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    }
  }
  if (length == 0 || length > 128)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  const auto name = UNSAFE_BUFFERS(std::string_view(name_utf8, length));
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_INVALID_STATE;
  auto& state = State();
  auto endpoint = mojo::NamedPlatformChannel::ConnectToServer(
      mojo::NamedPlatformChannel::ServerNameFromUTF8(name));
  if (!endpoint.is_valid())
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  auto channel = std::make_shared<ControlChannel>();
  channel->pipe = channel->connection.Connect(std::move(endpoint));
  if (!channel->pipe.is_valid())
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::lock_guard lock(state.lock);
  if (state.stopping || state.next_handle == 0)
    return REMOTEKIT_SDK_INVALID_STATE;
  const uint64_t id = state.next_handle++;
  state.channels.emplace(id, std::move(channel));
  *handle = id;
  return REMOTEKIT_SDK_OK;
}

namespace {
int ControlRequestInternal(uint64_t handle,
                           const void* input,
                           size_t size,
                           void* output,
                           size_t capacity,
                           size_t* output_size,
                           uint32_t timeout_ms,
                           std::vector<mojo::ScopedHandle>* attachments) {
  if (attachments)
    attachments->clear();
  if (output_size)
    *output_size = 0;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<ControlChannel> channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.channels.find(handle);
    if (state.stopping || found == state.channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = found->second;
  }
  std::lock_guard request_lock(channel->request_lock);
  if (channel->closed.load(std::memory_order_acquire))
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  const auto fail = [&](int status) {
    RetireChannel(handle, channel);
    return status;
  };
  if (!output_size || size > kMaxMessageSize || (size && !input) || (capacity && !output) ||
      timeout_ms == 0 || timeout_ms > 30000) {
    return fail(REMOTEKIT_SDK_INVALID_ARGUMENT);
  }
  const base::TimeTicks deadline = base::TimeTicks::Now() + base::Milliseconds(timeout_ms);
  const auto pipe = channel->pipe.get();
  if (mojo::WriteMessageRaw(pipe, input, size, nullptr, 0, MOJO_WRITE_MESSAGE_FLAG_NONE) !=
      MOJO_RESULT_OK) {
    return fail(REMOTEKIT_SDK_CHANNEL_CLOSED);
  }
  std::vector<uint8_t> response;
  std::vector<mojo::ScopedHandle> received_handles;
  for (;;) {
    if (channel->closed.load(std::memory_order_acquire))
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    if (base::TimeTicks::Now() >= deadline)
      return fail(REMOTEKIT_SDK_TIMEOUT);
    const MojoResult result =
        mojo::ReadMessageRaw(pipe, &response, &received_handles, MOJO_READ_MESSAGE_FLAG_NONE);
    if (result == MOJO_RESULT_OK)
      break;
    if (result != MOJO_RESULT_SHOULD_WAIT)
      return fail(REMOTEKIT_SDK_CHANNEL_CLOSED);
    base::PlatformThread::Sleep(base::Milliseconds(1));
  }
  if (!attachments && !received_handles.empty())
    return fail(REMOTEKIT_SDK_DATA_MISMATCH);
  if (response.size() > kMaxMessageSize)
    return fail(REMOTEKIT_SDK_MOJO_ERROR);
  if (response.size() > capacity) {
    *output_size = response.size();
    return fail(REMOTEKIT_SDK_BUFFER_TOO_SMALL);
  }
  // SAFETY: the C ABI caller provides capacity bytes, checked above to cover
  // the complete response. Null output is permitted only for an empty buffer.
  auto output_bytes = UNSAFE_BUFFERS(base::span(static_cast<uint8_t*>(output), response.size()));
  output_bytes.copy_from(response);
  *output_size = response.size();
  if (attachments)
    *attachments = std::move(received_handles);
  return REMOTEKIT_SDK_OK;
}

}  // namespace
int remotekit_sdk_control_request(uint64_t handle,
                                  const void* input,
                                  size_t size,
                                  void* output,
                                  size_t capacity,
                                  size_t* output_size,
                                  uint32_t timeout_ms) {
  return ControlRequestInternal(handle, input, size, output, capacity, output_size, timeout_ms,
                                nullptr);
}

int remotekit_sdk_control_close(uint64_t handle) {
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<ControlChannel> channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.channels.find(handle);
    if (found == state.channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = std::move(found->second);
    channel->closed.store(true, std::memory_order_release);
    channel->pending_render.Reset();
    state.channels.erase(found);
  }
  return REMOTEKIT_SDK_OK;
}

namespace {
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
    if (result == MOJO_RESULT_OK && bytes.size() == sizeof(remotekit::RenderWireMessage) &&
        handles.empty()) {
      remotekit::RenderWireMessage message;
      // SAFETY: the enclosing check proves bytes contains exactly sizeof(message)
      // bytes, and message is a complete trivially-copyable wire object.
      UNSAFE_BUFFERS(std::memcpy(&message, bytes.data(), sizeof(message)));
      if (message.magic == remotekit::kRenderWireMagic &&
          message.version == remotekit::kRenderWireVersion &&
          message.type == remotekit::RenderWireType::kReject &&
          remotekit::ValidRenderIdentity(message.begin.identity) && message.reason >= 1 &&
          message.reason <= 4 && !message.begin.interval_us && !message.begin.force) {
        event.type = REMOTEKIT_SDK_RENDER_REJECT;
        event.reason = message.reason;
        event.generation = message.begin.identity.generation;
        event.value = message.begin.identity.value;
        event.slot = message.begin.identity.slot;
      } else if (remotekit::ValidRenderWake(message)) {
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
      } else if (message.type == remotekit::RenderWireType::kStopped &&
                 remotekit::ValidRenderGenerationControl(message)) {
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
}  // namespace
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
  if (mojo::WriteMessageRaw(channel->pipe.get(), &message, sizeof(message), nullptr, 0,
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
  if (mojo::WriteMessageRaw(channel->pipe.get(), &message, sizeof(message), nullptr, 0,
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

namespace {
bool DecimalUint64(std::string_view text, uint64_t* result) {
  if (text.empty() || text.size() > 20)
    return false;
  for (char ch : text)
    if (ch < '0' || ch > '9')
      return false;
  return base::StringToUint64(text, result);
}
bool DecimalInt64(std::string_view text, int64_t* result) {
  if (text.empty() || text.size() > 20)
    return false;
  auto digits = text;
  if (digits.front() == '-')
    digits.remove_prefix(1);
  if (digits.empty())
    return false;
  for (char ch : digits)
    if (ch < '0' || ch > '9')
      return false;
  return base::StringToInt64(text, result);
}
bool StringUint64(const base::DictValue& value, std::string_view key, uint64_t* result) {
  const auto* text = value.FindString(key);
  return text && DecimalUint64(*text, result);
}
bool Uint32Field(const base::DictValue& dict, std::string_view key, uint32_t* result) {
  if (auto number = dict.FindInt(key)) {
    if (*number < 0)
      return false;
    *result = static_cast<uint32_t>(*number);
    return true;
  }
  uint64_t number = 0;
  if (!StringUint64(dict, key, &number) || number > std::numeric_limits<uint32_t>::max())
    return false;
  *result = static_cast<uint32_t>(number);
  return true;
}
bool Int32Field(const base::DictValue& dict, std::string_view key, int32_t* result) {
  if (auto number = dict.FindInt(key)) {
    *result = *number;
    return true;
  }
  const auto* text = dict.FindString(key);
  int64_t number = 0;
  if (!text || !DecimalInt64(*text, &number) || number < std::numeric_limits<int32_t>::min() ||
      number > std::numeric_limits<int32_t>::max())
    return false;
  *result = static_cast<int32_t>(number);
  return true;
}
HANDLE NativeHandle(uint64_t value) {
  return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(value));
}
bool ValidHandle(uint64_t value) {
  if (!value || value > std::numeric_limits<uintptr_t>::max() ||
      value == std::numeric_limits<uintptr_t>::max())
    return false;
  DWORD flags = 0;
  return GetHandleInformation(NativeHandle(value), &flags) != FALSE;
}

// Every identified resource handle in a decoded reply has already been
// duplicated into this process. Keep ownership through all validation paths;
// only the 13 successfully returned handles are released to the caller.
class ReplyHandles {
 public:
  explicit ReplyHandles(const base::DictValue& reply) {
    Collect(reply);
    if (const auto* resources = reply.FindDict("resources"))
      Collect(*resources);
  }
  ~ReplyHandles() {
    for (uint64_t value : owned_)
      if (ValidHandle(value))
        CloseHandle(NativeHandle(value));
  }
  void Transfer(const remotekit_sdk_render_setup& setup) {
    owned_.erase(setup.mapping_handle);
    for (uint64_t value : setup.ready_fence_handles)
      owned_.erase(value);
    for (uint64_t value : setup.consumed_fence_handles)
      owned_.erase(value);
    for (uint64_t value : setup.texture_handles)
      owned_.erase(value);
  }

 private:
  void Add(const base::Value* value) {
    if (!value)
      return;
    uint64_t handle = 0;
    // Invalid numeric JSON types are never accepted for setup, but an exact
    // positive integer is still recognized for failure-path handle cleanup.
    if (const auto* text = value->GetIfString()) {
      if (DecimalUint64(*text, &handle) && handle)
        owned_.insert(handle);
    } else if (auto number = value->GetIfInt(); number && *number > 0) {
      owned_.insert(static_cast<uint64_t>(*number));
    } else if (auto real_number = value->GetIfDouble();
               real_number && *real_number > 0 &&
               *real_number <= std::numeric_limits<uint32_t>::max() &&
               std::floor(*real_number) == *real_number) {
      owned_.insert(static_cast<uint64_t>(*real_number));
    }
  }
  void Collect(const base::DictValue& dict) {
    Add(dict.Find("mapping_handle"));
    for (const char* key : {"ready_fence_handles", "consumed_fence_handles"})
      if (const auto* list = dict.FindList(key))
        for (const auto& value : *list)
          Add(&value);
    if (const auto* textures = dict.FindList("texture_handles"))
      for (const auto& texture : *textures)
        Add(&texture);
    else
      Add(dict.Find("texture_handles"));
  }
  std::set<uint64_t> owned_;
};

int ExchangeJson(uint64_t handle,
                 std::string_view request,
                 uint32_t timeout_ms,
                 std::optional<base::DictValue>* reply,
                 std::vector<mojo::ScopedHandle>* attachments = nullptr) {
  std::vector<uint8_t> response(kMaxMessageSize);
  size_t size = 0;
  // control_request serializes the exchange on this channel only.
  int status = ControlRequestInternal(handle, request.data(), request.size(), response.data(),
                                      response.size(), &size, timeout_ms, attachments);
  if (status != REMOTEKIT_SDK_OK)
    return status;
  if (size > response.size())
    return REMOTEKIT_SDK_DATA_MISMATCH;
  *reply = base::JSONReader::ReadDict(base::as_string_view(base::span(response).first(size)),
                                      base::JSON_PARSE_RFC, 32);
  return reply->has_value() ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_DATA_MISMATCH;
}

bool ReadToken(const base::DictValue& reply, remotekit_sdk_token* token) {
  const auto* node = reply.Find("token");
  if (!node)
    return true;
  const auto* dict = node->GetIfDict();
  if (!dict)
    return false;
  remotekit_sdk_token parsed{};
  if (!StringUint64(*dict, "session", &parsed.session) || !parsed.session ||
      !StringUint64(*dict, "view", &parsed.view) || !parsed.view ||
      !StringUint64(*dict, "instance", &parsed.instance) || !parsed.instance ||
      !StringUint64(*dict, "document", &parsed.document) || !parsed.document ||
      !StringUint64(*dict, "focus", &parsed.focus) || !parsed.focus)
    return false;
  *token = parsed;
  return true;
}

int Command(uint64_t handle,
            const char* json,
            size_t size,
            uint32_t timeout_ms,
            remotekit_sdk_token* token) {
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  if (token)
    *token = {};
  if (!json || !size || size > kMaxMessageSize || !timeout_ms || timeout_ms > 30000)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  // SAFETY: the caller supplies size bytes of JSON as required by this C ABI.
  const auto request = UNSAFE_BUFFERS(std::string_view(json, size));
  std::optional<base::DictValue> reply;
  int status = ExchangeJson(handle, request, timeout_ms, &reply);
  if (status != REMOTEKIT_SDK_OK)
    return status;
  ReplyHandles handles(*reply);
  if (token && !ReadToken(*reply, token))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  if (reply->FindBool("ok") == true)
    return REMOTEKIT_SDK_OK;
  if (reply->FindInt("code") == remotekit::protocol::kBusyError)
    return REMOTEKIT_SDK_BUSY;
  return REMOTEKIT_SDK_DATA_MISMATCH;
}

int NextRequestId() {
  static std::atomic<uint32_t> sequence{0};
  return static_cast<int>(sequence.fetch_add(1, std::memory_order_relaxed) %
                          static_cast<uint32_t>(std::numeric_limits<int>::max())) +
         1;
}
uint32_t RemainingMilliseconds(base::TimeTicks deadline) {
  const auto left = deadline - base::TimeTicks::Now();
  if (left <= base::TimeDelta())
    return 0;
  return static_cast<uint32_t>(std::clamp<int64_t>(left.InMillisecondsRoundedUp(), 1, 30000));
}
bool Pending(const base::DictValue& reply) {
  const auto* error = reply.FindString("error");
  return reply.FindBool("pending") == true && (!error || *error == "output_pending");
}
// Log only exact, bounded Browser-owned error literals. Unknown replies never
// expose arbitrary payloads, full JSON, resource handles or OS error values.
void LogRenderOpenFailure(bool opening, const base::DictValue& reply, std::string_view fallback) {
  constexpr std::string_view kKnownErrors[] = {
      "output_gpu_fault_sealed",
      "consumer_pid_required",
      "output_not_open",
      "invalid_envelope",
      "response_too_large",
      "OSR stopped",
      "one consumer per generation",
      "invalid consumer pid",
      "OpenProcess consumer failed",
      "DuplicateHandle consumer failed",
      "previous OSR GPU fault remains sealed",
      "invalid OSR dimensions/generation",
      "render mapping allocation failed",
      "OSR hardware D3D11.4/shader initialization failed",
      "OSR slot resources allocation failed",
      "too many OSR planes",
      "invalid OSR plane layout",
      "native-window OSR output unsupported; use offscreen service host",
      "Viz root rebound with unretired OSR producer work",
      "OSR output configuration did not succeed within 5 seconds",
      "OSR plane resources allocation failed",
      "OSR handle duplicate failed",
      "Begin attempted reuse before its slot consumed GPU fence",
      "OSR Begin capacity exceeded",
      "Viz OSR write completion unknown/lost",
      "slot consumed without producer ready completion",
      "OSR plane GPU Wait failed",
      "OSR atlas GPU Signal failed",
      "render stop generation mismatch",
      "OSR D3D device removed",
  };
  std::string_view detail = fallback;
  if (const auto* error = reply.FindString("error")) {
    detail = "unclassified_browser_error";
    if (error->size() <= 96 && std::ranges::find(kKnownErrors, *error) != std::end(kKnownErrors))
      detail = *error;
  }
  LOG(ERROR) << "RemoteKit SDK " << (opening ? "output.open" : "output.describe")
             << " failed browser_error=" << detail;
}
bool ParseRender(const base::DictValue& reply, remotekit_sdk_render_setup* setup) {
  const auto* resources = reply.FindDict("resources");
  if (reply.Find("resources") && !resources)
    return false;
  const auto& dict = resources ? *resources : reply;
  remotekit_sdk_render_setup parsed{};
  parsed.struct_size = sizeof(parsed);
  if (!StringUint64(dict, "generation", &parsed.generation) || !parsed.generation ||
      !Uint32Field(dict, "width", &parsed.width) || !parsed.width || parsed.width > 16384 ||
      !Uint32Field(dict, "height", &parsed.height) || !parsed.height || parsed.height > 16384 ||
      !Uint32Field(dict, "mapping_size", &parsed.mapping_size) ||
      parsed.mapping_size != sizeof(remotekit::SharedRenderMapping) ||
      !StringUint64(dict, "mapping_handle", &parsed.mapping_handle) ||
      !Uint32Field(dict, "adapter_luid_low", &parsed.adapter_luid_low) ||
      !Int32Field(dict, "adapter_luid_high", &parsed.adapter_luid_high))
    return false;
  const auto* name = dict.FindString("render_channel");
  if (!name || name->empty() || name->size() > 128)
    return false;
  for (char ch : *name)
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
          ch == '_' || ch == '-' || ch == '.'))
      return false;
  // SAFETY: name is bounded above to 128 bytes; render_channel has 129 bytes
  // and parsed was zero-initialized, preserving the terminating NUL.
  UNSAFE_BUFFERS(std::memcpy(parsed.render_channel, name->data(), name->size()));
  std::set<uint64_t> unique{parsed.mapping_handle};
  for (auto entry :
       {std::pair{"texture_handles", base::span(parsed.texture_handles)},
        std::pair{"ready_fence_handles", base::span(parsed.ready_fence_handles)},
        std::pair{"consumed_fence_handles", base::span(parsed.consumed_fence_handles)}}) {
    const auto* list = dict.FindList(entry.first);
    if (!list || list->size() != 4)
      return false;
    for (size_t i = 0; i < 4; ++i) {
      const auto* text = (*list)[i].GetIfString();
      if (!text || !DecimalUint64(*text, &entry.second[i]))
        return false;
      unique.insert(entry.second[i]);
    }
  }
  if (unique.size() != 13)
    return false;
  for (uint64_t handle : unique)
    if (!ValidHandle(handle))
      return false;
  *setup = parsed;
  return true;
}
}  // namespace

int remotekit_sdk_control_command(uint64_t handle,
                                  const char* json,
                                  size_t size,
                                  uint32_t timeout_ms) {
  return Command(handle, json, size, timeout_ms, nullptr);
}
int remotekit_sdk_control_command_token(uint64_t handle,
                                        const char* json,
                                        size_t size,
                                        uint32_t timeout_ms,
                                        remotekit_sdk_token* token) {
  if (!token)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *token = {};
  return Command(handle, json, size, timeout_ms, token);
}
int remotekit_sdk_control_open_render(uint64_t handle,
                                      uint32_t consumer_pid,
                                      remotekit_sdk_render_setup* setup,
                                      uint32_t timeout_ms) {
  if (!setup || setup->struct_size != sizeof(*setup))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *setup = {};
  setup->struct_size = sizeof(*setup);
  if (consumer_pid != GetCurrentProcessId() || !timeout_ms || timeout_ms > 30000)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  std::shared_ptr<ControlChannel> control_channel;
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    const auto found = state.channels.find(handle);
    if (found == state.channels.end() || found->second->closed.load(std::memory_order_acquire))
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    control_channel = found->second;
  }
  // Serialize complete open/describe helpers, beyond per-request serialization.
  std::lock_guard open_lock(control_channel->open_lock);
  {
    auto& state = State();
    std::lock_guard lock(state.lock);
    control_channel->pending_render.Reset();
    if (control_channel->closed.load(std::memory_order_acquire))
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
  }
  const auto deadline = base::TimeTicks::Now() + base::Milliseconds(timeout_ms);
  bool opening = true;
  for (;;) {
    const uint32_t remaining = RemainingMilliseconds(deadline);
    if (!remaining)
      return REMOTEKIT_SDK_TIMEOUT;
    const int id = NextRequestId();
    base::DictValue request;
    request.Set("version", 1);
    request.Set("id", id);
    request.Set("method", opening ? "output.open" : "output.describe");
    request.Set("consumer_pid", base::NumberToString(consumer_pid));
    auto encoded = base::WriteJson(request);
    if (!encoded)
      return REMOTEKIT_SDK_DATA_MISMATCH;
    std::optional<base::DictValue> reply;
    std::vector<mojo::ScopedHandle> attachments;
    int status = ExchangeJson(handle, *encoded, remaining, &reply, &attachments);
    if (status != REMOTEKIT_SDK_OK)
      return status;
    ReplyHandles handles(*reply);
    if (reply->FindInt("version") != 1 || reply->FindInt("id") != id) {
      LogRenderOpenFailure(opening, *reply, "invalid_reply_envelope");
      return REMOTEKIT_SDK_DATA_MISMATCH;
    }
    if (!RemainingMilliseconds(deadline))
      return REMOTEKIT_SDK_TIMEOUT;
    // Only a successful describe may carry one endpoint. All rejected, pending
    // or opening replies destroy their attachments before returning.
    if (!attachments.empty() && (opening || reply->FindBool("ok") != true || Pending(*reply))) {
      LogRenderOpenFailure(opening, *reply, "unexpected_render_endpoint");
      return REMOTEKIT_SDK_DATA_MISMATCH;
    }
    if (opening) {
      const bool accepted = reply->FindBool("ok") == true && reply->FindBool("accepted") == true &&
                            !reply->Find("error");
      if (!accepted && !Pending(*reply)) {
        LogRenderOpenFailure(true, *reply, "open_not_accepted");
        return REMOTEKIT_SDK_DATA_MISMATCH;
      }
      opening = false;
    } else if (reply->FindBool("ok") == true) {
      if (reply->Find("error")) {
        LogRenderOpenFailure(false, *reply, "unexpected_reply_error");
        return REMOTEKIT_SDK_DATA_MISMATCH;
      }
      remotekit_sdk_render_setup parsed{};
      if (!ParseRender(*reply, &parsed)) {
        LogRenderOpenFailure(false, *reply, "invalid_render_resources");
        return REMOTEKIT_SDK_DATA_MISMATCH;
      }
      if (!RemainingMilliseconds(deadline))
        return REMOTEKIT_SDK_TIMEOUT;
      const auto* resources = reply->FindDict("resources");
      const auto& description = resources ? *resources : *reply;
      const auto* token = description.FindString("render_channel");
      {
        auto& state = State();
        std::lock_guard lock(state.lock);
        const auto found = state.channels.find(handle);
        if (state.stopping || found == state.channels.end() || found->second != control_channel ||
            control_channel->closed.load(std::memory_order_acquire))
          return REMOTEKIT_SDK_CHANNEL_CLOSED;
        for (const auto& [other_id, other] : state.channels) {
          if (other != control_channel && other->pending_render.Matches(*token)) {
            LogRenderOpenFailure(false, *reply, "duplicate_render_token");
            return REMOTEKIT_SDK_DATA_MISMATCH;
          }
        }
        if (!control_channel->pending_render.Install(*token, std::move(attachments))) {
          LogRenderOpenFailure(false, *reply, "invalid_render_endpoint");
          return REMOTEKIT_SDK_DATA_MISMATCH;
        }
        if (!RemainingMilliseconds(deadline)) {
          control_channel->pending_render.Reset();
          return REMOTEKIT_SDK_TIMEOUT;
        }
      }
      *setup = parsed;
      handles.Transfer(parsed);
      return REMOTEKIT_SDK_OK;
    } else if (!Pending(*reply)) {
      LogRenderOpenFailure(false, *reply, "describe_not_accepted");
      return REMOTEKIT_SDK_DATA_MISMATCH;
    }
    const uint32_t sleep_ms = RemainingMilliseconds(deadline);
    if (!sleep_ms)
      return REMOTEKIT_SDK_TIMEOUT;
    base::PlatformThread::Sleep(base::Milliseconds(std::min<uint32_t>(10, sleep_ms)));
  }
}
uint32_t remotekit_sdk_windows_dom_code(uint32_t native_scan_code) {
  if (native_scan_code > static_cast<uint32_t>(std::numeric_limits<int>::max()))
    return 0;
  return static_cast<uint32_t>(
      ui::KeycodeConverter::NativeKeycodeToDomCode(static_cast<int>(native_scan_code)));
}
uint64_t remotekit_sdk_windows_dom_key(uint32_t virtual_key,
                                       uint32_t blink_modifiers,
                                       uint64_t keyboard_layout) {
  if (virtual_key > 255)
    return 0;
  int flags = 0;
  if (blink_modifiers & 1)
    flags |= ui::EF_SHIFT_DOWN;
  if (blink_modifiers & 2)
    flags |= ui::EF_CONTROL_DOWN;
  if (blink_modifiers & 4)
    flags |= ui::EF_ALT_DOWN;
  if (blink_modifiers & 512)
    flags |= ui::EF_CAPS_LOCK_ON;
  const HKL current = GetKeyboardLayout(0);
  const HKL requested = reinterpret_cast<HKL>(static_cast<uintptr_t>(keyboard_layout));
  const bool change = requested && requested != current;
  if (change && !ActivateKeyboardLayout(requested, 0))
    return 0;
  const auto key = ui::PlatformKeyMap::DomKeyFromKeyboardCode(
      static_cast<ui::KeyboardCode>(virtual_key), &flags);
  if (change)
    ActivateKeyboardLayout(current, 0);
  return static_cast<uint64_t>(key);
}
