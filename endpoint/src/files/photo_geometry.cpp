#include "files/photo_geometry.hpp"
#include "files/photo_scan.hpp"

#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <numeric>
#include <random>
#include <tuple>

#include "util/result_macros.hpp"

namespace remotekit::photo {
namespace {
using Points = std::vector<cv::Point2d>;
constexpr double kDegrees = 180 / CV_PI;

Result<void> CheckCancelled(const PhotoCancelled& cancelled) {
  if (cancelled && cancelled())
    return Error{ErrorCode::kCanceled, "Photo processing canceled"};
  return {};
}

double Quantile(std::vector<double> values, double fraction = .5) {
  if (values.empty())
    return 0;
  const double position = (values.size() - 1) * fraction;
  const auto lower = static_cast<size_t>(position);
  std::nth_element(values.begin(), values.begin() + lower, values.end());
  const double first = values[lower];
  return lower + 1 == values.size()
             ? first
             : first + (position - lower) *
                           (*std::min_element(values.begin() + lower + 1, values.end()) - first);
}

cv::Vec3d Homogeneous(cv::Point2d p) {
  return {p.x, p.y, 1};
}
cv::Point2d Transform(cv::Point2d p, const cv::Matx33d& matrix) {
  const auto value = matrix * Homogeneous(p);
  return {value[0] / value[2], value[1] / value[2]};
}
Points Transform(const Points& points, const cv::Matx33d& matrix) {
  Points result;
  for (auto p : points)
    result.push_back(Transform(p, matrix));
  return result;
}
cv::Point2d Mean(const Points& points) {
  return std::accumulate(points.begin(), points.end(), cv::Point2d{}) / double(points.size());
}
double Range(const Points& points, int axis) {
  double low = 1e30, high = -1e30;
  for (auto p : points) {
    const double v = axis ? p.y : p.x;
    low = std::min(low, v);
    high = std::max(high, v);
  }
  return high - low;
}
double Coordinate(cv::Point2d p, int axis) {
  return axis ? p.y : p.x;
}
double PointQuantile(const Points& points, int axis, double fraction = .5) {
  std::vector<double> values;
  for (auto p : points)
    values.push_back(Coordinate(p, axis));
  return Quantile(std::move(values), fraction);
}
cv::Vec3d Line(const Points& points) {
  if (points.size() == 2) {
    auto line = Homogeneous(points[0]).cross(Homogeneous(points[1]));
    return line / std::max(std::hypot(line[0], line[1]), 1e-12);
  }
  std::vector<cv::Point2f> converted(points.begin(), points.end());
  cv::Vec4f fitted;
  cv::fitLine(converted, fitted, cv::DIST_HUBER, 0, .01, .01);
  return {fitted[1], -fitted[0], fitted[0] * fitted[3] - fitted[1] * fitted[2]};
}
double Angle(const Points& points) {
  const auto line = Line(points);
  return std::atan(-line[0] / line[1]) * kDegrees;
}

enum class Kind { kText, kRule, kDotted, kStroke, kBoundary, kBinding, kMargin, kOcclusion };
struct Span {
  Points points;
  Kind kind = Kind::kText;
  double height = 1;
  double weight = 1;
  cv::Vec3d line;
  double angle = 0;
  double glyph_height = 0;
  int glyph_count = 0;
  Points printed_points;
  Span(Points samples,
       Kind type,
       double text_height,
       double evidence_weight,
       std::optional<cv::Vec3d> fitted = {})
      : points(std::move(samples)),
        kind(type),
        height(text_height),
        weight(evidence_weight),
        line(fitted ? *fitted : Line(points)),
        angle(std::atan(-line[0] / line[1]) * kDegrees) {}
  double Width() const { return Range(points, 0); }
};
struct Segment {
  Points points;
  Kind kind = Kind::kStroke;
  double weight = 1;
  double contrast = 0;
  double support = 0;
  double Length() const { return cv::norm(points.back() - points.front()); }
};
struct Evidence {
  std::vector<Span> spans;
  cv::Mat ink, clean, protected_ink;
  std::vector<cv::Rect> boxes;
};
struct Region {
  std::vector<int> members;
  std::optional<cv::Vec3d> left, right;
  double score = 0;
  std::vector<cv::Vec3d> boundaries;
};

Points ColumnCentres(const cv::Mat& mask,
                     cv::Rect box,
                     int step = 8,
                     bool baseline = false,
                     const cv::Mat& labels = {},
                     int label = 0) {
  Points points;
  for (int start = box.x; start < box.x + box.width; start += step) {
    double sum_x = 0, sum_y = 0;
    std::vector<double> ordinates;
    for (int y = box.y; y < box.y + box.height; ++y) {
      const auto* row = mask.ptr<uint8_t>(y);
      const auto* ids = labels.empty() ? nullptr : labels.ptr<int>(y);
      for (int x = start; x < std::min(start + step, box.x + box.width); ++x) {
        if (!row[x] || (ids && ids[x] != label))
          continue;
        sum_x += x;
        sum_y += y;
        ordinates.push_back(y);
      }
    }
    if (ordinates.size() >= 3)
      points.emplace_back(sum_x / ordinates.size(),
                          baseline ? Quantile(ordinates, .8) : sum_y / ordinates.size());
  }
  return points;
}

std::vector<double> Polynomial(const Points& points, int degree) {
  cv::Mat design(static_cast<int>(points.size()), degree + 1, CV_64F), rhs(design.rows, 1, CV_64F),
      solution;
  for (int i = 0; i < design.rows; ++i) {
    auto* row = design.ptr<double>(i);
    row[0] = 1;
    for (int d = 1; d <= degree; ++d)
      row[d] = row[d - 1] * points[i].x;
    rhs.ptr<double>(i)[0] = points[i].y;
  }
  cv::solve(design, rhs, solution, cv::DECOMP_SVD);
  return {solution.ptr<double>(), solution.ptr<double>() + degree + 1};
}
double Evaluate(const std::vector<double>& coefficients, double x) {
  double value = 0;
  for (auto i = coefficients.rbegin(); i != coefficients.rend(); ++i)
    value = value * x + *i;
  return value;
}

void FindPrintedBaselines(Evidence& evidence, cv::Size size) {
  double font_height = 0;
  int best_population = 0;
  for (const auto& candidate : evidence.spans) {
    if (candidate.kind != Kind::kText || candidate.weight < .5 || candidate.glyph_height < 3)
      continue;
    int population = 0;
    for (const auto& span : evidence.spans)
      if (span.weight >= .5 && span.glyph_height >= .8 * candidate.glyph_height &&
          span.glyph_height <= 1.25 * candidate.glyph_height)
        population += span.glyph_count;
    if (population > best_population) {
      best_population = population;
      font_height = candidate.glyph_height;
    }
  }
  if (font_height == 0)
    return;
  for (auto& span : evidence.spans) {
    if (span.kind != Kind::kText || span.weight < .5 || span.glyph_height < .65 * font_height ||
        span.glyph_height > 1.4 * font_height)
      continue;
    Points glyphs;
    for (const auto& box : evidence.boxes) {
      const cv::Point2d center(box.x + box.width * .5, box.y + box.height * .5);
      if (box.height >= .65 * font_height && box.height <= 1.4 * font_height &&
          box.width >= .2 * box.height && box.width <= 1.7 * box.height &&
          center.x >= span.points.front().x - 4 && center.x <= span.points.back().x + 4 &&
          std::abs(span.line.dot(Homogeneous(center))) < span.height * .7)
        glyphs.emplace_back(center.x, box.y + box.height);
    }
    if (glyphs.size() < 6)
      continue;
    Points best;
    for (size_t i = 0; i < glyphs.size(); ++i) {
      for (size_t j = i + 1; j < glyphs.size(); ++j) {
        const auto delta = glyphs[j] - glyphs[i];
        if (std::abs(delta.x) < .06 * size.width || std::abs(delta.y) > .4 * std::abs(delta.x))
          continue;
        const auto line = Line({glyphs[i], glyphs[j]});
        Points selected;
        for (auto point : glyphs)
          if (std::abs(line.dot(Homogeneous(point))) <= std::max(1.5, .18 * font_height))
            selected.push_back(point);
        if (selected.size() > best.size())
          best = std::move(selected);
      }
    }
    if (best.size() >= 6 && best.size() >= .55 * glyphs.size() &&
        Range(best, 0) >= std::max(60.0, .1 * size.width)) {
      std::sort(best.begin(), best.end(), [](auto a, auto b) { return a.x < b.x; });
      span.printed_points = std::move(best);
    }
  }
}

Evidence ExtractEvidence(const cv::Mat& image) {
  Evidence evidence;
  cv::Mat gray, hsv, low, labels, stats, centres;
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  cv::cvtColor(image, hsv, cv::COLOR_BGR2HSV);
  cv::adaptiveThreshold(gray, evidence.ink, 255, cv::ADAPTIVE_THRESH_GAUSSIAN_C,
                        cv::THRESH_BINARY_INV, 31, 9);
  evidence.protected_ink = evidence.ink.clone();
  cv::GaussianBlur(gray, low, {}, 7);
  for (int y = 0; y < image.rows; ++y) {
    auto* ink = evidence.ink.ptr<uint8_t>(y);
    const auto* smooth = low.ptr<uint8_t>(y);
    const auto* color = hsv.ptr<cv::Vec3b>(y);
    for (int x = 0; x < image.cols; ++x)
      if (x < 3 || y < 3 || x >= image.cols - 3 || y >= image.rows - 3 || smooth[x] < 55 ||
          color[x][1] > 110)
        ink[x] = 0;
  }
  const int count = cv::connectedComponentsWithStats(evidence.ink, labels, stats, centres);
  std::vector<uint8_t> keep(count);
  std::vector<Span> rules;
  for (int i = 1; i < count; ++i) {
    const auto* s = stats.ptr<int>(i);
    const cv::Rect box(s[0], s[1], s[2], s[3]);
    if (box.width > .28 * image.cols && box.height < .15 * image.rows &&
        double(s[4]) / box.width < 3.5) {
      auto points = ColumnCentres(evidence.ink, box, 12, false, labels, i);
      if (points.size() >= 15)
        rules.push_back(
            {std::move(points), Kind::kRule, std::max(1.0, double(s[4]) / box.width), 2});
    }
    if (box.height >= 3 && box.height <= .07 * image.rows && box.width < .13 * image.cols &&
        s[4] >= 4) {
      keep[i] = 255;
      evidence.boxes.push_back(box);
    }
  }
  evidence.clean.create(image.size(), CV_8U);
  for (int y = 0; y < image.rows; ++y) {
    const auto* ids = labels.ptr<int>(y);
    auto* row = evidence.clean.ptr<uint8_t>(y);
    for (int x = 0; x < image.cols; ++x)
      row[x] = keep[ids[x]];
  }
  cv::Mat words;
  cv::dilate(evidence.clean, words, cv::Mat::ones(1, 7, CV_8U));
  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(words, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
  struct Fragment {
    Points points;
    cv::Rect box;
    double angle;
  };
  std::vector<Fragment> fragments;
  for (const auto& contour : contours) {
    const auto box = cv::boundingRect(contour);
    if (box.width < 12 || box.height < 4 || box.height > 45 || double(box.width) / box.height < 1.6)
      continue;
    auto points = ColumnCentres(evidence.clean, box, 8, true);
    if (points.size() < 2)
      continue;
    const double angle = Angle(points);
    if (std::abs(angle) <= 25)
      fragments.push_back({std::move(points), box, angle});
  }
  struct Link {
    double score;
    int first, second;
  };
  std::vector<Link> links;
  for (int i = 0; i < static_cast<int>(fragments.size()); ++i) {
    const auto& first = fragments[i];
    for (int j = 0; j < static_cast<int>(fragments.size()); ++j) {
      const auto& second = fragments[j];
      const auto delta = second.points.front() - first.points.back();
      if (i == j || delta.x < -2 || delta.x > 55)
        continue;
      const double angle = std::atan2(delta.y, std::max(12.0, delta.x)) * kDegrees;
      if (std::abs(angle) > 16 || (first.box.width > 65 && std::abs(angle - first.angle) > 9) ||
          (second.box.width > 65 && std::abs(angle - second.angle) > 9))
        continue;
      links.push_back({delta.x + 4 * std::abs(angle - first.angle), i, j});
    }
  }
  std::sort(links.begin(), links.end(), [](auto a, auto b) {
    return std::tie(a.score, a.first, a.second) < std::tie(b.score, b.first, b.second);
  });
  std::vector<int> successors(fragments.size(), -1), predecessors(fragments.size(), -1);
  for (auto link : links)
    if (successors[link.first] < 0 && predecessors[link.second] < 0) {
      successors[link.first] = link.second;
      predecessors[link.second] = link.first;
    }
  for (int i = 0; i < static_cast<int>(fragments.size()); ++i) {
    if (predecessors[i] >= 0)
      continue;
    Points points;
    std::vector<double> heights;
    std::vector<int> visited;
    for (int j = i; j >= 0 && std::find(visited.begin(), visited.end(), j) == visited.end();
         j = successors[j]) {
      visited.push_back(j);
      points.insert(points.end(), fragments[j].points.begin(), fragments[j].points.end());
      heights.push_back(fragments[j].box.height);
    }
    std::sort(points.begin(), points.end(), [](auto a, auto b) { return a.x < b.x; });
    if (points.size() < 6 || Range(points, 0) < std::max(65.0, .07 * image.cols))
      continue;
    const double height = Quantile(heights);
    const auto line = Line(points);
    std::vector<double> residual;
    for (auto p : points)
      residual.push_back(std::abs(line.dot(Homogeneous(p))));
    if (Quantile(residual) > std::max(1.6, .16 * height)) {
      const double mean = Mean(points).x, width = Range(points, 0);
      Points normalized;
      for (auto p : points)
        normalized.emplace_back((p.x - mean) / width, p.y);
      const auto polynomial = Polynomial(normalized, 3);
      residual.clear();
      for (auto p : normalized)
        residual.push_back(std::abs(p.y - Evaluate(polynomial, p.x)));
      if (width < .2 * image.cols || Quantile(residual) > std::max(1.5, .12 * height))
        continue;
    }
    int glyphs = 0;
    std::vector<double> glyph_heights;
    for (const auto& box : evidence.boxes) {
      const cv::Point2d centre(box.x + box.width * .5, box.y + box.height * .5);
      const double aspect = double(box.width) / box.height;
      if (centre.x >= points.front().x - 4 && centre.x <= points.back().x + 4 &&
          std::abs(line.dot(Homogeneous(centre))) < height * .7 && aspect > .15 && aspect < 1.7 &&
          box.height > height * .25) {
        ++glyphs;
        glyph_heights.push_back(box.height);
      }
    }
    const double weight = glyphs >= std::max(5.0, Range(points, 0) / 32) ? 1 : .2;
    evidence.spans.push_back({std::move(points), Kind::kText, height, weight, line});
    evidence.spans.back().glyph_height = Quantile(glyph_heights);
    evidence.spans.back().glyph_count = glyphs;
  }
  cv::Mat faint, blurred;
  cv::adaptiveThreshold(gray, faint, 255, cv::ADAPTIVE_THRESH_GAUSSIAN_C, cv::THRESH_BINARY_INV, 31,
                        4);
  cv::GaussianBlur(gray, blurred, {}, 3);
  for (int y = 0; y < image.rows; ++y) {
    auto* row = faint.ptr<uint8_t>(y);
    const auto* a = blurred.ptr<uint8_t>(y);
    const auto* b = gray.ptr<uint8_t>(y);
    for (int x = 0; x < image.cols; ++x)
      if (int(a[x]) - b[x] < 12)
        row[x] = 0;
  }
  const int dots_count = cv::connectedComponentsWithStats(faint, labels, stats, centres);
  keep.assign(dots_count, 0);
  for (int i = 1; i < dots_count; ++i) {
    const auto* s = stats.ptr<int>(i);
    if (s[2] <= 5 && s[3] <= 3 && s[4] <= 10)
      keep[i] = 255;
  }
  cv::Mat dots(image.size(), CV_8U);
  for (int y = 0; y < image.rows; ++y) {
    auto* row = dots.ptr<uint8_t>(y);
    const auto* ids = labels.ptr<int>(y);
    for (int x = 0; x < image.cols; ++x)
      row[x] = keep[ids[x]];
  }
  cv::dilate(dots, words, cv::Mat::ones(3, 3, CV_8U));
  cv::morphologyEx(words, words, cv::MORPH_CLOSE, cv::Mat::ones(1, 21, CV_8U));
  cv::morphologyEx(words, words, cv::MORPH_OPEN, cv::Mat::ones(1, 75, CV_8U));
  cv::findContours(words, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
  for (const auto& contour : contours) {
    const auto box = cv::boundingRect(contour);
    if (box.width < .18 * image.cols || box.height > .035 * image.rows)
      continue;
    auto points = ColumnCentres(dots, box, 14);
    if (points.size() < 10 || points.size() * 14 < .7 * box.width)
      continue;
    if (std::any_of(rules.begin(), rules.end(), [&](const auto& rule) {
          return std::abs(rule.line.dot(Homogeneous(Mean(points)))) < 5;
        }))
      continue;
    rules.push_back({std::move(points), Kind::kDotted, 1, 1.5});
  }
  evidence.spans.insert(evidence.spans.end(), rules.begin(), rules.end());
  FindPrintedBaselines(evidence, image.size());
  return evidence;
}

cv::Vec3d SampleColor(const cv::Mat& image, cv::Point2d point) {
  const double x = std::clamp(point.x, 0.0, double(image.cols - 1));
  const double y = std::clamp(point.y, 0.0, double(image.rows - 1));
  const int left = static_cast<int>(x), top = static_cast<int>(y);
  const int right = std::min(left + 1, image.cols - 1), bottom = std::min(top + 1, image.rows - 1);
  const double fx = x - left, fy = y - top;
  return cv::Vec3d(image.ptr<cv::Vec3b>(top)[left]) * ((1 - fx) * (1 - fy)) +
         cv::Vec3d(image.ptr<cv::Vec3b>(top)[right]) * (fx * (1 - fy)) +
         cv::Vec3d(image.ptr<cv::Vec3b>(bottom)[left]) * ((1 - fx) * fy) +
         cv::Vec3d(image.ptr<cv::Vec3b>(bottom)[right]) * (fx * fy);
}
uint8_t SampleInk(const cv::Mat& ink, cv::Point2d p) {
  if (p.x < 0 || p.x >= ink.cols || p.y < 0 || p.y >= ink.rows)
    return 0;
  return ink.ptr<uint8_t>(
      std::clamp(cvRound(p.y), 0, ink.rows - 1))[std::clamp(cvRound(p.x), 0, ink.cols - 1)];
}
std::pair<double, double> BoundaryContrast(const cv::Mat& lab, const Segment& segment) {
  const auto direction = segment.points.back() - segment.points.front();
  const cv::Point2d normal = cv::Point2d(-direction.y, direction.x) / cv::norm(direction);
  std::vector<cv::Vec3d> deltas;
  std::vector<double> strengths;
  std::array<std::vector<double>, 3> channels;
  for (int i = 0; i < 40; ++i) {
    const auto p = segment.points.front() + direction * (.05 + .9 * i / 39);
    bool valid = true;
    for (int offset : {-10, 10}) {
      const auto test = p + normal * offset;
      valid &= test.x >= 2 && test.x < lab.cols - 2 && test.y >= 2 && test.y < lab.rows - 2;
    }
    if (!valid)
      continue;
    const auto delta = SampleColor(lab, p + normal * 7) - SampleColor(lab, p - normal * 7);
    deltas.push_back(delta);
    strengths.push_back(cv::norm(delta));
    for (int c = 0; c < 3; ++c)
      channels[c].push_back(delta[c]);
  }
  if (deltas.size() < 12)
    return {};
  const cv::Vec3d median(Quantile(channels[0]), Quantile(channels[1]), Quantile(channels[2]));
  int support = 0;
  for (size_t i = 0; i < deltas.size(); ++i)
    support += strengths[i] >= 7 && deltas[i].dot(median) > 0;
  return {Quantile(strengths), double(support) / deltas.size()};
}

std::pair<double, double> TrackSupport(const Segment& segment, const cv::Mat& ink) {
  const auto line = Line(segment.points);
  if (std::abs(line[0]) < .1)
    return {0, double(ink.rows)};
  std::array<int, 10> occupied{}, lengths{};
  int last = -1, gap = 0;
  for (int y = 0; y < ink.rows; ++y) {
    const int block = std::min(9, y * 10 / ink.rows);
    ++lengths[block];
    const double x = (-line[2] - line[1] * y) / line[0];
    bool found = false;
    for (double offset : {-1.5, 0.0, 1.5})
      found |= SampleInk(ink, {x + offset, double(y)}) > 0;
    if (found) {
      ++occupied[block];
      if (last >= 0)
        gap = std::max(gap, y - last);
      last = y;
    }
  }
  int blocks = 0;
  for (int i = 0; i < 10; ++i)
    blocks += occupied[i] > .13 * lengths[i];
  return {blocks / 10.0, last < 0 ? double(ink.rows) : double(gap)};
}

std::vector<Segment> ExtractSegments(const cv::Mat& image,
                                     const cv::Mat& ink,
                                     cv::Mat& background) {
  cv::Mat gray, lab;
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  cv::morphologyEx(image, background, cv::MORPH_CLOSE, cv::Mat::ones(9, 9, CV_8U));
  cv::GaussianBlur(background, background, {}, 1.5);
  lab = AnalysisLab(background);
  std::vector<cv::Vec4f> raw;
  cv::createLineSegmentDetector(cv::LSD_REFINE_STD, .7)->detect(gray, raw);
  cv::Mat smooth_gray, edges;
  cv::cvtColor(background, smooth_gray, cv::COLOR_BGR2GRAY);
  cv::Canny(smooth_gray, edges, 8, 20);
  std::vector<cv::Vec4i> transitions;
  cv::HoughLinesP(edges, transitions, 1, CV_PI / 720, 40, .15 * std::min(image.cols, image.rows),
                  25);
  for (const auto& transition : transitions)
    raw.emplace_back(transition[0], transition[1], transition[2], transition[3]);
  std::vector<Segment> segments;
  for (const auto& r : raw) {
    Segment segment{{{r[0], r[1]}, {r[2], r[3]}}};
    if (segment.Length() < 40)
      continue;
    const auto [contrast, support] = BoundaryContrast(lab, segment);
    segment.contrast = contrast;
    segment.support = support;
    if (contrast >= 7 && support >= .65)
      segment.kind = Kind::kBoundary;
    segments.push_back(segment);
  }
  const size_t observations = segments.size();
  for (size_t i = 0; i < observations; ++i) {
    const auto& seed = segments[i];
    const auto direction = seed.points.back() - seed.points.front();
    if (seed.kind != Kind::kBoundary || std::abs(direction.y) < 1.3 * std::abs(direction.x))
      continue;
    const auto line = Line(seed.points);
    Points observations_on_edge;
    double observed_length = 0;
    std::vector<double> contrasts;
    for (size_t j = 0; j < observations; ++j) {
      const auto& other = segments[j];
      if (other.kind != Kind::kBoundary)
        continue;
      const auto other_line = Line(other.points);
      if (std::abs(line.dot(Homogeneous(Mean(other.points)))) < 10 &&
          std::abs(line[0] * other_line[0] + line[1] * other_line[1]) > .995) {
        observations_on_edge.insert(observations_on_edge.end(), other.points.begin(),
                                    other.points.end());
        observed_length += other.Length();
        contrasts.push_back(other.contrast);
      }
    }
    if (observations_on_edge.size() < 4 || observed_length < .4 * image.rows ||
        Range(observations_on_edge, 1) < .55 * image.rows)
      continue;
    const auto fitted = Line(observations_on_edge);
    const double low = PointQuantile(observations_on_edge, 1, 0);
    const double high = PointQuantile(observations_on_edge, 1, 1);
    if (std::any_of(segments.begin() + observations, segments.end(), [&](const auto& item) {
          return std::abs(Line(item.points).dot(Homogeneous(Mean(observations_on_edge)))) < 6;
        }))
      continue;
    segments.push_back({{{(-fitted[2] - fitted[1] * low) / fitted[0], low},
                         {(-fitted[2] - fitted[1] * high) / fitted[0], high}},
                        Kind::kBoundary,
                        1,
                        Quantile(contrasts),
                        1});
  }
  const size_t seeds = segments.size();
  for (size_t i = 0; i < seeds; ++i) {
    const auto delta = segments[i].points.back() - segments[i].points.front();
    if (std::abs(delta.x) > .25 * std::abs(delta.y) || segments[i].Length() > .5 * image.rows)
      continue;
    const auto line = Line(segments[i].points);
    Points nearby;
    std::vector<double> row_counts;
    for (int y = 0; y < ink.rows; ++y) {
      const auto* row = ink.ptr<uint8_t>(y);
      const int x_centre = cvRound((-line[2] - line[1] * y) / line[0]);
      int count = 0;
      for (int x = std::max(0, x_centre - 3); x <= std::min(ink.cols - 1, x_centre + 3); ++x)
        if (row[x] && std::abs(line.dot(cv::Vec3d(x, y, 1))) < 2.2) {
          nearby.emplace_back(x, y);
          ++count;
        }
      if (count)
        row_counts.push_back(count);
    }
    if (nearby.size() < 50 || row_counts.size() < .18 * image.rows || Quantile(row_counts) > 3)
      continue;
    const double low = PointQuantile(nearby, 1, .02), high = PointQuantile(nearby, 1, .98);
    if (high - low < .55 * image.rows)
      continue;
    const auto fitted = Line(nearby);
    Segment candidate{{{(-fitted[2] - fitted[1] * low) / fitted[0], low},
                       {(-fitted[2] - fitted[1] * high) / fitted[0], high}},
                      Kind::kBinding,
                      .6};
    const auto middle = Homogeneous(Mean(candidate.points));
    if (std::any_of(segments.begin(), segments.end(), [&](const auto& item) {
          const auto other = Line(item.points);
          return item.Length() > .4 * image.rows && std::abs(other.dot(middle)) < 5 &&
                 std::abs(other[0] * fitted[0] + other[1] * fitted[1]) > .999;
        }))
      continue;
    segments.push_back(std::move(candidate));
  }
  return segments;
}

Points RegionPoints(const Region& region, const std::vector<Span>& spans, bool reliable = false) {
  Points points;
  for (int i : region.members)
    if (!reliable || spans[i].weight >= .5)
      points.insert(points.end(), spans[i].points.begin(), spans[i].points.end());
  if (reliable && points.empty())
    return RegionPoints(region, spans);
  return points;
}
double RegionScore(const Region& region, const std::vector<Span>& spans) {
  double score = 0;
  for (int i : region.members) {
    const auto& span = spans[i];
    if (span.kind == Kind::kText)
      score += span.Width() * span.height * span.weight;
    else if (span.kind == Kind::kRule)
      score += span.Width() * 6;
  }
  return score;
}
std::vector<Region> SegmentRegions(const cv::Mat& image,
                                   const Evidence& evidence,
                                   const std::vector<Segment>& segments,
                                   const cv::Mat& background) {
  std::vector<std::pair<double, cv::Vec3d>> barriers;
  for (const auto& segment : segments) {
    const auto delta = segment.points.back() - segment.points.front();
    if ((segment.kind != Kind::kBoundary && segment.kind != Kind::kBinding) ||
        std::abs(delta.y) < 1.3 * std::abs(delta.x) || segment.Length() < .27 * image.rows)
      continue;
    const auto [continuity, gap] = TrackSupport(segment, evidence.ink);
    if (segment.kind == Kind::kBinding && (continuity < .8 || gap > .04 * image.rows))
      continue;
    const auto line = Line(segment.points);
    const double crossing = (-line[2] - line[1] * image.rows * .5) / line[0];
    if (crossing <= .045 * image.cols || crossing >= .94 * image.cols ||
        std::any_of(barriers.begin(), barriers.end(), [&](auto other) {
          return std::abs(crossing - other.first) < .065 * image.cols;
        }))
      continue;
    barriers.emplace_back(crossing, line);
  }
  std::sort(barriers.begin(), barriers.end(), [](auto a, auto b) { return a.first < b.first; });
  std::vector<Region> regions;
  for (size_t i = 0; i <= barriers.size(); ++i) {
    Region region;
    if (i)
      region.left = barriers[i - 1].second;
    if (i < barriers.size())
      region.right = barriers[i].second;
    for (int j = 0; j < static_cast<int>(evidence.spans.size()); ++j) {
      const auto p = Mean(evidence.spans[j].points);
      if (region.left && p.x < (-(*region.left)[2] - (*region.left)[1] * p.y) / (*region.left)[0])
        continue;
      if (region.right &&
          p.x >= (-(*region.right)[2] - (*region.right)[1] * p.y) / (*region.right)[0])
        continue;
      region.members.push_back(j);
    }
    if (!region.members.empty()) {
      region.score = RegionScore(region, evidence.spans);
      regions.push_back(std::move(region));
    }
  }
  cv::Mat hsv, paper;
  cv::cvtColor(background, hsv, cv::COLOR_BGR2HSV);
  cv::inRange(hsv, cv::Scalar(0, 0, 75), cv::Scalar(180, 100, 255), paper);
  std::vector<cv::Vec3d> boundaries;
  for (const auto& segment : segments) {
    if (segment.kind != Kind::kBoundary ||
        segment.Length() < .25 * std::min(image.rows, image.cols))
      continue;
    const auto direction = (segment.points.back() - segment.points.front()) / segment.Length();
    const auto middle = Mean(segment.points);
    const double extent = 2 * std::max(image.rows, image.cols);
    cv::line(paper, middle - direction * extent, middle + direction * extent, cv::Scalar(0), 5);
    boundaries.push_back(Line(segment.points));
  }
  cv::Mat labels;
  const int count = cv::connectedComponents(paper, labels);
  std::vector<Region> associated;
  for (const auto& region : regions) {
    std::vector<Region> sheets(count);
    for (int i : region.members) {
      std::vector<int> votes(count);
      for (auto p : evidence.spans[i].points)
        ++votes[labels.at<int>(std::clamp(cvRound(p.y), 0, image.rows - 1),
                               std::clamp(cvRound(p.x), 0, image.cols - 1))];
      const auto best = std::max_element(votes.begin() + 1, votes.end());
      if (best != votes.end() && *best >= .65 * evidence.spans[i].points.size())
        sheets[best - votes.begin()].members.push_back(i);
    }
    for (auto& sheet : sheets) {
      if (sheet.members.empty())
        continue;
      sheet.left = region.left;
      sheet.right = region.right;
      const auto core = RegionPoints(sheet, evidence.spans);
      const auto center = Mean(core);
      for (auto line : boundaries) {
        if (line.dot(Homogeneous(center)) < 0)
          line *= -1;
        const auto inside = std::count_if(core.begin(), core.end(),
                                          [&](auto p) { return line.dot(Homogeneous(p)) >= -3; });
        if (inside >= .95 * core.size())
          sheet.boundaries.push_back(line);
      }
      sheet.score = RegionScore(sheet, evidence.spans);
      associated.push_back(std::move(sheet));
    }
  }
  std::sort(associated.begin(), associated.end(),
            [](const auto& a, const auto& b) { return a.score > b.score; });
  return associated;
}

struct VpFit {
  cv::Vec3d point;
  std::vector<double> errors;
};
double VpError(cv::Vec3d line, cv::Point2d middle, cv::Vec3d value) {
  const double distance =
      std::hypot(value[0] - value[2] * middle.x, value[1] - value[2] * middle.y);
  return std::asin(std::clamp(std::abs(line.dot(value)) / std::max(distance, 1e-12), 0.0, 1.0)) *
         kDegrees;
}
std::optional<VpFit> FitVp(const std::vector<cv::Vec3d>& lines,
                           const Points& middles,
                           const std::vector<double>& weights,
                           double threshold,
                           int axis,
                           double separation) {
  if (lines.size() < 2)
    return {};
  std::vector<std::pair<int, int>> pairs;
  for (int i = 0; i < static_cast<int>(lines.size()); ++i)
    for (int j = i + 1; j < static_cast<int>(lines.size()); ++j)
      pairs.emplace_back(i, j);
  if (pairs.size() > 192) {
    std::mt19937 random(73);
    std::shuffle(pairs.begin(), pairs.end(), random);
    pairs.resize(192);
  }
  auto score = [&](cv::Vec3d value) {
    double result = 0, low = 1e30, high = -1e30;
    for (size_t i = 0; i < lines.size(); ++i) {
      const double error = VpError(lines[i], middles[i], value) / threshold;
      result += std::max(0.0, 1 - error * error) * weights[i];
      if (error < 1) {
        low = std::min(low, Coordinate(middles[i], axis));
        high = std::max(high, Coordinate(middles[i], axis));
      }
    }
    return high - low < separation ? -1.0 : result;
  };
  double best_score = 0;
  cv::Vec3d best;
  for (auto [i, j] : pairs) {
    auto value = lines[i].cross(lines[j]);
    value /= std::max(cv::norm(value), 1e-12);
    const double candidate = score(value);
    if (candidate > best_score) {
      best_score = candidate;
      best = value;
    }
  }
  if (best_score <= 0)
    return {};
  auto value = best;
  for (int repeat = 0; repeat < 4; ++repeat) {
    cv::Matx33d normal = cv::Matx33d::zeros();
    for (size_t i = 0; i < lines.size(); ++i) {
      const double distance = std::max(
          .1, std::hypot(value[0] - value[2] * middles[i].x, value[1] - value[2] * middles[i].y));
      const double error = VpError(lines[i], middles[i], value) / threshold;
      const double weight = weights[i] * std::max(0.0, 1 - error * error) / (distance * distance);
      normal += lines[i] * lines[i].t() * weight;
    }
    cv::Vec3d eigenvalues;
    cv::Matx33d eigenvectors;
    cv::eigen(normal, eigenvalues, eigenvectors);
    value = {eigenvectors(2, 0), eigenvectors(2, 1), eigenvectors(2, 2)};
    const double candidate = score(value);
    if (candidate > best_score) {
      best_score = candidate;
      best = value;
    }
  }
  VpFit fit{best, {}};
  for (size_t i = 0; i < lines.size(); ++i)
    fit.errors.push_back(VpError(lines[i], middles[i], best));
  return fit;
}

std::vector<Segment> MarginTracks(const Region& region,
                                  const std::vector<Span>& spans,
                                  cv::Size size) {
  std::vector<Segment> result;
  for (bool end : {false, true}) {
    Points points;
    for (int i : region.members)
      if (!spans[i].printed_points.empty())
        points.push_back(end ? spans[i].printed_points.back() : spans[i].printed_points.front());
    std::vector<bool> remaining(points.size(), true);
    for (int repeat = 0; repeat < 2 && points.size() >= 4; ++repeat) {
      std::vector<int> best;
      for (size_t i = 0; i < points.size(); ++i)
        for (size_t j = i + 1; j < points.size(); ++j) {
          const auto delta = points[i] - points[j];
          if (std::abs(delta.y) <= .2 * size.height || std::abs(delta.x) >= .8 * std::abs(delta.y))
            continue;
          auto line = Homogeneous(points[i]).cross(Homogeneous(points[j]));
          line /= std::hypot(line[0], line[1]);
          std::vector<int> good;
          for (int k = 0; k < static_cast<int>(points.size()); ++k)
            if (remaining[k] && std::abs(line.dot(Homogeneous(points[k]))) < 3.5)
              good.push_back(k);
          if (good.size() > best.size())
            best = std::move(good);
        }
      Points selected;
      for (int i : best)
        selected.push_back(points[i]);
      if (best.size() < 4 || Range(selected, 1) < .3 * size.height)
        break;
      const auto line = Line(selected);
      const double low = PointQuantile(selected, 1, 0), high = PointQuantile(selected, 1, 1);
      result.push_back({{{(-line[2] - line[1] * low) / line[0], low},
                         {(-line[2] - line[1] * high) / line[0], high}},
                        Kind::kMargin,
                        std::min(1.2, best.size() * .15)});
      for (int i : best)
        remaining[i] = false;
    }
  }
  return result;
}

cv::Matx33d Normalizer(cv::Size size) {
  const double length = std::max(size.width, size.height);
  return {1 / length, 0, -size.width / (2 * length), 0, 1 / length, -size.height / (2 * length), 0,
          0,          1};
}
Points Frame(cv::Size size, int samples = 1) {
  Points corners{{0, 0},
                 {double(size.width), 0},
                 {double(size.width), double(size.height)},
                 {0, double(size.height)}};
  Points points;
  for (int i = 0; i < 4; ++i)
    for (int j = 0; j < samples; ++j)
      points.push_back(corners[i] + (corners[(i + 1) % 4] - corners[i]) * (double(j) / samples));
  return points;
}

bool BelongsToRegion(const Segment& segment, const Region& region) {
  const auto middle = Mean(segment.points);
  if (region.left &&
      middle.x < (-(*region.left)[2] - (*region.left)[1] * middle.y) / (*region.left)[0] - 5)
    return false;
  if (region.right &&
      middle.x > (-(*region.right)[2] - (*region.right)[1] * middle.y) / (*region.right)[0] + 5)
    return false;
  return std::all_of(region.boundaries.begin(), region.boundaries.end(),
                     [&](auto line) { return line.dot(Homogeneous(middle)) >= -5; });
}

std::optional<cv::Matx33d> FitRegion(const cv::Mat& image,
                                     const Evidence& evidence,
                                     const Region& region,
                                     const std::vector<Segment>& segments) {
  const auto& spans = evidence.spans;
  const double length = std::max(image.cols, image.rows);
  const auto normalizer = Normalizer(image.size());
  int printed = 0;
  std::vector<cv::Vec3d> lines;
  Points middles;
  std::vector<double> weights;
  for (int i : region.members) {
    const auto& span = spans[i];
    if (span.printed_points.empty())
      continue;
    ++printed;
    const auto points = Transform(span.printed_points, normalizer);
    lines.push_back(Line(points));
    middles.push_back(Mean(points));
    weights.push_back(std::min(Range(span.printed_points, 0) / length, .5));
  }
  const int printed_candidates = printed;
  if (printed < 3)
    return {};
  const auto reliable = RegionPoints(region, spans, true);
  const double y_low = PointQuantile(reliable, 1, .1), y_high = PointQuantile(reliable, 1, .9);
  std::vector<Segment> physical_edges;
  for (const auto& segment : segments) {
    if (!BelongsToRegion(segment, region))
      continue;
    const auto delta = segment.points.back() - segment.points.front();
    const auto middle = Mean(segment.points);
    if (segment.kind != Kind::kBoundary || segment.contrast < 20 || segment.support < .65 ||
        std::abs(delta.y) > .3 * std::abs(delta.x) || segment.Length() < .16 * image.cols ||
        (middle.y > y_low && middle.y < y_high))
      continue;
    const auto edge_line = Line(segment.points);
    if (std::any_of(physical_edges.begin(), physical_edges.end(), [&](const auto& other) {
          const auto other_line = Line(other.points);
          return std::abs(edge_line.dot(Homogeneous(Mean(other.points)))) < 8 &&
                 std::abs(edge_line[0] * other_line[0] + edge_line[1] * other_line[1]) > .995;
        }))
      continue;
    physical_edges.push_back(segment);
    const auto points = Transform(segment.points, normalizer);
    lines.push_back(Line(points));
    middles.push_back(Mean(points));
    weights.push_back(std::min(segment.Length() / length, .5) * 1.5);
  }
  if (printed < 5 && physical_edges.empty())
    return {};
  auto horizontal = FitVp(lines, middles, weights, .9, 1, .22 * image.rows / length);
  if (!horizontal)
    return {};
  int printed_inliers = 0, edge_inliers = 0;
  double selected_weight = 0;
  for (size_t i = 0; i < weights.size(); ++i) {
    if (horizontal->errors[i] >= .9)
      continue;
    printed_inliers += i < size_t(printed_candidates);
    edge_inliers += i >= size_t(printed_candidates);
    selected_weight += weights[i];
  }
  if (!((printed_inliers >= 5) || (printed_inliers >= 3 && edge_inliers >= 1)) ||
      selected_weight < .6 * std::accumulate(weights.begin(), weights.end(), 0.0))
    return {};
  auto verticals = MarginTracks(region, spans, image.size());
  for (const auto& segment : segments) {
    if (!BelongsToRegion(segment, region) || segment.kind != Kind::kBoundary)
      continue;
    const auto delta = segment.points.back() - segment.points.front();
    if (std::abs(delta.y) < 1.3 * std::abs(delta.x) || segment.Length() < .12 * image.rows)
      continue;
    auto copy = segment;
    copy.weight = 1.5;
    verticals.push_back(std::move(copy));
  }
  std::sort(verticals.begin(), verticals.end(), [](const auto& a, const auto& b) {
    return a.weight * a.Length() > b.weight * b.Length();
  });
  std::vector<Segment> unique;
  for (const auto& segment : verticals) {
    const auto line = Line(segment.points);
    if (std::any_of(unique.begin(), unique.end(), [&](const auto& item) {
          const auto other = Line(item.points);
          return std::abs(other.dot(Homogeneous(Mean(segment.points)))) < 6 &&
                 std::abs(other[0] * line[0] + other[1] * line[1]) > .999;
        }))
      continue;
    unique.push_back(segment);
  }
  lines.clear();
  middles.clear();
  weights.clear();
  for (const auto& segment : unique) {
    const auto points = Transform(segment.points, normalizer);
    lines.push_back(Line(points));
    middles.push_back(Mean(points));
    weights.push_back(segment.weight * std::min(segment.Length() / length, .7));
  }
  const auto vertical = FitVp(lines, middles, weights, 1.7, 0, .2 * image.cols / length);
  if (!vertical)
    return {};
  const auto h = horizontal->point, v = vertical->point;
  auto horizon = h.cross(v);
  if (std::abs(horizon[2]) < 1e-6)
    return {};
  horizon /= horizon[2];
  cv::Matx33d affine = cv::Matx33d::eye();
  for (int i = 0; i < 3; ++i)
    affine(2, i) = horizon[i];
  const auto hx = affine * h, vy = affine * v;
  cv::Vec2d x(hx[0], hx[1]), y(vy[0], vy[1]);
  x *= (x[0] < 0 ? -1 : 1) / cv::norm(x);
  y *= (y[1] < 0 ? -1 : 1) / cv::norm(y);
  const cv::Matx22d directions(x[0], y[0], x[1], y[1]);
  cv::Vec2d singular;
  cv::SVD::compute(directions, singular);
  if (singular[1] <= 0 || singular[0] / singular[1] > 1.7)
    return {};
  const auto metric = directions.inv() * std::sqrt(std::abs(cv::determinant(directions)));
  const cv::Matx33d orthogonal(metric(0, 0), metric(0, 1), 0, metric(1, 0), metric(1, 1), 0, 0, 0,
                               1);
  const cv::Matx33d matrix = normalizer.inv() * orthogonal * affine * normalizer;
  double minimum = 1e30, maximum = -1e30, displacement = 0;
  for (auto p : Frame(image.size())) {
    const auto value = matrix * Homogeneous(p);
    minimum = std::min(minimum, value[2]);
    maximum = std::max(maximum, value[2]);
    displacement = std::max(displacement, cv::norm(Transform(p, matrix) - p) / length);
  }
  if (minimum < .45 || maximum / minimum > 2.5)
    return {};
  if (displacement >= .012 && std::abs(h[2]) > 1e-5 && std::abs(v[2]) > 1e-5 &&
      -(h[0] * v[0] + h[1] * v[1]) / (h[2] * v[2]) <= 0)
    return {};
  for (int axis = 0; axis < 2; ++axis) {
    std::vector<double> coordinates;
    for (int i : region.members)
      if (!spans[i].printed_points.empty())
        coordinates.push_back(Coordinate(Mean(spans[i].printed_points), axis));
    const double split = Quantile(coordinates);
    for (bool side : {false, true}) {
      std::vector<double> errors;
      for (size_t i = 0; i < coordinates.size(); ++i)
        if ((coordinates[i] >= split) == side && horizontal->errors[i] < .9)
          errors.push_back(horizontal->errors[i]);
      if (errors.size() >= 3 && Quantile(errors) > .7)
        return {};
    }
  }
  return displacement < .012 ? cv::Matx33d::eye() : matrix;
}

std::pair<double, double> FlowValues(double x, const PageGeometry& geometry) {
  if (!geometry.has_flow)
    return {};
  x = std::clamp(x, geometry.flow_domain[0], geometry.flow_domain[1]);
  const cv::Vec3d basis(x, x * x, x * x * x);
  return {basis.dot(cv::Vec3d(geometry.flow[0], geometry.flow[1], geometry.flow[2])),
          basis.dot(cv::Vec3d(geometry.flow[3], geometry.flow[4], geometry.flow[5]))};
}
cv::Point2d MapPoint(cv::Point2d point, const PageGeometry& geometry) {
  const auto normalizer = Normalizer(geometry.analysis_size);
  auto p = Transform(point, normalizer * geometry.matrix);
  const auto [a, b] = FlowValues(p.x, geometry);
  p.y = (p.y - b) / (1 + a);
  return Transform(p, normalizer.inv());
}
Points MapPoints(const Points& points, const PageGeometry& geometry) {
  Points result;
  for (auto p : points)
    result.push_back(MapPoint(p, geometry));
  return result;
}

cv::Vec<double, 6> FitFlow(const std::vector<Points>& lines,
                           const std::vector<double>& weights,
                           double length) {
  struct Sample {
    cv::Vec3d basis;
    double y, weight, robust = 1;
    size_t group;
  };
  std::vector<Sample> samples;
  std::vector<double> ordinates;
  for (size_t i = 0; i < lines.size(); ++i) {
    const int step = std::max(1, int(lines[i].size() / 40));
    std::vector<double> y;
    for (size_t j = 0; j < lines[i].size(); j += step) {
      const auto p = lines[i][j];
      samples.push_back({{p.x, p.x * p.x, p.x * p.x * p.x}, p.y, weights[i], 1, i});
      y.push_back(p.y);
    }
    ordinates.push_back(Quantile(y));
  }
  cv::Vec<double, 6> coefficients{};
  for (int repeat = 0; repeat < 16; ++repeat) {
    cv::Matx<double, 6, 6> normal = cv::Matx<double, 6, 6>::eye() * std::pow(6 / length, 2);
    cv::Vec<double, 6> rhs{};
    for (const auto& sample : samples) {
      cv::Vec<double, 6> basis;
      for (int i = 0; i < 3; ++i) {
        basis[i] = sample.basis[i] * ordinates[sample.group];
        basis[i + 3] = sample.basis[i];
      }
      const double weight = sample.weight * sample.robust;
      normal += basis * basis.t() * weight;
      rhs += basis * ((sample.y - ordinates[sample.group]) * weight);
    }
    cv::solve(normal, rhs, coefficients, cv::DECOMP_CHOLESKY);
    std::vector<double> numerator(lines.size()), denominator(lines.size());
    bool valid = true;
    for (const auto& sample : samples) {
      const double a =
          1 + sample.basis.dot(cv::Vec3d(coefficients[0], coefficients[1], coefficients[2]));
      const double b =
          sample.basis.dot(cv::Vec3d(coefficients[3], coefficients[4], coefficients[5]));
      valid &= a >= .35;
      const double weight = sample.weight * sample.robust;
      numerator[sample.group] += weight * a * (sample.y - b);
      denominator[sample.group] += weight * a * a;
    }
    if (!valid)
      break;
    for (size_t i = 0; i < lines.size(); ++i)
      ordinates[i] = numerator[i] / std::max(denominator[i], 1e-12);
    for (auto& sample : samples) {
      const double a =
          1 + sample.basis.dot(cv::Vec3d(coefficients[0], coefficients[1], coefficients[2]));
      const double b =
          sample.basis.dot(cv::Vec3d(coefficients[3], coefficients[4], coefficients[5]));
      const double residual = std::abs(sample.y - ordinates[sample.group] * a - b) * length;
      sample.robust = std::min(1.0, 1.3 / std::max(residual, .01));
    }
  }
  return coefficients;
}

std::pair<double, double> LineMetrics(const std::vector<Points>& lines) {
  std::vector<double> angles, curves;
  for (const auto& points : lines) {
    angles.push_back(std::abs(Angle(points)));
    const double mean = Mean(points).x, scale = std::max(Range(points, 0) / 2, 1.0);
    Points normalized;
    for (auto p : points)
      normalized.emplace_back((p.x - mean) / scale, p.y);
    const auto polynomial = Polynomial(normalized, std::min(3, int(points.size()) - 1));
    Points smoothed;
    for (auto p : normalized)
      smoothed.emplace_back(p.x, Evaluate(polynomial, p.x));
    const auto linear = Polynomial(smoothed, 1);
    double sum = 0;
    for (auto p : smoothed)
      sum += std::pow(p.y - Evaluate(linear, p.x), 2);
    curves.push_back(std::sqrt(sum / smoothed.size()));
  }
  return {Quantile(angles), Quantile(curves)};
}

void FitResidualFlow(const Evidence& evidence, const Region& region, PageGeometry& geometry) {
  const auto normalizer = Normalizer(geometry.analysis_size);
  const double length = std::max(geometry.analysis_size.width, geometry.analysis_size.height);
  std::vector<Points> points;
  std::vector<double> weights;
  for (int i : region.members)
    if (evidence.spans[i].weight >= .5) {
      points.push_back(Transform(evidence.spans[i].points, normalizer * geometry.matrix));
      weights.push_back(evidence.spans[i].weight);
    }
  if (points.size() < 8)
    return;
  std::vector<int> order(points.size());
  std::iota(order.begin(), order.end(), 0);
  std::sort(order.begin(), order.end(),
            [&](int a, int b) { return Mean(points[a]).y < Mean(points[b]).y; });
  std::vector<Points> train, holdout;
  std::vector<double> train_weights;
  Points all;
  for (size_t i = 0; i < order.size(); ++i) {
    const int index = order[i];
    if (i % 2)
      holdout.push_back(points[index]);
    else {
      train.push_back(points[index]);
      train_weights.push_back(weights[index]);
    }
    all.insert(all.end(), points[index].begin(), points[index].end());
  }
  geometry.flow = FitFlow(train, train_weights, length);
  geometry.flow_domain = {PointQuantile(all, 0, .01) - .02, PointQuantile(all, 0, .99) + .02};
  geometry.has_flow = true;
  auto valid = [&] {
    for (int i = 0; i < 100; ++i) {
      const double x =
          geometry.flow_domain[0] + (geometry.flow_domain[1] - geometry.flow_domain[0]) * i / 99;
      const auto [a, b] = FlowValues(x, geometry);
      if (!std::isfinite(a) || !std::isfinite(b) || 1 + a < .65 || 1 + a > 1.5 || std::abs(b) > .1)
        return false;
    }
    return true;
  };
  std::vector<Points> before, after;
  for (const auto& line : holdout) {
    Points old_points, new_points;
    for (auto p : line) {
      old_points.push_back(p * length);
      const auto [a, b] = FlowValues(p.x, geometry);
      new_points.emplace_back(p.x * length, (p.y - b) / (1 + a) * length);
    }
    before.push_back(std::move(old_points));
    after.push_back(std::move(new_points));
  }
  const auto [before_angle, before_curve] = LineMetrics(before);
  const auto [after_angle, after_curve] = LineMetrics(after);
  const bool angle_good = before_angle - after_angle >= .2 && after_angle <= before_angle * .8;
  const bool curve_good = after_curve <= before_curve * 1.1 + .1;
  const bool curve_gain = before_curve - after_curve >= .5 && after_curve <= before_curve * .75;
  if (!valid() ||
      !((angle_good && curve_good) || (curve_gain && after_angle <= before_angle + .1))) {
    geometry.has_flow = false;
    return;
  }
  geometry.flow = FitFlow(points, weights, length);
  geometry.has_flow = valid();
}

bool GutterDiscontinuity(const cv::Mat& image, const Evidence& evidence, const Region& main_page) {
  if (!main_page.left)
    return false;
  const auto points = RegionPoints(main_page, evidence.spans);
  const auto line = *main_page.left;
  const double sign = line.dot(Homogeneous(Mean(points))) < 0 ? -1 : 1;
  cv::Mat outside = evidence.ink.clone();
  for (int y = 0; y < image.rows; ++y) {
    auto* row = outside.ptr<uint8_t>(y);
    for (int x = 0; x < image.cols; ++x)
      if ((line[0] * x + line[1] * y + line[2]) * sign >= -4)
        row[x] = 0;
  }
  cv::Mat joined;
  cv::dilate(outside, joined, cv::Mat::ones(1, 5, CV_8U));
  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(joined, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
  std::vector<double> angles;
  for (int i : main_page.members)
    if (evidence.spans[i].weight >= .5)
      angles.push_back(evidence.spans[i].angle);
  const double main_angle = Quantile(angles);
  int count = 0;
  double length = 0;
  for (const auto& contour : contours) {
    const auto box = cv::boundingRect(contour);
    const double aspect = double(box.width) / box.height;
    if (box.width < 12 || box.width > .12 * image.cols || box.height < 8 ||
        box.height > .08 * image.rows || aspect < 1.5 || aspect > 6)
      continue;
    const auto samples = ColumnCentres(outside, box, 5, true);
    if (samples.size() < 3)
      continue;
    const double angle = Angle(samples);
    if (std::abs(angle) <= 50 && std::abs(angle - main_angle) >= 12) {
      ++count;
      length += box.width;
    }
  }
  return count >= 2 && length >= .05 * image.cols;
}

// Only physical paper transitions assign components to a sheet. Text/rule
// associations on a different sheet cannot override that ownership.
std::vector<Points> ProtectedComponents(const cv::Mat& image,
                                        const Evidence& evidence,
                                        const Region& main_page,
                                        const std::vector<Segment>& segments,
                                        bool gutter_crop) {
  const auto core = RegionPoints(main_page, evidence.spans, true);
  const cv::Point2d reference(PointQuantile(core, 0), PointQuantile(core, 1));
  std::vector<double> heights, angles;
  for (int i : main_page.members) {
    const auto& span = evidence.spans[i];
    if (span.kind == Kind::kText && span.weight >= .5) {
      heights.push_back(span.height);
      angles.push_back(span.angle);
    }
  }
  const double typical_height = heights.empty() ? 15 : Quantile(heights);
  const double main_angle = Quantile(angles);
  const double top = PointQuantile(core, 1, 0), left = PointQuantile(core, 0, 0);
  std::vector<cv::Vec3d> envelopes;
  for (bool left_side : {true, false}) {
    const Segment* best = nullptr;
    for (const auto& segment : segments) {
      const auto delta = segment.points.back() - segment.points.front();
      const auto middle = Mean(segment.points);
      if (segment.kind != Kind::kBoundary || std::abs(delta.y) < 1.3 * std::abs(delta.x) ||
          (segment.contrast < 65 && (!left_side || segment.Length() < .25 * image.rows)) ||
          (middle.x < reference.x) != left_side)
        continue;
      if (left_side ? middle.x >= PointQuantile(core, 0, .15)
                    : middle.x <= PointQuantile(core, 0, .85))
        continue;
      if (!best || segment.Length() * segment.contrast > best->Length() * best->contrast)
        best = &segment;
    }
    if (best) {
      auto line = Line(best->points);
      if (line.dot(Homogeneous(reference)) < 0)
        line *= -1;
      envelopes.push_back(line);
    }
  }
  if (gutter_crop && main_page.left) {
    auto line = *main_page.left;
    if (line.dot(Homogeneous(reference)) < 0)
      line *= -1;
    envelopes.push_back(line);
  }
  cv::Mat labels, stats, centres;
  const int count = cv::connectedComponentsWithStats(evidence.ink, labels, stats, centres);
  std::vector<cv::Vec3d> text_lines;
  std::vector<double> text_angles;
  for (const auto& span : evidence.spans) {
    text_lines.push_back(span.line);
    text_angles.push_back(span.angle);
  }
  std::vector<Points> protected_boxes;
  for (int i = 1; i < count; ++i) {
    const auto* s = stats.ptr<int>(i);
    const cv::Rect box(s[0], s[1], s[2], s[3]);
    if (s[4] < 5 || box.width > .4 * image.cols || box.height > .25 * image.rows ||
        (box.width > 10 * box.height && box.height < 5))
      continue;
    const cv::Point2d centre(box.x + box.width * .5, box.y + box.height * .5);
    if (std::any_of(main_page.boundaries.begin(), main_page.boundaries.end(), [&](auto line) {
          const std::array<cv::Point2d, 4> corners{
              {{double(box.x), double(box.y)},
               {double(box.x + box.width), double(box.y)},
               {double(box.x + box.width), double(box.y + box.height)},
               {double(box.x), double(box.y + box.height)}}};
          return std::all_of(corners.begin(), corners.end(),
                             [&](auto p) { return line.dot(Homogeneous(p)) < -3; });
        }))
      continue;
    bool associated = false, main_associated = false, wrong_direction = false;
    for (int j = 0; j < static_cast<int>(evidence.spans.size()); ++j) {
      const auto& span = evidence.spans[j];
      if (span.kind != Kind::kText || centre.x < span.points.front().x - 4 ||
          centre.x > span.points.back().x + 4 ||
          std::abs(text_lines[j].dot(Homogeneous(centre))) >= span.height * .8)
        continue;
      associated = true;
      main_associated |=
          span.weight >= .5 && std::find(main_page.members.begin(), main_page.members.end(), j) !=
                                   main_page.members.end();
      wrong_direction |= span.weight < .5 && std::abs(text_angles[j] - main_angle) >= 12;
    }
    if (!associated && (box.height < 4 || box.height > typical_height * 3.5))
      continue;
    if (gutter_crop && main_page.left) {
      const auto seam = *main_page.left;
      const double sign = seam.dot(Homogeneous(reference)) < 0 ? -1 : 1;
      // The continuous seam and its narrow shadow belong to the binding,
      // including small disconnected ink fragments along that track.
      if (seam.dot(Homogeneous(centre)) * sign < .008 * std::max(image.cols, image.rows))
        continue;
    }
    if (!main_associated && std::any_of(envelopes.begin(), envelopes.end(), [&](auto line) {
          return line.dot(Homogeneous(centre)) < -1.5;
        }))
      continue;
    if (centre.y < top && wrong_direction)
      continue;
    if (!main_associated && (centre.y < std::max(0.0, top - 1.2 * typical_height) ||
                             centre.x < std::max(0.0, left - 3 * typical_height)))
      continue;
    protected_boxes.push_back({{double(box.x), double(box.y)},
                               {double(box.x + box.width), double(box.y)},
                               {double(box.x + box.width), double(box.y + box.height)},
                               {double(box.x), double(box.y + box.height)}});
  }
  return protected_boxes;
}

Points ClipPolygon(const Points& polygon, cv::Vec3d line) {
  Points result;
  for (size_t i = 0; i < polygon.size(); ++i) {
    const auto a = polygon[i], b = polygon[(i + 1) % polygon.size()];
    const double first = line.dot(Homogeneous(a)), second = line.dot(Homogeneous(b));
    if (first >= 0)
      result.push_back(a);
    if ((first >= 0) != (second >= 0))
      result.push_back(a + (b - a) * (first / (first - second)));
  }
  return result;
}

struct OcclusionText {
  double angle;
  double font;
  double first_print;
  double foreign_bottom;
  double foreign_flat_bottom;
  double foreign_slope;
  double foreign_x;
  Points printed;
  std::vector<int> foreign;
};

std::optional<OcclusionText> FindOcclusionText(const Evidence& evidence, const Region& region) {
  std::vector<double> angles, heights;
  Points printed;
  for (int i : region.members) {
    const auto& span = evidence.spans[i];
    if (span.printed_points.empty())
      continue;
    angles.push_back(Angle(span.printed_points));
    heights.push_back(span.glyph_height);
    printed.insert(printed.end(), span.printed_points.begin(), span.printed_points.end());
  }
  if (angles.size() < 3)
    return {};
  const double main_angle = Quantile(angles), font = Quantile(heights);
  const double first_print = PointQuantile(printed, 1, 0);
  std::vector<int> foreign;
  for (int i : region.members) {
    const auto& span = evidence.spans[i];
    if (span.kind != Kind::kText || Mean(span.points).y >= first_print - 2 * font)
      continue;
    int similar_rows = 0;
    if (span.glyph_height > 1.5 * font) {
      for (int j : region.members) {
        const auto& other = evidence.spans[j];
        if (i != j && other.kind == Kind::kText && other.glyph_height >= .8 * span.glyph_height &&
            other.glyph_height <= 1.25 * span.glyph_height &&
            std::abs(other.angle - span.angle) < 4 &&
            std::abs(Mean(other.points).y - Mean(span.points).y) < 6 * font)
          ++similar_rows;
      }
    }
    if (std::abs(span.angle - main_angle) >= 7 || similar_rows >= 2)
      foreign.push_back(i);
  }
  std::vector<double> foreign_angles;
  for (int i : foreign)
    foreign_angles.push_back(evidence.spans[i].angle);
  for (size_t n = 0; n < foreign.size(); ++n) {
    const auto& seed = evidence.spans[foreign[n]];
    for (int i : region.members) {
      const auto& span = evidence.spans[i];
      if (span.kind != Kind::kText || Mean(span.points).y >= first_print - 2 * font ||
          std::find(foreign.begin(), foreign.end(), i) != foreign.end())
        continue;
      const double gap = std::max(seed.points.front().x, span.points.front().x) -
                         std::min(seed.points.back().x, span.points.back().x);
      if (gap < 3 * font && std::abs(Mean(seed.points).y - Mean(span.points).y) < 3.5 * font)
        foreign.push_back(i);
    }
  }
  if (foreign.size() < 2)
    return {};
  const double foreign_slope = std::tan(Quantile(foreign_angles) / kDegrees);
  std::vector<double> foreign_xs;
  for (int i : foreign)
    foreign_xs.push_back(Mean(evidence.spans[i].points).x);
  const double foreign_x = Quantile(foreign_xs);
  double foreign_bottom = 0, foreign_flat_bottom = 0;
  for (int i : foreign) {
    for (auto point : evidence.spans[i].points) {
      foreign_bottom = std::max(foreign_bottom, point.y - foreign_slope * (point.x - foreign_x) +
                                                    evidence.spans[i].height * .5);
      foreign_flat_bottom = std::max(foreign_flat_bottom, point.y + evidence.spans[i].height * .5);
    }
  }
  return OcclusionText{main_angle,          font,          first_print, foreign_bottom,
                       foreign_flat_bottom, foreign_slope, foreign_x,   std::move(printed),
                       std::move(foreign)};
}

double ForeignTextBottom(const OcclusionText& text, double x) {
  return std::max(text.foreign_flat_bottom,
                  text.foreign_bottom + text.foreign_slope * (x - text.foreign_x));
}

struct OcclusionCandidate {
  cv::Vec3d line;
  double strength;
  double support;
  double center;
};

std::vector<OcclusionCandidate> OcclusionCandidates(const cv::Mat& image,
                                                    const Evidence& evidence,
                                                    const OcclusionText& text) {
  cv::Mat gray, smooth;
  cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  gray.convertTo(gray, CV_32F);
  cv::GaussianBlur(gray, smooth, {}, 1);
  std::vector<OcclusionCandidate> candidates;
  const double middle_x = image.cols * .5;
  double first_foreign = image.rows;
  for (int i : text.foreign)
    first_foreign = std::min(first_foreign, PointQuantile(evidence.spans[i].points, 1, 0));
  const int first_y = std::max(12, cvRound(first_foreign));
  const int last_y = std::min(cvRound(text.first_print - text.font), cvRound(.3 * image.rows));
  for (int angle = -24; angle <= 24; ++angle) {
    const double slope = std::tan(angle / kDegrees);
    for (int center = first_y; center <= last_y; center += 2) {
      cv::Vec3d line(-slope, 1, slope * middle_x - center);
      line /= std::hypot(line[0], line[1]);
      int outside_lines = 0;
      for (int i : text.foreign)
        outside_lines += line.dot(Homogeneous(Mean(evidence.spans[i].points))) < 0;
      if (outside_lines < 2 ||
          std::any_of(
              text.printed.begin(), text.printed.end(),
              [&](auto point) { return line.dot(Homogeneous(point)) < text.font; }))
        continue;
      double sum = 0;
      int positive = 0, negative = 0, valid = 0, samples = 0;
      for (int x = 10; x < image.cols - 10; x += 4) {
        const int y = cvRound(center + slope * (x - middle_x));
        if (y < 10 || y >= image.rows - 10)
          continue;
        ++samples;
        const std::array<float, 4> values{{smooth.at<float>(y - 9, x), smooth.at<float>(y - 3, x),
                                           smooth.at<float>(y + 3, x), smooth.at<float>(y + 9, x)}};
        const auto [low, high] = std::minmax_element(values.begin(), values.end());
        if (*low < 110 || *high - *low > 20)
          continue;
        // Remove gradual lighting changes; retain a narrow, coherent paper step.
        const double edge = values[2] - values[1] - .5 * (values[3] - values[0]);
        sum += std::clamp(edge, -3.0, 3.0);
        positive += edge > .5;
        negative += edge < -.5;
        ++valid;
      }
      if (valid < .55 * samples || valid < 50)
        continue;
      const double strength = std::abs(sum) / valid;
      const double support = double(sum > 0 ? positive : negative) / valid;
      if (strength >= .6 && support >= .55)
        candidates.push_back({line, strength, support, double(center)});
    }
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const auto& a, const auto& b) { return a.center > b.center; });
  return candidates;
}

std::optional<Segment> FindOccludingEdge(const cv::Mat& image,
                                         const Evidence& evidence,
                                         Region& region) {
  const auto text = FindOcclusionText(evidence, region);
  if (!text)
    return {};
  const auto candidates = OcclusionCandidates(image, evidence, *text);
  if (candidates.empty())
    return {};
  cv::Mat labels, stats, centers;
  const int count =
      cv::connectedComponentsWithStats(evidence.protected_ink, labels, stats, centers);
  struct ProtectedInk {
    Points box;
    bool main_text;
  };
  std::vector<ProtectedInk> protected_ink;
  for (int i = 1; i < count; ++i) {
    const auto* box = stats.ptr<int>(i);
    if (box[4] < 4 || box[2] >= .9 * image.cols || box[3] >= .9 * image.rows)
      continue;
    const cv::Point2d center(box[0] + box[2] * .5, box[1] + box[3] * .5);
    bool main_text = false;
    for (int j : region.members) {
      const auto& span = evidence.spans[j];
      if (center.x >= span.points.front().x - text->font &&
          center.x <= span.points.back().x + text->font &&
          std::abs(span.line.dot(Homogeneous(center))) < span.height * .8 &&
          (!span.printed_points.empty() ||
           (Mean(span.points).y > ForeignTextBottom(*text, Mean(span.points).x) + 2 * text->font &&
            std::abs(span.angle - text->angle) < 5)))
        main_text = true;
    }
    protected_ink.push_back({{{double(box[0]), double(box[1])},
                              {double(box[0] + box[2]), double(box[1])},
                              {double(box[0] + box[2]), double(box[1] + box[3])},
                              {double(box[0]), double(box[1] + box[3])}},
                             main_text});
  }
  for (auto candidate : candidates) {
    double outside = 0;
    for (const auto& ink : protected_ink) {
      const auto center = Mean(ink.box);
      if (!ink.main_text && center.y < ForeignTextBottom(*text, center.x) + text->font &&
          std::all_of(
              ink.box.begin(), ink.box.end(),
              [&](auto point) { return candidate.line.dot(Homogeneous(point)) < -text->font; }))
        continue;
      for (auto point : ink.box)
        outside = std::max(outside, -candidate.line.dot(Homogeneous(point)));
    }
    if (outside > .01 * std::max(image.cols, image.rows))
      continue;
    candidate.line[2] += outside + 1.5;
    const auto line = candidate.line;
    int removed_lines = 0;
    for (int i : text->foreign)
      removed_lines += line.dot(Homogeneous(Mean(evidence.spans[i].points))) < 0;
    if (removed_lines < 2)
      continue;
    region.boundaries.push_back(line);
    std::erase_if(region.members, [&](int i) {
      return line.dot(Homogeneous(Mean(evidence.spans[i].points))) < 0 &&
             evidence.spans[i].printed_points.empty();
    });
    return Segment{{{0, -line[2] / line[1]},
                    {double(image.cols - 1), (-line[2] - line[0] * (image.cols - 1)) / line[1]}},
                   Kind::kOcclusion,
                   1,
                   candidate.strength,
                   candidate.support};
  }
  return {};
}

void ChooseEdges(const cv::Mat& image,
                 const Evidence& evidence,
                 const Region& region,
                 const std::vector<Segment>& segments,
                 PageGeometry& geometry) {
  const bool gutter_crop = GutterDiscontinuity(image, evidence, region);
  auto protected_boxes = ProtectedComponents(image, evidence, region, segments, gutter_crop);
  for (auto& box : protected_boxes)
    box = MapPoints(box, geometry);
  const auto core = MapPoints(RegionPoints(region, evidence.spans, true), geometry);
  const cv::Point2d reference(PointQuantile(core, 0), PointQuantile(core, 1));
  struct Proposal {
    double coordinate;
    Points visible;
    const Segment* segment;
  };
  std::array<std::vector<Proposal>, 4> proposals;
  for (const auto& segment : segments) {
    if (segment.kind != Kind::kBoundary && segment.kind != Kind::kOcclusion)
      continue;
    Points positions;
    for (int i = 0; i < 8; ++i)
      positions.push_back(segment.points.front() +
                          (segment.points.back() - segment.points.front()) * (i / 7.0));
    auto mapped = MapPoints(positions, geometry);
    const auto delta = mapped.back() - mapped.front();
    const bool horizontal = std::abs(delta.y) <= std::abs(delta.x);
    const int axis = horizontal ? 1 : 0;
    const double coordinate = PointQuantile(mapped, axis);
    const bool low = coordinate < Coordinate(reference, axis);
    const int side = axis * 2 + (low ? 0 : 1);
    const double limit = PointQuantile(core, axis, axis ? (low ? .2 : .8) : (low ? .15 : .85));
    if (low ? coordinate > limit : coordinate < limit)
      continue;
    proposals[side].push_back({coordinate, std::move(mapped), &segment});
  }
  for (int side = 0; side < 4; ++side) {
    const int axis = side / 2, other_axis = 1 - axis;
    auto& candidates = proposals[side];
    std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) {
      return a.segment->Length() > b.segment->Length();
    });
    std::vector<std::vector<Proposal>> groups;
    for (auto& proposal : candidates) {
      auto found = groups.end();
      for (auto i = groups.begin(); i != groups.end(); ++i) {
        std::vector<double> coordinates;
        for (const auto& p : *i)
          coordinates.push_back(p.coordinate);
        const auto first_line = Line(i->front().visible);
        const auto next_line = Line(proposal.visible);
        if (std::abs(first_line[0] * next_line[0] + first_line[1] * next_line[1]) > .995 &&
            std::abs(proposal.coordinate - Quantile(coordinates)) <
                (axis ? .035 : .015) * std::max(image.cols, image.rows)) {
          found = i;
          break;
        }
      }
      if (found == groups.end())
        groups.push_back({std::move(proposal)});
      else
        found->push_back(std::move(proposal));
    }
    std::optional<cv::Vec3d> best;
    double best_removed = 0;
    const auto frame = MapPoints(Frame(image.size(), 65), geometry);
    for (const auto& group : groups) {
      Points visible;
      std::vector<double> contrasts;
      for (const auto& proposal : group) {
        visible.insert(visible.end(), proposal.visible.begin(), proposal.visible.end());
        contrasts.push_back(proposal.segment->contrast);
      }
      const double contrast = Quantile(contrasts), coverage = Range(visible, other_axis);
      if (coverage < .16 * (axis ? image.cols : image.rows) && !(contrast > 20 && coverage >= 40))
        continue;
      auto line = Line(visible);
      if (line.dot(Homogeneous(reference)) < 0)
        line *= -1;
      std::vector<double> residuals;
      for (auto p : visible)
        residuals.push_back(line.dot(Homogeneous(p)));
      const bool occlusion = std::any_of(group.begin(), group.end(), [](const auto& proposal) {
        return proposal.segment->kind == Kind::kOcclusion;
      });
      if (occlusion) {
        // The occlusion boundary already includes a margin for every ink component.
        line[2] += std::max(0.0, -*std::min_element(residuals.begin(), residuals.end())) + .5;
      } else {
        line[2] -=
            std::max(0.0, Quantile(residuals, .95)) + .003 * (axis ? image.rows : image.cols);
      }
      if (side == 0 && region.left) {
        Points seam;
        for (int i = 0; i < 20; ++i) {
          const double y = image.rows * i / 19.0;
          seam.push_back({(-(*region.left)[2] - (*region.left)[1] * y) / (*region.left)[0], y});
        }
        if (!gutter_crop && std::abs(PointQuantile(MapPoints(seam, geometry), 0) -
                                     PointQuantile(visible, 0)) < .05 * image.cols)
          continue;
      }
      if (side == 0 && !region.left && region.boundaries.empty())
        continue;
      double outside = 0;
      for (const auto& box : protected_boxes)
        for (auto p : box)
          outside = std::max(outside, -line.dot(Homogeneous(p)));
      if (outside > .01 * std::max(image.cols, image.rows))
        continue;
      // Move a nearly touching boundary outward to retain the complete stroke.
      // A component that crosses farther into the background vetoes this edge.
      if (outside > 0)
        line[2] += outside + 1.5;
      const auto retained = ClipPolygon(frame, line);
      if (retained.size() < 3)
        continue;
      std::vector<cv::Point2f> original(frame.begin(), frame.end()),
          clipped(retained.begin(), retained.end());
      const double removed =
          std::abs(cv::contourArea(original)) - std::abs(cv::contourArea(clipped));
      if (removed > best_removed) {
        best_removed = removed;
        best = line;
      }
    }
    if (best)
      geometry.crops.push_back(*best);
  }
}

bool PaperRegion(const cv::Mat& background, const Region& region, const Evidence& evidence) {
  const auto points = RegionPoints(region, evidence.spans);
  std::vector<cv::Point2f> converted(points.begin(), points.end());
  std::vector<cv::Point> hull;
  std::vector<cv::Point2f> float_hull;
  cv::convexHull(converted, float_hull);
  for (auto p : float_hull)
    hull.emplace_back(cvRound(p.x), cvRound(p.y));
  cv::Mat mask(background.size(), CV_8U, cv::Scalar(0)), hsv;
  cv::fillConvexPoly(mask, hull, cv::Scalar(255));
  cv::cvtColor(background, hsv, cv::COLOR_BGR2HSV);
  int total = 0, paper = 0;
  for (int y = 0; y < background.rows; ++y) {
    const auto* selected = mask.ptr<uint8_t>(y);
    const auto* row = hsv.ptr<cv::Vec3b>(y);
    for (int x = 0; x < background.cols; ++x)
      if (selected[x]) {
        ++total;
        paper += row[x][1] < 55 && row[x][2] > 80;
      }
  }
  return total && paper >= .65 * total;
}

// Parallel text with no independent vertical evidence still supports deskew.
std::optional<double> TextSkew(const Evidence& evidence, const Region& region) {
  std::vector<double> angles, left, right;
  Points middles;
  for (int i : region.members)
    if (evidence.spans[i].kind == Kind::kText && evidence.spans[i].weight >= .5)
      middles.push_back(Mean(evidence.spans[i].points));
  if (middles.size() < 6)
    return {};
  const double split = PointQuantile(middles, 0);
  for (int i : region.members) {
    const auto& span = evidence.spans[i];
    if (span.kind != Kind::kText || span.weight < .5)
      continue;
    const double angle = span.angle;
    angles.push_back(angle);
    (Mean(span.points).x < split ? left : right).push_back(angle);
  }
  const double angle = Quantile(angles);
  std::vector<double> errors;
  for (double value : angles)
    errors.push_back(std::abs(value - angle));
  if (std::abs(angle) < 1 || std::abs(angle) > 13 || Quantile(errors, .8) > .9 ||
      (!left.empty() && !right.empty() && std::abs(Quantile(left) - Quantile(right)) > 1.5))
    return {};
  return angle;
}
}  // namespace

Result<unsigned> GeometryAxisQuarterTurns(const cv::Mat& source, const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  cv::Mat image;
  const double scale = std::min(1.0, 640.0 / std::max(source.cols, source.rows));
  cv::resize(source, image, {}, scale, scale, cv::INTER_AREA);
  const auto evidence = ExtractEvidence(image);
  std::array<double, 2> scores{};
  for (int axis = 0; axis < 2; ++axis) {
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    cv::Mat oriented, joined, labels, stats, centers;
    if (axis)
      cv::transpose(evidence.clean, oriented);
    else
      oriented = evidence.clean;
    cv::morphologyEx(oriented, joined, cv::MORPH_CLOSE, cv::Mat::ones(3, 23, CV_8U));
    const int count = cv::connectedComponentsWithStats(joined, labels, stats, centers);
    std::vector<bool> lines(count);
    for (int i = 1; i < count; ++i) {
      const auto* box = stats.ptr<int>(i);
      lines[i] = box[2] >= 40 && box[2] >= 3.5 * box[3] && box[3] >= 3 && box[3] <= 48;
    }
    for (int y = 0; y < oriented.rows; ++y) {
      const auto* pixels = oriented.ptr<uint8_t>(y);
      const auto* ids = labels.ptr<int>(y);
      for (int x = 0; x < oriented.cols; ++x)
        scores[axis] += pixels[x] && lines[ids[x]];
    }
  }
  return scores[1] > 1.8 * std::max(1.0, scores[0]) &&
                 scores[1] > .35 * cv::countNonZero(evidence.clean)
             ? 1u
             : 0u;
}

Result<PageGeometry> AnalyzeGeometry(const cv::Mat& source, const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  PageGeometry geometry;
  geometry.scale = std::min(1.0, 1024.0 / std::max(source.cols, source.rows));
  cv::Mat image;
  cv::resize(source, image, {}, geometry.scale, geometry.scale, cv::INTER_AREA);
  geometry.analysis_size = image.size();
  if (std::min(image.rows, image.cols) < 96)
    return geometry;
  const auto evidence = ExtractEvidence(image);
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  cv::Mat background;
  auto segments = ExtractSegments(image, evidence.ink, background);
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  const auto regions = SegmentRegions(image, evidence, segments, background);
  if (regions.empty() || !PaperRegion(background, regions.front(), evidence))
    return geometry;
  auto main_page = regions.front();
  if (auto occlusion = FindOccludingEdge(image, evidence, main_page))
    segments.push_back(std::move(*occlusion));
  std::array<std::vector<double>, 3> colors;
  for (auto point : RegionPoints(main_page, evidence.spans, true)) {
    const auto color = SampleColor(background, point);
    for (int channel = 0; channel < 3; ++channel)
      colors[channel].push_back(color[channel]);
  }
  for (int channel = 0; channel < 3; ++channel)
    geometry.paper_color[channel] = Quantile(colors[channel], .75);
  std::vector<Region> candidates{main_page};
  std::vector<double> text_x;
  for (int i : main_page.members)
    if (evidence.spans[i].kind == Kind::kText)
      text_x.push_back(Mean(evidence.spans[i].points).x);
  if (text_x.size() >= 16) {
    const double split = Quantile(text_x);
    for (bool left : {true, false}) {
      Region field{{}, main_page.left, main_page.right, 0, main_page.boundaries};
      for (int i : main_page.members)
        if ((Mean(evidence.spans[i].points).x < split) == left)
          field.members.push_back(i);
      field.score = RegionScore(field, evidence.spans);
      candidates.push_back(field);
      if (field.members.size() >= 12) {
        std::vector<double> y;
        for (int i : field.members)
          y.push_back(Mean(evidence.spans[i].points).y);
        const double y_split = Quantile(y);
        for (bool upper : {true, false}) {
          Region half{{}, main_page.left, main_page.right, 0, main_page.boundaries};
          for (int i : field.members)
            if ((Mean(evidence.spans[i].points).y < y_split) == upper)
              half.members.push_back(i);
          half.score = RegionScore(half, evidence.spans);
          candidates.push_back(std::move(half));
        }
      }
    }
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const auto& a, const auto& b) { return a.score > b.score; });
  bool fitted = false;
  for (const auto& region : candidates) {
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    const auto matrix = FitRegion(image, evidence, region, segments);
    if (!matrix)
      continue;
    fitted = true;
    geometry.matrix = *matrix;
    break;
  }
  if (fitted && cv::norm(cv::Mat(geometry.matrix - cv::Matx33d::eye())) > 1e-9) {
    geometry.kind = "perspective";
    const double angle = std::atan2(geometry.matrix(0, 1) - geometry.matrix(1, 0),
                                    geometry.matrix(0, 0) + geometry.matrix(1, 1)) *
                         kDegrees;
    if (std::abs(angle) >= 1 && std::abs(angle) <= 13) {
      const auto rotation = cv::getRotationMatrix2D({image.cols * .5f, image.rows * .5f}, angle, 1);
      const cv::Matx33d deskew(rotation.ptr<double>(0)[0], rotation.ptr<double>(0)[1],
                               rotation.ptr<double>(0)[2], rotation.ptr<double>(1)[0],
                               rotation.ptr<double>(1)[1], rotation.ptr<double>(1)[2], 0, 0, 1);
      double movement = 0;
      for (auto point : Frame(image.size()))
        movement = std::max(movement,
                            cv::norm(Transform(point, geometry.matrix) - Transform(point, deskew)));
      if (movement < .012 * std::max(image.cols, image.rows)) {
        geometry.matrix = deskew;
        geometry.kind = "deskew";
      }
    }
    FitResidualFlow(evidence, main_page, geometry);
    if (geometry.has_flow)
      geometry.kind = "perspective";
  } else if (!fitted) {
    const auto angle = TextSkew(evidence, main_page);
    if (angle) {
      const auto rotation =
          cv::getRotationMatrix2D({image.cols * .5f, image.rows * .5f}, *angle, 1);
      geometry.matrix = {rotation.ptr<double>(0)[0],
                         rotation.ptr<double>(0)[1],
                         rotation.ptr<double>(0)[2],
                         rotation.ptr<double>(1)[0],
                         rotation.ptr<double>(1)[1],
                         rotation.ptr<double>(1)[2],
                         0,
                         0,
                         1};
      geometry.kind = "deskew";
    }
  }
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  ChooseEdges(image, evidence, main_page, segments, geometry);
  return geometry;
}

Result<cv::Rect2d> GeometryBounds(const PageGeometry& geometry) {
  auto retained = MapPoints(Frame(geometry.analysis_size, 257), geometry);
  for (auto line : geometry.crops)
    retained = ClipPolygon(retained, line);
  if (retained.size() < 3)
    return Error{ErrorCode::kRejected, "invalid-document-geometry"};
  const double low_x = std::floor(PointQuantile(retained, 0, 0) / geometry.scale) - 3;
  const double low_y = std::floor(PointQuantile(retained, 1, 0) / geometry.scale) - 3;
  const double width = std::ceil(PointQuantile(retained, 0, 1) / geometry.scale) + 4 - low_x;
  const double height = std::ceil(PointQuantile(retained, 1, 1) / geometry.scale) + 4 - low_y;
  return cv::Rect2d{low_x, low_y, width, height};
}

Result<cv::Mat> ApplyGeometry(const cv::Mat& source,
                              const PageGeometry& geometry,
                              const cv::Scalar& fill,
                              const PhotoCancelled& cancelled) {
  RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
  if (geometry.kind == "unchanged" && geometry.crops.empty()) {
    if (std::max(source.cols, source.rows) <= 2480)
      return source;
    cv::Mat result;
    const double scale = 2480.0 / std::max(source.cols, source.rows);
    cv::resize(source, result, {cvRound(source.cols * scale), cvRound(source.rows * scale)}, 0, 0,
               cv::INTER_AREA);
    return result;
  }
  RK_ASSIGN_OR_RETURN(bounds, GeometryBounds(geometry));
  const double low_x = bounds.x, low_y = bounds.y;
  const double zoom = std::min(1.0, 2480.0 / std::max(bounds.width, bounds.height));
  const cv::Size size{std::min(2480, int(std::ceil(bounds.width * zoom))),
                      std::min(2480, int(std::ceil(bounds.height * zoom)))};
  const auto inverse = (Normalizer(geometry.analysis_size) * geometry.matrix).inv();
  const double length = std::max(geometry.analysis_size.width, geometry.analysis_size.height);
  // A 16-pixel grid keeps map storage below 1 MiB at the maximum canvas size.
  const cv::Size grid_size((size.width + 15) / 16 + 1, (size.height + 15) / 16 + 1);
  cv::Mat grid(grid_size, CV_32FC2);
  for (int y = 0; y < grid.rows; ++y) {
    auto* row = grid.ptr<cv::Vec2f>(y);
    for (int x = 0; x < grid.cols; ++x) {
      const double output_x = x * 16.0, output_y = y * 16.0;
      const double analysis_x = (output_x / zoom + low_x) * geometry.scale;
      const double analysis_y = (output_y / zoom + low_y) * geometry.scale;
      const double nx = (analysis_x - geometry.analysis_size.width * .5) / length;
      const auto [a, b] = FlowValues(nx, geometry);
      const double ny = (analysis_y - geometry.analysis_size.height * .5) / length * (1 + a) + b;
      const auto p = Transform({nx, ny}, inverse) / geometry.scale;
      row[x] = {float(p.x), float(p.y)};
    }
  }
  cv::Mat result(size, source.type());
  // Strip maps are allocated at the final output size, independently of the source frame.
  for (int top = 0; top < size.height; top += 128) {
    RK_RETURN_IF_ERROR(CheckCancelled(cancelled));
    const int rows = std::min(128, size.height - top);
    cv::Mat map(rows, size.width, CV_32FC2);
    for (int y = 0; y < rows; ++y) {
      auto* row = map.ptr<cv::Vec2f>(y);
      const int gy = (top + y) / 16;
      const float fy = ((top + y) % 16) / 16.0f;
      const auto* first = grid.ptr<cv::Vec2f>(gy);
      const auto* second = grid.ptr<cv::Vec2f>(gy + 1);
      const double analysis_y = ((top + y) / zoom + low_y) * geometry.scale;
      for (int x = 0; x < size.width; ++x) {
        const int gx = x / 16;
        const float fx = (x % 16) / 16.0f;
        row[x] = (first[gx] * (1 - fx) + first[gx + 1] * fx) * (1 - fy) +
                 (second[gx] * (1 - fx) + second[gx + 1] * fx) * fy;
        const double analysis_x = (x / zoom + low_x) * geometry.scale;
        for (auto line : geometry.crops)
          if (line[0] * analysis_x + line[1] * analysis_y + line[2] < 0) {
            row[x] = {-100, -100};
            break;
          }
      }
    }
    cv::remap(source, result.rowRange(top, top + rows), map, cv::noArray(), cv::INTER_LINEAR,
              cv::BORDER_CONSTANT, fill);
  }
  return result;
}
}  // namespace remotekit::photo
