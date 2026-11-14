#pragma once
#include "retry_owner_drivers.hpp"

namespace remotekit::retry_test {
inline OwnerDriver FinalExportDriver(const fs::path& root) {
  struct Fixture {
    SessionFixture session;
    std::future<Result<void>> task;
    Json view{{"view", "1"}, {"instance", "1"}, {"document", "1"}, {"navigationRevision", "1"}};
    std::optional<Error> failure;
    bool started = false;
    explicit Fixture(const fs::path& root) : session(root, "navigation.final_export") {
      browser_dispatch = [&](Json request) -> Result<Json> {
        request.erase("id");
        const auto method = request.at("method");
        if (method == "snapshot")
          return Json{{"sessions", Json::array({{{"views", Json::array({view})}}})}};
        if (method == "navigation.export.chunk")
          return Json{{"data", "YQ=="}};
        if (method == "navigation.transfer.cancel")
          return Json::object();
        return session.boundary.Call(request, {{"transfer", "transfer"}, {"size", "1"}});
      };
    }
    ~Fixture() {
      if (task.valid())
        task.wait();
    }
    void Tick() {
      if (!task.valid())
        task = std::async(std::launch::async,
                          [&] { return NativeRetryOwnerProbe::FinalExport(session.owner); });
      if (started && task.wait_for(std::chrono::seconds(0)) != std::future_status::ready) {
        const RetryUnit::Snapshot state = NativeRetryOwnerProbe::FinalExportState(session.owner);
        if (state.Status() == RetryUnit::State::kWaiting && RetryClock::now() < state.Until())
          return;
      }
      if (task.wait_for(std::chrono::seconds(2)) != std::future_status::ready)
        throw std::runtime_error("final export owner did not finish its admitted attempt");
      auto result = task.get();
      if (!result)
        failure = result.error();
      started = true;
    }
    void Change() {
      view["navigationRevision"] = "2";
      NativeRetryOwnerProbe::Change(session.owner, "navigation.final_export");
    }
  };
  auto f = std::make_shared<Fixture>(root);
  return {f,
          std::shared_ptr<Boundary>(f, &f->session.boundary),
          [f] { f->Tick(); },
          [f] { f->Change(); },
          [f]() -> const RetryUnit& {
            return NativeRetryOwnerProbe::FinalExportState(f->session.owner);
          },
          [f] { return f->failure.has_value(); }};
}
}  // namespace remotekit::retry_test
