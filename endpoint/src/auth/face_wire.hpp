#pragma once

#include "auth/face_engine.hpp"
#include "util/common.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

namespace rk::auth {

inline remotekit::Result<void> ValidateFaceFields(std::string_view method,
                                                  const remotekit::Json& request) {
  constexpr std::array<std::string_view, 6> binding{"method",       "tenantId", "leaseId",
                                                    "connectionId", "epoch",    "challengeId"};
  constexpr std::array<std::string_view, 3> begin{"purpose", "timeoutMs", "templates"};
  if (!request.is_object())
    return remotekit::Error{remotekit::ErrorCode::kInvalidRequest, "invalid_face_request"};
  for (const auto& [key, value] : request.items()) {
    if (std::find(binding.begin(), binding.end(), key) == binding.end() &&
        (method != "auth.face.begin" || std::find(begin.begin(), begin.end(), key) == begin.end()))
      return remotekit::Error{remotekit::ErrorCode::kInvalidRequest, "unknown_face_field"};
  }
  return {};
}

inline remotekit::Result<FaceGallery> ReadFaceGallery(const remotekit::Json& request,
                                                      FacePurpose purpose) {
  const auto templates = request.find("templates");
  if (purpose == FacePurpose::enroll) {
    if (templates != request.end())
      return remotekit::Error{remotekit::ErrorCode::kInvalidRequest, "unexpected_face_templates"};
    return FaceGallery{};
  }
  const auto invalid = [] {
    return remotekit::Error{remotekit::ErrorCode::kInvalidRequest, "invalid_face_templates"};
  };
  if (templates == request.end() || !templates->is_array() || templates->empty() ||
      templates->size() > 9)
    return invalid();
  FaceGallery gallery;
  for (const auto& vector : *templates) {
    FaceTemplate value{};
    if (!vector.is_array() || vector.size() != value.size())
      return invalid();
    double squared_norm = 0;
    for (size_t i = 0; i < value.size(); ++i) {
      if (!vector[i].is_number())
        return invalid();
      const double component = vector[i].get<double>();
      if (!std::isfinite(component) || std::abs(component) > 1.001)
        return invalid();
      squared_norm += component * component;
      value[i] = static_cast<float>(component);
    }
    if (std::abs(std::sqrt(squared_norm) - 1) >= 1e-3 || !ValidTemplate(value))
      return invalid();
    gallery.push_back(value);
  }
  return gallery;
}

inline remotekit::Json FaceStatusJson(const FaceResult& result, std::string_view challenge) {
  constexpr std::array states{"pending", "matched", "enrolled", "absent", "failed", "expired"};
  remotekit::Json reply = {{"challengeId", challenge},
                           {"status", states[static_cast<size_t>(result.state)]}};
  if (result.state == FaceState::enrolled)
    reply["templates"] = result.templates;
  if (result.state == FaceState::pending && result.progress) {
    reply["progress"] = *result.progress;
    if (result.hint)
      reply["hint"] = *result.hint;
  }
  if ((result.state == FaceState::matched || result.state == FaceState::pending) && result.learn)
    reply["learn"] = *result.learn;
  if (result.outcome == FaceOutcome::camera_unavailable)
    reply["outcome"] = "camera_unavailable";
  else if (result.outcome == FaceOutcome::no_matching_face)
    reply["outcome"] = "no_matching_face";
  return reply;
}

}  // namespace rk::auth
