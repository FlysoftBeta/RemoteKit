#include "remotekit/browser/sdk/sdk_internal.h"
#include "remotekit/browser/sdk/sdk_resources.h"

using namespace remotekit::sdk;
namespace remotekit::sdk {
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
int ExchangeJson(uint64_t handle,
                 std::string_view request,
                 uint32_t timeout_ms,
                 std::optional<base::DictValue>* reply,
                 std::vector<mojo::ScopedHandle>* attachments) {
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
}  // namespace remotekit::sdk
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

namespace remotekit::sdk {
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

}  // namespace remotekit::sdk
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
