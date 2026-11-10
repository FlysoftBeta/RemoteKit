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

Result<std::optional<unsigned>> AutomaticQuarterTurns(const cv::Mat&, const PhotoCancelled&);
Result<Paper> AnalyzePaper(const cv::Mat&, const PhotoCancelled&);
Result<void> EnhanceScan(cv::Mat&, const Paper&, const PhotoCancelled&);
}  // namespace remotekit::photo
