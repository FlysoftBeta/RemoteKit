// CPU reproduction using the production compositor scroll predictor.
#include <cstdio>
#include "base/at_exit.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/feature_list.h"
#include "base/functional/callback_helpers.h"
#include "browser/service_input_policy.h"
#include "cc/metrics/event_metrics.h"
#include "third_party/blink/renderer/platform/widget/input/scroll_predictor.h"  // nogncheck

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  auto& command = *base::CommandLine::ForCurrentProcess();
  const bool service_policy = command.HasSwitch("service-policy");
  if (service_policy) {
    command.AppendSwitchASCII("disable-features", "CalculateNativeWinOcclusion");
    remotekit::browser::ConfigureServiceScrollPolicy(command);
    CHECK_EQ(command.GetSwitchValueASCII("disable-features"),
             "CalculateNativeWinOcclusion,ResamplingScrollEvents");
    // A caller's enable list must not override the fixed service policy.
    base::FeatureList::InitInstance("ResamplingScrollEvents",
                                   command.GetSwitchValueASCII("disable-features"));
    CHECK(!base::FeatureList::IsEnabled(blink::features::kResamplingScrollEvents));
    std::puts("service policy: resampling disabled; existing disable list preserved; explicit enable cannot override");
    return 0;
  }
  base::FeatureList::InitInstance("", "");
  using E = blink::WebInputEvent;
  using G = blink::WebGestureEvent;
  const auto origin = base::TimeTicks() + base::Seconds(1);
  for (int frame_lag : {-10, 0, 10}) {
    blink::ScrollPredictor predictor;
    G begin(E::Type::kGestureScrollBegin, 0, origin,
            blink::WebGestureDevice::kTouchscreen);
    predictor.ResetOnGestureScrollBegin(begin);
    float applied = 0;
    auto update = [&](float delta, int source_ms, bool momentum) {
      G event(E::Type::kGestureScrollUpdate, 0,
              origin + base::Milliseconds(source_ms),
              blink::WebGestureDevice::kTouchscreen);
      event.data.scroll_update.delta_y = delta;
      event.data.scroll_update.inertial_phase = momentum
          ? G::InertialPhaseState::kMomentum
          : G::InertialPhaseState::kNonMomentum;
      auto queued = std::make_unique<blink::EventWithCallback>(
          std::make_unique<blink::WebCoalescedInputEvent>(event, ui::LatencyInfo()),
          base::NullCallback(), nullptr);
      queued = predictor.ResampleScrollEvents(std::move(queued),
          origin + base::Milliseconds(source_ms + frame_lag),
          base::Milliseconds(20), nullptr, nullptr);
      applied += static_cast<const G&>(queued->event()).data.scroll_update.delta_y;
    };
    for (int i = 1; i <= 8; ++i) update(-27.5f, i * 20, false);
    const float direct = applied;
    update(-172.3003f, 383, true);
    update(-117.5145f, 1500, true);
    std::printf("frame_offset_ms=%d direct=%.4f momentum=%.4f total=%.4f expected=-509.8148 resampling=%d\n",
        frame_lag, direct, applied - direct, applied,
        predictor.ShouldResampleScrollEvents());
  }
}
