#pragma once
#include "util/common.hpp"
namespace remotekit::test {
inline Json Desired(const std::string& session = std::string(32, 'a'),
                    uint64_t epoch = 1,
                    const std::string& revision = "1",
                    const std::string& connection = "connection") {
  return {
      {"method", "session.desired"},
      {"connectionEpoch", connection},
      {"tenantId", "tenant"},
      {"sessionId", session},
      {"placementEpoch", epoch},
      {"revision", revision},
      {"run", "stopped"},
      {"commit", nullptr},
      {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
      {"checkpoint", nullptr},
      {"sitePreferences", {{"sites", Json::object()}}},
      {"mediaPolicy", {{"maxFps", 30}, {"degradationPreference", "balanced"}, {"audio", false}}},
      {"quality", {{"effectiveDpr", 1}}},
      {"clipboard", {{"revision", "0"}, {"value", {{"text", ""}, {"html", ""}}}}},
      {"views", Json::array()},
      {"authorization",
       {{"connectionId", nullptr},
        {"epoch", 0},
        {"unlocked", false},
        {"files", {{"requests", Json::array()}}}}},
      {"lock", {{"leaseId", nullptr}, {"epoch", 0}, {"state", "locked"}}}};
}
inline Json NodeDesired(const Json& sessions = Json::array(),
                        const std::string& connection = "connection",
                        const std::string& revision = "1") {
  return {{"method", "node.desired"},
          {"connectionEpoch", connection},
          {"revision", revision},
          {"sessions", sessions}};
}
inline Json Rpc(const std::string& method,
                const Json& params = Json::object(),
                const std::string& op = "operation",
                const std::string& session = std::string(32, 'a'),
                uint64_t epoch = 1) {
  return {{"method", method},
          {"tenantId", "tenant"},
          {"sessionId", session},
          {"placementEpoch", epoch},
          {"endpointIncarnation", "endpoint"},
          {"opId", op},
          {"replay", false},
          {"params", params}};
}
inline Json Placement(const std::string& id = std::string(32, 'a'), uint64_t epoch = 1) {
  return {
      {"tenantId", "tenant"}, {"sessionId", id}, {"placementEpoch", epoch}, {"dataState", "dirty"}};
}
}  // namespace remotekit::test
