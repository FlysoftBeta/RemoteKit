#include "management/coordination.hpp"
#include "management/payload_limits.hpp"
#include "management/rpc_results.hpp"
#include <atomic>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>

using namespace remotekit;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
using GateRelease = std::unique_ptr<std::promise<void>, void (*)(std::promise<void>*)>;
GateRelease ReleaseOnExit(std::promise<void>& promise) {
  return GateRelease(&promise, [](std::promise<void>* value) { value->set_value(); });
}
}  // namespace
int main(int argc, char** argv) {
  try {
    Check(argc == 2, "fixture required");
    Json contract;
    std::ifstream(std::filesystem::path(argv[1]).parent_path() / "limits.json") >> contract;
    Check(contract.at("managementQueueMessages") == limits::managementQueueMessages &&
              contract.at("managementQueueBytes") == limits::managementQueueBytes &&
              contract.at("managementWorkerQueue") == limits::managementWorkerQueue,
          "generated queue limits match JSON contract");
    Check(limits::managementQueueMessages == 256 && limits::managementQueueBytes == 67108864 &&
              limits::managementWorkerQueue == 64,
          "management queue contract values");
    std::ifstream input(argv[1]);
    Json desired;
    input >> desired;
    Check(bool(coordination::ValidateDesired(desired)), "valid desired fixture");
    for (const auto& [number, bytes] : std::vector<std::pair<double, size_t>>{
             {1.0, 1}, {1e-6, 8}, {1e-7, 4}, {1e20, 21}, {1e21, 5}, {1.25, 4}})
      Check(coordination::DocumentBytes(Json{{"value", number}}) == bytes + 10,
            "document numbers use JSON.stringify byte lengths");
    for (const auto& [field, bound] : std::vector<std::pair<std::string, size_t>>{
             {"text", limits::textBytes}, {"html", limits::htmlBytes}}) {
      Json boundary{{"method", "session.clipboard"},
                    {"tenantId", desired["tenantId"]},
                    {"sessionId", desired["sessionId"]},
                    {"placementEpoch", desired["placementEpoch"]},
                    {"connectionEpoch", desired["connectionEpoch"]},
                    {"revision", "1"},
                    {"value", {{"text", ""}, {"html", ""}}}};
      boundary["value"][field] = std::string(bound, 'x');
      Check(bool(coordination::ValidateClipboard(boundary)), "clipboard bound accepted");
      auto body = boundary["value"];
      Check(coordination::EventBodyFits("clipboard.changed", body), "event bound accepted");
      boundary["value"][field] = std::string(bound + 1, 'x');
      Check(!coordination::ValidateClipboard(boundary), "clipboard overflow rejected");
      body[field] = std::string(bound + 1, 'x');
      Check(!coordination::EventBodyFits("clipboard.changed", body), "event overflow rejected");
    }
    auto configuration = desired;
    configuration["views"][0]["url"] = "";
    configuration["views"][0]["url"] =
        std::string(limits::configurationBytes - limits::managementEnvelopeBytes -
                        coordination::DocumentBytes(configuration),
                    'x');
    Check(bool(coordination::ValidateDesired(configuration)),
          "configuration byte boundary accepted");
    configuration["id"] = std::string(36, 'f');
    Check(bool(coordination::ValidateDesired(configuration)),
          "wire id excluded from document measurement");
    configuration["views"][0]["url"] = configuration["views"][0]["url"].get<std::string>() + "x";
    Check(!coordination::ValidateDesired(configuration), "configuration byte overflow rejected");
    Json clipboard{{"method", "session.clipboard"},
                   {"tenantId", desired["tenantId"]},
                   {"sessionId", desired["sessionId"]},
                   {"placementEpoch", desired["placementEpoch"]},
                   {"connectionEpoch", desired["connectionEpoch"]},
                   {"revision", "1"},
                   {"value", {{"text", std::string(600000, '\0')}, {"html", ""}}}};
    clipboard["value"]["html"] =
        std::string(limits::documentBytes - limits::managementEnvelopeBytes -
                        coordination::DocumentBytes(clipboard),
                    'x');
    Check(bool(coordination::ValidateClipboard(clipboard)),
          "encoded clipboard byte boundary accepted");
    clipboard["id"] = std::string(36, 'f');
    Check(bool(coordination::ValidateClipboard(clipboard)), "clipboard wire id excluded");
    clipboard["value"]["html"] = clipboard["value"]["html"].get<std::string>() + "x";
    Check(!coordination::ValidateClipboard(clipboard), "encoded clipboard overflow rejected");
    Json body{{"viewId", "1"}, {"reason", "script"}, {"padding", ""}};
    body["padding"] = std::string(limits::eventBytes - body.dump().size(), 'x');
    Check(coordination::EventBodyFits("view.closed", body), "encoded event bound accepted");
    body["padding"] = body["padding"].get<std::string>() + "x";
    Check(!coordination::EventBodyFits("view.closed", body), "encoded event overflow rejected");
    Json observation{{"padding", ""}};
    observation["padding"] = std::string(limits::observationBytes - observation.dump().size(), 'x');
    Check(coordination::ObservationFits(observation), "observation bound accepted");
    observation["padding"] = observation["padding"].get<std::string>() + "x";
    Check(!coordination::ObservationFits(observation), "observation overflow rejected");
    for (const auto* kind : {"views", "sites", "files"}) {
      auto boundary = desired;
      const size_t bound = std::string_view(kind) == "views"   ? limits::views
                           : std::string_view(kind) == "sites" ? limits::sites
                                                               : limits::fileRequests;
      auto set = [&](size_t count) {
        boundary["views"] = desired["views"];
        boundary["sitePreferences"]["sites"] = Json::object();
        boundary["authorization"]["files"]["requests"] = Json::array();
        if (std::string_view(kind) == "views") {
          boundary["views"] = Json::array();
          for (size_t index = 0; index < count; ++index) {
            auto view = desired["views"][0];
            view["viewId"] = std::to_string(index + 1);
            boundary["views"].push_back(view);
          }
        } else if (std::string_view(kind) == "sites") {
          for (size_t index = 0; index < count; ++index)
            boundary["sitePreferences"]["sites"]["https://site" + std::to_string(index) + ".test"] =
                {{"tabletUa", true}};
        } else {
          for (size_t index = 0; index < count; ++index)
            boundary["authorization"]["files"]["requests"].push_back(
                {{"id", "request" + std::to_string(index)},
                 {"binding",
                  {{"browserIncarnation", "browser"},
                   {"view", "1"},
                   {"instance", "1"},
                   {"document", "1"},
                   {"request", "1"}}}});
        }
      };
      set(bound);
      Check(bool(coordination::ValidateDesired(boundary)), "collection bound accepted");
      set(bound + 1);
      Check(!coordination::ValidateDesired(boundary), "collection overflow rejected");
    }
    auto invalid = desired;
    invalid["commit"] = "commit";
    Check(!coordination::ValidateDesired(invalid), "running commit rejected");
    invalid = desired;
    invalid["views"].push_back(invalid["views"][0]);
    Check(!coordination::ValidateDesired(invalid), "duplicate views rejected");
    invalid = desired;
    invalid["views"][0]["occludedBottom"] = 901;
    Check(!coordination::ValidateDesired(invalid), "invalid occlusion rejected");
    invalid = desired;
    invalid["unrecognized"] = true;
    Check(!coordination::ValidateDesired(invalid), "unknown fields rejected");
    invalid = desired;
    invalid["sitePreferences"]["sites"]["https://EXAMPLE.test"] = {{"tabletUa", true}};
    Check(!coordination::ValidateDesired(invalid), "site entries are validated before publication");
    invalid = desired;
    invalid["authorization"]["files"]["requests"] =
        Json::array({{{"id", "token"}, {"binding", {{"view", "1"}}}}});
    Check(!coordination::ValidateDesired(invalid), "file grants are validated before publication");
    for (const auto* value : {"0", "1", "18446744073709551615"})
      Check(coordination::Counter(value), "valid counter");
    for (const auto* value : {"01", "-1", "18446744073709551616", "1.0"})
      Check(!coordination::Counter(value), "invalid counter");
    Check(!coordination::Counter("0", true), "positive counter");
    Json node{{"method", "node.desired"},
              {"connectionEpoch", "connection"},
              {"revision", "1"},
              {"sessions", Json::array()}};
    Check(bool(coordination::ValidateNodeDesired(node)), "empty fencing list");
    node["sessions"].push_back({{"tenantId", "tenant"},
                                {"sessionId", std::string(32, '1')},
                                {"placementEpoch", 1},
                                {"dataState", "dirty"}});
    Check(bool(coordination::ValidateNodeDesired(node)), "fencing list");
    node["sessions"].push_back(node["sessions"][0]);
    Check(!coordination::ValidateNodeDesired(node), "duplicate fence rejected");
    node["sessions"] = Json::array();
    for (size_t index = 0; index < limits::sessions; ++index) {
      const auto suffix = std::to_string(index);
      node["sessions"].push_back({{"tenantId", "tenant" + suffix},
                                  {"sessionId", std::string(32 - suffix.size(), '0') + suffix},
                                  {"placementEpoch", 1},
                                  {"dataState", "dirty"}});
    }
    Check(bool(coordination::ValidateNodeDesired(node)), "session count bound accepted");
    node["sessions"].push_back({{"tenantId", "extra"},
                                {"sessionId", std::string(32, 'f')},
                                {"placementEpoch", 1},
                                {"dataState", "dirty"}});
    Check(!coordination::ValidateNodeDesired(node), "session count overflow rejected");
    {
      std::promise<void> release_after_failure;
      auto failure_gate = release_after_failure.get_future().share();
      std::future<void> waiting;
      try {
        auto release_on_failure = ReleaseOnExit(release_after_failure);
        waiting = std::async(std::launch::async, [failure_gate] { failure_gate.wait(); });
        Check(false, "injected assertion failure");
      } catch (const std::runtime_error&) {
      }
      Check(waiting.wait_for(std::chrono::seconds(1)) == std::future_status::ready,
            "assertion failure releases asynchronous gate");
      waiting.get();
    }
    RpcResults results;
    Json request{{"method", "view.navigate"},
                 {"opId", "operation"},
                 {"replay", false},
                 {"endpointIncarnation", "endpoint"},
                 {"params", {{"browserIncarnation", "browser"}}}};
    std::atomic<unsigned> calls{0};
    std::promise<void> entered, release;
    auto gate = release.get_future().share();
    std::future<Result<Json>> original, duplicate;
    auto release_gate = ReleaseOnExit(release);
    original = std::async(std::launch::async, [&] {
      return results.Execute(request, [&]() -> Result<Json> {
        ++calls;
        entered.set_value();
        gate.wait();
        return Json{{"accepted", true}};
      });
    });
    entered.get_future().wait();
    auto retry = request;
    retry["replay"] = true;
    duplicate = std::async(std::launch::async, [&] {
      return results.Execute(retry, [&]() -> Result<Json> {
        ++calls;
        return Json();
      });
    });
    Check(duplicate.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout,
          "duplicate waits for original");
    release_gate.reset();
    Check(original.get().value() == duplicate.get().value() && calls == 1, "one RPC execution");
    auto changed = retry;
    changed["params"]["browserIncarnation"] = "replacement";
    Check(!results.Execute(changed, []() -> Result<Json> { return Json(); }),
          "changed target conflicts");
    for (unsigned i = 0; i <= coordination::kMaxResults; ++i) {
      request["opId"] = std::to_string(i);
      Check(bool(results.Execute(request, [i]() -> Result<Json> { return Json(i); })),
            "cache fill");
    }
    retry["opId"] = "0";
    const auto evicted = results.Execute(retry, [&]() -> Result<Json> {
      ++calls;
      return Json();
    });
    Check(!evicted && evicted.error().code == ErrorCode::kOutcomeUnknown && calls == 1,
          "evicted replay cannot execute");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
