#pragma once

#include <windows.h>

#include <compare>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>

namespace remotekit::media {

class FrameAdmission {
 private:
  struct Adapter;

 public:
  static constexpr uint32_t kBudget = 3;
  enum class Priority { normal, interactive };
  struct Identity {
    uint64_t incarnation = 0;
    uint64_t generation = 0;
    uint64_t value = 0;
    uint32_t slot = 0;
    auto operator<=>(const Identity&) const = default;
  };
  struct ClassStats {
    uint64_t grants = 0, denials = 0, wait_us = 0;
  };
  struct Snapshot {
    uint32_t budget = kBudget;
    uint32_t inflight = 0, waiting = 0, tenant_inflight = 0;
    bool tenant_waiting = false;
    uint64_t requests = 0, denials = 0, grants = 0, returns = 0;
    uint64_t wait_us = 0, current_wait_us = 0, last_wait_us = 0;
    Priority pending_priority = Priority::normal, last_priority = Priority::normal;
    ClassStats normal, interactive;
  };
  class Client {
   public:
    Client(const Client&) = delete;
    Client& operator=(const Client&) = delete;
    ~Client();
    bool TryAcquire(Identity identity, Priority priority);
    bool Upgrade(Priority priority);
    bool Return(Identity identity);
    void Withdraw();
    Snapshot Stats() const;
    HANDLE event() const { return event_; }

   private:
    friend class FrameAdmission;
    Client(std::shared_ptr<Adapter> adapter, HANDLE event);
    std::shared_ptr<Adapter> adapter_;
    const uint64_t id_;
    const HANDLE event_;
  };

  std::shared_ptr<Client> Register(LUID adapter);

 private:
  std::mutex mutex_;
  std::map<uint64_t, std::shared_ptr<Adapter>> adapters_;
};

}  // namespace remotekit::media
