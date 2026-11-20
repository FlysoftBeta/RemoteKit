#include "files/photo_scan.hpp"

#include <windows.h>
#include <opencv2/dnn.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <mutex>
#include <numeric>
#include "util/result_macros.hpp"

namespace remotekit::photo {
namespace {

Result<void> CheckCancelled(const PhotoCancelled& cancelled) {
  if (cancelled && cancelled())
    return Error{ErrorCode::kCanceled, "Photo processing canceled"};
  return {};
}

cv::Mat LimitSide(const cv::Mat& image, int side) {
  const int longest = std::max(image.cols, image.rows);
  if (longest <= side)
    return image;
  cv::Mat result;
  cv::resize(image, result, {image.cols * side / longest, image.rows * side / longest}, 0, 0,
             cv::INTER_AREA);
  return result;
}

float Quantile(std::vector<float> values, double fraction) {
  const double position = (values.size() - 1) * fraction;
  const auto lower = static_cast<std::size_t>(position);
  std::nth_element(values.begin(), values.begin() + lower, values.end());
  const float first = values[lower];
  if (lower + 1 == values.size() || position == lower)
    return first;
  const float next = *std::min_element(values.begin() + lower + 1, values.end());
  return first + static_cast<float>(position - lower) * (next - first);
}

int Percentile(const cv::Mat& image, double fraction) {
  std::array<unsigned, 256> histogram{};
  for (int row = 0; row < image.rows; ++row) {
    const auto* pixels = image.ptr<std::uint8_t>(row);
    for (int col = 0; col < image.cols; ++col)
      ++histogram[pixels[col]];
  }
  int remaining = static_cast<int>(image.total() * fraction);
  for (int value = 0; value < 256; ++value) {
    remaining -= histogram[value];
    if (remaining < 0)
      return value;
  }
  return 255;
}

struct Projection {
  double score = 0;
  int lines = 0;
};

Projection Project(const std::vector<cv::Point2d>& points, bool vertical) {
  Projection best;
  for (int step = 0; step <= 60; ++step) {
    const double slope = std::tan((step * 0.5 - 15) * CV_PI / 180);
    std::array<int, 600> bins{};
    for (const auto& point : points) {
      const double x = vertical ? point.y : point.x;
      const double y = vertical ? point.x : point.y;
      ++bins[std::clamp(cvRound((y - x * slope) / 4) + 100, 0, 599)];
    }
    std::array<int, 600> smoothed{};
    double score = 0;
    for (int index = 0; index < 600; ++index) {
      smoothed[index] =
          2 * bins[index] + (index ? bins[index - 1] : 0) + (index + 1 < 600 ? bins[index + 1] : 0);
      score += static_cast<double>(smoothed[index]) * smoothed[index];
    }
    if (score <= best.score)
      continue;
    int lines = 0;
    for (int index = 3; index + 3 < 600; ++index) {
      if (smoothed[index] >= 16 && smoothed[index] > smoothed[index - 1] &&
          smoothed[index] ==
              *std::max_element(smoothed.begin() + index - 3, smoothed.begin() + index + 4))
        ++lines;
    }
    best = {score, lines};
  }
  return best;
}

double LineMembership(const cv::Mat& mask, const std::vector<cv::Point2d>& points, bool vertical) {
  cv::Mat oriented, joined, labels, stats, centers;
  if (vertical)
    cv::transpose(mask, oriented);
  else
    oriented = mask;
  cv::morphologyEx(oriented, joined, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_RECT, {35, 3}));
  const int count = cv::connectedComponentsWithStats(joined, labels, stats, centers, 8);
  std::vector<bool> lines(count);
  for (int index = 1; index < count; ++index) {
    const auto* box = stats.ptr<int>(index);
    lines[index] = box[cv::CC_STAT_WIDTH] >= 60 &&
                   box[cv::CC_STAT_WIDTH] >= 3.5 * box[cv::CC_STAT_HEIGHT] &&
                   box[cv::CC_STAT_HEIGHT] >= 5 && box[cv::CC_STAT_HEIGHT] <= 60;
  }
  int members = 0;
  for (const auto& point : points) {
    const int x = static_cast<int>(vertical ? point.y : point.x);
    const int y = static_cast<int>(vertical ? point.x : point.y);
    members += lines[labels.ptr<int>(y)[x]];
  }
  return static_cast<double>(members) / points.size();
}

struct TextGate {
  bool text = false;
  bool vertical = false;
  double dominance = 0;
  std::array<double, 2> scores{};
  std::array<double, 2> membership{};
  std::vector<cv::Point2d> points;
  cv::Mat mask;
};

TextGate GateText(const cv::Mat& image) {
  cv::Mat gray, dark, binary, labels, stats, centers;
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  cv::morphologyEx(gray, dark, cv::MORPH_BLACKHAT,
                   cv::getStructuringElement(cv::MORPH_RECT, {17, 17}));
  cv::threshold(dark, binary, std::max(6.0, 0.65 * Percentile(dark, 0.90)), 255, cv::THRESH_BINARY);
  const int count = cv::connectedComponentsWithStats(binary, labels, stats, centers, 8);
  std::vector<bool> letters(count);
  std::vector<cv::Point2d> points;
  int area = 0;
  for (int index = 1; index < count; ++index) {
    const auto* box = stats.ptr<int>(index);
    const auto* center = centers.ptr<double>(index);
    if (box[cv::CC_STAT_AREA] < 20 || box[cv::CC_STAT_WIDTH] < 4 || box[cv::CC_STAT_WIDTH] > 64 ||
        box[cv::CC_STAT_HEIGHT] < 4 || box[cv::CC_STAT_HEIGHT] > 64 || center[0] < 16 ||
        center[0] >= image.cols - 16 || center[1] < 16 || center[1] >= image.rows - 16)
      continue;
    letters[index] = true;
    area += box[cv::CC_STAT_AREA];
    points.emplace_back(center[0], center[1]);
  }
  const double coverage = static_cast<double>(area) / image.total();
  if (points.size() < 100 || coverage < 0.004 || coverage > 0.30)
    return {};
  cv::Mat mask(image.size(), CV_8UC1);
  for (int row = 0; row < mask.rows; ++row) {
    const auto* ids = labels.ptr<int>(row);
    auto* pixels = mask.ptr<std::uint8_t>(row);
    for (int col = 0; col < mask.cols; ++col)
      pixels[col] = letters[ids[col]] ? 255 : 0;
  }
  const auto horizontal = Project(points, false);
  const auto vertical = Project(points, true);
  const double horizontal_members = LineMembership(mask, points, false);
  const double vertical_members = LineMembership(mask, points, true);
  const double horizontal_score = horizontal.score * std::max(0.05, horizontal_members);
  const double vertical_score = vertical.score * std::max(0.05, vertical_members);
  const bool axis = vertical_score > horizontal_score;
  const double dominance = std::max(horizontal_score, vertical_score) /
                           std::max(1.0, std::min(horizontal_score, vertical_score));
  return {(axis ? vertical.lines : horizontal.lines) >= 4 && dominance >= 1.18 &&
              (axis ? vertical_members : horizontal_members) >= 0.35,
          axis,
          dominance,
          {horizontal_score, vertical_score},
          {horizontal_members, vertical_members},
          std::move(points),
          std::move(mask)};
}

struct OrientationModel {
  std::mutex mutex;
  bool loaded = false;
  cv::dnn::Net net;
  std::string error;

  Result<void> Load() {
    if (!loaded) {
      loaded = true;
      wchar_t executable[32768]{};
      GetModuleFileNameW(nullptr, executable, 32768);
      const auto path =
          std::filesystem::path(executable).parent_path() / "models" / "doc-orientation.onnx";
      std::ifstream input(path, std::ios::binary);
      if (!input) {
        error = "photo-orientation-model-unavailable";
      } else {
        try {
          const std::vector<unsigned char> bytes(std::istreambuf_iterator<char>(input), {});
          net = cv::dnn::readNetFromONNX(bytes);
          net.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
          net.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
          if (net.empty())
            error = "photo-orientation-model-unavailable";
        } catch (const cv::Exception&) {
          error = "photo-orientation-model-unavailable";
        }
      }
    }
    if (!error.empty())
      return Error{ErrorCode::kUnavailable, error};
    return {};
  }
};

cv::Mat OrientationInput(const cv::Mat& image) {
  cv::Mat rgb, resized, normalized;
  cv::cvtColor(image, rgb, cv::COLOR_BGR2RGB);
  const double scale = 256.0 / std::min(rgb.rows, rgb.cols);
  cv::resize(rgb, resized, {cvRound(rgb.cols * scale), cvRound(rgb.rows * scale)}, 0, 0,
             cv::INTER_LINEAR);
  const cv::Rect crop{(resized.cols - 224) / 2, (resized.rows - 224) / 2, 224, 224};
  resized(crop).convertTo(normalized, CV_32FC3, 1.0 / 255);
  normalized -= cv::Scalar(0.485, 0.456, 0.406);
  cv::divide(normalized, cv::Scalar(0.229, 0.224, 0.225), normalized);
  return cv::dnn::blobFromImage(normalized);
}

}  // namespace

cv::Mat AnalysisLab(const cv::Mat& image) {
  // Small CIE D65 lookup tables avoid a large lazy color-table initialization
  // inside the first scan job. This uses the same 8-bit Lab channel scales.
  static const auto linear = [] {
    std::array<float, 256> values{};
    for (int i = 0; i < 256; ++i) {
      const float value = i / 255.0f;
      values[i] = value <= .04045f ? value / 12.92f : std::pow((value + .055f) / 1.055f, 2.4f);
    }
    return values;
  }();
  static const auto curve = [] {
    std::array<float, 8193> values{};
    for (int i = 0; i <= 8192; ++i) {
      const float value = i / 8192.0f;
      values[i] = value > .008856f ? std::cbrt(value) : 7.787f * value + 16.0f / 116;
    }
    return values;
  }();
  const auto transfer = [](float value) {
    const float position = std::clamp(value * 8192, 0.0f, 8192.0f);
    const int lower = std::min(8191, static_cast<int>(position));
    return curve[lower] + (position - lower) * (curve[lower + 1] - curve[lower]);
  };
  cv::Mat result(image.size(), CV_8UC3);
  for (int row = 0; row < image.rows; ++row) {
    const auto* source = image.ptr<cv::Vec3b>(row);
    auto* output = result.ptr<cv::Vec3b>(row);
    for (int col = 0; col < image.cols; ++col) {
      const float b = linear[source[col][0]];
      const float g = linear[source[col][1]];
      const float r = linear[source[col][2]];
      const float x = transfer((.412453f * r + .357580f * g + .180423f * b) / .950456f);
      const float y = transfer(.212671f * r + .715160f * g + .072169f * b);
      const float z = transfer((.019334f * r + .119193f * g + .950227f * b) / 1.088754f);
      output[col] = {cv::saturate_cast<std::uint8_t>((116 * y - 16) * 2.55f),
                     cv::saturate_cast<std::uint8_t>(500 * (x - y) + 128),
                     cv::saturate_cast<std::uint8_t>(200 * (y - z) + 128)};
    }
  }
  return result;
}

OrientationDecision FuseOrientation(bool vertical, const std::vector<OrientationCrop>& crops) {
  OrientationDecision result;
  result.vertical = vertical;
  result.crops = crops;
  if (crops.empty())
    return result;
  std::array<double, 4> logs{};
  for (const auto& crop : crops)
    for (int i = 0; i < 4; ++i)
      logs[i] += std::log(std::max(1e-7, crop.probabilities[i])) / crops.size();
  const double peak = *std::max_element(logs.begin(), logs.end());
  double total = 0;
  for (int i = 0; i < 4; ++i) {
    result.probabilities[i] = std::exp(logs[i] - peak);
    total += result.probabilities[i];
  }
  for (auto& probability : result.probabilities)
    probability /= total;
  const unsigned first = vertical ? 1 : 0;
  const unsigned second = first + 2;
  const unsigned best =
      result.probabilities[first] >= result.probabilities[second] ? first : second;
  double runner_up = 0;
  for (unsigned i = 0; i < 4; ++i)
    if (i != best)
      runner_up = std::max(runner_up, result.probabilities[i]);
  const double gap = result.probabilities[best] - runner_up;
  result.turns = (4u - best) % 4u;
  result.state = crops.size() >= 3 && result.probabilities[best] >= .78 && gap >= .60 ? "confident"
                                                                                      : "uncertain";
  return result;
}

Result<OrientationDecision> AutomaticQuarterTurns(const cv::Mat& image,
                                                  const PhotoCancelled& cancelled) {
  static OrientationModel model;
  {
    std::lock_guard lock(model.mutex);
    RK_RETURN_IF_ERROR(model.Load());
  }
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  const auto analysis = LimitSide(image, 1024);
  const auto gate = GateText(analysis);
  OrientationDecision result;
  result.vertical = gate.vertical;
  result.dominance = gate.dominance;
  result.scores = gate.scores;
  result.membership = gate.membership;
  if (!gate.text)
    return result;

  // Line clusters nominate blocks; component density ranks them. Suppressing
  // overlapping blocks keeps handwriting in one area from dominating the vote.
  cv::Mat joined, labels, stats, centers;
  cv::morphologyEx(gate.mask, joined, cv::MORPH_CLOSE,
                   cv::Mat::ones(gate.vertical ? 35 : 3, gate.vertical ? 3 : 35, CV_8U));
  const int count = cv::connectedComponentsWithStats(joined, labels, stats, centers);
  const int side = cvRound(.5 * std::min(analysis.cols, analysis.rows));
  struct Candidate {
    cv::Rect bounds;
    int members;
  };
  std::vector<Candidate> candidates;
  for (int i = 1; i < count; ++i) {
    const auto* box = stats.ptr<int>(i);
    if (box[cv::CC_STAT_AREA] < 80)
      continue;
    const auto* center = centers.ptr<double>(i);
    const cv::Rect bounds{std::clamp(cvRound(center[0]) - side / 2, 0, analysis.cols - side),
                          std::clamp(cvRound(center[1]) - side / 2, 0, analysis.rows - side), side,
                          side};
    int members = 0;
    for (auto point : gate.points)
      members += bounds.contains(cv::Point(cvRound(point.x), cvRound(point.y)));
    if (members >= 12)
      candidates.push_back({bounds, members});
  }
  std::vector<OrientationCrop> crops;
  std::lock_guard lock(model.mutex);
  try {
    while (crops.size() < 3) {
      const Candidate* selected = nullptr;
      double best_score = 0;
      for (const auto& candidate : candidates) {
        double overlap = 0;
        for (const auto& crop : crops)
          overlap = std::max(
              overlap, double((crop.bounds & candidate.bounds).area()) / candidate.bounds.area());
        const double score = candidate.members * (1 - overlap) * (1 - overlap);
        if (overlap <= .65 && score > best_score) {
          selected = &candidate;
          best_score = score;
        }
      }
      if (!selected)
        break;
      const auto& candidate = *selected;
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
      model.net.setInput(OrientationInput(analysis(candidate.bounds)));
      const auto output = model.net.forward();
      if (output.total() != 4 || output.type() != CV_32F)
        return Error{ErrorCode::kUnavailable, "photo-orientation-model-unavailable"};
      OrientationCrop crop{candidate.bounds};
      for (int i = 0; i < 4; ++i) {
        crop.probabilities[i] = output.ptr<float>()[i];
        if (!std::isfinite(crop.probabilities[i]) || crop.probabilities[i] < 0)
          return Error{ErrorCode::kUnavailable, "photo-orientation-model-unavailable"};
      }
      crops.push_back(crop);
    }
  } catch (const cv::Exception&) {
    return Error{ErrorCode::kUnavailable, "photo-orientation-model-unavailable"};
  }
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  auto fused = FuseOrientation(gate.vertical, crops);
  if (crops.empty()) {
    fused.turns = gate.vertical ? 1 : 0;
    fused.state = "uncertain";
  }
  fused.dominance = gate.dominance;
  fused.scores = gate.scores;
  fused.membership = gate.membership;
  return fused;
}

Result<Paper> AnalyzePaper(const cv::Mat& image, const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  const auto analysis = LimitSide(image, 768);
  cv::Mat background, lab;
  cv::morphologyEx(analysis, background, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_RECT, {31, 31}));
  cv::GaussianBlur(background, background, {}, 5);
  lab = AnalysisLab(background);
  std::vector<cv::Mat> channels;
  cv::split(lab, channels);
  const int brightness = Percentile(channels[0], 0.40);
  cv::Mat bright = channels[0] > brightness;
  if (!cv::countNonZero(bright))
    bright = channels[0] >= brightness;
  std::array<unsigned, 1024> histogram{};
  for (int row = 0; row < lab.rows; ++row) {
    const auto* pixels = lab.ptr<cv::Vec3b>(row);
    const auto* selected = bright.ptr<std::uint8_t>(row);
    for (int col = 0; col < lab.cols; ++col)
      if (selected[col])
        ++histogram[(pixels[col][1] / 8) * 32 + pixels[col][2] / 8];
  }
  const auto mode = std::max_element(histogram.begin(), histogram.end()) - histogram.begin();
  const int chroma_a = static_cast<int>(mode / 32) * 8 + 4;
  const int chroma_b = static_cast<int>(mode % 32) * 8 + 4;
  std::array<std::vector<float>, 3> paper_channels, paper_lab;
  for (int row = 0; row < lab.rows; ++row) {
    const auto* pixels = lab.ptr<cv::Vec3b>(row);
    const auto* colors = background.ptr<cv::Vec3b>(row);
    const auto* selected = bright.ptr<std::uint8_t>(row);
    for (int col = 0; col < lab.cols; ++col) {
      if (!selected[col] || std::abs(pixels[col][1] - chroma_a) >= 12 ||
          std::abs(pixels[col][2] - chroma_b) >= 12)
        continue;
      for (int channel = 0; channel < 3; ++channel) {
        paper_channels[channel].push_back(colors[col][channel]);
        paper_lab[channel].push_back(pixels[col][channel]);
      }
    }
  }
  Paper paper;
  cv::Vec3f dominant;
  for (int channel = 0; channel < 3; ++channel) {
    paper.color[channel] = Quantile(std::move(paper_channels[channel]), 0.5);
    dominant[channel] = Quantile(std::move(paper_lab[channel]), 0.5);
  }
  cv::Mat mask(lab.size(), CV_8UC1);
  for (int row = 0; row < lab.rows; ++row) {
    const auto* pixels = lab.ptr<cv::Vec3b>(row);
    auto* selected = mask.ptr<std::uint8_t>(row);
    for (int col = 0; col < lab.cols; ++col) {
      const float a = pixels[col][1] - dominant[1];
      const float b = pixels[col][2] - dominant[2];
      selected[col] =
          a * a + b * b < 17 * 17 && pixels[col][0] > std::max(70.0f, dominant[0] - 85) ? 255 : 0;
    }
  }
  cv::morphologyEx(mask, mask, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_RECT, {11, 11}));
  cv::morphologyEx(mask, mask, cv::MORPH_OPEN, cv::getStructuringElement(cv::MORPH_RECT, {5, 5}));
  cv::Mat labels;
  // Smooth neutral shadows remain part of the sheet. A sharp luminance
  // transition blocks growth into a table or binding even when it is neutral.
  cv::Mat light, mean, squared, variance, gradient_x, gradient_y, gradient;
  channels[0].convertTo(light, CV_32F);
  cv::GaussianBlur(light, mean, {}, 3);
  cv::multiply(light, light, squared);
  cv::GaussianBlur(squared, squared, {}, 3);
  variance = squared - mean.mul(mean);
  cv::Sobel(light, gradient_x, CV_32F, 1, 0, 3, 0.125);
  cv::Sobel(light, gradient_y, CV_32F, 0, 1, 3, 0.125);
  cv::magnitude(gradient_x, gradient_y, gradient);
  cv::Mat connected = mask.clone();
  for (int row = 0; row < lab.rows; ++row) {
    const auto* pixels = lab.ptr<cv::Vec3b>(row);
    const auto* texture = variance.ptr<float>(row);
    const auto* slope = gradient.ptr<float>(row);
    auto* selected = connected.ptr<std::uint8_t>(row);
    for (int col = 0; col < lab.cols; ++col) {
      const float a = pixels[col][1] - dominant[1];
      const float b = pixels[col][2] - dominant[2];
      const float neutral_a = pixels[col][1] - 128.0f;
      const float neutral_b = pixels[col][2] - 128.0f;
      if (pixels[col][0] > 55 && a * a + b * b < 17 * 17 &&
          neutral_a * neutral_a + neutral_b * neutral_b < 18 * 18 && texture[col] < 64 &&
          slope[col] < 3)
        selected[col] = 255;
    }
  }
  const int shadow_count = cv::connectedComponents(connected, labels, 8);
  std::vector<bool> attached(shadow_count);
  for (int row = 0; row < mask.rows; ++row) {
    const auto* selected = mask.ptr<std::uint8_t>(row);
    const auto* ids = labels.ptr<int>(row);
    for (int col = 0; col < mask.cols; ++col)
      if (selected[col])
        attached[ids[col]] = true;
  }
  attached[0] = false;
  for (int row = 0; row < mask.rows; ++row) {
    auto* selected = mask.ptr<std::uint8_t>(row);
    const auto* ids = labels.ptr<int>(row);
    for (int col = 0; col < mask.cols; ++col)
      selected[col] = attached[ids[col]] ? 255 : 0;
  }
  mask.convertTo(paper.mask, CV_32F, 1.0 / 255);
  cv::GaussianBlur(paper.mask, paper.mask, {}, 2);
  // Fit illumination only to paper samples. Dilating the ink exclusion also
  // keeps antialiased stroke edges and colored ink out of the light field.
  cv::Mat gray, local, excluded;
  cv::cvtColor(analysis, gray, cv::COLOR_BGR2GRAY);
  cv::GaussianBlur(gray, local, {}, 3);
  excluded = local - gray > 3;
  const auto source_lab = AnalysisLab(analysis);
  for (int row = 0; row < lab.rows; ++row) {
    const auto* colors = source_lab.ptr<cv::Vec3b>(row);
    auto* ink = excluded.ptr<std::uint8_t>(row);
    for (int col = 0; col < lab.cols; ++col)
      if (std::hypot(colors[col][1] - dominant[1], colors[col][2] - dominant[2]) > 12)
        ink[col] = 255;
  }
  cv::dilate(excluded, excluded, cv::getStructuringElement(cv::MORPH_RECT, {3, 3}));
  cv::Mat samples, mass, weighted;
  cv::bitwise_and(mask, ~excluded, samples);
  samples.convertTo(mass, CV_32F, 1.0 / 255);
  analysis.convertTo(weighted, CV_32FC3);
  std::vector<cv::Mat> planes;
  cv::split(weighted, planes);
  cv::boxFilter(mass, mass, -1, {65, 65});
  cv::GaussianBlur(mass, mass, {}, 8);
  for (int channel = 0; channel < 3; ++channel) {
    cv::Mat weights;
    samples.convertTo(weights, CV_32F, 1.0 / 255);
    cv::multiply(planes[channel], weights, planes[channel]);
    cv::boxFilter(planes[channel], planes[channel], -1, {65, 65});
    cv::GaussianBlur(planes[channel], planes[channel], {}, 8);
    for (int row = 0; row < mass.rows; ++row) {
      auto* values = planes[channel].ptr<float>(row);
      const auto* counts = mass.ptr<float>(row);
      for (int col = 0; col < mass.cols; ++col)
        values[col] = counts[col] > .01f ? values[col] / counts[col] : paper.color[channel];
    }
  }
  cv::merge(planes, background);
  cv::max(background, 64, background);
  cv::divide(255.0, background, paper.gain);
  cv::min(paper.gain, 3.2, paper.gain);
  cv::Mat normalized, luminance, low;
  analysis.convertTo(normalized, CV_32FC3);
  cv::multiply(normalized, paper.gain, normalized);
  cv::min(normalized, 255, normalized);
  cv::cvtColor(normalized, luminance, cv::COLOR_BGR2GRAY);
  cv::GaussianBlur(luminance, low, {}, 2);
  std::vector<float> ink;
  for (int row = 0; row < low.rows; ++row) {
    const auto* values = luminance.ptr<float>(row);
    const auto* blurred = low.ptr<float>(row);
    const auto* selected = paper.mask.ptr<float>(row);
    for (int col = 0; col < low.cols; ++col)
      if (selected[col] > 0.95 && blurred[col] - values[col] > 6 && values[col] < 225)
        ink.push_back(values[col]);
  }
  paper.black_point =
      std::clamp(ink.empty() ? 45.0f : Quantile(std::move(ink), 0.05), 25.0f, 145.0f) * 0.9f;
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  return paper;
}

namespace {
cv::Mat PaperNoise(const cv::Mat& gray, const cv::Mat& local, const cv::Mat& mask) {
  cv::Mat median_filtered;
  cv::medianBlur(gray, median_filtered, 3);
  // MAD is measured before normalization, so weak strokes are compared with
  // sensor noise rather than with the varying paper brightness.
  constexpr int tile = 64;
  cv::Mat noise((gray.rows + tile - 1) / tile, (gray.cols + tile - 1) / tile, CV_32F);
  for (int y = 0; y < noise.rows; ++y) {
    for (int x = 0; x < noise.cols; ++x) {
      std::array<unsigned, 511> residuals{};
      std::array<unsigned, 256> fine_residuals{};
      unsigned count = 0;
      for (int row = y * tile; row < std::min((y + 1) * tile, gray.rows); ++row) {
        const auto* values = gray.ptr<std::uint8_t>(row);
        const auto* means = local.ptr<float>(row);
        const auto* filtered = median_filtered.ptr<std::uint8_t>(row);
        const auto* selected = mask.ptr<float>(row);
        for (int col = x * tile; col < std::min((x + 1) * tile, gray.cols); ++col) {
          if (selected[col] < .9f)
            continue;
          ++residuals[std::clamp(cvRound(values[col] - means[col]) + 255, 0, 510)];
          ++fine_residuals[std::abs(values[col] - filtered[col])];
          ++count;
        }
      }
      unsigned sum = 0;
      int median = 0;
      while (median < 510 && sum + residuals[median] < (count + 1) / 2)
        sum += residuals[median++];
      sum = residuals[median];
      int mad = 0;
      while (mad < 510 && sum < (count + 1) / 2) {
        ++mad;
        if (median >= mad)
          sum += residuals[median - mad];
        if (median + mad < 511)
          sum += residuals[median + mad];
      }
      sum = 0;
      int fine_mad = 0;
      while (fine_mad < 255 && sum + fine_residuals[fine_mad] < (count + 1) / 2)
        sum += fine_residuals[fine_mad++];
      // Dense ink can occupy half a tile. Its broad residual must not raise
      // the noise threshold enough to erase a grid or overlapping handwriting.
      noise.at<float>(y, x) = std::max(.8f, std::min(1.4826f * mad, 2 * 1.4826f * fine_mad + 1.5f));
    }
  }
  cv::resize(noise, noise, gray.size(), 0, 0, cv::INTER_LINEAR);
  return noise;
}

cv::Mat ProtectedStrokes(const cv::Mat& gray, const cv::Mat& local, const cv::Mat& noise) {
  cv::Mat envelope;
  cv::morphologyEx(gray, envelope, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_RECT, {21, 21}));
  cv::Mat strokes(gray.size(), CV_8U);
  for (int row = 0; row < gray.rows; ++row) {
    const auto* values = gray.ptr<std::uint8_t>(row);
    const auto* means = local.ptr<float>(row);
    const auto* surface = envelope.ptr<std::uint8_t>(row);
    const auto* sigma = noise.ptr<float>(row);
    auto* selected = strokes.ptr<std::uint8_t>(row);
    for (int col = 0; col < gray.cols; ++col) {
      const float contrast = std::min(means[col], static_cast<float>(surface[col])) - values[col];
      selected[col] = contrast > std::max(3.0f, 2.5f * sigma[col]) ? 255 : 0;
    }
  }
  cv::Mat labels, stats, centers;
  const int count = cv::connectedComponentsWithStats(strokes, labels, stats, centers, 8);
  std::vector<bool> retained(count);
  std::vector<double> signal(count);
  for (int row = 0; row < gray.rows; ++row) {
    const auto* ids = labels.ptr<int>(row);
    const auto* values = gray.ptr<std::uint8_t>(row);
    const auto* means = local.ptr<float>(row);
    const auto* sigma = noise.ptr<float>(row);
    for (int col = 0; col < gray.cols; ++col)
      if (ids[col])
        signal[ids[col]] += (means[col] - values[col]) / sigma[col];
  }
  for (int index = 1; index < count; ++index) {
    const auto* component = stats.ptr<int>(index);
    const int length = std::max(component[cv::CC_STAT_WIDTH], component[cv::CC_STAT_HEIGHT]);
    const int width = std::min(component[cv::CC_STAT_WIDTH], component[cv::CC_STAT_HEIGHT]);
    const double contrast = signal[index] / component[cv::CC_STAT_AREA];
    retained[index] = component[cv::CC_STAT_AREA] >= 12 && length >= 7 &&
                      (contrast >= 4 || (length >= 18 && length > width * 4));
  }
  for (int row = 0; row < gray.rows; ++row) {
    const auto* ids = labels.ptr<int>(row);
    auto* selected = strokes.ptr<std::uint8_t>(row);
    for (int col = 0; col < gray.cols; ++col)
      selected[col] = retained[ids[col]] ? 255 : 0;
  }
  cv::dilate(strokes, strokes, cv::getStructuringElement(cv::MORPH_RECT, {3, 3}));
  cv::GaussianBlur(strokes, strokes, {}, .6);
  return strokes;
}
}  // namespace

Result<void> EnhanceScan(cv::Mat& image, const Paper& paper, const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  cv::Mat gain, mask, gray, local;
  cv::resize(paper.gain, gain, image.size(), 0, 0, cv::INTER_LINEAR);
  cv::resize(paper.mask, mask, image.size(), 0, 0, cv::INTER_LINEAR);
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  cv::boxFilter(gray, local, CV_32F, {9, 9});
  const auto noise = PaperNoise(gray, local, mask);
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  const auto protection = ProtectedStrokes(gray, local, noise);
  const float black = std::min(160.0f, paper.black_point + 14);
  std::array<float, 256> ink_tone{};
  for (int value = 0; value < 256; ++value)
    ink_tone[value] = 255 * std::pow(std::max(0.0f, (value - black) / (255 - black)), 1.12f);

  for (int row = 0; row < image.rows; ++row) {
    if (row % 32 == 0)
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    auto* pixels = image.ptr<cv::Vec3b>(row);
    const auto* gains = gain.ptr<cv::Vec3f>(row);
    const auto* weights = mask.ptr<float>(row);
    const auto* sigma = noise.ptr<float>(row);
    const auto* protected_ink = protection.ptr<std::uint8_t>(row);
    for (int col = 0; col < image.cols; ++col) {
      const float weight = weights[col];
      if (weight == 0)
        continue;
      cv::Vec3f pixel;
      for (int channel = 0; channel < 3; ++channel)
        pixel[channel] = std::min(255.0f, pixels[col][channel] * gains[col][channel]);
      const float luminance = pixel[0] * .114f + pixel[1] * .587f + pixel[2] * .299f;
      const float chroma =
          std::max({pixel[0], pixel[1], pixel[2]}) - std::min({pixel[0], pixel[1], pixel[2]});
      const float deficit = 255 - luminance;
      const float threshold = std::max(14.0f, 4 * sigma[col] * gains[col][1]);
      const float u = std::clamp((deficit - threshold * .5f) / (threshold * 1.5f), 0.0f, 1.0f);
      const float color_ink = std::clamp((chroma - 8) / 12, 0.0f, 1.0f);
      const float ink_weight = std::max(color_ink, protected_ink[col] / 255.0f);
      const float ink_multiplier =
          ink_tone[std::clamp(static_cast<int>(luminance), 0, 255)] / std::max(luminance, 1.0f);
      const float multiplier = 1 + (ink_multiplier - 1) * (1 - .7f * color_ink);
      for (int channel = 0; channel < 3; ++channel) {
        const float clean = 255 - std::min(255 - pixel[channel], 3.0f) * u * u * (3 - 2 * u);
        const float target = pixel[channel] * multiplier;
        // Feathered stroke support preserves continuous ink tones; unsupported
        // neutral texture stays within three levels of white.
        pixel[channel] = clean + (target - clean) * ink_weight;
      }
      for (int channel = 0; channel < 3; ++channel)
        pixels[col][channel] = cv::saturate_cast<std::uint8_t>(
            pixels[col][channel] + (pixel[channel] - pixels[col][channel]) * weight);
    }
  }
  return {};
}
}  // namespace remotekit::photo
