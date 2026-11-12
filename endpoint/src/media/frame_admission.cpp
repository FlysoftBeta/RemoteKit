#include "media/frame_admission.hpp"

#include <algorithm>
#include <chrono>
#include <deque>
#include <set>
#include <system_error>

namespace remotekit::media {
namespace {
using Clock = std::chrono::steady_clock;
uint64_t WaitMicros(Clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start).count();
}
}  // namespace

struct FrameAdmission::Adapter {
  struct Demand {
    HANDLE event;
    Snapshot stats;
    Clock::time_point waiting_since;
    bool denied = false;

    ClassStats& Class() {
      return stats.pending_priority == Priority::interactive ? stats.interactive : stats.normal;
    }
  };
  std::mutex mutex;
  uint64_t next_client = 0;
  std::map<uint64_t, Demand> clients;
  // One latest demand per client. A grant removes that client; its next demand
  // joins behind every other waiter, while an uncontended client can borrow.
  std::deque<uint64_t> waiting;
  std::set<std::pair<uint64_t, Identity>> held;

  uint64_t Next() const {
    for (auto id : waiting)
      if (clients.at(id).stats.pending_priority == Priority::interactive)
        return id;
    return waiting.empty() ? 0 : waiting.front();
  }
  void Notify() {
    if (held.size() < kBudget && !waiting.empty())
      SetEvent(clients.at(Next()).event);
  }
  bool Upgrade(uint64_t id, Priority priority) {
    auto& demand = clients.at(id);
    auto& stats = demand.stats;
    if (!stats.tenant_waiting || priority != Priority::interactive ||
        stats.pending_priority == Priority::interactive)
      return false;
    stats.pending_priority = Priority::interactive;
    Notify();
    return true;
  }
  void Withdraw(uint64_t id) {
    auto& demand = clients.at(id);
    if (demand.stats.tenant_waiting) {
      const auto wait = WaitMicros(demand.waiting_since);
      demand.stats.wait_us += wait;
      demand.Class().wait_us += wait;
      demand.stats.tenant_waiting = false;
      std::erase(waiting, id);
      ResetEvent(demand.event);
      Notify();
    }
  }
};

FrameAdmission::Client::Client(std::shared_ptr<Adapter> adapter, HANDLE event)
    : adapter_(std::move(adapter)),
      id_([&] {
        std::lock_guard lock(adapter_->mutex);
        const auto id = ++adapter_->next_client;
        adapter_->clients.emplace(id, Adapter::Demand{event, {}, {}});
        return id;
      }()),
      event_(event) {}

FrameAdmission::Client::~Client() {
  {
    std::lock_guard lock(adapter_->mutex);
    adapter_->Withdraw(id_);
    // Destruction cannot certify GPU completion. Held identities deliberately
    // remain charged even if their last client is destroyed.
    adapter_->clients.erase(id_);
  }
  // Notify and unregister share the mutex, so no notifier can use a closed HANDLE.
  CloseHandle(event_);
}

bool FrameAdmission::Client::TryAcquire(Identity identity, Priority priority) {
  std::lock_guard lock(adapter_->mutex);
  auto& demand = adapter_->clients.at(id_);
  auto& stats = demand.stats;
  const auto key = std::make_pair(id_, identity);
  if (adapter_->held.contains(key))
    return false;
  if (!stats.tenant_waiting) {
    stats.tenant_waiting = true;
    stats.pending_priority = priority;
    demand.denied = false;
    demand.waiting_since = Clock::now();
    ++stats.requests;
    adapter_->waiting.push_back(id_);
  } else {
    adapter_->Upgrade(id_, priority);
  }
  if (adapter_->held.size() >= kBudget || adapter_->Next() != id_) {
    if (!demand.denied) {
      demand.denied = true;
      ++stats.denials;
      ++demand.Class().denials;
    }
    adapter_->Notify();
    return false;
  }
  std::erase(adapter_->waiting, id_);
  stats.tenant_waiting = false;
  stats.last_wait_us = WaitMicros(demand.waiting_since);
  stats.last_priority = stats.pending_priority;
  stats.wait_us += stats.last_wait_us;
  demand.Class().wait_us += stats.last_wait_us;
  ++demand.Class().grants;
  ++stats.grants;
  ++stats.tenant_inflight;
  adapter_->held.insert(key);
  ResetEvent(event_);
  adapter_->Notify();
  return true;
}

bool FrameAdmission::Client::Upgrade(Priority priority) {
  std::lock_guard lock(adapter_->mutex);
  return adapter_->Upgrade(id_, priority);
}

bool FrameAdmission::Client::Return(Identity identity) {
  std::lock_guard lock(adapter_->mutex);
  if (!adapter_->held.erase({id_, identity}))
    return false;
  auto& stats = adapter_->clients.at(id_).stats;
  --stats.tenant_inflight;
  ++stats.returns;
  adapter_->Notify();
  return true;
}

void FrameAdmission::Client::Withdraw() {
  std::lock_guard lock(adapter_->mutex);
  adapter_->Withdraw(id_);
}

FrameAdmission::Snapshot FrameAdmission::Client::Stats() const {
  std::lock_guard lock(adapter_->mutex);
  const auto& demand = adapter_->clients.at(id_);
  auto result = demand.stats;
  result.inflight = static_cast<uint32_t>(adapter_->held.size());
  result.waiting = static_cast<uint32_t>(adapter_->waiting.size());
  if (result.tenant_waiting)
    result.current_wait_us = WaitMicros(demand.waiting_since);
  return result;
}

std::shared_ptr<FrameAdmission::Client> FrameAdmission::Register(LUID luid) {
  std::shared_ptr<Adapter> adapter;
  {
    std::lock_guard lock(mutex_);
    const auto key = (uint64_t(static_cast<uint32_t>(luid.HighPart)) << 32) | luid.LowPart;
    auto& entry = adapters_[key];
    if (!entry)
      entry = std::make_shared<Adapter>();
    adapter = entry;
  }
  // Auto-reset events retain a notification until Comp waits; no external reset
  // races with a return. No GPU/SDK work or callbacks run under the adapter lock.
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event)
    throw std::system_error(GetLastError(), std::system_category(), "frame admission event");
  return std::shared_ptr<Client>(new Client(std::move(adapter), event));
}

}  // namespace remotekit::media
