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
#include <tuple>
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

bool ValidChallenge(const FaceChallenge& challenge) {
  if (!challenge.epoch || challenge.challenge_id.empty() || challenge.challenge_id.size() > 128 ||
      !challenge.timeout_ms)
    return false;
  switch (challenge.purpose) {
    case FacePurpose::enroll:
      return challenge.timeout_ms <= 60'000 && challenge.templates.empty();
    case FacePurpose::verify:
    case FacePurpose::presence: {
      const auto max = challenge.purpose == FacePurpose::verify ? 30'000u : 120'000u;
      return challenge.timeout_ms <= max && !challenge.templates.empty() &&
             challenge.templates.size() <= 9 &&
             std::all_of(challenge.templates.begin(), challenge.templates.end(), ValidTemplate);
    }
  }
  return false;
}
}  // namespace

struct Faces::Impl {
  explicit Impl(std::filesystem::path path) : models(std::move(path)) {}
  ~Impl() {
    worker.thread.request_stop();
    changed.notify_all();
  }

  void Finish(FaceResult final) {
    result = std::move(final);
    latest.reset();
    challenge.templates.clear();
    policy = {};
  }

  void Finish(FaceState state,
              FaceOutcome outcome = FaceOutcome::none,
              std::optional<remotekit::Error> error = {}) {
    FaceResult final;
    final.state = state;
    final.outcome = outcome;
    final.error = std::move(error);
    Finish(std::move(final));
  }

  void Expire(Clock::time_point now) {
    if (!active || result.state != FaceState::pending)
      return;
    if (policy.CompletionTime() && *policy.CompletionTime() <= deadline) {
      policy.Advance(now);
      if (policy.Result().state == FaceState::enrolled) {
        Finish(policy.Result());
        return;
      }
    }
    if (challenge.purpose == FacePurpose::presence && now - last_match >= 5s)
      Finish(FaceState::absent, now - last_submit >= 5s ? FaceOutcome::camera_unavailable
                                                        : FaceOutcome::no_matching_face);
    else if (now >= deadline)
      Finish(FaceState::expired);
  }

  // What Control shows of the pending challenge; a change of it is announced once.
  using Visible =
      std::tuple<FaceState, std::optional<float>, std::optional<std::string>, FaceOutcome, bool>;
  Visible VisibleResult() const {
    return {result.state, result.progress, result.hint, result.outcome, result.error.has_value()};
  }
  void Announce() {
    const auto visible = VisibleResult();
    if (visible == announced)
      return;
    announced = visible;
    if (on_change)
      on_change();
  }

  void Observe(Clock::time_point received, const FaceInference& inference, uint64_t frame_hash) {
    const auto observation = policy.Observe(received, inference, frame_hash);
    if (observation.gate != FaceGate::none)
      ++gate_failures[static_cast<size_t>(observation.gate)];
    if (observation.presence_match)
      last_match = received;
    result = policy.Result();
    if (result.state != FaceState::pending)
      Finish(result);
  }

  void Run(std::stop_token stop) {
    while (!stop.stop_requested()) {
      std::unique_lock lock(mutex);
      const bool pending = active && result.state == FaceState::pending;
      if (!pending) {
        changed.wait(lock, stop, [this] { return active && result.state == FaceState::pending; });
        continue;
      }
      auto expiry = challenge.purpose == FacePurpose::presence ? std::min(deadline, last_match + 5s)
                                                               : deadline;
      if (const auto completion = policy.CompletionTime())
        expiry = std::min(expiry, *completion);
      const auto waiting_generation = generation;
      changed.wait_until(lock, stop, expiry, [this, waiting_generation] {
        return latest.has_value() || generation != waiting_generation ||
               result.state != FaceState::pending;
      });
      if (stop.stop_requested())
        break;
      Expire(Clock::now());
      Announce();
      if (!latest)
        continue;
      Frame frame = std::move(*latest);
      latest.reset();
      lock.unlock();
      FaceInference inference;
      std::optional<remotekit::Error> failure;
#if defined(RK_FACE_OPENCV)
      if (Clock::now() - frame.received <= 1s) {
        auto engine = GetEngine(models);
        if (!engine)
          failure = engine.error();
        else {
          auto inferred = engine.value()->InferRGB24(frame.width, frame.height, frame.data.data());
          if (inferred) {
            inference = std::move(inferred).value();
          } else {
            failure = inferred.error();
          }
        }
      }
#else
      failure = remotekit::Error{remotekit::ErrorCode::kUnavailable,
                                 "Face inference capability unavailable"};
#endif
      const auto frame_hash = Fingerprint(frame.data);
      lock.lock();
      const auto now = Clock::now();
      Expire(now);
      if (!active || frame.generation != generation || result.state != FaceState::pending)
        continue;
      if (failure) {
        Finish(FaceState::failed, FaceOutcome::none, *failure);
      } else if (now - frame.received <= 1s) {
        Observe(frame.received, inference, frame_hash);
      }
      Announce();
    }
  }

  void Reset() {
    ++generation;
    active = false;
    challenge = {};
    Finish(FaceResult{});
    announced = VisibleResult();
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
  FacePolicy policy;
  std::array<uint64_t, kFaceGateCount> gate_failures{};
  Worker worker;
  std::function<void()> on_change;
  Visible announced;
};

void Faces::Worker::Start(std::mutex& mutex,
                          std::function<void(std::stop_token)> run,
                          std::function<void()> failed) {
  if (state == State::kRunning)
    return;
  if (state == State::kExited)
    thread.join();
  state = State::kRunning;
  try {
    thread = std::jthread(
        [this, &mutex, run = std::move(run), failed = std::move(failed)](std::stop_token stop) {
          remotekit::RunThread(
              "face",
              [&] {
                run(stop);
                std::lock_guard lock(mutex);
                state = State::kExited;
              },
              [&] {
                std::lock_guard lock(mutex);
                state = State::kExited;
                failed();
              });
        });
  } catch (...) {
    state = State::kNotStarted;
    throw;
  }
}

Faces::Faces(std::filesystem::path models) : impl_(std::make_unique<Impl>(std::move(models))) {}
Faces::~Faces() = default;

std::array<uint64_t, kFaceGateCount> Faces::GateFailures() {
  std::lock_guard lock(impl_->mutex);
  return impl_->gate_failures;
}

void Faces::SetChanged(std::function<void()> changed) {
  std::lock_guard lock(impl_->mutex);
  impl_->on_change = std::move(changed);
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
  impl_->policy = FacePolicy(impl_->challenge.purpose, impl_->challenge.templates);
  impl_->result = impl_->policy.Result();
  impl_->active = true;
  const auto now = Clock::now();
  impl_->last_match = now;
  impl_->last_submit = now - 1s;
  impl_->deadline = now + std::chrono::milliseconds(impl_->challenge.timeout_ms);
  impl_->worker.Start(
      impl_->mutex, [impl = impl_.get()](std::stop_token stop) { impl->Run(stop); },
      [impl = impl_.get()] {
        impl->Finish(FaceState::failed, FaceOutcome::none,
                     remotekit::Error{remotekit::ErrorCode::kInternal, "Face worker failed"});
      });
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
