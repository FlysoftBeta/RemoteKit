#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace rk::auth {

enum class FaceGate {
  none,
  no_qualified_face,
  multiple_faces,
  boundary,
  nonfinite,
  live_v1se,
  live_v2,
  live_mean,
  embedding,
  count
};
inline constexpr size_t kFaceGateCount = static_cast<size_t>(FaceGate::count);

using FaceTemplate = std::array<float, 128>;

enum class FacePurpose { enroll, verify, presence };
enum class FaceState { pending, matched, enrolled, absent, failed, expired };

struct FaceCapabilities {
  bool available = false;
  std::string reason;
  std::string model_version;
};

struct FaceChallenge {
  uint64_t epoch = 0;
  std::string challenge_id;
  FacePurpose purpose = FacePurpose::verify;
  uint32_t timeout_ms = 0;
  std::optional<FaceTemplate> face_template;
};

struct FaceResult {
  FaceState state = FaceState::pending;
  std::optional<FaceTemplate> face_template;
  std::string reason;
};

class Faces {
 public:
  explicit Faces(std::filesystem::path models);
  ~Faces();
  static FaceCapabilities Capabilities(const std::filesystem::path& models);
  bool Begin(FaceChallenge challenge);
  void SubmitRGB24(int width, int height, const uint8_t* rgb, int stride);
  std::optional<FaceResult> Status(uint64_t epoch, std::string_view challenge_id);
  bool Cancel(uint64_t epoch, std::string_view challenge_id);
  void Cancel();
  std::array<uint64_t, kFaceGateCount> GateFailures();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace rk::auth
