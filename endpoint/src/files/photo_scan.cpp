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
          axis};
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

Result<std::optional<unsigned>> AutomaticQuarterTurns(const cv::Mat& image,
                                                      const PhotoCancelled& cancelled) {
  static OrientationModel model;
  {
    std::lock_guard lock(model.mutex);
    RK_RETURN_IF_ERROR(model.Load());
  }
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  const auto analysis = LimitSide(image, 1024);
  const auto gate = GateText(analysis);
  if (!gate.text)
    return std::optional<unsigned>{};
  const auto input = OrientationInput(analysis);
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  std::lock_guard lock(model.mutex);
  try {
    model.net.setInput(input);
    const auto output = model.net.forward();
    if (output.total() != 4 || output.type() != CV_32F)
      return Error{ErrorCode::kUnavailable, "photo-orientation-model-unavailable"};
    const auto* probabilities = output.ptr<float>();
    const auto best = std::max_element(probabilities, probabilities + 4);
    const unsigned orientation = static_cast<unsigned>(best - probabilities);
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    if (!std::isfinite(*best) || *best < 0.78f || (orientation % 2 != 0) != gate.vertical)
      return std::optional<unsigned>{};
    return std::optional<unsigned>{(4u - orientation) % 4u};
  } catch (const cv::Exception&) {
    return Error{ErrorCode::kUnavailable, "photo-orientation-model-unavailable"};
  }
}

Result<Paper> AnalyzePaper(const cv::Mat& image, const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  const auto analysis = LimitSide(image, 768);
  cv::Mat background, lab;
  cv::morphologyEx(analysis, background, cv::MORPH_CLOSE,
                   cv::getStructuringElement(cv::MORPH_ELLIPSE, {31, 31}));
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
  cv::Mat labels, stats, centers;
  const int count = cv::connectedComponentsWithStats(mask, labels, stats, centers, 8);
  int largest = 0;
  for (int index = 1; index < count; ++index)
    if (!largest ||
        stats.ptr<int>(index)[cv::CC_STAT_AREA] > stats.ptr<int>(largest)[cv::CC_STAT_AREA])
      largest = index;
  if (largest)
    mask = labels == largest;
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
  background.convertTo(background, CV_32FC3);
  cv::max(background, 64, background);
  cv::divide(248.0, background, paper.gain);
  cv::min(paper.gain, 2.2, paper.gain);
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

Result<void> EnhanceScan(cv::Mat& image, const Paper& paper, const PhotoCancelled& cancelled) {
  cv::Mat gain, mask;
  cv::resize(paper.gain, gain, image.size(), 0, 0, cv::INTER_LINEAR);
  cv::resize(paper.mask, mask, image.size(), 0, 0, cv::INTER_LINEAR);
  std::array<float, 256> tone{};
  for (int value = 0; value < 256; ++value) {
    float target =
        255 *
        std::pow(std::max(0.0f, (value - paper.black_point) / (255 - paper.black_point)), 1.12f);
    const float u = std::clamp((target - 237) / 16, 0.0f, 1.0f);
    tone[value] = target + (255 - target) * u * u * (3 - 2 * u) * 0.88f;
  }
  cv::Mat toned(image.size(), CV_32FC3);
  for (int row = 0; row < image.rows; ++row) {
    if (row % 32 == 0)
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    const auto* source = image.ptr<cv::Vec3b>(row);
    const auto* gains = gain.ptr<cv::Vec3f>(row);
    const auto* weights = mask.ptr<float>(row);
    auto* output = toned.ptr<cv::Vec3f>(row);
    for (int col = 0; col < image.cols; ++col) {
      const float weight = weights[col];
      cv::Vec3f pixel;
      for (int channel = 0; channel < 3; ++channel)
        pixel[channel] =
            std::min(255.0f, source[col][channel] * (1 + (gains[col][channel] - 1) * weight));
      const float luminance = pixel[0] * 0.114f + pixel[1] * 0.587f + pixel[2] * 0.299f;
      const float multiplier =
          tone[std::clamp(static_cast<int>(luminance), 0, 255)] / std::max(luminance, 1.0f);
      for (int channel = 0; channel < 3; ++channel)
        output[col][channel] = std::clamp(
            pixel[channel] + (pixel[channel] * multiplier - pixel[channel]) * weight, 0.0f, 255.0f);
    }
  }
  cv::Mat luminance, blurred;
  cv::cvtColor(toned, luminance, cv::COLOR_BGR2GRAY);
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  cv::GaussianBlur(luminance, blurred, {}, 0.65 * std::max(image.cols, image.rows) / 2480.0);
  for (int row = 0; row < image.rows; ++row) {
    if (row % 32 == 0)
      RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    auto* output = image.ptr<cv::Vec3b>(row);
    const auto* pixels = toned.ptr<cv::Vec3f>(row);
    const auto* values = luminance.ptr<float>(row);
    const auto* smooth = blurred.ptr<float>(row);
    const auto* weights = mask.ptr<float>(row);
    for (int col = 0; col < image.cols; ++col) {
      if (weights[col] == 0)
        continue;
      const float scale =
          (values[col] + 0.32f * (values[col] - smooth[col])) / std::max(values[col], 1.0f);
      for (int channel = 0; channel < 3; ++channel) {
        const float sharpened = std::clamp(pixels[col][channel] * scale, 0.0f, 255.0f);
        output[col][channel] = cv::saturate_cast<std::uint8_t>(
            pixels[col][channel] + (sharpened - pixels[col][channel]) * weights[col]);
      }
    }
  }
  return {};
}
}  // namespace remotekit::photo
