#pragma once

#include "auth/face_auth.hpp"
#include "util/error.hpp"

#include <span>

namespace rk::auth {

inline constexpr float kMatchThreshold = 0.45f;
using FaceDetection = std::array<float, 15>;

bool Normalize(FaceTemplate& value);
float Similarity(const FaceTemplate& lhs, const FaceTemplate& rhs);
uint64_t Fingerprint(std::span<const uint8_t> data);

struct FaceSelection {
  FaceGate gate = FaceGate::none;
  int qualified = 0;
  FaceDetection face{};
};
FaceSelection SelectFace(std::span<const FaceDetection> detections, int width, int height);

struct FaceInference {
  FaceGate gate = FaceGate::none;
  int detections = 0;
  int qualified = 0;
  float detection_score = -1;
  float live_v1se = -1;
  float live_v2 = -1;
  // Available after detection for identity-only evaluation, including live-gate failures.
  std::optional<FaceTemplate> feature;
};

class Engine {
 public:
  Engine();
  ~Engine();
  remotekit::Result<void> Initialize(const std::filesystem::path& root);
  remotekit::Result<FaceInference> InferRGB24(int width, int height, const uint8_t* rgb);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
remotekit::Result<std::shared_ptr<Engine>> GetEngine(const std::filesystem::path& models);

}  // namespace rk::auth
