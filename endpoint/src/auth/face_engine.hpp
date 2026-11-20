#pragma once

#include "auth/face_auth.hpp"
#include "util/error.hpp"

#include <span>

namespace rk::auth {

inline constexpr float kMatchThreshold = 0.41f;
inline constexpr float kLearnFloor = 0.335f;
inline constexpr float kNovelty = 0.60f;
inline constexpr float kDiversity = 0.995f;
inline constexpr float kDetectScore = 0.90f;
inline constexpr float kMinFace = 40;
using FaceDetection = std::array<float, 15>;

bool Normalize(FaceTemplate& value);
float Similarity(const FaceTemplate& lhs, const FaceTemplate& rhs);
float BestSimilarity(std::span<const FaceTemplate> gallery, const FaceTemplate& value);
bool ValidTemplate(const FaceTemplate& value);
uint64_t Fingerprint(std::span<const uint8_t> data);

inline FaceGate PerFrameLiveGate(float first, float second) {
  if (first < 0.50f)
    return FaceGate::live_v1se;
  return second < 0.50f ? FaceGate::live_v2 : FaceGate::none;
}

struct FaceSelection {
  FaceGate gate = FaceGate::none;
  int qualified = 0;
  FaceDetection face{};
};
FaceSelection SelectFace(std::span<const FaceDetection> detections, int width, int height);

struct FaceQuality {
  float inter_ocular = 0;
  float yaw = 0;
  float pitch = 0;
  float sharpness = 0;
  float mean_luma = 0;
  float dark_fraction = 0;
  float bright_fraction = 0;
  float contrast = 0;
  float background_luma = 0;
  float backlight = 0;
};

struct FaceInference {
  FaceDetection face{};
  FaceQuality quality;
  bool detection_retried = false;
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
