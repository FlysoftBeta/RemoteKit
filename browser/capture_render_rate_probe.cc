// Focused policy probe; runs the real Viz manager/throttler without a GPU.
#include <iostream>
#include <memory>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/feature_list.h"
#include "base/metrics/field_trial.h"
#include "base/task/single_thread_task_executor.h"
#include "base/time/time.h"
#include "components/viz/service/frame_sinks/compositor_frame_sink_support.h"
#include "components/viz/service/frame_sinks/frame_sink_manager_impl.h"
#include "components/viz/service/frame_sinks/frame_sink_throttler.h"
#include "mojo/core/embedder/embedder.h"

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  const bool enabled = !base::CommandLine::ForCurrentProcess()->HasSwitch("off");
  base::FieldTrialList field_trials;
  auto features = std::make_unique<base::FeatureList>();
  features->InitFromCommandLine(enabled ? "RemoteKitCaptureRenderRate:max_fps/30" : "",
                                enabled ? "" : "RemoteKitCaptureRenderRate");
  base::FeatureList::SetInstance(std::move(features));
  base::SingleThreadTaskExecutor tasks(base::MessagePumpType::DEFAULT);
  mojo::core::Init();

  viz::FrameSinkThrottler policy;
  policy.SetLastKnownVsync(base::Hertz(60), base::Hertz(60));
  policy.SetThrottleInterval(base::Hertz(20));
  policy.SetCadenceThrottleInterval(base::Hertz(30));
  CHECK(policy.begin_frame_interval() == base::Hertz(30));
  policy.SetCaptureRenderInterval(base::Hertz(30));
  CHECK(policy.begin_frame_interval() == base::Hertz(20));
  policy.SetThrottleInterval(base::Hertz(60));
  policy.SetCadenceThrottleInterval(base::Hertz(15));
  CHECK(policy.begin_frame_interval() == base::Hertz(15));
  policy.SetCadenceThrottleInterval(base::Hertz(60));
  CHECK(policy.begin_frame_interval() == base::Hertz(30));
  policy.SetCaptureRenderInterval(base::TimeDelta());
  CHECK(policy.begin_frame_interval() == base::Hertz(60));
  policy.SetThrottleInterval(base::Hertz(20));
  policy.SetCadenceThrottleInterval(base::Hertz(30));
  CHECK(policy.begin_frame_interval() == base::Hertz(30));

  viz::FrameSinkManagerImpl::InitParams params(nullptr, nullptr);
  viz::FrameSinkManagerImpl manager(params);
  const viz::FrameSinkId a(1, 1), b(2, 1), c(3, 1);
  for (const auto id : {a, b, c}) manager.RegisterFrameSinkId(id, false);
  auto parent = std::make_unique<viz::CompositorFrameSinkSupport>(nullptr, &manager, a, false);
  auto captured = std::make_unique<viz::CompositorFrameSinkSupport>(nullptr, &manager, b, false);
  manager.RegisterFrameSinkHierarchy(a, b);
  manager.RegisterFrameSinkHierarchy(b, c);
  manager.Throttle({a}, base::Hertz(20));
  manager.OnCaptureStarted(b);
  CHECK(parent->GetThrottlerForTesting().begin_frame_interval() == base::Hertz(20));
  CHECK(captured->GetThrottlerForTesting().begin_frame_interval() == (enabled ? base::Hertz(20) : base::TimeDelta()));
  // A newly registered child inherits capture admission/exemption correctly.
  auto child = std::make_unique<viz::CompositorFrameSinkSupport>(nullptr, &manager, c, false);
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == (enabled ? base::Hertz(20) : base::TimeDelta()));
  manager.StartThrottlingAllFrameSinks(base::Hertz(10));
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == (enabled ? base::Hertz(10) : base::TimeDelta()));
  manager.StopThrottlingAllFrameSinks();
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == (enabled ? base::Hertz(20) : base::TimeDelta()));
  manager.Throttle({}, base::TimeDelta());
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == (enabled ? base::Hertz(30) : base::TimeDelta()));
  manager.UnregisterFrameSinkHierarchy(b, c);
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == base::TimeDelta());
  manager.RegisterFrameSinkHierarchy(b, c);
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == (enabled ? base::Hertz(30) : base::TimeDelta()));
  manager.OnCaptureStopped(b);
  CHECK(captured->GetThrottlerForTesting().begin_frame_interval() == base::TimeDelta());
  CHECK(child->GetThrottlerForTesting().begin_frame_interval() == base::TimeDelta());
  CHECK(captured->GetThrottlerForTesting().throttling_allowed());
  CHECK(child->GetThrottlerForTesting().throttling_allowed());
  manager.UnregisterFrameSinkHierarchy(b, c);
  manager.UnregisterFrameSinkHierarchy(a, b);
  std::cout << "capture-render-rate " << (enabled ? "on" : "off")
            << ": explicit/cadence, capture stop, late child, unparent/reparent passed\n";
}
