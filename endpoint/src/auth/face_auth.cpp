#include "util/thread.hpp"
#include "auth/face_auth.hpp"
#include "auth/face_engine.hpp"
#include "auth/face_policy.hpp"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace rk::auth {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
#if defined(RK_FACE_OPENCV)
constexpr char kModelVersion[] = RK_FACE_MODEL_VERSION;
#endif
struct Frame {
  int width = 0;
  int height = 0;
  uint64_t generation = 0;
  Clock::time_point received;
  std::vector<uint8_t> data;
};

bool ValidChallenge(FaceChallenge& challenge) {
  if (!challenge.epoch || challenge.challenge_id.empty() || challenge.challenge_id.size() > 128 ||
      !challenge.timeout_ms)
    return false;
  switch (challenge.purpose) {
    case FacePurpose::enroll:
      return challenge.timeout_ms <= 60'000 && !challenge.face_template;
    case FacePurpose::verify:
    case FacePurpose::presence: {
      const auto max = challenge.purpose == FacePurpose::verify ? 30'000u : 120'000u;
      return challenge.timeout_ms <= max && challenge.face_template &&
             Normalize(*challenge.face_template);
    }
  }
  return false;
}
}  // namespace

struct Faces::Impl {
  explicit Impl(std::filesystem::path path) : models(std::move(path)) {}
  ~Impl() {
    worker.request_stop();
    changed.notify_all();
  }

  void Finish(FaceResult final) {
    result = std::move(final);
    latest.reset();
    challenge.face_template.reset();
    samples = {};
    last_presence_hash.reset();
  }

  void Expire(Clock::time_point now) {
    if (!active || result.state != FaceState::pending)
      return;
    if (challenge.purpose == FacePurpose::presence && now - last_match >= 5s)
      Finish({FaceState::absent,
              {},
              now - last_submit >= 5s ? "camera-unavailable" : "no-matching-face"});
    else if (now >= deadline)
      Finish({FaceState::expired, {}, {}});
  }

  void Observe(Clock::time_point received,
               const std::optional<FaceTemplate>& value,
               uint64_t frame_hash) {
    const bool enroll = challenge.purpose == FacePurpose::enroll;
    const bool matches =
        value && (enroll || Similarity(*value, *challenge.face_template) >= kMatchThreshold);
    if (challenge.purpose == FacePurpose::presence) {
      if (matches && last_presence_hash != frame_hash) {
        last_presence_hash = frame_hash;
        last_match = received;
      }
      return;
    }
    if (auto accepted = samples.Observe(received, value, frame_hash, challenge.face_template)) {
      Finish({enroll ? FaceState::enrolled : FaceState::matched,
              enroll ? std::optional(*accepted) : std::nullopt,
              {}});
    }
  }

  void Run(std::stop_token stop) {
    while (!stop.stop_requested()) {
      std::unique_lock lock(mutex);
      const bool pending = active && result.state == FaceState::pending;
      if (!pending) {
        changed.wait(lock, stop, [this] { return active && result.state == FaceState::pending; });
        continue;
      }
      const auto expiry = challenge.purpose == FacePurpose::presence
                              ? std::min(deadline, last_match + 5s)
                              : deadline;
      const auto waiting_generation = generation;
      changed.wait_until(lock, stop, expiry, [this, waiting_generation] {
        return latest.has_value() || generation != waiting_generation ||
               result.state != FaceState::pending;
      });
      if (stop.stop_requested())
        break;
      Expire(Clock::now());
      if (!latest)
        continue;
      Frame frame = std::move(*latest);
      latest.reset();
      lock.unlock();
      std::optional<FaceTemplate> value;
      bool failed = false;
      FaceGate gate = FaceGate::none;
#if defined(RK_FACE_OPENCV)
      if (Clock::now() - frame.received <= 1s) {
        auto engine = GetEngine(models);
        if (!engine)
          failed = true;
        else {
          auto inferred = engine.value()->InferRGB24(frame.width, frame.height, frame.data.data());
          if (inferred) {
            gate = inferred.value().gate;
            if (gate == FaceGate::none)
              value = std::move(inferred.value().feature);
          } else {
            failed = true;
          }
        }
      }
#else
      failed = true;
#endif
      const auto frame_hash = value ? Fingerprint(frame.data) : 0;
      lock.lock();
      const auto now = Clock::now();
      Expire(now);
      if (!active || frame.generation != generation || result.state != FaceState::pending)
        continue;
      if (gate != FaceGate::none)
        ++gate_failures[static_cast<size_t>(gate)];
      if (failed) {
        if (challenge.purpose != FacePurpose::presence)
          Finish({FaceState::failed, {}, "face-inference-failed"});
      } else if (now - frame.received <= 1s) {
        Observe(frame.received, value, frame_hash);
      }
    }
  }

  void Reset() {
    ++generation;
    active = false;
    challenge = {};
    Finish({});
  }

  const std::filesystem::path models;
  std::mutex mutex;
  std::condition_variable_any changed;
  bool active = false;
  uint64_t generation = 0;
  FaceChallenge challenge;
  FaceResult result;
  std::optional<Frame> latest;
  Clock::time_point deadline, last_match, last_submit;
  FaceWindow samples;
  std::array<uint64_t, kFaceGateCount> gate_failures{};
  std::optional<uint64_t> last_presence_hash;
  std::jthread worker;
};

Faces::Faces(std::filesystem::path models) : impl_(std::make_unique<Impl>(std::move(models))) {}
Faces::~Faces() = default;

std::array<uint64_t, kFaceGateCount> Faces::GateFailures() {
  std::lock_guard lock(impl_->mutex);
  return impl_->gate_failures;
}

FaceCapabilities Faces::Capabilities(const std::filesystem::path& models) {
#if defined(RK_FACE_OPENCV)
  auto engine = GetEngine(models);
  if (!engine)
    return {false, "face-models-unavailable", kModelVersion};
  return {true, {}, kModelVersion};
#else
  (void)models;
  return {false, "face-inference-unavailable", {}};
#endif
}

bool Faces::Begin(FaceChallenge challenge) {
  if (!ValidChallenge(challenge) || !Capabilities(impl_->models).available)
    return false;
  std::lock_guard lock(impl_->mutex);
  if (impl_->active && impl_->challenge.epoch == challenge.epoch &&
      impl_->challenge.challenge_id == challenge.challenge_id)
    return false;
  impl_->Reset();
  impl_->challenge = std::move(challenge);
  impl_->active = true;
  const auto now = Clock::now();
  impl_->last_match = now;
  impl_->last_submit = now - 1s;
  impl_->deadline = now + std::chrono::milliseconds(impl_->challenge.timeout_ms);
  if (!impl_->worker.joinable()) {
    impl_->worker = std::jthread([impl = impl_.get()](std::stop_token stop) {
      remotekit::RunThread(
          "face", [impl, stop] { impl->Run(stop); },
          [impl] {
            std::lock_guard lock(impl->mutex);
            impl->Finish({FaceState::failed, {}, "face-worker-failed"});
          });
    });
  }
  impl_->changed.notify_one();
  return true;
}

void Faces::SubmitRGB24(int width, int height, const uint8_t* rgb, int stride) {
  if (width < 64 || height < 64 || std::max(width, height) > 640 || std::min(width, height) > 480 ||
      !rgb || stride < width * 3 || stride > 4096)
    return;
  const auto now = Clock::now();
  std::lock_guard lock(impl_->mutex);
  if (!impl_->active || impl_->result.state != FaceState::pending || now >= impl_->deadline ||
      now - impl_->last_submit < 180ms)
    return;
  Frame& frame = impl_->latest ? *impl_->latest : impl_->latest.emplace();
  frame.data.resize(size_t(width) * height * 3);
  impl_->last_submit = now;
  frame.width = width;
  frame.height = height;
  frame.generation = impl_->generation;
  frame.received = now;
  const auto row_bytes = size_t(width) * 3;
  for (int row = 0; row < height; ++row) {
    std::memcpy(frame.data.data() + size_t(row) * row_bytes, rgb + size_t(row) * stride, row_bytes);
  }
  impl_->changed.notify_one();
}

std::optional<FaceResult> Faces::Status(uint64_t epoch, std::string_view challenge_id) {
  std::lock_guard lock(impl_->mutex);
  if (!impl_->active || epoch != impl_->challenge.epoch ||
      challenge_id != impl_->challenge.challenge_id)
    return std::nullopt;
  impl_->Expire(Clock::now());
  return impl_->result;
}

bool Faces::Cancel(uint64_t epoch, std::string_view challenge_id) {
  std::lock_guard lock(impl_->mutex);
  if (!impl_->active || epoch != impl_->challenge.epoch ||
      challenge_id != impl_->challenge.challenge_id)
    return false;
  impl_->Reset();
  return true;
}

void Faces::Cancel() {
  std::lock_guard lock(impl_->mutex);
  impl_->Reset();
  impl_->changed.notify_one();
}
}  // namespace rk::auth
