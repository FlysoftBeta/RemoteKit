#include "remotekit/browser/sdk/sdk_internal.h"
#include "remotekit/browser/sdk/sdk_resources.h"

using namespace remotekit::sdk;
namespace remotekit::sdk {
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

ReplyHandles::ReplyHandles(const base::DictValue& reply) {
  Collect(reply);
  if (const auto* resources = reply.FindDict("resources"))
    Collect(*resources);
}
ReplyHandles::~ReplyHandles() {
  for (uint64_t value : owned_)
    if (ValidHandle(value))
      CloseHandle(NativeHandle(value));
}
void ReplyHandles::Transfer(const remotekit_sdk_render_setup& setup) {
  owned_.erase(setup.mapping_handle);
  for (uint64_t value : setup.ready_fence_handles)
    owned_.erase(value);
  for (uint64_t value : setup.consumed_fence_handles)
    owned_.erase(value);
  for (uint64_t value : setup.texture_handles)
    owned_.erase(value);
}
void ReplyHandles::Add(const base::Value* value) {
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
void ReplyHandles::Collect(const base::DictValue& dict) {
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
  const auto* error = reply.FindDict("error");
  return reply.FindBool("pending") == true && error && error->FindString("code") &&
         *error->FindString("code") == "busy";
}
void LogRenderOpenFailure(bool opening, const base::DictValue& reply, std::string_view fallback) {
  LOG(ERROR) << "RemoteKit SDK " << (opening ? "output.open" : "output.describe")
             << " failed: " << fallback;
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

}  // namespace remotekit::sdk
int remotekit_sdk_control_open_render(uint64_t handle,
                                      uint32_t consumer_pid,
                                      remotekit_sdk_render_setup* setup,
                                      uint32_t timeout_ms,
                                      remotekit_sdk_failure* failure) {
  if (failure)
    *failure = {};
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
  std::optional<base::TimeTicks> deadline;
  bool opening = true;
  bool written = false;
  for (;;) {
    if (!deadline)
      deadline = base::TimeTicks::Now() + base::Milliseconds(timeout_ms);
    const uint32_t remaining = opening ? timeout_ms : RemainingMilliseconds(*deadline);
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
      return written &&
                     (status == REMOTEKIT_SDK_CHANNEL_CLOSED || status == REMOTEKIT_SDK_MOJO_ERROR)
                 ? REMOTEKIT_SDK_LOST
                 : status;
    written = true;
    ReplyHandles handles(*reply);
    if (reply->FindInt("version") != 1 || reply->FindInt("id") != id) {
      LogRenderOpenFailure(opening, *reply, "invalid_reply_envelope");
      return REMOTEKIT_SDK_DATA_MISMATCH;
    }
    if (!RemainingMilliseconds(*deadline))
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
        return ReplyStatus(*reply, failure);
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
      if (!RemainingMilliseconds(*deadline))
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
          return REMOTEKIT_SDK_LOST;
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
        if (!RemainingMilliseconds(*deadline)) {
          control_channel->pending_render.Reset();
          return REMOTEKIT_SDK_TIMEOUT;
        }
      }
      *setup = parsed;
      handles.Transfer(parsed);
      return REMOTEKIT_SDK_OK;
    } else if (!Pending(*reply)) {
      LogRenderOpenFailure(false, *reply, "describe_not_accepted");
      return ReplyStatus(*reply, failure);
    }
    const uint32_t sleep_ms = RemainingMilliseconds(*deadline);
    if (!sleep_ms)
      return REMOTEKIT_SDK_TIMEOUT;
    base::PlatformThread::Sleep(base::Milliseconds(std::min<uint32_t>(10, sleep_ms)));
  }
}
