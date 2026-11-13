#pragma once

#include "util/error.hpp"
#include <array>
#include <atomic>
#include <functional>
#include <mutex>
#include <thread>
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

enum class FaceOutcome { none, no_matching_face, camera_unavailable };

struct FaceResult {
  FaceState state = FaceState::pending;
  std::optional<FaceTemplate> face_template;
  FaceOutcome outcome = FaceOutcome::none;
  std::optional<remotekit::Error> error;
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
  friend struct FaceWorkerTestAccess;
  struct Worker {
    enum class State { kNotStarted, kRunning, kExited };
    std::atomic<State> state{State::kNotStarted};
    std::jthread thread;
    void Start(std::mutex&, std::function<void(std::stop_token)>, std::function<void()> failed);
  };
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace rk::auth
