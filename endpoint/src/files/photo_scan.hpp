#pragma once
#include "files/photo_processing.hpp"

#include <opencv2/core.hpp>

namespace remotekit::photo {
cv::Mat AnalysisLab(const cv::Mat&);

struct Paper {
  cv::Mat gain;
  cv::Mat mask;
  cv::Scalar color;
  float black_point = 45;
};

struct OrientationCrop {
  cv::Rect bounds;
  std::array<double, 4> probabilities{};
};

struct OrientationDecision {
  unsigned turns = 0;
  std::string state = "none";
  bool vertical = false;
  double dominance = 0;
  std::array<double, 2> scores{};
  std::array<double, 2> membership{};
  std::array<double, 4> probabilities{};
  std::vector<OrientationCrop> crops;
};

OrientationDecision FuseOrientation(bool vertical, const std::vector<OrientationCrop>&);
Result<OrientationDecision> AutomaticQuarterTurns(const cv::Mat&, const PhotoCancelled&);
Result<Paper> AnalyzePaper(const cv::Mat&, const PhotoCancelled&);
Result<void> EnhanceScan(cv::Mat&, const Paper&, const PhotoCancelled&);
}  // namespace remotekit::photo
