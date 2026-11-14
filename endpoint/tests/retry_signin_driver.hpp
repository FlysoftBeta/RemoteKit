#pragma once
#include "retry_owner_drivers.hpp"

namespace remotekit::retry_test {
inline OwnerDriver SignInDriver(const fs::path& root) {
  struct Fixture {
    SessionFixture session;
    Boundary boundary;
    bool acknowledged = false;
    explicit Fixture(const fs::path& root) : session(root, "signin.handoff") {}
    void Tick() {
      browser_dispatch = [&](Json request) -> Result<Json> {
        for (const auto& id : request.at("eventIds"))
          if (id == "event")
            acknowledged = true;
        const Json event{
            {"type", "view.signIn"},
            {"version", 1},
            {"eventId", "event"},
            {"webviewId", "1"},
            {"provider", "xinjiaoyu"},
            {"result",
             {{"authorization", "JBY test"}, {"accesstoken", "test"}, {"clientsession", "test"}}}};
        return Json{{"events", acknowledged ? Json::array() : Json::array({event})}};
      };
      NativeRetryOwnerProbe::SignIn(
          session.owner, [&](const Json& body, const std::string& id, const std::string& browser) {
            return boundary.Call({{"body", body}, {"eventId", id}, {"browser", browser}});
          });
    }
  };
  auto f = std::make_shared<Fixture>(root);
  return {
      f,
      std::shared_ptr<Boundary>(f, &f->boundary),
      [f] { f->Tick(); },
      [f] { NativeRetryOwnerProbe::ChangeSignIn(f->session.owner); },
      [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::SignInState(f->session.owner); },
      [f] { return NativeRetryOwnerProbe::SignInSurfaced(f->session.owner); },
      [f] { return NativeRetryOwnerProbe::SignInRetired(f->session.owner); }};
}
}  // namespace remotekit::retry_test
