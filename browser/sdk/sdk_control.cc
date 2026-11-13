#include "remotekit/browser/sdk/sdk_internal.h"
#include "remotekit/browser/sdk/sdk_resources.h"
#include "browser/control_clipboard.h"

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
  const auto parsed = base::JSONReader::ReadDict(request, base::JSON_PARSE_RFC, 32);
  if (!parsed)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  std::vector<uint8_t> response(browser::ControlResponseJsonLimit(*parsed));
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
int ReplyStatus(const base::DictValue& reply, remotekit_sdk_failure* failure) {
  if (reply.FindInt("version") != 1 || !reply.FindInt("id"))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  if (reply.FindBool("ok") == true && !reply.contains("error"))
    return REMOTEKIT_SDK_OK;
  const auto* error = reply.FindDict("error");
  const auto* code = error ? error->FindString("code") : nullptr;
  const auto* message = error ? error->FindString("message") : nullptr;
  if (reply.FindBool("ok") != false || !code || !message || !protocol::ParseErrorCode(*code))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  const auto parsed_code = *protocol::ParseErrorCode(*code);
  for (const auto [key, value] : *error)
    if (key != "code" && key != "message" && key != "reason" && key != "retryAfterMs" &&
        key != "errorId")
      return REMOTEKIT_SDK_DATA_MISMATCH;
  if (error->contains("reason") &&
      (!error->FindString("reason") || !protocol::ParseErrorReason(*error->FindString("reason"))))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  if (error->contains("errorId") &&
      (!error->FindString("errorId") || error->FindString("errorId")->empty()))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  const auto retry = error->FindInt("retryAfterMs");
  if (error->contains("retryAfterMs") && (!retry || *retry < 0 || *retry > 86400000 ||
                                          (parsed_code != protocol::ErrorCode::kBusy &&
                                           parsed_code != protocol::ErrorCode::kRateLimited &&
                                           parsed_code != protocol::ErrorCode::kUnavailable)))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  if (failure) {
    *failure = {};
    auto copy = [](auto& target, const std::string& source) {
      const size_t count = std::min(source.size(), sizeof(target) - 1);
      UNSAFE_BUFFERS(std::memcpy(target, source.data(), count));
    };
    copy(failure->code, *code);
    copy(failure->message, *message);
    if (const auto* reason = error->FindString("reason");
        reason && protocol::ParseErrorReason(*reason))
      copy(failure->reason, *reason);
    if (retry) {
      failure->retry_after_ms = *retry;
      failure->has_retry_after = 1;
    }
  }
  return REMOTEKIT_SDK_REFUSED;
}
bool ValidReplyToken(const base::DictValue& reply) {
  const auto* node = reply.Find("token");
  if (!node)
    return true;
  const auto* dict = node->GetIfDict();
  if (!dict || dict->size() != 5)
    return false;
  for (auto field : {"session", "view", "instance", "document", "focus"}) {
    uint64_t value = 0;
    if (!StringUint64(*dict, field, &value) || !value)
      return false;
  }
  return true;
}
int Command(uint64_t handle,
            const char* json,
            size_t size,
            uint32_t timeout_ms,
            remotekit_sdk_failure* failure) {
  OperationLease lease;
  if (!lease)
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  if (failure)
    *failure = {};
  if (!json || !size || size > browser::kClipboardJsonLimit || !timeout_ms || timeout_ms > 30000)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  // SAFETY: the caller supplies size bytes of JSON as required by this C ABI.
  const auto request = UNSAFE_BUFFERS(std::string_view(json, size));
  std::optional<base::DictValue> reply;
  int status = ExchangeJson(handle, request, timeout_ms, &reply);
  if (status != REMOTEKIT_SDK_OK)
    return status;
  ReplyHandles handles(*reply);
  if (!ValidReplyToken(*reply))
    return REMOTEKIT_SDK_DATA_MISMATCH;
  return ReplyStatus(*reply, failure);
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
  if (state.phase != SDKPhase::kRunning || state.next_handle == 0)
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
    if (state.phase != SDKPhase::kRunning || found == state.channels.end())
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    channel = found->second;
  }
  std::lock_guard request_lock(channel->request_lock);
  if (channel->closed.load(std::memory_order_acquire))
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  const auto fail = [&](int status) {
    if (status == REMOTEKIT_SDK_CHANNEL_CLOSED || status == REMOTEKIT_SDK_MOJO_ERROR ||
        status == REMOTEKIT_SDK_LOST)
      RetireChannel(handle, channel);
    return status;
  };
  if (!output_size || size > browser::kClipboardJsonLimit || (size && !input) ||
      (capacity && !output) || timeout_ms == 0 || timeout_ms > 30000) {
    return fail(REMOTEKIT_SDK_INVALID_ARGUMENT);
  }
  const auto bytes = UNSAFE_BUFFERS(std::string_view(static_cast<const char*>(input), size));
  auto request = base::JSONReader::ReadDict(bytes, base::JSON_PARSE_RFC, 32);
  if (!request || size > browser::ControlRequestJsonLimit(*request) || !request->FindInt("id") ||
      channel->next_request_id == INT_MAX)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  const int caller_id = *request->FindInt("id");
  const int wire_id = ++channel->next_request_id;
  request->Set("id", wire_id);
  const auto encoded = base::WriteJson(*request);
  if (!encoded || encoded->size() > browser::ControlRequestJsonLimit(*request))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  const auto started = base::TimeTicks::Now();
  const base::TimeTicks deadline = started + base::Milliseconds(timeout_ms);
  const auto pipe = channel->pipe.get();
  const auto written = mojo::WriteMessageRaw(pipe, encoded->data(), encoded->size(), nullptr, 0,
                                             MOJO_WRITE_MESSAGE_FLAG_NONE);
  if (written != MOJO_RESULT_OK)
    return fail(written == MOJO_RESULT_FAILED_PRECONDITION ? REMOTEKIT_SDK_CHANNEL_CLOSED
                                                           : REMOTEKIT_SDK_MOJO_ERROR);
  std::vector<uint8_t> response;
  std::vector<mojo::ScopedHandle> received_handles;
  for (;;) {
    if (channel->closed.load(std::memory_order_acquire))
      return fail(REMOTEKIT_SDK_LOST);
    if (base::TimeTicks::Now() >= deadline) {
      LOG(WARNING) << "RemoteKit control timeout method="
                   << (request->FindString("method") ? *request->FindString("method") : "")
                   << " request_id=" << caller_id << " wire_id=" << wire_id
                   << " elapsed_ms=" << (base::TimeTicks::Now() - started).InMilliseconds()
                   << " sdk_status=" << REMOTEKIT_SDK_TIMEOUT;
      return REMOTEKIT_SDK_TIMEOUT;
    }
    const MojoResult result =
        mojo::ReadMessageRaw(pipe, &response, &received_handles, MOJO_READ_MESSAGE_FLAG_NONE);
    if (result == MOJO_RESULT_OK) {
      if (response.size() > browser::kClipboardJsonLimit)
        return fail(REMOTEKIT_SDK_DATA_MISMATCH);
      auto reply = base::JSONReader::ReadDict(base::as_string_view(base::span(response)),
                                              base::JSON_PARSE_RFC, 32);
      if (!reply)
        return REMOTEKIT_SDK_DATA_MISMATCH;
      const auto reply_id = reply->FindInt("id");
      if (!reply_id || *reply_id <= 0 || *reply_id > wire_id) {
        ReplyHandles discard(*reply);
        return REMOTEKIT_SDK_DATA_MISMATCH;
      }
      if (*reply_id != wire_id) {
        // A timed-out output.describe can carry both Mojo endpoints and native
        // handles duplicated into this process. Drop both kinds of ownership.
        ReplyHandles discard(*reply);
        received_handles.clear();
        response.clear();
        continue;
      }
      if (response.size() > browser::ControlResponseJsonLimit(*request)) {
        ReplyHandles discard(*reply);
        return fail(REMOTEKIT_SDK_DATA_MISMATCH);
      }
      reply->Set("id", caller_id);
      const auto restored = base::WriteJson(*reply);
      if (!restored)
        return REMOTEKIT_SDK_DATA_MISMATCH;
      if (restored->size() > capacity || (!attachments && !received_handles.empty())) {
        ReplyHandles discard(*reply);
        *output_size = restored->size();
        return restored->size() > capacity ? REMOTEKIT_SDK_BUFFER_TOO_SMALL
                                           : REMOTEKIT_SDK_DATA_MISMATCH;
      }
      response.assign(restored->begin(), restored->end());
      break;
    }
    if (result != MOJO_RESULT_SHOULD_WAIT)
      return fail(REMOTEKIT_SDK_LOST);
    base::PlatformThread::Sleep(base::Milliseconds(1));
  }
  if (!attachments && !received_handles.empty())
    return fail(REMOTEKIT_SDK_DATA_MISMATCH);
  if (response.size() > browser::ControlResponseJsonLimit(*request))
    return fail(REMOTEKIT_SDK_DATA_MISMATCH);
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
                                  uint32_t timeout_ms,
                                  remotekit_sdk_failure* failure) {
  return Command(handle, json, size, timeout_ms, failure);
}
