// Register local Mojo peers through internal types and link production objects.
#include "sdk_internal.h"
#include "sdk_resources.h"
#include "browser/control_clipboard.h"
#include "browser/control_response.h"
using namespace remotekit::sdk;

#include <chrono>
#include <cstdio>
#include <thread>

#include "base/check.h"
#include "mojo/public/cpp/system/buffer.h"

namespace {
using namespace std::chrono_literals;

struct TestChannel {
  uint64_t id;
  mojo::ScopedMessagePipeHandle peer;
  std::weak_ptr<ControlChannel> lifetime;
};

TestChannel NewChannel() {
  auto channel = std::make_shared<ControlChannel>();
  TestChannel result{};
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &channel->pipe, &result.peer), MOJO_RESULT_OK);
  result.lifetime = channel;
  auto& state = State();
  std::lock_guard lock(state.lock);
  result.id = state.next_handle++;
  state.channels.emplace(result.id, std::move(channel));
  return result;
}

void WaitFor(auto predicate) {
  const auto until = std::chrono::steady_clock::now() + 3s;
  while (!predicate()) {
    CHECK(std::chrono::steady_clock::now() < until);
    std::this_thread::sleep_for(1ms);
  }
}

std::vector<uint8_t> Read(mojo::MessagePipeHandle pipe) {
  std::vector<uint8_t> bytes;
  WaitFor([&] {
    const auto status = mojo::ReadMessageRaw(pipe, &bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE);
    CHECK(status == MOJO_RESULT_OK || status == MOJO_RESULT_SHOULD_WAIT);
    return status == MOJO_RESULT_OK;
  });
  return bytes;
}

void Reply(mojo::MessagePipeHandle pipe, const std::vector<uint8_t>& bytes) {
  CHECK_EQ(mojo::WriteMessageRaw(pipe, bytes.data(), bytes.size(), nullptr, 0,
                                 MOJO_WRITE_MESSAGE_FLAG_NONE),
           MOJO_RESULT_OK);
}

int Payload(const std::vector<uint8_t>& bytes) {
  auto request =
      base::JSONReader::ReadDict(base::as_string_view(base::span(bytes)), base::JSON_PARSE_RFC);
  CHECK(request);
  return *request->FindInt("probe");
}
int Request(uint64_t id, uint8_t byte, uint32_t timeout_ms = 5000) {
  const auto input =
      base::WriteJson(base::DictValue().Set("id", int(byte)).Set("probe", int(byte)));
  std::array<char, 512> output{};
  size_t size = 0;
  const int status = remotekit_sdk_control_request(id, input->data(), input->size(), output.data(),
                                                   output.size(), &size, timeout_ms);
  if (status == REMOTEKIT_SDK_OK) {
    auto reply =
        base::JSONReader::ReadDict(std::string_view(output.data(), size), base::JSON_PARSE_RFC);
    CHECK(reply);
    CHECK_EQ(*reply->FindInt("probe"), int(byte));
    CHECK_EQ(*reply->FindInt("id"), int(byte));
  }
  return status;
}

void ParallelChannelsAndClose() {
  auto slow = NewChannel();
  auto fast = NewChannel();
  int slow_status = -1;
  std::thread pending([&] { slow_status = Request(slow.id, 1); });
  CHECK_EQ(Payload(Read(slow.peer.get())), 1);
  const auto start = std::chrono::steady_clock::now();
  CHECK_EQ(RemoteKitSdkBeginRtc(), REMOTEKIT_SDK_OK);
  RemoteKitSdkEndRtc();
  std::thread responder([&] { Reply(fast.peer.get(), Read(fast.peer.get())); });
  CHECK_EQ(Request(fast.id, 2), REMOTEKIT_SDK_OK);
  responder.join();
  CHECK(std::chrono::steady_clock::now() - start < 1s);
  CHECK_EQ(remotekit_sdk_control_close(slow.id), REMOTEKIT_SDK_OK);
  pending.join();
  CHECK_EQ(slow_status, REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK(slow.lifetime.expired());
  CHECK_EQ(Request(slow.id, 3), REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK_EQ(remotekit_sdk_control_close(fast.id), REMOTEKIT_SDK_OK);
}

void SameChannelSerializationAndQueuedClose() {
  auto channel = NewChannel();
  int first_status = -1;
  int second_status = -1;
  std::thread first([&] { first_status = Request(channel.id, 3); });
  auto first_bytes = Read(channel.peer.get());
  std::thread second([&] { second_status = Request(channel.id, 4); });
  WaitFor([] {
    std::lock_guard lock(State().lock);
    return State().operations == 2;
  });
  std::vector<uint8_t> premature;
  CHECK_EQ(
      mojo::ReadMessageRaw(channel.peer.get(), &premature, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
      MOJO_RESULT_SHOULD_WAIT);
  Reply(channel.peer.get(), first_bytes);
  auto second_bytes = Read(channel.peer.get());
  CHECK_EQ(Payload(second_bytes), 4);
  Reply(channel.peer.get(), second_bytes);
  first.join();
  second.join();
  CHECK_EQ(first_status, REMOTEKIT_SDK_OK);
  CHECK_EQ(second_status, REMOTEKIT_SDK_OK);

  std::thread active([&] { first_status = Request(channel.id, 5); });
  Read(channel.peer.get());
  std::thread queued([&] { second_status = Request(channel.id, 6); });
  WaitFor([] {
    std::lock_guard lock(State().lock);
    return State().operations == 2;
  });
  CHECK_EQ(remotekit_sdk_control_close(channel.id), REMOTEKIT_SDK_OK);
  active.join();
  queued.join();
  CHECK_EQ(first_status, REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK_EQ(second_status, REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK(channel.lifetime.expired());
}

std::vector<mojo::ScopedHandle> GenericEndpoints(
    std::vector<mojo::ScopedMessagePipeHandle> endpoints) {
  std::vector<mojo::ScopedHandle> result;
  for (auto& endpoint : endpoints)
    result.emplace_back(endpoint.release());
  return result;
}
void PendingEndpointOwnership() {
  remotekit::sdk::PendingRenderEndpoint pending;
  CHECK(!pending.Install("zero", {}));
  std::vector<mojo::ScopedMessagePipeHandle> endpoints;
  std::vector<mojo::ScopedMessagePipeHandle> peers;
  for (int i = 0; i < 2; ++i) {
    mojo::ScopedMessagePipeHandle endpoint, peer;
    CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &peer), MOJO_RESULT_OK);
    endpoints.push_back(std::move(endpoint));
    peers.push_back(std::move(peer));
  }
  CHECK(!pending.Install("multiple", GenericEndpoints(std::move(endpoints))));
  for (const auto& peer : peers) {
    std::vector<uint8_t> bytes;
    CHECK_EQ(mojo::ReadMessageRaw(peer.get(), &bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
             MOJO_RESULT_FAILED_PRECONDITION);
  }
  auto buffer = mojo::SharedBufferHandle::Create(4096);
  CHECK(buffer.is_valid());
  std::vector<mojo::ScopedHandle> wrong_type;
  wrong_type.emplace_back(buffer.release());
  CHECK(!pending.Install("wrong-type", std::move(wrong_type)));
  mojo::ScopedMessagePipeHandle endpoint, peer;
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &peer), MOJO_RESULT_OK);
  std::vector<mojo::ScopedHandle> one;
  one.emplace_back(endpoint.release());
  CHECK(pending.Install("once", std::move(one)));
  CHECK(!pending.Claim("other").is_valid());
  auto claimed = pending.Claim("once");
  CHECK(claimed.is_valid());
  CHECK(!pending.Claim("once").is_valid());
  // Reset must not own or close an endpoint after its one-use claim.
  pending.Reset();
  Reply(claimed.get(), {9});
  CHECK_EQ(Read(peer.get()).front(), 9);
  claimed.reset();
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &peer), MOJO_RESULT_OK);
  one.emplace_back(endpoint.release());
  CHECK(pending.Install("close", std::move(one)));
  pending.Reset();
  std::vector<uint8_t> bytes;
  CHECK_EQ(mojo::ReadMessageRaw(peer.get(), &bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
           MOJO_RESULT_FAILED_PRECONDITION);
}
void ReplyWithEndpoints(mojo::MessagePipeHandle pipe,
                        const base::DictValue& reply,
                        std::vector<mojo::ScopedMessagePipeHandle>* endpoints) {
  const auto json = base::WriteJson(reply);
  CHECK(json);
  std::vector<MojoHandle> raw;
  for (const auto& endpoint : *endpoints)
    raw.push_back(endpoint.get().value());
  CHECK_EQ(mojo::WriteMessageRaw(pipe, json->data(), json->size(), raw.data(), raw.size(),
                                 MOJO_WRITE_MESSAGE_FLAG_NONE),
           MOJO_RESULT_OK);
  for (auto& endpoint : *endpoints)
    static_cast<void>(endpoint.release());
}
base::DictValue ReadJsonRequest(mojo::MessagePipeHandle pipe) {
  auto bytes = Read(pipe);
  auto request =
      base::JSONReader::ReadDict(base::as_string_view(base::span(bytes)), base::JSON_PARSE_RFC);
  CHECK(request);
  return std::move(*request);
}
void OpenRenderAttachmentContract(size_t attachment_count) {
  auto control = NewChannel();
  mojo::ScopedMessagePipeHandle old_endpoint, old_producer;
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &old_endpoint, &old_producer), MOJO_RESULT_OK);
  {
    std::lock_guard lock(State().lock);
    std::vector<mojo::ScopedHandle> old;
    old.emplace_back(old_endpoint.release());
    CHECK(State().channels.at(control.id)->pending_render.Install("old-unclaimed", std::move(old)));
  }
  std::vector<uint64_t> windows_handles;
  for (size_t i = 0; i < 13; ++i) {
    HANDLE event = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    CHECK(event);
    windows_handles.push_back(reinterpret_cast<uintptr_t>(event));
  }
  std::vector<mojo::ScopedMessagePipeHandle> endpoints, producers;
  for (size_t i = 0; i < attachment_count; ++i) {
    mojo::ScopedMessagePipeHandle endpoint, producer;
    CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &producer), MOJO_RESULT_OK);
    endpoints.push_back(std::move(endpoint));
    producers.push_back(std::move(producer));
  }
  std::thread responder([&] {
    auto open = ReadJsonRequest(control.peer.get());
    CHECK_EQ(*open.FindString("method"), "output.open");
    CHECK(!open.Find("fps"));
    base::DictValue accepted;
    accepted.Set("version", 1);
    accepted.Set("id", *open.FindInt("id"));
    accepted.Set("ok", true);
    accepted.Set("accepted", true);
    if (attachment_count == 1) {
      accepted.Set("ok", false);
      accepted.Set("pending", true);
      accepted.Set("code", static_cast<int>(remotekit::protocol::ErrorCode::busy));
      accepted.Set("error", "busy");
    }
    std::vector<mojo::ScopedMessagePipeHandle> none;
    ReplyWithEndpoints(control.peer.get(), accepted, &none);
    auto describe = ReadJsonRequest(control.peer.get());
    CHECK_EQ(*describe.FindString("method"), "output.describe");
    base::DictValue reply;
    reply.Set("version", 1);
    reply.Set("id", *describe.FindInt("id"));
    reply.Set("ok", true);
    reply.Set("generation", "1");
    reply.Set("width", 64);
    reply.Set("height", 64);
    reply.Set("mapping_size", int(sizeof(remotekit::SharedRenderMapping)));
    reply.Set("mapping_handle", base::NumberToString(windows_handles[0]));
    reply.Set("adapter_luid_low", "0");
    reply.Set("adapter_luid_high", "0");
    reply.Set("render_channel", "opaque-once-token");
    for (size_t group = 0; group < 3; ++group) {
      base::ListValue handles;
      for (size_t i = 0; i < 4; ++i)
        handles.Append(base::NumberToString(windows_handles[1 + group * 4 + i]));
      reply.Set(group == 0   ? "ready_fence_handles"
                : group == 1 ? "consumed_fence_handles"
                             : "texture_handles",
                std::move(handles));
    }
    ReplyWithEndpoints(control.peer.get(), reply, &endpoints);
  });
  remotekit_sdk_render_setup setup{};
  setup.struct_size = sizeof(setup);
  const int status =
      remotekit_sdk_control_open_render(control.id, GetCurrentProcessId(), &setup, 5000);
  responder.join();
  std::vector<uint8_t> old_bytes;
  CHECK_EQ(
      mojo::ReadMessageRaw(old_producer.get(), &old_bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
      MOJO_RESULT_FAILED_PRECONDITION);
  if (attachment_count != 1) {
    CHECK_EQ(status, REMOTEKIT_SDK_DATA_MISMATCH);
    for (uint64_t handle : windows_handles)
      CHECK(!ValidHandle(handle));
  } else {
    CHECK_EQ(status, REMOTEKIT_SDK_OK);
    std::atomic<int> rejects{0};
    uint64_t render = 0, repeated = 0;
    CHECK_EQ(remotekit_sdk_render_connect(
                 setup.render_channel,
                 [](void* context, const remotekit_sdk_render_event* event) {
                   CHECK_EQ(event->type, uint32_t(REMOTEKIT_SDK_RENDER_REJECT));
                   ++*static_cast<std::atomic<int>*>(context);
                 },
                 &rejects, &render),
             REMOTEKIT_SDK_OK);
    CHECK_EQ(remotekit_sdk_render_connect(
                 setup.render_channel, [](void*, const remotekit_sdk_render_event*) {}, nullptr,
                 &repeated),
             REMOTEKIT_SDK_CHANNEL_CLOSED);
    remotekit_sdk_render_request begin{1, 1, 0, 16667, 0};
    CHECK_EQ(remotekit_sdk_render_begin(render, &begin), REMOTEKIT_SDK_OK);
    auto wire_bytes = Read(producers.front().get());
    CHECK_EQ(wire_bytes.size(), sizeof(remotekit::RenderWireMessage));
    remotekit::RenderWireMessage reject;
    reject.type = remotekit::RenderWireType::kReject;
    reject.reason = uint32_t(remotekit::RenderRejectReason::kIdle);
    reject.begin.identity = {1, 1, 0, 0};
    CHECK_EQ(mojo::WriteMessageRaw(producers.front().get(), &reject, sizeof(reject), nullptr, 0,
                                   MOJO_WRITE_MESSAGE_FLAG_NONE),
             MOJO_RESULT_OK);
    WaitFor([&] { return rejects.load() == 1; });
    // The original Control pipe must remain usable after independent render IPC.
    std::thread echo([&] { Reply(control.peer.get(), Read(control.peer.get())); });
    CHECK_EQ(Request(control.id, 17), REMOTEKIT_SDK_OK);
    echo.join();
    // Claim transfers ownership: closing Control must not close claimed render.
    CHECK_EQ(remotekit_sdk_control_close(control.id), REMOTEKIT_SDK_OK);
    begin.value = 2;
    CHECK_EQ(remotekit_sdk_render_begin(render, &begin), REMOTEKIT_SDK_OK);
    CHECK_EQ(Read(producers.front().get()).size(), sizeof(remotekit::RenderWireMessage));
    CHECK_EQ(remotekit_sdk_render_close(render), REMOTEKIT_SDK_OK);
    for (uint64_t handle : windows_handles)
      CHECK(CloseHandle(NativeHandle(handle)));
    return;
  }
  CHECK_EQ(remotekit_sdk_control_close(control.id), REMOTEKIT_SDK_OK);
}
void NumericRenderFailure(bool opening) {
  auto control = NewChannel();
  std::thread responder([&] {
    auto request = ReadJsonRequest(control.peer.get());
    std::vector<mojo::ScopedMessagePipeHandle> none;
    if (!opening) {
      base::DictValue accepted;
      accepted.Set("version", 1);
      accepted.Set("id", *request.FindInt("id"));
      accepted.Set("ok", true);
      accepted.Set("accepted", true);
      ReplyWithEndpoints(control.peer.get(), accepted, &none);
      request = ReadJsonRequest(control.peer.get());
    }
    base::DictValue failure;
    failure.Set("version", 1);
    failure.Set("id", *request.FindInt("id"));
    failure.Set("ok", false);
    failure.Set("code", static_cast<int>(remotekit::protocol::ErrorCode::busy));
    failure.Set("error", "busy");
    failure.Set("detail", "Output is occupied");
    ReplyWithEndpoints(control.peer.get(), failure, &none);
  });
  remotekit_sdk_render_setup setup{};
  setup.struct_size = sizeof(setup);
  CHECK_EQ(remotekit_sdk_control_open_render(control.id, GetCurrentProcessId(), &setup, 5000),
           REMOTEKIT_SDK_BUSY);
  responder.join();
  CHECK_EQ(remotekit_sdk_control_close(control.id), REMOTEKIT_SDK_OK);
}
void UnclaimedControlClose() {
  auto control = NewChannel();
  mojo::ScopedMessagePipeHandle endpoint, producer;
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &producer), MOJO_RESULT_OK);
  {
    std::lock_guard lock(State().lock);
    std::vector<mojo::ScopedHandle> one;
    one.emplace_back(endpoint.release());
    CHECK(State().channels.at(control.id)->pending_render.Install("unclaimed", std::move(one)));
  }
  CHECK_EQ(remotekit_sdk_control_close(control.id), REMOTEKIT_SDK_OK);
  uint64_t handle = 0;
  CHECK_EQ(remotekit_sdk_render_connect(
               "unclaimed", [](void*, const remotekit_sdk_render_event*) {}, nullptr, &handle),
           REMOTEKIT_SDK_CHANNEL_CLOSED);
  std::vector<uint8_t> bytes;
  CHECK_EQ(mojo::ReadMessageRaw(producer.get(), &bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
           MOJO_RESULT_FAILED_PRECONDITION);
}
void RawControlRejectsAttachments() {
  auto channel = NewChannel();
  mojo::ScopedMessagePipeHandle endpoint, peer;
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &peer), MOJO_RESULT_OK);
  std::thread responder([&] {
    const auto request = Read(channel.peer.get());
    const MojoHandle raw = endpoint.get().value();
    CHECK_EQ(mojo::WriteMessageRaw(channel.peer.get(), request.data(), request.size(), &raw, 1,
                                   MOJO_WRITE_MESSAGE_FLAG_NONE),
             MOJO_RESULT_OK);
    static_cast<void>(endpoint.release());
  });
  CHECK_EQ(Request(channel.id, 1), REMOTEKIT_SDK_DATA_MISMATCH);
  responder.join();
  std::vector<uint8_t> bytes;
  CHECK_EQ(mojo::ReadMessageRaw(peer.get(), &bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
           MOJO_RESULT_FAILED_PRECONDITION);
  CHECK_EQ(remotekit_sdk_control_close(channel.id), REMOTEKIT_SDK_OK);
}
void TimeoutDiscardsLateReplyAndAttachments() {
  auto channel = NewChannel();
  CHECK_EQ(Request(channel.id, 21, 20), REMOTEKIT_SDK_TIMEOUT);
  auto late = ReadJsonRequest(channel.peer.get());
  HANDLE native = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  CHECK(native);
  late.Set("mapping_handle", base::NumberToString(reinterpret_cast<uintptr_t>(native)));
  std::vector<mojo::ScopedMessagePipeHandle> endpoints;
  mojo::ScopedMessagePipeHandle endpoint, peer;
  CHECK_EQ(mojo::CreateMessagePipe(nullptr, &endpoint, &peer), MOJO_RESULT_OK);
  endpoints.push_back(std::move(endpoint));
  ReplyWithEndpoints(channel.peer.get(), late, &endpoints);
  std::thread responder([&] { Reply(channel.peer.get(), Read(channel.peer.get())); });
  CHECK_EQ(Request(channel.id, 22), REMOTEKIT_SDK_OK);
  responder.join();
  CHECK(!ValidHandle(reinterpret_cast<uintptr_t>(native)));
  std::vector<uint8_t> bytes;
  CHECK_EQ(mojo::ReadMessageRaw(peer.get(), &bytes, nullptr, MOJO_READ_MESSAGE_FLAG_NONE),
           MOJO_RESULT_FAILED_PRECONDITION);
  channel.peer.reset();
  CHECK_EQ(Request(channel.id, 23), REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK(channel.lifetime.expired());
}
void ShutdownDrainsLeases() {
  auto channel = NewChannel();
  int request_status = -1;
  std::thread request([&] { request_status = Request(channel.id, 7); });
  Read(channel.peer.get());
  // A held operation proves shutdown waits after cancelling channels, without
  // holding the registry mutex needed by operation/RTC completion.
  auto held = std::make_unique<OperationLease>();
  CHECK(*held);
  int shutdown_status = -1;
  std::atomic<bool> finished{false};
  std::thread shutdown([&] {
    shutdown_status = remotekit_sdk_shutdown();
    finished.store(true);
  });
  WaitFor([] {
    std::lock_guard lock(State().lock);
    return State().stopping;
  });
  request.join();
  CHECK_EQ(request_status, REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK(channel.lifetime.expired());
  CHECK(!finished.load());
  CHECK_EQ(RemoteKitSdkBeginRtc(), REMOTEKIT_SDK_INVALID_STATE);
  CHECK_EQ(Request(channel.id, 8), REMOTEKIT_SDK_CHANNEL_CLOSED);
  channel.peer.reset();
  held.reset();
  shutdown.join();
  CHECK_EQ(shutdown_status, REMOTEKIT_SDK_OK);
  CHECK_EQ(remotekit_sdk_initialize(), REMOTEKIT_SDK_INVALID_STATE);
}

void ClipboardPayloadBounds() {
  using namespace remotekit::browser;
  auto channel = NewChannel();
  const std::string text(1024 * 1024, '\x01');
  const std::string html(2 * 1024 * 1024, '\x02');
  auto write = base::DictValue()
                   .Set("id", 901)
                   .Set("method", "clipboard.write")
                   .Set("revision", "1")
                   .Set("text", text)
                   .Set("html", html);
  CHECK(ValidClipboardWrite(write));
  const auto encoded = base::WriteJson(write);
  CHECK_GT(encoded->size(), kControlJsonLimit);
  CHECK_LE(encoded->size(), kClipboardJsonLimit);
  std::thread responder([&] {
    const auto received = ReadJsonRequest(channel.peer.get());
    CHECK_EQ(*received.FindString("text"), text);
    CHECK_EQ(*received.FindString("html"), html);
    const auto response = base::WriteJson(ControlResult::Success(*received.FindInt("id")));
    CHECK_EQ(mojo::WriteMessageRaw(channel.peer.get(), response->data(), response->size(), nullptr,
                                   0, MOJO_WRITE_MESSAGE_FLAG_NONE),
             MOJO_RESULT_OK);
  });
  std::optional<base::DictValue> reply;
  CHECK_EQ(ExchangeJson(channel.id, *encoded, 5000, &reply), REMOTEKIT_SDK_OK);
  responder.join();
  write.Set("method", "view.navigate");
  const auto ordinary = base::WriteJson(write);
  CHECK_EQ(ExchangeJson(channel.id, *ordinary, 5000, &reply), REMOTEKIT_SDK_INVALID_ARGUMENT);

  auto read = base::DictValue().Set("id", 902).Set("method", "clipboard.read");
  const auto value = ControlResult::Success(
      902, base::DictValue().Set("sequence", "1").Set("text", text).Set("html", html));
  bool original = false;
  const auto capture = base::BindRepeating(
      [](bool* original, std::string_view, bool application_reply) {
        *original = application_reply;
        return true;
      },
      base::Unretained(&original));
  CHECK(WriteControlResponse(read, value, capture));
  CHECK(original);
  auto ordinary_read = base::DictValue().Set("id", 902).Set("method", "session.describe");
  CHECK(WriteControlResponse(ordinary_read, value, capture));
  CHECK(!original);
  std::thread reader([&] {
    const auto received = ReadJsonRequest(channel.peer.get());
    CHECK(WriteControlResponse(
        received, ControlResult::Success(*received.FindInt("id"), value.Clone()),
        base::BindRepeating(
            [](mojo::MessagePipeHandle pipe, std::string_view bytes, bool application_reply) {
              CHECK(application_reply);
              return mojo::WriteMessageRaw(pipe, bytes.data(), bytes.size(), nullptr, 0,
                                           MOJO_WRITE_MESSAGE_FLAG_NONE) == MOJO_RESULT_OK;
            },
            channel.peer.get())));
  });
  const auto read_json = base::WriteJson(read);
  CHECK_EQ(ExchangeJson(channel.id, *read_json, 5000, &reply), REMOTEKIT_SDK_OK);
  reader.join();
  CHECK_EQ(*reply->FindString("text"), text);
  CHECK_EQ(*reply->FindString("html"), html);
  CHECK_EQ(remotekit_sdk_control_close(channel.id), REMOTEKIT_SDK_OK);

  auto invalid_response = NewChannel();
  std::thread invalid_reader([&] {
    auto received = ReadJsonRequest(invalid_response.peer.get());
    const auto oversized =
        base::WriteJson(ControlResult::Success(*received.FindInt("id"), value.Clone()));
    CHECK_EQ(mojo::WriteMessageRaw(invalid_response.peer.get(), oversized->data(),
                                   oversized->size(), nullptr, 0, MOJO_WRITE_MESSAGE_FLAG_NONE),
             MOJO_RESULT_OK);
  });
  const auto ordinary_json = base::WriteJson(ordinary_read);
  CHECK_EQ(ExchangeJson(invalid_response.id, *ordinary_json, 5000, &reply),
           REMOTEKIT_SDK_MOJO_ERROR);
  invalid_reader.join();
  CHECK_EQ(remotekit_sdk_control_close(invalid_response.id), REMOTEKIT_SDK_OK);
}
}  // namespace

int main() {
  CHECK_EQ(remotekit_sdk_initialize(), REMOTEKIT_SDK_OK);
  ParallelChannelsAndClose();
  SameChannelSerializationAndQueuedClose();
  PendingEndpointOwnership();
  OpenRenderAttachmentContract(0);
  OpenRenderAttachmentContract(2);
  OpenRenderAttachmentContract(1);
  NumericRenderFailure(true);
  NumericRenderFailure(false);
  UnclaimedControlClose();
  RawControlRejectsAttachments();
  TimeoutDiscardsLateReplyAndAttachments();
  ClipboardPayloadBounds();
  ShutdownDrainsLeases();
  std::puts("SDK channel concurrency, queued close, and shutdown lease tests passed");
}
