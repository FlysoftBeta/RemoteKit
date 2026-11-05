#include "auth/face_auth.hpp"
#include "auth/face_engine.hpp"
#include "auth/face_policy.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>

#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

namespace {
using namespace rk::auth;
using namespace std::chrono_literals;
void Require(bool condition, const char* name) {
  if (!condition)
    throw std::runtime_error(name);
}

FaceDetection Detection(float x = 100,
                        float y = 100,
                        float width = 64,
                        float height = 64,
                        float score = 0.90f) {
  FaceDetection face{};
  face[0] = x;
  face[1] = y;
  face[2] = width;
  face[3] = height;
  face[14] = score;
  return face;
}

void DetectionTests() {
  const auto valid = Detection();
  std::vector<FaceDetection> candidates{valid, Detection(200, 200, 100, 100, 0.89f),
                                        Detection(200, 200, 63.99f),
                                        Detection(200, 200, 64, 63.99f)};
  auto selected = SelectFace(candidates, 640, 480);
  Require(selected.gate == FaceGate::none && selected.qualified == 1,
          "filter score and both dimensions before cardinality");
  candidates.push_back(Detection(200, 200));
  Require(SelectFace(candidates, 640, 480).gate == FaceGate::multiple_faces,
          "two qualified faces reject");
  candidates.erase(candidates.begin());
  candidates.pop_back();
  Require(SelectFace(candidates, 640, 480).gate == FaceGate::no_qualified_face,
          "all unqualified faces reject");
  Require(SelectFace({}, 640, 480).gate == FaceGate::no_qualified_face, "empty detection");
  for (int side = 0; side < 4; ++side) {
    auto face = valid;
    const float edge = side % 2 == 0 ? 640.0f : 480.0f;
    const float margin = edge * 0.02f;
    const int coordinate = side % 2;
    face[coordinate] = side < 2 ? -margin : edge + margin - 64;
    selected = SelectFace(std::span(&face, 1), 640, 480);
    Require(selected.gate == FaceGate::none, "exact two percent boundary accepts");
    Require(selected.face[coordinate] >= 0 &&
                selected.face[coordinate] + selected.face[coordinate + 2] <= edge,
            "boundary box clamps to frame");
    face[coordinate] += side < 2 ? -0.01f : 0.01f;
    Require(SelectFace(std::span(&face, 1), 640, 480).gate == FaceGate::boundary,
            "more than two percent boundary rejects");
  }
  auto edge = Detection(576, 416);
  Require(SelectFace(std::span(&edge, 1), 640, 480).gate == FaceGate::none,
          "box touching frame edge accepts");
  auto invalid = valid;
  invalid[4] = std::numeric_limits<float>::quiet_NaN();
  Require(SelectFace(std::span(&invalid, 1), 640, 480).gate == FaceGate::nonfinite,
          "nonfinite landmark rejects");
  invalid = valid;
  invalid[2] = std::numeric_limits<float>::infinity();
  Require(SelectFace(std::span(&invalid, 1), 640, 480).gate == FaceGate::nonfinite,
          "nonfinite qualified box rejects");
}

void FramePolicyTests() {
  const auto epoch = FaceWindow::Clock::time_point{};
  FaceTemplate anchor{};
  anchor[0] = 1;
  FaceTemplate different{};
  different[1] = 1;
  FaceWindow window;
  auto observe = [&](int ms, std::optional<FaceTemplate> value, uint64_t hash,
                     std::optional<FaceTemplate> reference = std::nullopt) {
    return window.Observe(epoch + std::chrono::milliseconds(ms), value, hash, reference);
  };
  Require(!observe(0, anchor, 1, anchor), "one match waits");
  Require(!observe(200, different, 2, anchor), "identity mismatch occupies slot");
  Require(!observe(400, anchor, 3, anchor), "two matches wait");
  Require(!observe(600, std::nullopt, 4, anchor), "detection miss occupies slot");
  Require(observe(800, anchor, 5, anchor).has_value(), "three among five accepts");

  window = {};
  observe(0, anchor, 1, anchor);
  observe(200, std::nullopt, 2, anchor);
  observe(400, anchor, 3, anchor);
  observe(600, std::nullopt, 4, anchor);
  observe(800, std::nullopt, 5, anchor);
  Require(!observe(1000, anchor, 6, anchor), "sixth observation evicts first match");

  window = {};
  observe(0, anchor, 1);
  observe(100, anchor, 2);
  Require(!observe(399, anchor, 3), "span under four hundred rejects");
  Require(observe(400, anchor, 3).has_value(), "later duplicate may complete distinct triple span");

  window = {};
  observe(0, anchor, 1);
  observe(200, anchor, 1);
  Require(!observe(400, anchor, 2), "duplicate image cannot count twice");
  Require(observe(600, anchor, 3).has_value(), "third distinct image accepts");

  window = {};
  observe(0, anchor, 1);
  observe(200, anchor, 2);
  Require(observe(1000, anchor, 3).has_value(), "one thousand millisecond window inclusive");
  window = {};
  observe(0, anchor, 1);
  observe(200, anchor, 2);
  Require(!observe(1001, anchor, 3), "old matches outside window expire");

  FaceTemplate upper{}, lower{};
  upper[0] = lower[0] = 0.6f;
  upper[1] = 0.8f;
  lower[1] = -0.8f;
  window = {};
  observe(0, anchor, 1);
  observe(200, upper, 2);
  auto enrolled = observe(400, lower, 3);
  FaceTemplate expected{};
  expected[0] = 1;
  Require(enrolled && Similarity(*enrolled, expected) > 0.999f,
          "enrollment matches first anchor and normalizes mean");

  window = {};
  observe(0, anchor, 1);
  observe(200, upper, 2);
  Require(!observe(400, different, 3), "matching preceding sample cannot drift from anchor");
  Require(observe(600, lower, 4).has_value(), "anchor mismatch does not reset enrollment");

  FaceTemplate threshold{}, below{};
  threshold[0] = 0.45f;
  threshold[1] = std::sqrt(1 - threshold[0] * threshold[0]);
  below[0] = 0.449f;
  below[1] = std::sqrt(1 - below[0] * below[0]);
  window = {};
  observe(0, threshold, 1, anchor);
  observe(200, threshold, 2, anchor);
  Require(!observe(400, below, 3, anchor), "below match threshold rejects");
  Require(observe(600, threshold, 4, anchor).has_value(), "match threshold inclusive");

  window = {};
  observe(0, anchor, 1);
  observe(200, different, 2);
  observe(400, different, 3);
  Require(!observe(600, different, 4), "first enrollment anchor persists in window");
  Require(observe(1200, different, 5).has_value(),
          "expired enrollment anchor leaves current window");
}
}  // namespace

int main(int argc, char** argv) {
  using namespace rk::auth;
  using namespace std::chrono_literals;
  DetectionTests();
  FramePolicyTests();
  if (argc != 2)
    return 1;
  const std::filesystem::path models = argv[1];
  if (Faces::Capabilities(models / "not-installed").available)
    return 2;
  const auto capabilities = Faces::Capabilities(models);
  if (!capabilities.available || capabilities.model_version.empty()) {
    std::cerr << capabilities.reason << std::endl;
    return 3;
  }

  Faces faces(models);
  if (faces.Begin({1, "invalid", FacePurpose::verify, 2000, FaceTemplate{}}))
    return 4;
  if (!faces.Begin({1, "test", FacePurpose::enroll, 2000, {}}))
    return 5;
  if (faces.Status(2, "test") || faces.Cancel(1, "wrong"))
    return 6;
  std::vector<uint8_t> rgb(320 * 240 * 3, 0);
  faces.SubmitRGB24(320, 240, rgb.data(), 320 * 3);
  std::this_thread::sleep_for(500ms);
  auto status = faces.Status(1, "test");
  if (!status || status->state != FaceState::pending || status->face_template)
    return 7;
  Require(faces.GateFailures()[static_cast<size_t>(FaceGate::no_qualified_face)] == 1,
          "production counts detection gate failures");
  if (!faces.Cancel(1, "test") || faces.Status(1, "test"))
    return 8;

  if (!faces.Begin({2, "expiry", FacePurpose::enroll, 1, {}}))
    return 9;
  std::this_thread::sleep_for(20ms);
  status = faces.Status(2, "expiry");
  if (!status || status->state != FaceState::expired || status->face_template)
    return 10;
  FaceTemplate enrolled{};
  enrolled[0] = 1.0f;
  if (!faces.Begin({2, "presence", FacePurpose::presence, 7000, enrolled}))
    return 11;
  Faces no_match(models);
  if (!no_match.Begin({2, "no-match", FacePurpose::presence, 7000, enrolled}))
    return 12;
  std::this_thread::sleep_for(2500ms);
  no_match.SubmitRGB24(320, 240, rgb.data(), 320 * 3);
  std::this_thread::sleep_for(2600ms);
  status = faces.Status(2, "presence");
  if (!status || status->state != FaceState::absent || status->face_template ||
      status->reason != "camera-unavailable")
    return 13;
  status = no_match.Status(2, "no-match");
  if (!status || status->state != FaceState::absent || status->face_template ||
      status->reason != "no-matching-face")
    return 14;
}
