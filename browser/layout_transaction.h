#pragma once
#include "browser/view_registry.h"
#include "remotekit/endpoint/include/remotekit/atlas_dimensions.hpp"
namespace remotekit::browser {
struct LayoutPlan {
  ViewRegistry::Specifications specs;
  Atlas atlas;
  int width = 0, height = 0;
  float scale = 1;
  uint32_t alignment = 1;
  uint32_t output_width = 0, output_height = 0;
};
class LayoutTransaction {
 public:
  explicit LayoutTransaction(ViewRegistry& views) : views_(views) {}
  Result<LayoutPlan> Prepare(ViewRegistry::Specifications specs,
                             int width = 0,
                             int height = 0,
                             float scale = 0,
                             uint32_t alignment = 0) const;
  void Commit(LayoutPlan);
  float PageScale(const ViewSpec& spec) const {
    return spec.page_dsf > 0 ? spec.page_dsf : output_scale;
  }
  float output_scale = 1;
  uint32_t allocation_alignment = 1;
  int logical_width = 0, logical_height = 0;
  uint32_t output_width = 0, output_height = 0;

 private:
  ViewRegistry& views_;
};
}  // namespace remotekit::browser
