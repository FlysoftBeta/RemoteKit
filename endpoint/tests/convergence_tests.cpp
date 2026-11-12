#include "session/coordinator.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace remotekit;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class Predicate>
void Await(Predicate predicate) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!predicate()) {
    Check(std::chrono::steady_clock::now() < deadline, "convergence deadline");
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}
}  // namespace
int main(int argc, char** argv) {
  try {
    Check(argc == 2, "desired fixture required");
    std::ifstream input(argv[1]);
    Json desired;
    input >> desired;
    Json target{{"tenantId", desired["tenantId"]},
                {"sessionId", desired["sessionId"]},
                {"placementEpoch", desired["placementEpoch"]}};
    std::mutex mutex;
    std::vector<std::string> order;
    std::atomic<unsigned> prepares{0}, starts{0}, configured{0}, stopped{0}, requests{0};
    std::atomic<bool> blocked{true}, authorized{true}, running{false};
    const auto record = [&](const char* action) {
      std::lock_guard lock(mutex);
      order.push_back(action);
    };
    SessionCoordinator coordinator(
        target, "endpoint",
        {
            .authorization = [&](const Json&, uint64_t) -> Result<void> {
              record("authorization");
              return {};
            },
            .prepare = [&](const Json&) -> Result<void> {
              record("prepare");
              ++prepares;
              return {};
            },
            .start = [&]() -> Result<void> {
              record("start");
              ++starts;
              running = true;
              return {};
            },
            .views = [&](const Json&) -> Result<void> {
              record("views");
              ++configured;
              return {};
            },
            .stop = [&](const Json&) -> Result<Json> {
              if (blocked)
                return Error{ErrorCode::kConflict, "stop blocked: selection"};
              ++stopped;
              running = false;
              return Json{{"state", "clean"}};
            },
            .observe = [&]() -> Result<Json> {
              return Json{{"browser", running ? "running" : "stopped"},
                          {"browserIncarnation", running ? Json("browser") : Json()}};
            },
            .maintain = [] {},
            .admit = [&](const Json&, uint64_t) -> Result<void> {
              if (!authorized)
                return Error{ErrorCode::kLocked, "authorization revoked"};
              return {};
            },
            .request = [&](const Json&, uint64_t) -> Result<Json> {
              ++requests;
              return Json{{"accepted", true}};
            },
            .acknowledge = [](const std::string&, uint64_t) -> Result<void> { return {}; },
            .management_lost = [&](uint64_t) { authorized = false; },
            .send = [](const Json&, uint64_t) { return true; },
        });
    coordinator.Activate("connection", "1", 1);
    Check(bool(coordinator.Publish(desired, 1)), "desired accepted");
    Await([&] { return coordinator.Latest().value("converged", false); });
    {
      std::lock_guard lock(mutex);
      const auto prepare = std::find(order.begin(), order.end(), "prepare");
      const auto start = std::find(order.begin(), order.end(), "start");
      const auto views = std::find(order.begin(), order.end(), "views");
      Check(order.front() == "authorization" && prepare < start && start < views,
            "authorization and startup ordering");
    }
    Check(bool(coordinator.Publish(desired, 1)), "same revision accepted");
    std::this_thread::sleep_for(std::chrono::milliseconds(120));
    Check(prepares == 1 && starts == 1 && configured == 1, "revision applied idempotently");
    auto conflict = desired;
    conflict["views"][0]["visible"] = true;
    Check(!coordinator.Publish(conflict, 1), "changed document at same revision rejected");
    conflict = desired;
    conflict["placementEpoch"] = 2;
    Check(!coordinator.Publish(conflict, 1), "stale placement rejected");
    Json request = target;
    request.update({{"method", "view.navigate"},
                    {"endpointIncarnation", "endpoint"},
                    {"opId", "navigation"},
                    {"replay", false},
                    {"params", Json::object()}});
    Check(bool(coordinator.Request(request, 1)), "RPC accepted");
    request["replay"] = true;
    Check(bool(coordinator.Request(request, 1)) && requests == 1, "RPC deduplicated");
    authorized = false;
    Check(!coordinator.Request(request, 1) && requests == 1,
          "cached reply revalidates authorization");
    authorized = true;
    desired["revision"] = "2";
    desired["run"] = "stopped";
    desired["commit"] = "commit";
    Check(bool(coordinator.Publish(desired, 1)), "blocked stop accepted as desired state");
    Await([&] {
      const auto value = coordinator.Latest();
      return value.value("observedRevision", Json()) == "2";
    });
    Check(stopped == 0 && !coordinator.Latest().value("converged", true),
          "blocker delays completion");
    blocked = false;
    Await([&] { return stopped == 1 && coordinator.Latest().value("converged", false); });
    coordinator.ManagementLost(1);
    Check(!coordinator.Request(request, 1), "management loss rejects stale RPC");
    coordinator.Activate("reconnected", "2", 2);
    desired["connectionEpoch"] = "reconnected";
    Check(bool(coordinator.Publish(desired, 2)), "reconnect accepts same desired revision");
    Await([&] { return coordinator.Latest().value("connectionEpoch", Json()) == "reconnected"; });
    Check(stopped == 1, "reconnect does not repeat completed commit");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
