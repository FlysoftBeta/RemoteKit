#include "session/coordinator.hpp"
#include "session/clipboard.hpp"
#include "session/version_identity.hpp"
#include <fstream>
#include <future>
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
// A geometry-only revision runs ahead of maintenance and the observation publish, skips the
// full convergence pass, and is coalesced to the latest value.
void GeometryPriority(const Json& fixture, const Json& target) {
  using namespace std::chrono_literals;
  std::mutex mutex;
  std::vector<std::string> log;
  const auto record = [&](std::string entry) {
    std::lock_guard lock(mutex);
    log.push_back(std::move(entry));
  };
  const auto position = [&](const std::string& entry, size_t from) {
    std::lock_guard lock(mutex);
    const auto found = std::find(log.begin() + std::min(from, log.size()), log.end(), entry);
    return static_cast<size_t>(found - log.begin());
  };
  const auto count = [&](const std::string& entry) {
    std::lock_guard lock(mutex);
    return static_cast<size_t>(std::count(log.begin(), log.end(), entry));
  };
  std::atomic<bool> running{false}, slow_maintenance{false}, decline{false}, fail{false};
  std::atomic<bool> hold_geometry{false};
  std::promise<void> maintenance_entered, release_maintenance;
  std::promise<void> geometry_entered, release_geometry;
  SessionCoordinator::Hooks hooks{
      .authorization = [](const Json&, uint64_t) -> Result<void> { return {}; },
      .prepare = [&](const Json&) -> Result<void> {
        record("prepare");
        return {};
      },
      .start = [&]() -> Result<void> {
        record("start");
        running = true;
        return {};
      },
      .views = [&](const Json&) -> Result<void> {
        record("views");
        return {};
      },
      .geometry = [&](const Json& desired) -> Result<bool> {
        record("geometry:" + desired.at("revision").get<std::string>());
        if (hold_geometry.exchange(false)) {
          geometry_entered.set_value();
          release_geometry.get_future().wait_for(5s);
        }
        if (fail.exchange(false))
          return Error{ErrorCode::kUnavailable, "injected geometry failure"};
        return !decline.exchange(false);
      },
      .observe = [&]() -> Result<Json> {
        record("observe");
        return Json{{"browser", running ? "running" : "stopped"},
                    {"browserIncarnation", running ? Json("browser") : Json()}};
      },
      .maintain = [&]() -> Result<void> {
        if (slow_maintenance.exchange(false)) {
          record("maintain-slow");
          maintenance_entered.set_value();
          release_maintenance.get_future().wait_for(5s);
        } else {
          record("maintain");
        }
        return {};
      },
      .signals = []() -> Result<void> { return {}; },
      .send = [](const Json&, uint64_t) { return true; },
  };
  std::atomic<uint64_t> sequence{0};
  SessionCoordinator coordinator(target, "endpoint", sequence, hooks);
  coordinator.Activate("connection", "1", 1);
  auto desired = fixture;
  desired["authorization"] = {{"connectionId", "peer"},
                              {"epoch", 1},
                              {"unlocked", true},
                              {"files", {{"requests", Json::array()}}}};
  desired["lock"] = {{"leaseId", "lease"}, {"epoch", 1}, {"state", "unlocked"}};
  desired["views"][0]["visible"] = true;
  const auto publish = [&](const char* revision, int width) {
    desired["revision"] = revision;
    desired["views"][0]["width"] = width;
    Check(bool(coordinator.Publish(desired, 1)), "geometry fixture admitted");
  };
  const auto converged = [&](const char* revision) {
    const auto value = coordinator.Latest();
    return value.value("observedRevision", Json()) == revision && value.value("converged", false) &&
           value.at("applied").at("viewsRevision") == revision;
  };
  publish("1", 1000);
  Await([&] { return converged("1"); });
  Check(count("geometry:1") == 0, "the first revision has no converged identity to reuse");
  Check(count("prepare") == 1 && count("start") == 1 && count("views") == 1, "full first pass");

  publish("2", 1200);
  Await([&] { return converged("2"); });
  Check(count("geometry:2") == 1 && count("prepare") == 1 && count("start") == 1 &&
            count("views") == 1,
        "geometry-only revision skips prepare, start and views");

  // The coordinator thread is inside a slow maintenance pass when geometry arrives. As soon
  // as it is free, geometry runs before the next maintenance and observation.
  slow_maintenance = true;
  maintenance_entered.get_future().wait();
  const auto slow = position("maintain-slow", 0);
  publish("3", 1300);
  release_maintenance.set_value();
  Await([&] { return converged("3"); });
  Check(position("geometry:3", slow) == slow + 1,
        "geometry runs before the maintenance and observation that follow a slow step");

  // Superseded geometry never runs: the hook blocks on 4 while 5 and 6 arrive.
  hold_geometry = true;
  publish("4", 1400);
  geometry_entered.get_future().wait();
  publish("5", 1500);
  publish("6", 1600);
  release_geometry.set_value();
  Await([&] { return converged("6"); });
  Check(count("geometry:4") == 1 && count("geometry:5") == 0 && count("geometry:6") == 1,
        "only the latest pending geometry is applied");

  // A topology change takes the full pass.
  const auto full = count("prepare");
  desired["views"][0]["url"] = "https://example.test/changed";
  publish("7", 1600);
  Await([&] { return converged("7"); });
  Check(count("geometry:7") == 0 && count("prepare") == full + 1,
        "a topology change is not geometry-only");
  publish("8", 1700);
  Await([&] { return converged("8"); });
  Check(count("geometry:8") == 1 && count("prepare") == full + 1,
        "geometry-only again after the full pass");

  // A different authorization epoch is not geometry-only either.
  desired["authorization"]["epoch"] = 2;
  publish("9", 1700);
  Await([&] { return converged("9"); });
  Check(count("geometry:9") == 0 && count("prepare") == full + 2,
        "an authorization change is not geometry-only");

  // The hook may decline; the revision then converges through the full pass.
  decline = true;
  publish("10", 1800);
  Await([&] { return converged("10"); });
  Check(count("geometry:10") == 1 && count("prepare") == full + 3,
        "a declined geometry application falls back to the full pass");

  // A failed application is reported and retried through the retry unit.
  fail = true;
  publish("11", 1900);
  Await([&] {
    const auto error = coordinator.Latest().value("lastError", Json());
    return error.is_object() && error.value("code", "") == "unavailable";
  });
  Check(!coordinator.Latest().value("converged", true), "failed geometry is not converged");
  Await([&] { return converged("11"); });
  Check(count("geometry:11") == 2, "geometry is retried after the failure");
}
// Every change is published when it happens: a Browser wake, an applied document and a finished
// job go out past the 100 ms send interval, a change inside the interval goes out when the
// interval ends, and a pending document does not swallow a wake.
void ObservationTiming(const Json& fixture, const Json& target) {
  using namespace std::chrono_literals;
  using Clock = std::chrono::steady_clock;
  std::mutex mutex;
  std::vector<std::pair<int, Clock::time_point>> sent;
  std::atomic<int> state{0};
  std::atomic<bool> running{false};
  SessionCoordinator::Hooks hooks{
      .authorization = [](const Json&, uint64_t) -> Result<void> { return {}; },
      .prepare = [](const Json&) -> Result<void> { return {}; },
      .start = [&]() -> Result<void> {
        running = true;
        return {};
      },
      .views = [](const Json&) -> Result<void> { return {}; },
      .geometry = [](const Json&) -> Result<bool> { return true; },
      .observe = [&]() -> Result<Json> {
        return Json{{"browser", running ? "running" : "stopped"},
                    {"browserIncarnation", running ? Json("browser") : Json()},
                    {"marker", state.load()}};
      },
      .maintain = []() -> Result<void> { return {}; },
      .signals = []() -> Result<void> { return {}; },
      .send =
          [&](const Json& observation, uint64_t) {
            std::lock_guard lock(mutex);
            sent.emplace_back(observation.value("marker", -1), Clock::now());
            return true;
          },
  };
  std::atomic<uint64_t> sequence{0};
  SessionCoordinator coordinator(target, "endpoint", sequence, hooks);
  coordinator.Activate("connection", "1", 1);
  auto desired = fixture;
  desired["authorization"] = {{"connectionId", "peer"},
                              {"epoch", 1},
                              {"unlocked", true},
                              {"files", {{"requests", Json::array()}}}};
  desired["lock"] = {{"leaseId", "lease"}, {"epoch", 1}, {"state", "unlocked"}};
  desired["views"][0]["visible"] = true;
  const auto publish = [&](const char* revision, int width) {
    desired["revision"] = revision;
    desired["views"][0]["width"] = width;
    Check(bool(coordinator.Publish(desired, 1)), "timing fixture admitted");
  };
  const auto converged = [&](const char* revision) {
    const auto value = coordinator.Latest();
    return value.value("observedRevision", Json()) == revision && value.value("converged", false) &&
           value.at("applied").at("viewsRevision") == revision;
  };
  const auto published = [&](int marker) {
    std::lock_guard lock(mutex);
    for (const auto& [value, at] : sent)
      if (value == marker)
        return std::optional<Clock::time_point>(at);
    return std::optional<Clock::time_point>();
  };
  const auto within = [&](int marker, Clock::time_point from, std::chrono::milliseconds limit,
                          const char* message) {
    const auto deadline = Clock::now() + 2s;
    while (!published(marker) && Clock::now() < deadline)
      std::this_thread::sleep_for(1ms);
    const auto at = published(marker);
    Check(at.has_value(), message);
    Check(*at - from < limit, message);
  };
  publish("1", 1000);
  Await([&] { return converged("1"); });
  std::this_thread::sleep_for(300ms);

  // A Browser wake publishes at once, also right after another publication.
  auto started = Clock::now();
  state = 1;
  coordinator.ObservedChanged();
  within(1, started, 40ms, "a Browser wake publishes without waiting for a sample");
  started = Clock::now();
  state = 2;
  coordinator.ObservedChanged();
  within(2, started, 40ms, "a Browser wake bypasses the minimum send interval");

  // An applied document is published at once even inside the send interval.
  started = Clock::now();
  state = 3;
  coordinator.ObservedChanged();
  within(3, started, 40ms, "wake before the document");
  publish("2", 1200);
  const auto document_deadline = Clock::now() + 2s;
  while (!converged("2") && Clock::now() < document_deadline)
    std::this_thread::sleep_for(1ms);
  Check(converged("2"), "document applied");
  Check(Clock::now() - started < 60ms, "an applied document is published without the interval");

  // A job's effect is published when the job returns.
  std::this_thread::sleep_for(300ms);
  started = Clock::now();
  Check(bool(coordinator.Execute([&]() -> Result<Json> {
          state = 4;
          return Json::object();
        })),
        "job ran");
  within(4, started, 40ms, "a finished job publishes its change at once");

  // A change inside the interval with no wake goes out when the interval ends, not a whole
  // sample later.
  std::this_thread::sleep_for(300ms);
  state = 5;
  coordinator.ObservedChanged();
  within(5, Clock::now(), 40ms, "leading change");
  const auto leading = *published(5);
  state = 6;
  within(6, leading, 140ms, "a change inside the interval goes out at its end");

  // A pending document does not delay or swallow a wake.
  std::this_thread::sleep_for(300ms);
  started = Clock::now();
  publish("3", 1300);
  state = 7;
  coordinator.ObservedChanged();
  within(7, started, 60ms, "a pending document does not swallow a wake");
  Await([&] { return converged("3"); });
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
    GeometryPriority(desired, target);
    ObservationTiming(desired, target);
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
        .stop = [&](const Json&, bool) -> Result<Json> {
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
        .maintain = []() -> Result<void> { return {}; },
        .signals = []() -> Result<void> { return {}; },
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
