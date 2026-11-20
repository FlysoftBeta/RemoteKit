#include "auth/face_engine.hpp"
#include "util/result_macros.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <mutex>
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

uint64_t Fingerprint(std::span<const uint8_t> data) {
  uint64_t hash = 14695981039346656037ull;
  for (uint8_t byte : data)
    hash = (hash ^ byte) * 1099511628211ull;
  return hash;
}

float BestSimilarity(std::span<const FaceTemplate> gallery, const FaceTemplate& value) {
  float score = -1;
  for (const auto& reference : gallery)
    score = std::max(score, Similarity(reference, value));
  return score;
}

bool ValidTemplate(const FaceTemplate& value) {
  double squared_norm = 0;
  for (float component : value) {
    if (!std::isfinite(component))
      return false;
    squared_norm += double(component) * component;
  }
  return std::abs(std::sqrt(squared_norm) - 1) < 1e-3;
}

FaceSelection SelectFace(std::span<const FaceDetection> detections, int width, int height) {
  FaceSelection result;
  float second_area = 0;
  for (const auto& candidate : detections) {
    if (candidate[14] < kDetectScore || candidate[2] < kMinFace || candidate[3] < kMinFace)
      continue;
    for (float component : candidate) {
      if (!std::isfinite(component)) {
        result.gate = FaceGate::nonfinite;
        return result;
      }
    }
    ++result.qualified;
    const float area = candidate[2] * candidate[3];
    if (area > result.face[2] * result.face[3]) {
      second_area = result.face[2] * result.face[3];
      result.face = candidate;
    } else {
      second_area = std::max(second_area, area);
    }
  }
  if (!result.qualified) {
    result.gate = FaceGate::no_qualified_face;
    return result;
  }
  if (second_area > result.face[2] * result.face[3] * 0.5f) {
    result.gate = FaceGate::multiple_faces;
    return result;
  }
  auto& face = result.face;
  for (int i = 4; i < 14; i += 2) {
    if (face[i] < 2 || face[i] > width - 3 || face[i + 1] < 2 || face[i + 1] > height - 3) {
      result.gate = FaceGate::boundary;
      return result;
    }
  }
  const float right = std::min(float(width), face[0] + face[2]);
  const float bottom = std::min(float(height), face[1] + face[3]);
  face[0] = std::max(0.0f, face[0]);
  face[1] = std::max(0.0f, face[1]);
  face[2] = right - face[0];
  face[3] = bottom - face[1];
  if (face[2] <= 0 || face[3] <= 0)
    result.gate = FaceGate::boundary;
  return result;
}

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

struct Engine::Impl {
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

  Result<FaceInference> InferRGB24(int width, int height, const uint8_t* data) {
    std::lock_guard lock(mutex_);
    cv::Mat rgb(height, width, CV_8UC3, const_cast<uint8_t*>(data));
    cv::Mat bgr;
    cv::cvtColor(rgb, bgr, cv::COLOR_RGB2BGR);
    detector_->setInputSize(bgr.size());
    auto candidates = Detect(bgr);
    auto selected = SelectFace(candidates, width, height);
    FaceInference result;
    cv::Mat gray;
    cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
    cv::Scalar mean, deviation;
    cv::meanStdDev(gray, mean, deviation);
    if (selected.gate == FaceGate::no_qualified_face &&
        (mean[0] < 65 || mean[0] > 190 || deviation[0] > 70 ||
         cv::countNonZero(gray < 8) + cv::countNonZero(gray > 247) > gray.total() * 0.15)) {
      candidates = Detect(CorrectLuminance(bgr));
      selected = SelectFace(candidates, width, height);
      result.detection_retried = true;
    }
    result.face = selected.face;
    result.detections = int(candidates.size());
    result.qualified = selected.qualified;
    result.gate = selected.gate;
    if (selected.qualified)
      result.detection_score = selected.face[14];
    if (result.gate != FaceGate::none)
      return result;
    const float* face = selected.face.data();
    RK_ASSIGN_OR_RETURN(real1, RealProbability(v1se_, bgr, face, 4.0f));
    RK_ASSIGN_OR_RETURN(real2, RealProbability(v2_, bgr, face, 2.7f));
    result.live_v1se = real1;
    result.live_v2 = real2;
    result.gate = PerFrameLiveGate(real1, real2);
    cv::Mat aligned, features;
    cv::Mat detection(1, 15, CV_32F, const_cast<float*>(face));
    recognizer_->alignCrop(bgr, detection, aligned);
    result.quality = MeasureQuality(bgr, aligned, selected.face);
    recognizer_->feature(aligned, features);
    FaceTemplate value;
    if (features.total() != value.size() || features.type() != CV_32F || !features.isContinuous())
      return Error{ErrorCode::kInternal, "invalid SFace output"};
    std::copy_n(features.ptr<float>(), value.size(), value.begin());
    if (Normalize(value))
      result.feature = value;
    else
      result.gate = FaceGate::embedding;
    return result;
  }

 private:
  std::vector<FaceDetection> Detect(const cv::Mat& image) {
    cv::Mat detections;
    detector_->detect(image, detections);
    std::vector<FaceDetection> candidates(detections.rows);
    for (int i = 0; i < detections.rows; ++i)
      std::copy_n(detections.ptr<float>(i), 15, candidates[i].begin());
    return candidates;
  }

  static cv::Mat CorrectLuminance(const cv::Mat& image) {
    cv::Mat lab;
    cv::cvtColor(image, lab, cv::COLOR_BGR2Lab);
    std::vector<cv::Mat> channels;
    cv::split(lab, channels);
    const double mean = std::clamp(cv::mean(channels[0])[0], 1.0, 254.0);
    const double gamma = std::clamp(std::log(120.0 / 255) / std::log(mean / 255), 0.45, 2.0);
    cv::Mat table(1, 256, CV_8U);
    for (int i = 0; i < 256; ++i)
      table.at<uint8_t>(i) = cv::saturate_cast<uint8_t>(255 * std::pow(i / 255.0, gamma));
    cv::LUT(channels[0], table, channels[0]);
    cv::createCLAHE(1.5, {4, 4})->apply(channels[0], channels[0]);
    cv::merge(channels, lab);
    cv::Mat result;
    cv::cvtColor(lab, result, cv::COLOR_Lab2BGR);
    return result;
  }

  static FaceQuality MeasureQuality(const cv::Mat& frame,
                                    const cv::Mat& aligned,
                                    const FaceDetection& face) {
    FaceQuality quality;
    const cv::Point2f eye1(face[4], face[5]), eye2(face[6], face[7]);
    const cv::Point2f eyes = (eye1 + eye2) * 0.5f;
    const cv::Point2f mouth =
        (cv::Point2f(face[10], face[11]) + cv::Point2f(face[12], face[13])) * 0.5f;
    const cv::Point2f nose(face[8], face[9]);
    quality.inter_ocular = float(cv::norm(eye2 - eye1));
    const cv::Point2f horizontal = (eye2 - eye1) / std::max(quality.inter_ocular, 1.0f);
    cv::Point2f vertical(-horizontal.y, horizontal.x);
    if ((mouth - eyes).dot(vertical) < 0)
      vertical *= -1;
    quality.yaw = (nose - eyes).dot(horizontal) / std::max(quality.inter_ocular, 1.0f);
    quality.pitch = (nose - eyes).dot(vertical) / std::max((mouth - eyes).dot(vertical), 1.0f);
    cv::Mat gray, laplacian;
    cv::cvtColor(aligned, gray, cv::COLOR_BGR2GRAY);
    cv::Laplacian(gray, laplacian, CV_32F);
    cv::Scalar mean, deviation;
    cv::meanStdDev(laplacian, mean, deviation);
    quality.sharpness = float(deviation[0] * deviation[0]);
    const auto interior = gray(cv::Rect(20, 20, 72, 72));
    cv::meanStdDev(interior, mean, deviation);
    quality.mean_luma = float(mean[0]);
    quality.contrast = float(deviation[0]);
    quality.dark_fraction = float(cv::countNonZero(interior < 8)) / float(interior.total());
    quality.bright_fraction = float(cv::countNonZero(interior > 247)) / float(interior.total());
    cv::cvtColor(frame, gray, cv::COLOR_BGR2GRAY);
    const cv::Rect bounds(0, 0, frame.cols, frame.rows);
    const cv::Rect box = cv::Rect(int(face[0]), int(face[1]), int(face[2]), int(face[3])) & bounds;
    const cv::Rect surrounding =
        cv::Rect(int(face[0] - face[2] * 0.5f), int(face[1] - face[3] * 0.5f), int(face[2] * 2),
                 int(face[3] * 2)) &
        bounds;
    const double area = surrounding.area() - box.area();
    quality.background_luma =
        area > 0 ? float((cv::sum(gray(surrounding))[0] - cv::sum(gray(box))[0]) / area)
                 : quality.mean_luma;
    quality.backlight = quality.background_luma - quality.mean_luma;
    return quality;
  }

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
      return Error{ErrorCode::kInternal, "invalid MiniFAS output"};
    const float* logits = output.ptr<float>();
    if (!std::isfinite(logits[0]) || !std::isfinite(logits[1]) || !std::isfinite(logits[2]))
      return Error{ErrorCode::kInternal, "invalid MiniFAS logits"};
    const float peak = std::max({logits[0], logits[1], logits[2]});
    const float real = std::exp(logits[1] - peak);
    return real / (std::exp(logits[0] - peak) + real + std::exp(logits[2] - peak));
  }

  std::mutex mutex_;
  cv::Ptr<cv::FaceDetectorYN> detector_;
  cv::Ptr<cv::FaceRecognizerSF> recognizer_;
  cv::dnn::Net v1se_, v2_;
};

Engine::Engine() : impl_(std::make_unique<Impl>()) {}
Engine::~Engine() = default;
Result<void> Engine::Initialize(const std::filesystem::path& root) {
  return impl_->Initialize(root);
}
Result<FaceInference> Engine::InferRGB24(int width, int height, const uint8_t* rgb) {
  return impl_->InferRGB24(width, height, rgb);
}

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

}  // namespace rk::auth
