#pragma once
#include "management/coordination.hpp"

namespace remotekit::coordination {
inline bool EventBodyFits(const std::string& type, const Json& body) {
  if (body.dump().size() > limits::eventBytes)
    return false;
  auto fits = [&](const char* field, size_t bound) {
    return body.contains(field) && body[field].is_string() &&
           body[field].get_ref<const std::string&>().size() <= bound;
  };
  if (type == "clipboard.changed")
    return body.value("oversize", false) ||
           (fits("text", limits::textBytes) && fits("html", limits::htmlBytes));
  if (type.starts_with("download."))
    return fits("name", limits::downloadNameBytes) && fits("origin", limits::originBytes) &&
           (type != "download.imported" || fits("mimeType", limits::mimeTypeBytes));
  if (type == "view.signIn")
    return body.contains("result") && body["result"].dump().size() <= limits::signInBytes;
  if (type == "view.closed")
    return fits("reason", limits::identityBytes);
  return false;
}
inline bool ObservationFits(const Json& observation) {
  return observation.value("views", Json::array()).size() <= limits::views &&
         (observation.value("checkpoint", Json()).is_null() ||
          observation["checkpoint"].value("objects", Json::array()).size() <=
              limits::checkpointObjects) &&
         observation.dump().size() <= limits::observationBytes;
}
}  // namespace remotekit::coordination
