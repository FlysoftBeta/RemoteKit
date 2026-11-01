#pragma once
#include <cmath>
#include <cstdint>
#include <optional>
namespace remotekit {
struct CaptureClock {double wall_ms,monotonic_ms,uncertainty_ms;};
inline std::optional<CaptureClock> MapCaptureClock(int64_t capture,int64_t frequency,
    int64_t before,int64_t after,double wall_ms,double source_uncertainty_ms) {
 if(capture<=0 || frequency<=0 || before<=0 || after<before || capture>after ||
    !std::isfinite(wall_ms) || !std::isfinite(source_uncertainty_ms) || source_uncertainty_ms<0)return {};
 const double midpoint=double(before)+double(after-before)/2;
 return CaptureClock{wall_ms+1000.0*(double(capture)-midpoint)/frequency,
   1000.0*double(capture)/frequency,source_uncertainty_ms+500.0*double(after-before)/frequency+0.001};
}
}
