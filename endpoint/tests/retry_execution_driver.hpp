#pragma once
#include "retry_owner_drivers.hpp"

namespace remotekit::retry_test {
inline OwnerDriver ExecutionDriver(const fs::path& root, bool events) {
  struct Fixture {
    Boundary boundary;
    std::shared_ptr<SessionFixture> session;
    std::shared_ptr<SessionExecution> owner;
    bool events;
    uint64_t generation = 1;
    Fixture(const fs::path& root, bool publish)
        : session(std::make_shared<SessionFixture>(root, "execution")), events(publish) {
      owner = std::make_shared<SessionExecution>(session->sdk, session->options, session->link,
                                                 session->objects, session->admission,
                                                 test::Placement(), "endpoint");
      NativeRetryOwnerProbe::Attach(*owner, std::shared_ptr<Session>(session, &session->owner));
      owner->Activate("connection", generation);
    }
    void Tick() {
      if (events)
        NativeRetryOwnerProbe::ExecutionEvents(*owner, [&]() -> Result<void> {
          auto result = boundary.Call({{"streamId", "stream"}, {"eventId", "event-1"}});
          return result ? Result<void>{} : Result<void>{result.error()};
        });
      else
        NativeRetryOwnerProbe::ExecutionSample(*owner, [&] {
          return boundary.Call(
              {{"method", "snapshot"}, {"browser", session->owner.BrowserIncarnation()}});
        });
    }
    RetryUnit::Snapshot Status() const {
      return events ? owner->EventsRetryStatus() : owner->SamplingRetryStatus();
    }
  };
  auto f = std::make_shared<Fixture>(root, events);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->owner->Activate("changed", ++f->generation); },
          [f] { return f->Status(); },
          [f] { return f->Status().Failure().has_value(); }};
}
}  // namespace remotekit::retry_test
