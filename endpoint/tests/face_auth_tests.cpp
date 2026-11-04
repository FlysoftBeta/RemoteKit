#include "remotekit/face_auth.hpp"

#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

int main(int argc, char** argv) {
  using namespace rk::auth;
  using namespace std::chrono_literals;
  if (argc != 2) return 1;
  const std::filesystem::path models = argv[1];
  if (Faces::Capabilities(models / "not-installed").available) return 2;
  const auto capabilities = Faces::Capabilities(models);
  if (!capabilities.available || capabilities.model_version.empty()) {
    std::cerr << capabilities.reason << std::endl;
    return 3;
  }

  Faces faces(models);
  if (faces.Begin({1, "invalid", FacePurpose::verify, 2000, FaceTemplate{}})) return 4;
  if (!faces.Begin({1, "test", FacePurpose::enroll, 2000, {}})) return 5;
  if (faces.Status(2, "test") || faces.Cancel(1, "wrong")) return 6;
  std::vector<uint8_t> rgb(320 * 240 * 3, 0);
  faces.SubmitRGB24(320, 240, rgb.data(), 320 * 3);
  std::this_thread::sleep_for(500ms);
  auto status = faces.Status(1, "test");
  if (!status || status->state != FaceState::pending || status->face_template) return 7;
  if (!faces.Cancel(1, "test") || faces.Status(1, "test")) return 8;

  if (!faces.Begin({2, "expiry", FacePurpose::enroll, 1, {}})) return 9;
  std::this_thread::sleep_for(20ms);
  status = faces.Status(2, "expiry");
  if (!status || status->state != FaceState::expired || status->face_template) return 10;
  FaceTemplate enrolled{};
  enrolled[0] = 1.0f;
  if (!faces.Begin({2, "presence", FacePurpose::presence, 7000, enrolled})) return 11;
  Faces no_match(models);
  if (!no_match.Begin({2, "no-match", FacePurpose::presence, 7000, enrolled})) return 12;
  std::this_thread::sleep_for(2500ms);
  no_match.SubmitRGB24(320, 240, rgb.data(), 320 * 3);
  std::this_thread::sleep_for(2600ms);
  status = faces.Status(2, "presence");
  if (!status || status->state != FaceState::absent || status->face_template ||
      status->reason != "camera-unavailable") return 13;
  status = no_match.Status(2, "no-match");
  if (!status || status->state != FaceState::absent || status->face_template ||
      status->reason != "no-matching-face") return 14;
}
