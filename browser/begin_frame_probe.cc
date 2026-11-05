// Deterministic CPU coverage of the real Viz scheduler; no GPU or renderer.
#include <iostream>
#include <memory>
#include <vector>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/check_op.h"
#include "base/command_line.h"
#include "base/feature_list.h"
#include "base/functional/bind.h"
#include "base/metrics/field_trial.h"
#include "base/memory/raw_ptr.h"
#include "base/task/single_thread_task_executor.h"
#include "base/test/allow_check_is_test_for_testing.h"
#include "base/test/bind.h"
#include "base/time/time.h"
#include "base/unguessable_token.h"
#include "components/viz/common/frame_sinks/begin_frame_source.h"
#include "components/viz/service/display/display_damage_tracker.h"
#include "components/viz/service/display/display_resource_provider_software.h"
#include "components/viz/service/display/display_scheduler.h"
#include "components/viz/service/display/surface_aggregator.h"
#include "components/viz/service/frame_sinks/external_begin_frame_source_mojo.h"
#include "components/viz/service/frame_sinks/frame_sink_manager_impl.h"
#include "components/viz/service/surfaces/surface_manager.h"
#include "gpu/command_buffer/service/scheduler.h"
#include "gpu/command_buffer/service/shared_image/shared_image_manager.h"
#include "gpu/command_buffer/service/sync_point_manager.h"
#include "mojo/core/embedder/embedder.h"
#include "mojo/public/cpp/bindings/associated_remote.h"

namespace viz {
class ExternalBeginFrameSourceMojoTestApi {
 public:
  static void EarlyNak(ExternalBeginFrameSourceMojo& source) {
    const auto id = *source.original_frame_id_;
    source.DispatchFrameCallback(BeginFrameAck(id.source_id, id.sequence_number, false));
  }
  static size_t RetiredCount(const ExternalBeginFrameSourceMojo& source) {
    return source.retired_frame_callbacks_.size();
  }
  static void MaybeComplete(ExternalBeginFrameSourceMojo& source) {
    source.MaybeProduceFrameCallback();
  }
};
}  // namespace viz

namespace {
class SourceClient : public viz::ExternalBeginFrameSourceClient {
 public:
  void OnNeedsBeginFrames(bool) override {}
};

class AdmissionObserver : public viz::BeginFrameObserverBase {
 public:
  explicit AdmissionObserver(base::RepeatingCallback<void(const viz::BeginFrameArgs&)> action)
      : action_(std::move(action)) {}
  void OnBeginFrameSourcePausedChanged(bool) override {}
  bool delivering = false;

 private:
  bool OnBeginFrameDerivedImpl(const viz::BeginFrameArgs& args) override {
    CHECK(!delivering);
    delivering = true;
    action_.Run(args);
    delivering = false;
    return true;
  }
  base::RepeatingCallback<void(const viz::BeginFrameArgs&)> action_;
};

class Damage : public viz::DisplayDamageTracker {
 public:
  using DisplayDamageTracker::DisplayDamageTracker;
  void SetMissing(bool missing) { SetRootFrameMissing(missing); }
  void UpdateRootFrameMissing() override { SetRootFrameMissing(false); }
  bool SurfaceHasUnackedFrame(const viz::SurfaceId&) const override { return false; }
};

class Scheduler : public viz::DisplayScheduler {
 public:
  Scheduler(viz::BeginFrameSource* source, base::SingleThreadTaskRunner* runner, Damage* damage)
      : DisplayScheduler(source, runner, viz::PendingSwapParams(1)) {
    SetDamageTracker(damage);
  }
  // Tests explicitly fire deadlines; all production transition logic runs.
  void ScheduleBeginFrameDeadline() override { ++deadline_schedules; }
  void Admit(const viz::BeginFrameArgs& args) { OnBeginFrameContinuation(args); }
  unsigned deadline_schedules = 0;
  bool active() const { return inside_begin_frame_deadline_interval_; }
  void Finish() {
    if (!missed_begin_frame_task_.IsCancelled())
      missed_begin_frame_task_.callback().Run();
    CHECK(active());
    OnBeginFrameDeadline();
  }
};

class Client : public viz::DisplaySchedulerClient {
 public:
  bool DrawAndSwap(const viz::DrawAndSwapParams&) override {
    CHECK(scheduler);
    ++swaps;
    scheduler->DidSwapBuffers();
    return true;
  }
  void DidFinishFrame(const viz::BeginFrameId& id,
                      viz::DisplaySchedulerDrawResult result) override {
    finished.push_back(id);
    std::cout << " finish " << id.ToString() << " result=" << static_cast<int>(result) << '\n';
  }
  raw_ptr<Scheduler> scheduler = nullptr;
  unsigned swaps = 0;
  std::vector<viz::BeginFrameId> finished;
};

struct Fixture {
  Fixture()
      : source(&source_client),
        manager(nullptr, 4u, 0),
        gpu_scheduler(&sync_points),
        provider(&images, &gpu_scheduler),
        aggregator(&manager, &provider, false),
        damage(&manager, &aggregator),
        scheduler(&source, base::SingleThreadTaskRunner::GetCurrentDefault().get(), &damage) {
    client.scheduler = &scheduler;
    scheduler.SetClient(&client);
    scheduler.SetVisible(true);
    damage.SetNewRootSurface(viz::SurfaceId(
        viz::FrameSinkId(1, 1), viz::LocalSurfaceId(1, base::UnguessableToken::Create())));
  }
  ~Fixture() {
    // Drain synthetic swap accounting before destroying the real scheduler.
    while (acks < client.swaps)
      Ack();
  }
  viz::BeginFrameArgs Args() {
    const auto time = origin + base::Milliseconds(20) * ++serial;
    return viz::BeginFrameArgs::Create(BEGINFRAME_FROM_HERE, 123, serial, time,
                                       time + base::Milliseconds(20), base::Milliseconds(20),
                                       viz::BeginFrameArgs::NORMAL);
  }
  void Issue(const viz::BeginFrameArgs& args) {
    source.OnBeginFrame(args);
    scheduler.SetNeedsOneBeginFrame(args, false);
  }
  void Ack() {
    ++acks;
    scheduler.DidReceiveSwapBuffersAck();
  }
  void Expect(const std::vector<viz::BeginFrameArgs>& args) {
    CHECK_EQ(args.size(), client.finished.size());
    for (size_t i = 0; i < args.size(); ++i)
      CHECK(client.finished[i] == args[i].frame_id);
  }
  SourceClient source_client;
  viz::ExternalBeginFrameSource source;
  viz::SurfaceManager manager;
  gpu::SharedImageManager images;
  gpu::SyncPointManager sync_points;
  gpu::Scheduler gpu_scheduler;
  viz::DisplayResourceProviderSoftware provider;
  viz::SurfaceAggregator aggregator;
  Damage damage;
  Client client;
  Scheduler scheduler;
  const base::TimeTicks origin = base::TimeTicks::Now();
  uint64_t serial = 0;
  unsigned acks = 0;
};

// Positive admission contract: alternate delivery types retain one immutable
// frame identity, while the next identity receives its own deadline/completion.
void SchedulerIdempotentAdmission() {
  Fixture f;
  auto a = f.Args();
  auto missed_a = a;
  missed_a.type = viz::BeginFrameArgs::MISSED;
  const auto initial_schedules = f.scheduler.deadline_schedules;
  f.scheduler.Admit(missed_a);
  CHECK(f.scheduler.active());
  CHECK_EQ(f.scheduler.deadline_schedules, initial_schedules + 1);
  f.scheduler.Admit(a);
  CHECK(f.scheduler.active());
  CHECK(f.client.finished.empty());
  CHECK_EQ(f.scheduler.deadline_schedules, initial_schedules + 1);
  f.scheduler.Finish();
  f.Expect({a});

  // Completion does not make the same current identity a new interval.
  const auto completed_schedules = f.scheduler.deadline_schedules;
  f.scheduler.Admit(a);
  CHECK(!f.scheduler.active());
  CHECK_EQ(f.scheduler.deadline_schedules, completed_schedules);
  f.Expect({a});

  auto b = f.Args();
  f.scheduler.Admit(b);
  CHECK(f.scheduler.active());
  CHECK_EQ(f.scheduler.deadline_schedules, completed_schedules + 1);
  auto missed_b = b;
  missed_b.type = viz::BeginFrameArgs::MISSED;
  f.scheduler.Admit(missed_b);
  CHECK(f.scheduler.active());
  CHECK_EQ(f.scheduler.deadline_schedules, completed_schedules + 1);
  f.Expect({a});
  auto c = f.Args();
  f.scheduler.Admit(c);
  CHECK(f.scheduler.active());
  CHECK_EQ(f.scheduler.deadline_schedules, completed_schedules + 2);
  f.Expect({a, b});
  f.scheduler.Finish();
  f.Expect({a, b, c});
  std::cout << "scheduler idempotent admission passed\n";
}

// The scheduler case above establishes this completion ordering. Exercise the
// corresponding real Mojo source state independently, without a GPU/Display.
// A's early NAK uses the exact production DispatchFrameCallback path, without
// pretending that its still-active display interval has already finished.
void MojoStaleCompletion() {
  base::test::AllowCheckIsTestForTesting();
  mojo::core::Init();
  viz::FrameSinkManagerImpl manager(viz::FrameSinkManagerImpl::InitParams(nullptr));
  const viz::FrameSinkId root(1, 1);
  manager.RegisterFrameSinkId(root, false);
  mojo::AssociatedRemote<viz::mojom::ExternalBeginFrameController> controller;
  viz::ExternalBeginFrameSourceMojo source(
      &manager, controller.BindNewEndpointAndPassDedicatedReceiver(), mojo::NullAssociatedRemote(),
      viz::BeginFrameSource::kNotRestartableId);
  manager.RegisterBeginFrameSource(&source, root);
  auto& observer = static_cast<viz::DisplayObserver&>(source);
  const auto now = base::TimeTicks::Now();
  auto make_args = [&](uint64_t sequence) {
    const auto time = now + base::Milliseconds(20) * sequence;
    return viz::BeginFrameArgs::Create(BEGINFRAME_FROM_HERE, 123, sequence, time,
                                       time + base::Milliseconds(20), base::Milliseconds(20),
                                       viz::BeginFrameArgs::NORMAL);
  };
  const auto a = make_args(2), b = make_args(3);
  std::vector<viz::BeginFrameId> callbacks;
  auto callback = [&] {
    return base::BindOnce([](std::vector<viz::BeginFrameId>* out,
                             const viz::BeginFrameAck& ack) { out->push_back(ack.frame_id); },
                          &callbacks);
  };
  source.IssueExternalBeginFrame(a, callback());
  viz::ExternalBeginFrameSourceMojoTestApi::EarlyNak(source);
  CHECK_EQ(callbacks.size(), 1u);
  CHECK(callbacks.front() == a.frame_id);
  source.IssueExternalBeginFrame(b, callback());
  manager.DidBeginFrame(root, b);
  manager.DidBeginFrame(viz::FrameSinkId(2, 2), a);
  CHECK_EQ(source.pending_frame_sinks_for_testing().size(), 1u);
  manager.DidFinishFrame(root, a);
  CHECK_EQ(source.pending_frame_sinks_for_testing().size(), 1u);
  observer.OnDisplayDidFinishFrame(a.frame_id, viz::DisplaySchedulerDrawResult::kDidNotDraw);
  CHECK_EQ(callbacks.size(), 1u);
  CHECK_EQ(viz::ExternalBeginFrameSourceMojoTestApi::RetiredCount(source), 0u);
  const auto* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("mojo-foreign"))
    observer.OnDisplayDidFinishFrame(viz::BeginFrameId(124, 3),
                                     viz::DisplaySchedulerDrawResult::kDidNotDraw);
  if (command->HasSwitch("mojo-future"))
    observer.OnDisplayDidFinishFrame(viz::BeginFrameId(123, 4),
                                     viz::DisplaySchedulerDrawResult::kDidNotDraw);
  if (command->HasSwitch("mojo-unproven-old"))
    observer.OnDisplayDidFinishFrame(a.frame_id, viz::DisplaySchedulerDrawResult::kDidNotDraw);
  // Before the fix, this hits !pending_ack_ with pending=A/original=B/incoming=B.
  observer.OnDisplayDidFinishFrame(b.frame_id, viz::DisplaySchedulerDrawResult::kDidNotDraw);
  if (command->HasSwitch("mojo-duplicate"))
    observer.OnDisplayDidFinishFrame(b.frame_id, viz::DisplaySchedulerDrawResult::kDidNotDraw);
  CHECK_EQ(callbacks.size(), 1u);
  manager.DidFinishFrame(root, b);
  CHECK_EQ(callbacks.size(), 2u);
  CHECK(callbacks.back() == b.frame_id);

  // Deferred early NAKs may never acquire a display interval. Bound exact
  // retirement memory, keep the next callback outstanding, and reclaim only
  // after a genuinely completed newer interval proves those old ones obsolete.
  for (uint64_t sequence = 10; sequence < 18; ++sequence) {
    source.IssueExternalBeginFrame(make_args(sequence), callback());
    viz::ExternalBeginFrameSourceMojoTestApi::EarlyNak(source);
  }
  CHECK_EQ(viz::ExternalBeginFrameSourceMojoTestApi::RetiredCount(source), 8u);
  source.IssueExternalBeginFrame(make_args(18), callback());
  viz::ExternalBeginFrameSourceMojoTestApi::MaybeComplete(source);
  CHECK_EQ(callbacks.size(), 10u);
  observer.OnDisplayDidFinishFrame(make_args(18).frame_id,
                                   viz::DisplaySchedulerDrawResult::kDidNotDraw);
  CHECK_EQ(callbacks.size(), 11u);
  CHECK_EQ(viz::ExternalBeginFrameSourceMojoTestApi::RetiredCount(source), 0u);
  // A callback may synchronously admit the next request in an embedder/test.
  // Completing C must not reset the ACK belonging to that newly admitted D.
  const auto c = make_args(20), d = make_args(21);
  source.IssueExternalBeginFrame(
      c,
      base::BindOnce(
          [](viz::ExternalBeginFrameSourceMojo* next_source, std::vector<viz::BeginFrameId>* out,
             viz::FrameSinkId sink, viz::BeginFrameArgs next, const viz::BeginFrameAck& ack) {
            out->push_back(ack.frame_id);
            next_source->IssueExternalBeginFrame(next,
                                                 base::BindOnce(
                                                     [](std::vector<viz::BeginFrameId>* entries,
                                                        const viz::BeginFrameAck& next_ack) {
                                                       entries->push_back(next_ack.frame_id);
                                                     },
                                                     out));
            // Test this source's reentrancy, not the manager's intentionally
            // non-reentrant ObserverList traversal.
            static_cast<viz::FrameSinkObserver*>(next_source)->OnFrameSinkDidBeginFrame(sink, next);
            static_cast<viz::DisplayObserver*>(next_source)
                ->OnDisplayDidFinishFrame(next.frame_id,
                                          viz::DisplaySchedulerDrawResult::kDidNotDraw);
          },
          base::Unretained(&source), &callbacks, root, d));
  manager.DidBeginFrame(root, c);
  observer.OnDisplayDidFinishFrame(c.frame_id, viz::DisplaySchedulerDrawResult::kDidNotDraw);
  manager.DidFinishFrame(root, c);
  CHECK_EQ(callbacks.size(), 12u);
  CHECK(callbacks.back() == c.frame_id);
  manager.DidFinishFrame(root, d);
  CHECK_EQ(callbacks.size(), 13u);
  CHECK(callbacks.back() == d.frame_id);
  manager.UnregisterBeginFrameSource(&source);
  // The supported non-waiting mode retires sink bookkeeping at display ACK.
  mojo::AssociatedRemote<viz::mojom::ExternalBeginFrameController> fast_controller;
  viz::ExternalBeginFrameSourceMojo fast_source(
      &manager, fast_controller.BindNewEndpointAndPassDedicatedReceiver(),
      mojo::NullAssociatedRemote(), viz::BeginFrameSource::kNotRestartableId, false);
  manager.RegisterBeginFrameSource(&fast_source, root);
  const auto fast = make_args(30);
  fast_source.IssueExternalBeginFrame(fast, callback());
  manager.DidBeginFrame(root, fast);
  static_cast<viz::DisplayObserver&>(fast_source)
      .OnDisplayDidFinishFrame(fast.frame_id, viz::DisplaySchedulerDrawResult::kDidNotDraw);
  CHECK_EQ(callbacks.size(), 14u);
  CHECK(fast_source.pending_frame_sinks_for_testing().empty());
  manager.UnregisterBeginFrameSource(&fast_source);
  std::cout << "real Mojo source retired-frame completion passed\n";
}

// Deliver current-frame completion from inside the real source's observer
// fanout, before IssueExternalBeginFrame returns. Previously the request ID
// was installed here but its callback was still null, exactly the released
// crash. Sink notifications around this completion also test admission order.
void MojoSynchronousAdmission(bool wait_for_sinks) {
  base::test::AllowCheckIsTestForTesting();
  mojo::core::Init();
  viz::FrameSinkManagerImpl manager(viz::FrameSinkManagerImpl::InitParams(nullptr));
  const viz::FrameSinkId root(1, 1), later(2, 2);
  manager.RegisterFrameSinkId(root, false);
  mojo::AssociatedRemote<viz::mojom::ExternalBeginFrameController> controller;
  viz::ExternalBeginFrameSourceMojo source(
      &manager, controller.BindNewEndpointAndPassDedicatedReceiver(), mojo::NullAssociatedRemote(),
      viz::BeginFrameSource::kNotRestartableId, wait_for_sinks);
  manager.RegisterBeginFrameSource(&source, root);
  auto& display = static_cast<viz::DisplayObserver&>(source);
  const auto now = base::TimeTicks::Now();
  auto args = [&](uint64_t sequence) {
    const auto time = now + base::Milliseconds(20) * sequence;
    return viz::BeginFrameArgs::Create(BEGINFRAME_FROM_HERE, 321, sequence, time,
                                       time + base::Milliseconds(20), base::Milliseconds(20),
                                       viz::BeginFrameArgs::NORMAL);
  };
  const auto a = args(5), b = args(6);
  unsigned callbacks = 0;
  auto action = base::BindLambdaForTesting([&](const viz::BeginFrameArgs& incoming) {
    CHECK_EQ(callbacks, 0u);
    if (incoming.frame_id == a.frame_id) {
      manager.DidBeginFrame(root, incoming);
      manager.DidFinishFrame(root, incoming);
      CHECK_EQ(callbacks, 0u);  // Temporarily empty is not admission finished.
    }
    display.OnDisplayDidFinishFrame(incoming.frame_id, viz::DisplaySchedulerDrawResult::kDrawn);
    CHECK_EQ(callbacks, 0u);
    if (base::CommandLine::ForCurrentProcess()->HasSwitch("mojo-sync-duplicate"))
      display.OnDisplayDidFinishFrame(incoming.frame_id, viz::DisplaySchedulerDrawResult::kDrawn);
    if (incoming.frame_id == a.frame_id) {
      // This sink only registers after the display has already completed.
      static_cast<viz::FrameSinkObserver&>(source).OnFrameSinkDidBeginFrame(later, incoming);
    }
  });
  AdmissionObserver observer(action);
  source.AddObserver(&observer);
  source.IssueExternalBeginFrame(
      a, base::BindLambdaForTesting([&](const viz::BeginFrameAck& ack) {
        CHECK(!observer.delivering);
        CHECK(ack.frame_id == a.frame_id && ack.has_damage);
        CHECK_EQ(callbacks, 0u);
        // Callback reentry is safe only after the old fanout has fully unwound.
        source.IssueExternalBeginFrame(
            b, base::BindLambdaForTesting([&](const viz::BeginFrameAck& next) {
              CHECK(!observer.delivering);
              CHECK(next.frame_id == b.frame_id && next.has_damage);
              ++callbacks;
            }));
        ++callbacks;
      }));
  if (wait_for_sinks) {
    CHECK_EQ(callbacks, 0u);
    CHECK_EQ(source.pending_frame_sinks_for_testing().size(), 1u);
    if (base::CommandLine::ForCurrentProcess()->HasSwitch("mojo-pending-duplicate"))
      display.OnDisplayDidFinishFrame(a.frame_id, viz::DisplaySchedulerDrawResult::kDrawn);
    static_cast<viz::FrameSinkObserver&>(source).OnFrameSinkDidFinishFrame(later, a);
  }
  CHECK_EQ(callbacks, 2u);
  CHECK(source.pending_frame_sinks_for_testing().empty());
  CHECK(!source.original_frame_id_for_testing());
  source.RemoveObserver(&observer);
  manager.UnregisterBeginFrameSource(&source);
  std::cout << "real Mojo synchronous admission passed wait=" << wait_for_sinks << '\n';
}
}  // namespace

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  base::FieldTrialList trials;
  auto features = std::make_unique<base::FeatureList>();
  features->InitFromCommandLine("DisplaySchedulerAsClient", "NoLateBeginFrames");
  base::FeatureList::SetInstance(std::move(features));
  base::SingleThreadTaskExecutor tasks;
  const auto* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("scheduler-admission")) {
    SchedulerIdempotentAdmission();
    return 0;
  }
  if (command->HasSwitch("mojo-sync") || command->HasSwitch("mojo-sync-fast") ||
      command->HasSwitch("mojo-sync-duplicate") || command->HasSwitch("mojo-pending-duplicate")) {
    MojoSynchronousAdmission(!command->HasSwitch("mojo-sync-fast"));
    return 0;
  }
  if (command->HasSwitch("mojo-stale") || command->HasSwitch("mojo-duplicate") ||
      command->HasSwitch("mojo-foreign") || command->HasSwitch("mojo-future") ||
      command->HasSwitch("mojo-unproven-old")) {
    MojoStaleCompletion();
    return 0;
  }
  {
    std::cout << "idle/missed/scheduler-client\n";
    Fixture f;
    auto a = f.Args();
    f.Issue(a);
    f.scheduler.Finish();
    f.Ack();
    auto b = f.Args();
    f.Issue(b);
    f.scheduler.Finish();
    CHECK(!f.scheduler.active());
    // Source delivery while idle, followed by the controller forcing one frame.
    auto c = f.Args();
    f.Issue(c);
    f.scheduler.Finish();
    f.Expect({a, b, c});
  }
  {
    std::cout << "gpu-busy/early-nak/deferred-resume\n";
    Fixture f;
    auto x = f.Args();
    f.Issue(x);
    f.scheduler.Finish();
    // X's swap is unacknowledged. A is the one frame allowed while busy.
    // With a missing root, ExternalBeginFrameSourceMojo returns A's early NAK
    // without finishing this scheduler interval. Its caller can now issue B.
    f.damage.SetMissing(true);
    auto a = f.Args();
    f.Issue(a);
    CHECK(f.scheduler.active());
    auto b = f.Args();
    f.Issue(b);  // GPU-busy defers source delivery of B.
    CHECK_EQ(f.client.finished.size(), 1u);
    f.Ack();
    // Resuming B first ends A synchronously. The Mojo request owner is already
    // B, so treating this completion as B's ACK would pollute pending_ack_.
    CHECK_EQ(f.client.finished.size(), 2u);
    CHECK(f.client.finished.back() == a.frame_id);
    std::cout << " stale completion=" << a.frame_id.ToString()
              << " while request=" << b.frame_id.ToString() << '\n';
    f.scheduler.Finish();
    f.Expect({x, a, b});
  }
  {
    std::cout << "resize/immediate-swap/deadline\n";
    Fixture f;
    auto a = f.Args();
    f.Issue(a);
    f.scheduler.ForceImmediateSwapIfPossible();
    CHECK(!f.scheduler.active());
    f.Ack();
    auto b = f.Args();
    f.Issue(b);
    f.scheduler.Finish();
    f.Expect({a, b});
  }
  std::cout << "3 scheduler lifecycle cases passed\n";
}
