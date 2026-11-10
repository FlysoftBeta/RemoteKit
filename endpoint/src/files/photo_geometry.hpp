#pragma once

#include "files/photo_processing.hpp"

#include <opencv2/core.hpp>

namespace remotekit::photo {

struct PageGeometry {
  cv::Size analysis_size;
  double scale = 1;
  cv::Matx33d matrix = cv::Matx33d::eye();
  cv::Vec<double, 6> flow{};
  cv::Vec2d flow_domain{};
  bool has_flow = false;
  cv::Scalar paper_color{248, 248, 248};
  std::vector<cv::Vec3d> crops;
  std::string kind = "unchanged";
};

Result<PageGeometry> AnalyzeGeometry(const cv::Mat&, const PhotoCancelled&);
Result<cv::Mat> ApplyGeometry(const cv::Mat&,
                              const PageGeometry&,
                              const cv::Scalar& paper_color,
                              const PhotoCancelled&);

}  // namespace remotekit::photo
