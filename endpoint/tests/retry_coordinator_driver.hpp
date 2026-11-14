#pragma once
#include "retry_owner_drivers.hpp"

namespace remotekit::retry_test {
inline OwnerDriver CoordinatorDriver(std::string loop) {
  struct Fixture {
    Boundary boundary;
    std::atomic<bool> armed = false;
    std::atomic<uint64_t> revision = 1, sequence = 0;
    std::string loop;
    std::unique_ptr<SessionCoordinator> owner;
    bool publish = false;
    Result<Json> Call(const std::string& selected, Json success) {
      if (!armed || selected != loop)
        return success;
      auto desired = test::Desired(std::string(32, 'a'), 1, std::to_string(revision.load()));
      desired.erase("id");
      if (NativeRetryOwnerProbe::CoordinatorInput(*owner, loop) != desired.dump() + ":1")
        return success;
      return boundary.Call({{"loop", selected}, {"revision", std::to_string(revision.load())}},
                           std::move(success));
    }
    Result<void> Work(const std::string& selected) {
      auto result = Call(selected, Json::object());
      return result ? Result<void>{} : Result<void>{result.error()};
    }
    void Tick() {
      if (!owner) {
        SessionCoordinator::Hooks hooks;
        hooks.authorization = [](const Json&, uint64_t) -> Result<void> { return {}; };
        hooks.stop = [&](const Json&) { return Call("session.convergence", Json::object()); };
        hooks.observe = [&] {
          return Call("session.observation",
                      {{"browser", "stopped"}, {"browserIncarnation", nullptr}});
        };
        hooks.maintain = [&] { return Work("session.maintenance"); };
        hooks.signals = [&] { return Work("session.signals"); };
        hooks.send = [](const Json&, uint64_t) { return true; };
        owner = std::make_unique<SessionCoordinator>(test::Placement(), "endpoint", sequence,
                                                     std::move(hooks));
        owner->Activate("connection", "1", 1);
        armed = true;
        Take(owner->Publish(test::Desired(), 1));
      }
      if (publish) {
        Take(owner->Publish(test::Desired(std::string(32, 'a'), 1, std::to_string(revision.load())),
                            1));
        publish = false;
      }
      if (loop == "session.signals")
        NativeRetryOwnerProbe::CoordinatorSignal(*owner);
      for (unsigned barrier = 0; barrier < 2; ++barrier)
        Take(owner->Execute([]() -> Result<Json> { return Json::object(); }));
    }
  };
  auto f = std::make_shared<Fixture>();
  f->loop = std::move(loop);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] {
            ++f->revision;
            f->publish = true;
          },
          [f] { return NativeRetryOwnerProbe::CoordinatorState(*f->owner, f->loop); },
          [f] {
            const auto report = f->owner->Report();
            return report && !report.value().value("lastError", Json()).is_null();
          }};
}
}  // namespace remotekit::retry_test
