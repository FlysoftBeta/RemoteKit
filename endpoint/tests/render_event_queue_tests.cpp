#include "media/render_event_queue.hpp"

#include <cstdio>
#include <cstdlib>
#include <thread>

namespace {

void Require(bool ok, const char* message) {
  if (ok) return;
  std::fprintf(stderr, "FAIL: %s\n", message);
  std::exit(1);
}

}  // namespace

int main() {
  remotekit::media::RenderEventQueue queue;
  Require(queue.handle() != nullptr, "render queue event creation");
  Require(WaitForSingleObject(queue.handle(), 0) == WAIT_TIMEOUT, "empty queue is quiet");

  const HANDLE timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);
  Require(timer != nullptr, "timer creation");
  LARGE_INTEGER due{};
  due.QuadPart = -300000000;  // 30 seconds. The queue must win the wait.
  Require(SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE), "arm timer");
  const HANDLE handles[] = {timer, queue.handle()};
  remotekit_sdk_render_event event{};
  event.type = REMOTEKIT_SDK_RENDER_WAKE;
  event.generation = 12;
  event.value = 42;

  std::thread callback([&] { queue.Push(event); });
  const auto result = WaitForMultipleObjects(2, handles, FALSE, 5000);
  callback.join();
  Require(result == WAIT_OBJECT_0 + 1, "callback signals the queue wait before the timer");
  const auto first = queue.Drain();
  Require(first.size() == 1 && first.front().value == 42, "wake payload survives drain");
  Require(WaitForSingleObject(queue.handle(), 0) == WAIT_TIMEOUT, "drain resets the event");

  ++event.value;
  queue.Push(event);
  ++event.value;
  queue.Push(event);
  Require(WaitForMultipleObjects(2, handles, FALSE, 0) == WAIT_OBJECT_0 + 1,
          "events queued before the wait remain signaled");
  const auto second = queue.Drain();
  Require(second.size() == 2 && second.front().value == 43 && second.back().value == 44,
          "a later drain gets both events in order");
  Require(queue.Drain().empty() && WaitForSingleObject(queue.handle(), 0) == WAIT_TIMEOUT,
          "draining an empty queue leaves it quiet");

  remotekit::media::RenderEventQueue next_generation;
  Require(next_generation.handle() != nullptr, "next generation queue creation");
  queue.Push(event);
  const HANDLE current_handles[] = {timer, next_generation.handle()};
  Require(WaitForMultipleObjects(2, current_handles, FALSE, 0) == WAIT_TIMEOUT,
          "a retired generation cannot signal the current queue");
  CloseHandle(timer);
}
