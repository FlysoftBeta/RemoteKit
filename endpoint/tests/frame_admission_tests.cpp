#include "media/frame_admission.hpp"

#include <atomic>
#include <barrier>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

using remotekit::media::FrameAdmission;
using Identity = FrameAdmission::Identity;
using Priority = FrameAdmission::Priority;

namespace {
void Require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
  }
}

Identity Frame(uint64_t value, uint32_t slot = 0) {
  return {1, 7, value, slot};
}

void ContentionAndRotation() {
  FrameAdmission registry;
  auto first = registry.Register({11, 22});
  auto second = registry.Register({11, 22});
  auto third = registry.Register({11, 22});
  Require(first->TryAcquire(Frame(1, 0), Priority::normal) &&
              first->TryAcquire(Frame(2, 1), Priority::normal) &&
              first->TryAcquire(Frame(3, 2), Priority::normal),
          "uncontended tenant borrows all three permits");
  Require(!second->TryAcquire(Frame(1), Priority::normal) &&
              !third->TryAcquire(Frame(1), Priority::normal) &&
              !first->TryAcquire(Frame(4, 3), Priority::normal),
          "contenders register one pending demand each");
  Require(!second->TryAcquire(Frame(2), Priority::normal) && second->Stats().waiting == 3 &&
              second->Stats().requests == 1,
          "repeated latest demand does not enqueue frame history");
  Require(first->Return(Frame(1, 0)), "return one accepted identity");
  Require(!first->TryAcquire(Frame(5, 3), Priority::normal),
          "returning borrower cannot steal the next turn");
  Require(WaitForSingleObject(second->event(), 0) == WAIT_OBJECT_0,
          "return before Comp waits retains its notification");
  Require(WaitForSingleObject(third->event(), 0) == WAIT_TIMEOUT,
          "only the eligible head is notified for one available permit");
  Require(second->TryAcquire(Frame(3), Priority::normal), "first waiting tenant gets next grant");
  Require(second->Return(Frame(3)), "second tenant completes");
  Require(WaitForSingleObject(third->event(), 0) == WAIT_OBJECT_0 &&
              third->TryAcquire(Frame(2), Priority::normal),
          "round robin advances to the third tenant");
  Require(!second->TryAcquire(Frame(4), Priority::normal),
          "new demand queues behind the borrower already waiting");
  Require(third->Return(Frame(2)), "third tenant completes");
  Require(first->TryAcquire(Frame(6, 3), Priority::normal),
          "borrower returns to the head after other tenants");
  Require(first->Return(Frame(2, 1)) && second->TryAcquire(Frame(5), Priority::normal),
          "continually requesting tenant cannot starve another waiter");
  const auto snapshot = second->Stats();
  Require(snapshot.inflight == 3 && snapshot.grants == 2 && snapshot.returns == 1 &&
              snapshot.denials == 2 && !snapshot.tenant_waiting,
          "contention counters describe grants and denied attempts");
}

void WithdrawalAndEventHandoff() {
  FrameAdmission registry;
  auto holder = registry.Register({1, 0});
  auto paused = registry.Register({1, 0});
  auto next = registry.Register({1, 0});
  for (uint32_t slot = 0; slot < 3; ++slot)
    Require(holder->TryAcquire(Frame(slot + 1, slot), Priority::normal), "fill adapter");
  Require(!paused->TryAcquire(Frame(1), Priority::normal) &&
              !next->TryAcquire(Frame(1), Priority::normal),
          "queue two tenants");
  Require(holder->Return(Frame(1)), "make capacity available to paused tenant");
  paused->Withdraw();
  Require(WaitForSingleObject(paused->event(), 0) == WAIT_TIMEOUT,
          "withdraw removes stale turn notification");
  Require(WaitForSingleObject(next->event(), 0) == WAIT_OBJECT_0 &&
              next->TryAcquire(Frame(2), Priority::normal),
          "withdrawing notified head wakes its successor without another return");
  Require(!paused->TryAcquire(Frame(2), Priority::normal), "resumed demand goes to the back");
  auto last = registry.Register({1, 0});
  Require(!last->TryAcquire(Frame(1), Priority::normal), "queue behind paused tenant");
  paused.reset();
  Require(holder->Return(Frame(2, 1)) && WaitForSingleObject(last->event(), 0) == WAIT_OBJECT_0 &&
              last->TryAcquire(Frame(2), Priority::normal),
          "destroyed waiter cannot retain a turn or a callback target");
  next->Withdraw();
  Require(next->Stats().tenant_inflight == 1 && next->Stats().inflight == 3,
          "withdrawing demand cannot return accepted work");
}

void IdentityAndRetainedAccounting() {
  FrameAdmission registry;
  auto old_client = registry.Register({5, -1});
  auto new_client = registry.Register({5, -1});
  const auto old_frame = Frame(1);
  auto new_generation = old_frame;
  ++new_generation.generation;
  auto new_incarnation = old_frame;
  ++new_incarnation.incarnation;
  Require(old_client->TryAcquire(old_frame, Priority::normal), "accept original request");
  Require(!old_client->Return(new_generation) && !old_client->Return(new_incarnation) &&
              !new_client->Return(old_frame) && !old_client->Return(Frame(1, 1)) &&
              !old_client->Return(Frame(2)),
          "generation, incarnation, client, slot and value must all match");
  Require(old_client->Return(old_frame) && !old_client->Return(old_frame),
          "rollback or matching terminal event returns an identity exactly once");
  Require(old_client->TryAcquire(new_incarnation, Priority::normal) &&
              new_client->TryAcquire(old_frame, Priority::normal) &&
              old_client->TryAcquire(new_generation, Priority::normal),
          "reused producer coordinates remain distinct across incarnations and clients");
  Require(!old_client->Return(old_frame) && old_client->Stats().inflight == 3,
          "late return cannot release newer work");
  old_client->Withdraw();
  old_client.reset();
  Require(new_client->Stats().inflight == 3 && !new_client->TryAcquire(Frame(2), Priority::normal),
          "unknown retained work continues charging adapter after client destruction");
  auto other_adapter = registry.Register({5, 0});
  Require(other_adapter->TryAcquire(old_frame, Priority::normal) &&
              other_adapter->Stats().inflight == 1,
          "physical adapter LUID high bits separate budgets");
  Require(new_client->Return(old_frame) && new_client->TryAcquire(Frame(3), Priority::normal),
          "known safe completion only releases its own capacity");
}

void PriorityOrderingAndUpgrade() {
  FrameAdmission registry;
  auto holder = registry.Register({1, 0});
  auto normal = registry.Register({1, 0});
  auto first_interactive = registry.Register({1, 0});
  auto second_interactive = registry.Register({1, 0});
  for (uint32_t slot = 0; slot < 3; ++slot)
    Require(holder->TryAcquire(Frame(slot + 1, slot), Priority::normal), "fill priority adapter");
  Require(!normal->TryAcquire(Frame(1), Priority::normal), "old normal demand waits");
  Require(!first_interactive->TryAcquire(Frame(1), Priority::interactive) &&
              !second_interactive->TryAcquire(Frame(1), Priority::interactive),
          "interactive demands wait in arrival order");
  Require(holder->Return(Frame(1)), "return capacity for priority selection");
  Require(WaitForSingleObject(first_interactive->event(), 0) == WAIT_OBJECT_0 &&
              WaitForSingleObject(normal->event(), 0) == WAIT_TIMEOUT &&
              WaitForSingleObject(second_interactive->event(), 0) == WAIT_TIMEOUT,
          "oldest interactive waiter is notified ahead of older normal demand");
  Require(first_interactive->TryAcquire(Frame(2), Priority::normal),
          "interactive class stays latched when activity expires");
  Require(first_interactive->Stats().last_priority == Priority::interactive,
          "expired activity does not demote an existing demand");
  Require(first_interactive->Return(Frame(2)) &&
              WaitForSingleObject(second_interactive->event(), 0) == WAIT_OBJECT_0 &&
              second_interactive->TryAcquire(Frame(2), Priority::interactive),
          "interactive grants are FIFO within the class");
  Require(second_interactive->Return(Frame(2)) &&
              WaitForSingleObject(normal->event(), 0) == WAIT_OBJECT_0 &&
              normal->TryAcquire(Frame(2), Priority::normal),
          "normal waiter gets capacity after interactive class drains");
  Require(normal->Return(Frame(2)), "return normal grant");

  auto upgrading = registry.Register({1, 0});
  auto newer_interactive = registry.Register({1, 0});
  Require(holder->TryAcquire(Frame(4), Priority::normal), "fill final available permit");
  Require(!upgrading->TryAcquire(Frame(1), Priority::normal) &&
              !newer_interactive->TryAcquire(Frame(1), Priority::interactive),
          "queue older normal before newer interactive");
  Require(upgrading->Upgrade(Priority::interactive) && !upgrading->Upgrade(Priority::interactive) &&
              !upgrading->Upgrade(Priority::normal),
          "waiting normal demand upgrades once without losing its age");
  Require(holder->Return(Frame(4)) && WaitForSingleObject(upgrading->event(), 0) == WAIT_OBJECT_0 &&
              upgrading->TryAcquire(Frame(2), Priority::normal),
          "upgraded older demand precedes newer interactive waiter");
  const auto stats = upgrading->Stats();
  Require(stats.requests == 1 && stats.denials == 1 && stats.interactive.grants == 1 &&
              stats.interactive.denials == 0 && stats.normal.denials == 1 &&
              stats.interactive.wait_us == stats.wait_us,
          "grants and wait use the upgraded class; denial keeps its arrival class");
  Require(upgrading->Return(Frame(2)), "return upgraded grant");
  newer_interactive->Withdraw();
  Require(!newer_interactive->Upgrade(Priority::interactive), "withdrawn demand cannot upgrade");
  Require(holder->Return(Frame(2, 1)) && holder->Return(Frame(3, 2)), "drain priority adapter");
  Require(holder->Stats().inflight == 0 && holder->Stats().waiting == 0,
          "priority scenario returns all permits and demands");
}

void UpgradeNotifiesWithAvailableCapacity() {
  FrameAdmission registry;
  auto holder = registry.Register({2, 0});
  auto normal = registry.Register({2, 0});
  auto upgrading = registry.Register({2, 0});
  for (uint32_t slot = 0; slot < 3; ++slot)
    Require(holder->TryAcquire(Frame(slot + 1, slot), Priority::normal), "fill upgrade adapter");
  Require(!normal->TryAcquire(Frame(1), Priority::normal) &&
              !upgrading->TryAcquire(Frame(1), Priority::normal),
          "queue two normal demands");
  Require(holder->Return(Frame(1)) && upgrading->Upgrade(Priority::interactive),
          "upgrade after a permit becomes available");
  Require(WaitForSingleObject(upgrading->event(), 0) == WAIT_OBJECT_0 &&
              upgrading->TryAcquire(Frame(2), Priority::interactive),
          "upgrade wakes the new eligible head without another return");
  Require(!normal->TryAcquire(Frame(2), Priority::normal) && normal->Stats().denials == 1,
          "a stale notification cannot bypass the new head or count another denied demand");
  Require(upgrading->Return(Frame(2)) && WaitForSingleObject(normal->event(), 0) == WAIT_OBJECT_0 &&
              normal->TryAcquire(Frame(3), Priority::normal),
          "normal waiter remains live");
}

void ConcurrentWakeAndReturn() {
  FrameAdmission registry;
  constexpr int kClients = 6;
  std::barrier start(kClients);
  std::atomic<int> active{0};
  std::vector<std::thread> threads;
  for (int index = 0; index < kClients; ++index) {
    auto client = registry.Register({9, 3});
    threads.emplace_back([&, client] {
      start.arrive_and_wait();
      for (uint64_t value = 1; value <= 100; ++value) {
        const auto identity = Frame(value);
        while (!client->TryAcquire(identity, Priority::normal))
          Require(WaitForSingleObject(client->event(), 1000) == WAIT_OBJECT_0,
                  "contended return wakes a live waiter without lost reset");
        Require(++active <= 3, "concurrent admissions never exceed fixed budget");
        std::this_thread::yield();
        --active;
        Require(client->Return(identity), "concurrent matching return succeeds");
      }
      client->Withdraw();
      Require(client->Stats().grants == 100 && client->Stats().returns == 100,
              "each contending tenant completes its demand stream");
    });
  }
  for (auto& thread : threads)
    thread.join();
  auto observer = registry.Register({9, 3});
  Require(observer->Stats().inflight == 0 && observer->Stats().waiting == 0,
          "completed clients leave no permit or wait behind");
}
}  // namespace

int main() {
  ContentionAndRotation();
  WithdrawalAndEventHandoff();
  IdentityAndRetainedAccounting();
  PriorityOrderingAndUpgrade();
  UpgradeNotifiesWithAvailableCapacity();
  ConcurrentWakeAndReturn();
  std::puts("frame admission checks completed");
}
