#include "management/coordination.hpp"
#include "management/payload_limits.hpp"
#include "management/rpc_results.hpp"
#include <atomic>
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace remotekit;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
}  // namespace
int main(int argc, char** argv) {
  try {
    Check(argc == 2, "fixture required");
    std::ifstream input(argv[1]);
    Json desired;
    input >> desired;
    Check(bool(coordination::ValidateDesired(desired)), "valid desired fixture");
    for (const auto& [field, bound] : std::vector<std::pair<std::string, size_t>>{
             {"text", limits::textBytes}, {"html", limits::htmlBytes}}) {
      auto boundary = desired;
      boundary["clipboard"]["value"][field] = std::string(bound, 'x');
      Check(bool(coordination::ValidateDesired(boundary)), "clipboard bound accepted");
      auto body = boundary["clipboard"]["value"];
      Check(coordination::EventBodyFits("clipboard.changed", body), "event bound accepted");
      boundary["clipboard"]["value"][field] = std::string(bound + 1, 'x');
      Check(!coordination::ValidateDesired(boundary), "clipboard overflow rejected");
      body[field] = std::string(bound + 1, 'x');
      Check(!coordination::EventBodyFits("clipboard.changed", body), "event overflow rejected");
    }
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
    RpcResults results;
    Json request{{"method", "view.navigate"},
                 {"opId", "operation"},
                 {"replay", false},
                 {"endpointIncarnation", "endpoint"},
                 {"params", {{"browserIncarnation", "browser"}}}};
    std::atomic<unsigned> calls{0};
    std::promise<void> entered, release;
    auto gate = release.get_future().share();
    auto original = std::async(std::launch::async, [&] {
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
    auto duplicate = std::async(std::launch::async, [&] {
      return results.Execute(retry, [&]() -> Result<Json> {
        ++calls;
        return Json();
      });
    });
    Check(duplicate.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout,
          "duplicate waits for original");
    release.set_value();
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
