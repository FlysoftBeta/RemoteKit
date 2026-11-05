#include "remotekit/presentation_barrier.hpp"
#include "remotekit/presentation_refresh.hpp"
#include "remotekit/tail_refresh.hpp"
#include <cstdlib>
#include <future>
#include <iostream>
#include <thread>
#define CHECK(x)                                    \
  do {                                              \
    if (!(x)) {                                     \
      std::cerr << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                 \
    }                                               \
  } while (false)
using Gate = remotekit::PresentationBarrier;
void TestPresentationRefresh() {
  using Refresh = remotekit::PresentationRefresh;
  using Attempt = remotekit::TailIdrAttempt;
  Gate gate;
  Refresh refresh;
  gate.Bind(1);
  gate.Layout(1, 7);
  CHECK(!gate.RefreshKey(1, 7));
  const auto key = gate.Video(1);
  CHECK(key && !gate.RefreshKey(1, 7));
  refresh.Update(true, 0);
  CHECK(!refresh.TryStart(0, 500));
  CHECK(gate.Ready(1, *key));
  CHECK(gate.RefreshKey(1, 7) == key && !gate.RefreshKey(2, 7) && !gate.RefreshKey(1, 6));
  refresh.SetScope(Refresh::Scope{1, 3, *key});
  CHECK(refresh.Pending());

  int leases = 0;
  remotekit_rtc_frame source{};
  source.layout_epoch = 7;
  source.release_context = &leases;
  source.retain = [](void* p, uint64_t) { ++*static_cast<int*>(p); };
  source.release = [](void* p, uint64_t) { --*static_cast<int*>(p); };
  CHECK(refresh.CanForce(0));
  refresh.Forced(0);
  auto lost = refresh.TryStart(0, 500);
  CHECK(lost && !refresh.TryStart(0, 500) && !refresh.CanForce(0));
  auto frame = remotekit::TailRefreshLease::Wrap(source, lost);
  // The SDK accepted the texture but its source released it before Encode.
  frame.release(frame.release_context, frame.frame_id);
  refresh.Update(false, 1);
  CHECK(leases == 0 && lost->state() == Attempt::State::failed && refresh.Pending());
  CHECK(!refresh.CanForce(999) && !refresh.TryStart(999, 500));
  CHECK(refresh.CanForce(1000));
  refresh.Forced(1000);
  auto gated = refresh.TryStart(1000, 500);
  CHECK(gated);
  frame = remotekit::TailRefreshLease::Wrap(source, gated);
  CHECK(remotekit::TailRefreshLease::BeginEncoding(frame));
  refresh.Update(true, 3000);
  CHECK(!refresh.CanForce(3000) && gated->state() == Attempt::State::encoding);
  // A hardware completion without a successful SDK publication does not
  // resolve the request. A different frame succeeding does not resolve it.
  CHECK(gate.Send(1, 7, true, [] { return false; }));
  remotekit::TailRefreshLease::Finish(frame, false);
  frame.release(frame.release_context, frame.frame_id);
  CHECK(gate.Send(1, 7, true, [] { return true; }));
  refresh.Update(false, 3000);
  CHECK(refresh.Pending() && refresh.CanForce(3000));
  auto late = refresh.TryStart(3000, 750);
  CHECK(late);
  frame = remotekit::TailRefreshLease::Wrap(source, late);
  refresh.Update(false, 4499);
  CHECK(!refresh.CanForce(4499) && late->state() == Attempt::State::source_wait);
  refresh.Update(false, 4500);
  CHECK(refresh.CanForce(4500) && !remotekit::TailRefreshLease::BeginEncoding(frame));
  frame.release(frame.release_context, frame.frame_id);

  auto old = refresh.TryStart(4500, 500);
  CHECK(old && old->BeginEncoding());
  const auto next = gate.Video(1, true);
  CHECK(next && *next != *key && !gate.RefreshKey(1, 7));
  refresh.SetScope(std::nullopt);
  CHECK(!refresh.Pending());
  CHECK(gate.Ready(1, *next));
  refresh.SetScope(Refresh::Scope{1, 3, *next});
  refresh.Update(true, 4500);
  auto current = refresh.TryStart(4500, 500);
  CHECK(current && current->BeginEncoding());
  old->Finish(true);
  refresh.Update(true, 4501);
  CHECK(refresh.Pending());
  current->Finish(gate.Send(1, 7, true, [] { return true; }));
  refresh.Update(false, 4502);
  CHECK(!refresh.Pending() && !refresh.CanForce(10000) && !refresh.TryStart(10000, 500));
  const auto stats = refresh.Snapshot();
  CHECK(!stats.pending && stats.attempts == 5 && stats.forced_begins == 2 && stats.successes == 1);

  refresh.Update(true, 10000);
  auto completed = refresh.TryStart(10000, 500);
  CHECK(completed && completed->BeginEncoding());
  completed->Finish(true);
  refresh.Update(true, 10001);
  CHECK(refresh.Pending() && !refresh.CanForce(10999) && refresh.CanForce(11000));
  auto stale_auth = refresh.TryStart(11000, 500);
  CHECK(stale_auth);
  refresh.SetScope(Refresh::Scope{1, 5, *next});
  CHECK(refresh.Pending() && !stale_auth->BeginEncoding());
  auto stale_layout = refresh.TryStart(11000, 500);
  CHECK(stale_layout);
  const auto changed = gate.Layout(2, 8);
  CHECK(changed && !gate.RefreshKey(1, 8));
  refresh.SetScope(std::nullopt);
  CHECK(!refresh.Pending() && !stale_layout->BeginEncoding());
  CHECK(gate.Ready(1, *changed));
  CHECK(gate.RefreshKey(1, 8) == changed);
  CHECK(leases == 0);
}

int main() {
  TestPresentationRefresh();
  Gate gate;
  int published = 0;
  auto send = [&](uint64_t peer, uint64_t epoch, bool key = true) {
    return gate.Send(peer, epoch, key, [&] {
      ++published;
      return true;
    });
  };
  gate.Bind(1);
  CHECK(!send(1, 0));
  CHECK(!send(2, 0));
  CHECK(!gate.Layout(3, 7));
  CHECK(!send(1, 7) && published == 0);  // Layout alone cannot open media publication.
  auto first = gate.Video(1);
  CHECK(first && first->epoch == 7 && first->generation == 3);
  CHECK(!send(1, 7) && !send(1, 6));
  auto wrong = *first;
  wrong.generation = 4;
  CHECK(!gate.Ready(1, wrong));
  wrong = *first;
  wrong.epoch = 8;
  CHECK(!gate.Ready(1, wrong));
  CHECK(!gate.Ready(2, *first));
  auto second = gate.Layout(3, 8);
  CHECK(second && second->barrier > first->barrier);
  CHECK(!gate.Ready(1, *first));  // Out-of-order ACK never opens a new layout.
  CHECK(gate.Ready(1, *second));
  CHECK(!gate.Ready(1, *second));
  CHECK(!send(1, 7));         // Old in-flight keyframe is rejected after the latest ACK.
  CHECK(!send(1, 8, false));  // Dependencies were discarded while waiting.
  CHECK(gate.Send(1, 8, true, [] { return false; }));  // SDK failure does not open P frames.
  CHECK(!send(1, 8, false));
  CHECK(send(1, 8));
  CHECK(send(1, 8, false));
  CHECK(!gate.Layout(3, 7));
  CHECK(!gate.Layout(3, 8));  // No rollback or focus-only prepare.
  CHECK(!gate.Video(1));
  CHECK(send(1, 8, false));

  // Actual encoded publication and layout replacement are a single critical
  // section: replacement cannot finish while the previous SDK send is running.
  std::promise<void> entered, release, updating;
  auto release_future = release.get_future().share();
  auto sending = std::async(std::launch::async, [&] {
    return gate.Send(1, 8, false, [&] {
      entered.set_value();
      release_future.wait();
      return true;
    });
  });
  CHECK(entered.get_future().wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  auto update = std::async(std::launch::async, [&] {
    updating.set_value();
    return gate.Layout(4, 9);
  });
  updating.get_future().wait();
  CHECK(update.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout);
  release.set_value();
  CHECK(sending.get());
  auto third = update.get();
  CHECK(third);
  CHECK(!send(1, 8) && !send(1, 9));
  CHECK(gate.Ready(1, *third));
  CHECK(!send(1, 8));

  // Model the worker's real post-Poll drop path: a failed TailRefresh and its
  // retained source lease must finish even when no encoded publication occurs.
  int leases = 0;
  remotekit_rtc_frame source{};
  source.frame_id = 42;
  source.layout_epoch = 8;
  source.release_context = &leases;
  source.retain = [](void* p, uint64_t) { ++*static_cast<int*>(p); };
  source.release = [](void* p, uint64_t) { --*static_cast<int*>(p); };
  auto attempt = std::make_shared<remotekit::TailIdrAttempt>();
  auto tail = remotekit::TailRefreshLease::Wrap(source, attempt);
  CHECK(leases == 1);
  CHECK(remotekit::TailRefreshLease::BeginEncoding(tail));
  CHECK(!gate.Send(1, tail.layout_epoch, true, [&] {
    ++published;
    return true;
  }));
  remotekit::TailRefreshLease::Finish(tail, false);
  tail.release(tail.release_context, tail.frame_id);
  CHECK(leases == 0 && attempt->state() == remotekit::TailIdrAttempt::State::failed);

  CHECK(!send(1, 8, false) && !send(1, 9, false));
  CHECK(send(1, 9));
  CHECK(send(1, 9, false));
  gate.Bind(2);
  CHECK(!send(1, 9));
  CHECK(!gate.Ready(1, *third));
  CHECK(!send(2, 0, false));
  gate.Layout(4, 10);
  auto fresh = gate.Video(2);
  CHECK(fresh);
  CHECK(fresh->barrier > third->barrier);
  CHECK(!gate.Ready(2, *third));
  CHECK(gate.Ready(2, *fresh));
  CHECK(send(2, 10));
  gate.Bind(0);
  CHECK(!send(2, 10));
  gate.Bind(3);
  auto early = gate.Video(3);
  CHECK(early && early->epoch == 0);
  CHECK(!send(3, 10));  // Negotiation before the first layout closes immediately.
  // Session suppresses this empty prepare; first real layout creates its key.
  auto initial = gate.Layout(5, 11);
  CHECK(initial && initial->barrier > early->barrier);
  CHECK(!gate.Ready(3, *early));
  CHECK(gate.Ready(3, *initial));
  CHECK(send(3, 11));
  auto resumed = gate.Video(3, true);
  CHECK(resumed && resumed->barrier > initial->barrier);
  CHECK(resumed->epoch == 11 && !gate.Ready(3, *initial) && !send(3, 11));
  CHECK(gate.Ready(3, *resumed) && !send(3, 11, false) && send(3, 11));
  auto invalid = gate.Layout(0, 12);
  CHECK(invalid && gate.Ready(3, *invalid));
  CHECK(!gate.RefreshKey(3, 12) && !send(3, 12));
  std::cout
      << "presentation barrier ordering, publication serialization and tail lease tests passed\n";
}
