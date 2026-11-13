#include "session/coordinator.hpp"
#include "session/clipboard.hpp"
#include "session/version_identity.hpp"
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
    std::atomic<bool> blocked{true}, authorized{true}, running{false}, sampling_failed{true};
    PlacementClipboard clipboard;
    const auto record = [&](const char* action) {
      std::lock_guard lock(mutex);
      order.push_back(action);
    };
    SessionCoordinator::Hooks hooks{
        .authorization = [&](const Json&, uint64_t) -> Result<void> {
          record("authorization");
          return {};
        },
        .prepare = [&](const Json& document) -> Result<void> {
          RK_RETURN_IF_ERROR(clipboard.Resolve(document.at("clipboard").at("revision")));
          record("prepare");
          ++prepares;
          return {};
        },
        .clipboard = [&](const Json& document) { return clipboard.Deliver(document); },
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
          if (sampling_failed)
            return Error{ErrorCode::kInternal, "Session copy is corrupt"};
          return Json{{"browser", running ? "running" : "stopped"},
                      {"browserIncarnation", running ? Json("browser") : Json()}};
        },
        .maintain = [] {},
        .signals = [] {},
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
    };
    std::atomic<uint64_t> observation_sequence{0};
    SessionCoordinator coordinator(target, "endpoint", observation_sequence, hooks);
    coordinator.Activate("connection", "1", 1);
    Await([&] { return coordinator.Latest().value("browser", "") == "failed"; });
    Check(!coordinator.Latest().at("lastError").is_null(), "sampling failure remains observable");
    sampling_failed = false;
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
    running = false;
    Await([&] {
      return starts == 2 && configured == 2 && coordinator.Latest().value("converged", false);
    });
    Check(prepares == 2, "Browser retirement re-converges from retained desired state");
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
    VersionIdentity identity{"endpoint", "browser", 1, 1};
    unsigned installed = 0;
    for (const auto* action : {"desired", "stop", "restart"}) {
      desired["revision"] = std::to_string(std::stoull(desired["revision"].get<std::string>()) + 1);
      desired["run"] = "running";
      desired["commit"] = nullptr;
      Check(bool(coordinator.Publish(desired, 2)), "start for version");
      Await([&] { return running && coordinator.Latest().value("converged", false); });
      VersionIdentity captured;
      std::promise<void> entered, release;
      auto gate = release.get_future();
      auto version = std::async(std::launch::async, [&] {
        return coordinator.Version(
            [&]() -> Result<void> {
              captured = identity;
              return {};
            },
            [&]() -> Result<void> {
              entered.set_value();
              if (gate.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
                return Error{ErrorCode::kUnavailable, "version test release timed out"};
              return {};
            },
            [&]() -> Result<Json> {
              if (!captured.Current(identity, running))
                return Json{{"discarded", true}};
              ++installed;
              return Json{{"installed", true}};
            });
      });
      entered.get_future().wait();
      desired["revision"] = std::to_string(std::stoull(desired["revision"].get<std::string>()) + 1);
      if (std::string_view(action) != "desired") {
        desired["run"] = "stopped";
        desired["commit"] = "stop-during-version";
      }
      Check(bool(coordinator.Publish(desired, 2)), "desired admitted during slow version build");
      Await([&] {
        return coordinator.Latest().value("observedRevision", Json()) == desired["revision"] &&
               coordinator.Latest().value("converged", false);
      });
      if (std::string_view(action) == "restart") {
        Check(bool(coordinator.Execute([&]() -> Result<Json> {
                ++identity.runtime_generation;
                identity.browser_incarnation = "restarted";
                return Json::object();
              })),
              "runtime generation advances in actor");
        desired["revision"] =
            std::to_string(std::stoull(desired["revision"].get<std::string>()) + 1);
        desired["run"] = "running";
        desired["commit"] = nullptr;
        Check(bool(coordinator.Publish(desired, 2)), "restart during version");
        Await([&] { return running && coordinator.Latest().value("converged", false); });
      }
      release.set_value();
      auto result = version.get();
      Check(bool(result), "version completes");
      Check(result.value().value("discarded", false) == (std::string_view(action) != "desired"),
            "stop and restart supersede running version");
    }
    Check(installed == 1, "only healthy current version installed");
    coordinator.ManagementLost(2);
    const auto previous_sequence = std::stoull(coordinator.Latest().at("seq").get<std::string>());
    SessionCoordinator reopened(target, "endpoint", observation_sequence, hooks);
    reopened.Activate("reconnected", "2", 2);
    desired["revision"] = std::to_string(std::stoull(desired["revision"].get<std::string>()) + 1);
    desired["run"] = "running";
    desired["commit"] = nullptr;
    Check(bool(reopened.Publish(desired, 2)), "reopened coordinator accepts desired state");
    Await([&] { return reopened.Latest().value("converged", false); });
    Check(std::stoull(reopened.Latest().at("seq").get<std::string>()) > previous_sequence,
          "coordinators in one Endpoint incarnation share a monotonic observation sequence");
    desired["revision"] = std::to_string(std::stoull(desired["revision"].get<std::string>()) + 1);
    desired["clipboard"]["revision"] = "5";
    Check(bool(reopened.Publish(desired, 2)), "missing clipboard desired accepted for convergence");
    Await([&] {
      const auto error = reopened.Latest().value("lastError", Json());
      return error.is_object() && error.value("code", "") == "conflict" &&
             error.value("message", "") == "clipboard revision not delivered";
    });
    auto delivery = target;
    delivery.update({{"method", "session.clipboard"},
                     {"connectionEpoch", "reconnected"},
                     {"revision", "5"},
                     {"value", {{"text", "delivered"}, {"html", ""}}}});
    auto stale = delivery;
    stale["connectionEpoch"] = "connection";
    auto result = reopened.DeliverClipboard(stale, 2);
    Check(!result && result.error().code == ErrorCode::kConflict,
          "stale clipboard connection conflicts");
    result = reopened.DeliverClipboard(delivery, 1);
    Check(!result && result.error().code == ErrorCode::kConflict,
          "stale clipboard generation conflicts");
    stale = delivery;
    stale["placementEpoch"] = 99;
    result = reopened.DeliverClipboard(stale, 2);
    Check(!result && result.error().code == ErrorCode::kConflict,
          "stale clipboard placement conflicts");
    Check(bool(reopened.DeliverClipboard(delivery, 2)), "clipboard delivered");
    Check(bool(reopened.DeliverClipboard(delivery, 2)), "same clipboard idempotent");
    stale = delivery;
    stale["value"]["text"] = "different";
    result = reopened.DeliverClipboard(stale, 2);
    Check(!result && result.error().code == ErrorCode::kConflict,
          "same clipboard revision changed conflicts");
    stale = delivery;
    stale["revision"] = "4";
    result = reopened.DeliverClipboard(stale, 2);
    Check(!result && result.error().code == ErrorCode::kConflict, "older clipboard conflicts");
    Await([&] { return reopened.Latest().value("converged", false); });
    Check(clipboard.Resolve("0").value().at("text") == "", "zero revision resolves empty");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
