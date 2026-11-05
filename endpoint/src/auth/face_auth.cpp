#include "util/thread.hpp"
#include "auth/face_auth.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <fstream>
#include <mutex>
#include "util/result_macros.hpp"
#include <thread>
#include <vector>

#if defined(RK_FACE_OPENCV)
#include <windows.h>
#include <bcrypt.h>
#include <opencv2/dnn.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/objdetect/face.hpp>
#endif

namespace rk::auth {
using remotekit::Error;
using remotekit::ErrorCode;
using remotekit::Result;
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
#if defined(RK_FACE_OPENCV)
constexpr char kModelVersion[] = RK_FACE_MODEL_VERSION;
#endif
constexpr float kMatchThreshold = 0.50f;

bool Normalize(FaceTemplate& value) {
  double sum = 0;
  for (float component : value) {
    if (!std::isfinite(component))
      return false;
    sum += double(component) * component;
  }
  if (sum <= 1e-12)
    return false;
  for (float& component : value)
    component = float(component / std::sqrt(sum));
  return true;
}

float Similarity(const FaceTemplate& lhs, const FaceTemplate& rhs) {
  float score = 0;
  for (size_t i = 0; i < lhs.size(); ++i)
    score += lhs[i] * rhs[i];
  return score;
}

uint64_t Fingerprint(const std::vector<uint8_t>& data) {
  uint64_t hash = 14695981039346656037ull;
  for (uint8_t byte : data)
    hash = (hash ^ byte) * 1099511628211ull;
  return hash;
}

struct Frame {
  int width = 0;
  int height = 0;
  uint64_t generation = 0;
  Clock::time_point received;
  std::vector<uint8_t> data;
};

#if defined(RK_FACE_OPENCV)
Result<std::vector<uchar>> Model(const std::filesystem::path& root,
                                 const char* name,
                                 std::string_view expected_sha) {
  std::ifstream stream(root / name, std::ios::binary | std::ios::ate);
  const auto size = stream.tellg();
  if (size <= 0 || size > 64 * 1024 * 1024)
    return Error{ErrorCode::kUnavailable, "missing or invalid model"};
  std::vector<uchar> bytes(static_cast<size_t>(size));
  stream.seekg(0);
  if (!stream.read(reinterpret_cast<char*>(bytes.data()), size))
    return Error{ErrorCode::kUnavailable, "failed to read model"};
  std::array<uint8_t, 32> hash{};
  if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, bytes.data(),
                 static_cast<ULONG>(bytes.size()), hash.data(),
                 static_cast<ULONG>(hash.size())) != 0)
    return Error{ErrorCode::kUnavailable, "failed to hash model"};
  constexpr char digits[] = "0123456789abcdef";
  std::array<char, 64> hex{};
  for (size_t i = 0; i < hash.size(); ++i) {
    hex[2 * i] = digits[hash[i] >> 4];
    hex[2 * i + 1] = digits[hash[i] & 15];
  }
  if (expected_sha != std::string_view(hex.data(), hex.size()))
    return Error{ErrorCode::kUnavailable, "model hash mismatch"};
  return bytes;
}

class Engine {
 public:
  Result<void> Initialize(const std::filesystem::path& root) {
    RK_ASSIGN_OR_RETURN(yunet, Model(root, "yunet.onnx", RK_FACE_YUNET_SHA));
    RK_ASSIGN_OR_RETURN(sface, Model(root, "sface.onnx", RK_FACE_SFACE_SHA));
    RK_ASSIGN_OR_RETURN(v1se, Model(root, "minifas-v1se.onnx", RK_FACE_MINIFAS_V1SE_SHA));
    RK_ASSIGN_OR_RETURN(v2, Model(root, "minifas-v2.onnx", RK_FACE_MINIFAS_V2_SHA));
    detector_ = cv::FaceDetectorYN::create("onnx", yunet, {}, {320, 320}, 0.75f, 0.3f, 100);
    recognizer_ = cv::FaceRecognizerSF::create("onnx", sface, {});
    v1se_ = cv::dnn::readNetFromONNX(v1se);
    v2_ = cv::dnn::readNetFromONNX(v2);
    return {};
  }

  Result<std::optional<FaceTemplate>> Infer(const Frame& frame) {
    std::lock_guard lock(mutex_);
    cv::Mat rgb(frame.height, frame.width, CV_8UC3, const_cast<uint8_t*>(frame.data.data()));
    cv::Mat bgr;
    cv::cvtColor(rgb, bgr, cv::COLOR_RGB2BGR);
    detector_->setInputSize(bgr.size());
    cv::Mat detections;
    detector_->detect(bgr, detections);
    if (detections.rows != 1)
      return std::optional<FaceTemplate>{};
    const float* face = detections.ptr<float>();
    for (int i = 0; i < 15; ++i) {
      if (!std::isfinite(face[i]))
        return std::optional<FaceTemplate>{};
    }
    if (face[0] < 0 || face[1] < 0 || face[2] < 64 || face[3] < 64 ||
        face[0] + face[2] >= bgr.cols || face[1] + face[3] >= bgr.rows || face[14] < 0.9f)
      return std::optional<FaceTemplate>{};
    RK_ASSIGN_OR_RETURN(real1, RealProbability(v1se_, bgr, face, 4.0f));
    RK_ASSIGN_OR_RETURN(real2, RealProbability(v2_, bgr, face, 2.7f));
    if (real1 < 0.70f || real2 < 0.70f || (real1 + real2) * 0.5f < 0.90f)
      return std::optional<FaceTemplate>{};
    cv::Mat aligned, features;
    recognizer_->alignCrop(bgr, detections.row(0), aligned);
    recognizer_->feature(aligned, features);
    FaceTemplate value;
    if (features.total() != value.size() || features.type() != CV_32F || !features.isContinuous())
      return Error{ErrorCode::kUnavailable, "invalid SFace output"};
    std::copy_n(features.ptr<float>(), value.size(), value.begin());
    return Normalize(value) ? std::optional(value) : std::nullopt;
  }

 private:
  static Result<float> RealProbability(cv::dnn::Net& net,
                                       const cv::Mat& frame,
                                       const float* face,
                                       float scale) {
    const int x = int(face[0]), y = int(face[1]);
    const int w = int(face[2]), h = int(face[3]);
    scale = std::min({scale, float(frame.cols - 1) / w, float(frame.rows - 1) / h});
    const float width = w * scale, height = h * scale;
    const float left =
        std::clamp(x + w * 0.5f - width * 0.5f, 0.0f, std::max(0.0f, frame.cols - 1 - width));
    const float top =
        std::clamp(y + h * 0.5f - height * 0.5f, 0.0f, std::max(0.0f, frame.rows - 1 - height));
    const cv::Rect crop(int(left), int(top),
                        std::min(frame.cols - 1, int(left + width)) - int(left) + 1,
                        std::min(frame.rows - 1, int(top + height)) - int(top) + 1);
    net.setInput(cv::dnn::blobFromImage(frame(crop), 1.0, {80, 80}));
    const cv::Mat output = net.forward();
    if (output.total() != 3 || output.type() != CV_32F || !output.isContinuous())
      return Error{ErrorCode::kUnavailable, "invalid MiniFAS output"};
    const float* logits = output.ptr<float>();
    if (!std::isfinite(logits[0]) || !std::isfinite(logits[1]) || !std::isfinite(logits[2]))
      return Error{ErrorCode::kUnavailable, "invalid MiniFAS logits"};
    const float peak = std::max({logits[0], logits[1], logits[2]});
    const float real = std::exp(logits[1] - peak);
    return real / (std::exp(logits[0] - peak) + real + std::exp(logits[2] - peak));
  }

  std::mutex mutex_;
  cv::Ptr<cv::FaceDetectorYN> detector_;
  cv::Ptr<cv::FaceRecognizerSF> recognizer_;
  cv::dnn::Net v1se_, v2_;
};

Result<std::shared_ptr<Engine>> GetEngine(const std::filesystem::path& models) {
  static std::mutex mutex;
  static std::once_flag worker_limit;
  static std::filesystem::path loaded_path;
  static std::shared_ptr<Engine> loaded;
  std::call_once(worker_limit, [] { cv::setNumThreads(2); });
  std::lock_guard lock(mutex);
  if (!loaded || models != loaded_path) {
    auto engine = std::make_shared<Engine>();
    RK_RETURN_IF_ERROR(engine->Initialize(models));
    loaded_path = models;
    loaded = std::move(engine);
  }
  return loaded;
}
#endif

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
    enrollment_anchor = {};
    enrollment = {};
    count = 0;
    sample_hashes = {};
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
    if (!matches) {
      count = 0;
      enrollment = {};
      return;
    }
    if (count && (received - last_match > 1s ||
                  (enroll && Similarity(*value, enrollment_anchor) < kMatchThreshold))) {
      count = 0;
      enrollment = {};
    }
    const auto end = sample_hashes.begin() + count;
    if (std::find(sample_hashes.begin(), end, frame_hash) != end)
      return;
    sample_hashes[count] = frame_hash;
    if (enroll) {
      if (!count)
        enrollment_anchor = *value;
      for (size_t i = 0; i < enrollment.size(); ++i)
        enrollment[i] += (*value)[i];
    }
    if (!count)
      first_match = received;
    last_match = received;
    if (++count < 3 || received - first_match < 400ms)
      return;
    if (enroll) {
      if (Normalize(enrollment))
        Finish({FaceState::enrolled, enrollment, {}});
      else
        Finish({FaceState::failed, {}, "face-inference-failed"});
    } else {
      Finish({FaceState::matched, {}, {}});
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
#if defined(RK_FACE_OPENCV)
      if (Clock::now() - frame.received <= 1s) {
        auto engine = GetEngine(models);
        if (!engine)
          failed = true;
        else {
          auto inferred = engine.value()->Infer(frame);
          if (inferred)
            value = std::move(inferred).value();
          else
            failed = true;
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
    enrollment_anchor = {};
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
  Clock::time_point deadline, last_match, first_match, last_submit;
  FaceTemplate enrollment{}, enrollment_anchor{};
  int count = 0;
  std::array<uint64_t, 4> sample_hashes{};
  std::optional<uint64_t> last_presence_hash;
  std::jthread worker;
};

Faces::Faces(std::filesystem::path models) : impl_(std::make_unique<Impl>(std::move(models))) {}
Faces::~Faces() = default;

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
