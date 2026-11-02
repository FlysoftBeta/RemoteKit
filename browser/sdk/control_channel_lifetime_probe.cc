// This probe includes the production implementation to register real local Mojo
// peers without adding test hooks or C ABI exports to the shipped SDK.
#include "remotekit_sdk.cc"

#include <chrono>
#include <cstdio>
#include <thread>

#include "base/check.h"

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
                               MOJO_WRITE_MESSAGE_FLAG_NONE), MOJO_RESULT_OK);
}

int Request(uint64_t id, uint8_t byte) {
  uint8_t output = 0;
  size_t size = 0;
  const int status = remotekit_sdk_control_request(id, &byte, 1, &output, 1, &size, 5000);
  if (status == REMOTEKIT_SDK_OK) {
    CHECK_EQ(size, 1u);
    CHECK_EQ(output, byte);
  }
  return status;
}

void ParallelChannelsAndClose() {
  auto slow = NewChannel();
  auto fast = NewChannel();
  int slow_status = -1;
  std::thread pending([&] { slow_status = Request(slow.id, 1); });
  CHECK_EQ(Read(slow.peer.get()).front(), 1);
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
  WaitFor([] { std::lock_guard lock(State().lock); return State().operations == 2; });
  std::vector<uint8_t> premature;
  CHECK_EQ(mojo::ReadMessageRaw(channel.peer.get(), &premature, nullptr,
                               MOJO_READ_MESSAGE_FLAG_NONE), MOJO_RESULT_SHOULD_WAIT);
  Reply(channel.peer.get(), first_bytes);
  auto second_bytes = Read(channel.peer.get());
  CHECK_EQ(second_bytes.front(), 4);
  Reply(channel.peer.get(), second_bytes);
  first.join();
  second.join();
  CHECK_EQ(first_status, REMOTEKIT_SDK_OK);
  CHECK_EQ(second_status, REMOTEKIT_SDK_OK);

  std::thread active([&] { first_status = Request(channel.id, 5); });
  Read(channel.peer.get());
  std::thread queued([&] { second_status = Request(channel.id, 6); });
  WaitFor([] { std::lock_guard lock(State().lock); return State().operations == 2; });
  CHECK_EQ(remotekit_sdk_control_close(channel.id), REMOTEKIT_SDK_OK);
  active.join();
  queued.join();
  CHECK_EQ(first_status, REMOTEKIT_SDK_CHANNEL_CLOSED);
  CHECK_EQ(second_status, REMOTEKIT_SDK_CHANNEL_CLOSED);
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
  WaitFor([] { std::lock_guard lock(State().lock); return State().stopping; });
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
}  // namespace

int main() {
  CHECK_EQ(remotekit_sdk_initialize(), REMOTEKIT_SDK_OK);
  ParallelChannelsAndClose();
  SameChannelSerializationAndQueuedClose();
  ShutdownDrainsLeases();
  std::puts("SDK channel concurrency, queued close, and shutdown lease tests passed");
}
