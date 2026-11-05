#include <cstdlib>
#include <iostream>
#include <limits>
#include "remotekit/core.hpp"
#include "remotekit/touch_clock.hpp"
#include "remotekit/sampling.hpp"
#include "remotekit/idle_idr.hpp"
#include "remotekit/tail_refresh.hpp"
#include "remotekit/atlas_dimensions.hpp"
#include "remotekit/coordinate_readiness.hpp"
using namespace remotekit;
#define CHECK(x)                                                       \
  do {                                                                 \
    if (!(x)) {                                                        \
      std::cerr << __FILE__ << ':' << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                                    \
    }                                                                  \
  } while (false)
static bool Overlap(const PixelRect& a, const PixelRect& b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
static void TailAttemptTests() {
  using State = TailIdrAttempt::State;
  TailIdrAttempt timed_out;
  CHECK(timed_out.CancelWaiting() && !timed_out.BeginEncoding());  // Late SDK delivery is rejected.
  timed_out.Finish(true);
  CHECK(timed_out.state() == State::canceled);
  TailIdrAttempt inflight;
  CHECK(inflight.BeginEncoding() && !inflight.BeginEncoding());
  CHECK(!inflight.CancelWaiting());  // A long GPU queue cannot trigger duplicate attempts.
  inflight.Finish(true);
  inflight.Finish(false);
  CHECK(inflight.state() == State::succeeded);
  CHECK(!inflight.BeginEncoding());  // Already satisfied token can never encode again.
  TailIdrAttempt failed;
  CHECK(failed.BeginEncoding());
  failed.Finish(false);
  failed.Finish(true);
  CHECK(failed.state() == State::failed);
  // Exercise the real forwarding lease, including release before Encode,
  // rejected SDK submit, worker drops/close, success, and superseded late tags.
  struct Pool {
    int refs = 1;
    uint64_t cookie = 77;
  };
  Pool pool;
  remotekit_rtc_frame source{};
  source.frame_id = pool.cookie;
  source.release_context = &pool;
  source.retain = [](void* context, uint64_t cookie) {
    auto* p = static_cast<Pool*>(context);
    CHECK(cookie == p->cookie);
    ++p->refs;
  };
  source.release = [](void* context, uint64_t cookie) {
    auto* p = static_cast<Pool*>(context);
    CHECK(cookie == p->cookie && p->refs > 0);
    --p->refs;
  };
  for (int outcome = 0; outcome < 5; ++outcome) {
    auto attempt = std::make_shared<TailIdrAttempt>();
    auto tagged = TailRefreshLease::Wrap(source, attempt);
    CHECK(pool.refs == 2);
    if (outcome == 0) {  // SDK rejects, or drops source before Encode.
      tagged.release(tagged.release_context, tagged.frame_id);
      CHECK(attempt->state() == State::failed && pool.refs == 1);
      continue;
    }
    if (outcome == 1) {  // Superseded source or timeout; no GPU queue admission.
      CHECK(attempt->CancelWaiting() && !TailRefreshLease::BeginEncoding(tagged));
      tagged.release(tagged.release_context, tagged.frame_id);
      CHECK(attempt->state() == State::canceled && pool.refs == 1);
      continue;
    }
    CHECK(TailRefreshLease::BeginEncoding(tagged));
    tagged.retain(tagged.release_context, tagged.frame_id);
    CHECK(pool.refs == 3);
    tagged.release(tagged.release_context, tagged.frame_id);
    CHECK(pool.refs == 2);  // SDK releases original.
    if (outcome == 2)
      TailRefreshLease::Finish(tagged, false);  // Queue replacement/worker cancellation.
    if (outcome == 3)
      TailRefreshLease::Finish(tagged, true);  // Actual keyframe encoded and SDK accepted.
    tagged.release(tagged.release_context, tagged.frame_id);  // Includes fallback worker close.
    CHECK(pool.refs == 1 && attempt->state() == (outcome == 3 ? State::succeeded : State::failed));
  }
  CHECK(TailRefreshLease::BeginEncoding(source));  // Normal frames are unaffected.
  TailRefreshLease::Finish(source, true);
  CHECK(pool.refs == 1);
}
int main() {
  TailAttemptTests();
  auto legacy_atlas = AtlasAllocationDimensions(1928, 1088, 1, 1);
  auto aligned_atlas = AtlasAllocationDimensions(1928, 1088, 1, 16);
  CHECK(legacy_atlas && legacy_atlas->width == 1928 && legacy_atlas->height == 1088);
  CHECK(aligned_atlas && aligned_atlas->width == 1936 && aligned_atlas->height == 1088);
  auto legacy_odd = AtlasAllocationDimensions(129, 127, 1.25f, 1);
  auto aligned_odd = AtlasAllocationDimensions(129, 127, 1.25f, 16);
  CHECK(legacy_odd && legacy_odd->width == 162 && legacy_odd->height == 160);
  CHECK(aligned_odd && aligned_odd->width == 176 && aligned_odd->height == 160);
  auto tablet_atlas = AtlasAllocationDimensions(828, 1188, 2, 16);
  CHECK(tablet_atlas && tablet_atlas->width == 1664 && tablet_atlas->height == 2384);
  auto split_atlas = AtlasAllocationDimensions(2756, 1188, 2, 16);
  CHECK(split_atlas && split_atlas->width == 5520 && split_atlas->height == 2384);
  CHECK(AtlasAllocationDimensions(4096, 4096, 1, 16));  // Exactly 16Mi pixels.
  CHECK(AtlasAllocationDimensions(4097, 4090, 1, 1));
  CHECK(!AtlasAllocationDimensions(4097, 4090, 1, 16));  // Padding itself exceeds the budget.
  auto edge_atlas = AtlasAllocationDimensions(8191, 16, 1, 16);
  CHECK(edge_atlas && edge_atlas->width == 8192);
  CHECK(!AtlasAllocationDimensions(8192, 16, 1.25f, 16));
  CHECK(!AtlasAllocationDimensions(16, 16, std::numeric_limits<float>::quiet_NaN(), 16));
  CHECK(!AtlasAllocationDimensions(16, 16, 1, 8));
  CoordinateReadiness readiness;
  readiness.Set(7, {{"1", true}, {"2", false}});
  CHECK(readiness.Allows("1", 7) && !readiness.Allows("2", 7));
  CHECK(!readiness.Allows("1", 6) && !readiness.Allows("missing", 7));
  readiness.Set(8, {{"1", true}, {"2", true}});
  CHECK(readiness.Allows("2", 8) && !readiness.Allows("2", 7));
  readiness.Clear();
  CHECK(!readiness.Allows("1", 8));
  IdleIdrPolicy tail(150);
  CHECK(tail.Observe(1, 1, 100, 0) && tail.delay_ms() == 150);
  CHECK(tail.Observe(1, 2, 200, 125) && tail.delay_ms() == 375);
  CHECK(!tail.Observe(1, 3, 200, 200) && tail.delay_ms() == 375);
  CHECK(tail.Observe(1, 4, 300, 250) && tail.delay_ms() == 375);
  CHECK(tail.Observe(1, 5, 400, 3000) && tail.delay_ms() == 150);
  CHECK(tail.Observe(2, 1, 500, 4000) && tail.delay_ms() == 150);
  CHECK(tail.Observe(2, 2, 600, 5000) && tail.delay_ms() == 1000);
  IdleIdrPolicy normal(150);
  normal.Observe(1, 1, 1, 0);
  normal.Observe(1, 2, 2, 40);
  CHECK(normal.delay_ms() == 150);
  IdleIdrPolicy disabled(0);
  disabled.Observe(1, 1, 1, 0);
  disabled.Observe(1, 2, 2, 500);
  CHECK(disabled.delay_ms() == 0 && !disabled.TailDue(10000));
  IdleIdrPolicy once(150);
  CHECK(!once.TailDue(1000));  // No source content to refresh yet.
  CHECK(once.Observe(1, 1, 100, 1000));
  CHECK(!once.TailDue(1149) && once.TailDue(1150));
  CHECK(!once.CompleteRefresh(1150, false) && once.TailDue(1151));  // Busy/failure retries.
  CHECK(once.CompleteRefresh(1151, true) && !once.TailDue(10000));
  CHECK(!once.CompleteRefresh(10000, true));  // Later recovery IDRs cannot rearm the tail.
  CHECK(!once.Observe(1, 2, 100, 10001) && !once.TailDue(20000));  // Same capture, new atlas ID.
  CHECK(once.Observe(1, 3, 200, 20000));  // New content rearms after the completed tail.
  CHECK(!once.CompleteRefresh(20100, true) &&
        once.TailDue(20150));  // Early recovery preserves tail.
  CHECK(once.CompleteRefresh(20150, true) &&
        !once.TailDue(30000));            // Due recovery can satisfy tail.
  CHECK(once.Observe(2, 3, 200, 30000));  // Resource generation is a new source incarnation.
  CHECK(once.TailDue(30150));
  CHECK(once.Observe(2, 4, 300, 30100) &&
        !once.TailDue(30399));  // Fresh content supersedes pending tail.
  CHECK(once.TailDue(30400));   // Low-fps 3x interval rule remains active.
  IdleIdrPolicy no_capture_clock(150);
  CHECK(no_capture_clock.Observe(1, 1, 0, 0));
  CHECK(no_capture_clock.CompleteRefresh(150, true));
  CHECK(!no_capture_clock.Observe(1, 1, 0, 1000) && !no_capture_clock.TailDue(1000));
  CHECK(no_capture_clock.Observe(1, 2, 0, 3000) && no_capture_clock.TailDue(3150));
  CHECK(H264RateLimits(31).bitrate_bps == 14000000 && H264RateLimits(31).cpb_kb == 1750);
  CHECK(H264FrameRateLimit(1936, 1088, 42) == 63);
  CHECK(H264FrameRateLimit(1937, 1088, 42) == 62);  // Ceil each dimension to macroblocks.
  CHECK(H264FrameRateLimit(1920, 1080, 42) == 64);
  CHECK(H264FrameRateLimit(4096, 2160, 51) == 28);
  CHECK(H264FrameRateLimit(4096, 2304, 51) == 26);  // Exactly MaxFS.
  CHECK(H264FrameRateLimit(4096, 2305, 51) == 0);
  CHECK(H264FrameRateLimit(4096, 4096, 52) == 0);
  CHECK(H264FrameRateLimit(16, 16, 52) == 2073600);
  CHECK(H264FrameRateLimit(8192, 16, 51) ==
        1920);  // Codec limit, independent of the hardware 4096 cap.
  CHECK(H264FrameRateLimit(8688, 16, 51) == 1810);  // 543 MB: 543^2 <= 8 * MaxFS.
  CHECK(H264FrameRateLimit(8689, 16, 51) == 0);  // Ceil to 544 MB exceeds the Table A-1 axis bound.
  CHECK(H264FrameRateLimit(16, 8689, 51) == 0);
  CHECK(H264FrameRateLimit(0, 1080, 42) == 0 && H264FrameRateLimit(1920, 0, 42) == 0);
  CHECK(H264FrameRateLimit(1936, 1088, 0) == 0 && H264FrameRateLimit(1936, 1088, 43) == 0);
  CHECK(H264FrameRateLimit(UINT32_MAX, UINT32_MAX, 52) == 0);  // No ceil overflow.
  auto full = FitH264Sampling(1928, 1088, 60, 42);
  CHECK(full.width == 1928 && full.height == 1088 && full.scale == 1);
  auto explicit_size = FitH264Sampling(3840, 2160, 60, 51, 1920, 1080);
  CHECK(explicit_size.width == 1920 && explicit_size.height == 1080 && explicit_size.scale == .5);
  auto tablet = FitH264Sampling(1656, 2376, 60, 42);
  CHECK(tablet.scale > .5 && tablet.scale < 1 && tablet.width % 2 == 0 && tablet.height % 2 == 0);
  CHECK(((tablet.width + 15) / 16) * ((tablet.height + 15) / 16) <= 8704);
  auto legacy = FitH264Sampling(1928, 1088, 60, 31);
  CHECK(((legacy.width + 15) / 16) * ((legacy.height + 15) / 16) * 60 <= 108000);
  CHECK(FitH264Sampling(1920, 1080, 60, 0).width == 0);
  auto full_4k = FitH264Sampling(3856, 2176, 50, 52);
  CHECK(full_4k.width == 3856 && full_4k.height == 2176 && full_4k.scale == 1);
  auto limited_4k = FitH264Sampling(3856, 2176, 60, 51);
  auto lower_cadence = FitH264Sampling(3856, 2176, 50, 51);
  CHECK(lower_cadence.width > limited_4k.width && lower_cadence.scale < 1);
  CHECK(std::string(limited_4k.limitation) == "receiver-level-macroblock-rate");
  KeyInput unicode_key;
  unicode_key.text = u"\U0001f600";
  CHECK(ValidateInput(unicode_key));
  unicode_key.text = u"abcde";
  CHECK(!ValidateInput(unicode_key));
  unicode_key.text = std::u16string(1, 0xd800);
  CHECK(!ValidateInput(unicode_key));

  CHECK(ValidateInput(ImeSet{u"A\U0001f600中", 1, 3}));
  CHECK(!ValidateInput(ImeSet{u"A\U0001f600中", 2, 3}));
  CHECK(!ValidateInput(ImeSet{u"abc", 3, 2}));
  CHECK(!ValidateInput(ImeSet{u"abc", 0, 4}));
  CHECK(!ValidateInput(ImeCommit{std::u16string(1, 0xd800)}));
  CHECK(!ValidateInput(ImeCommit{std::u16string(1, 0xdc00)}));
  CHECK(ValidateInput(ImeCommit{u"你好\U0001f600"}));
  CHECK(ValidateInput(ImeCancel{}));
  CHECK(ValidateInput(ImeFinish{}));
  CHECK(!ValidateInput(TouchInput{TouchInput::Action::start, {{1, 1, 1, .5}, {1, 2, 2, .5}}}));
  TouchInput sampled{TouchInput::Action::move, {{1, 1, 1, .5}}};
  sampled.clock = TouchInput::Clock{"gesture:1", true, 32000, 1700000000000000LL};
  sampled.samples = {{16000, {{1, 1, 1, .5}}}, {24000, {{1, 1, 2, .5}}}};
  CHECK(ValidateInput(sampled));
  sampled.samples[1].elapsed_us = 8000;
  CHECK(!ValidateInput(sampled));
  sampled.samples[1].elapsed_us = 40000;
  CHECK(!ValidateInput(sampled));
  sampled.samples.clear();
  sampled.clock->elapsed_us = -1;
  CHECK(!ValidateInput(sampled));
  sampled.clock->elapsed_us = 32000;
  sampled.clock->sequence_id.clear();
  CHECK(!ValidateInput(sampled));
  CHECK(TouchStartAgeUs(1000000, 1010000).value() == 10000);
  CHECK(!TouchStartAgeUs(1000000, 999000 - 1));
  CHECK(!TouchStartAgeUs(1000000, 6000001));
  CHECK(TouchElapsedValid(16000, 32000, 40000, true));
  CHECK(!TouchElapsedValid(32000, 16000, 40000, true));
  CHECK(!TouchElapsedValid(16000, 48000, 40000, true));
  CHECK(TouchElapsedValid(16000, 48000, 40000, false));
  // Long gestures use monotonic age; there is no wall argument to re-anchor.
  CHECK(TouchElapsedValid(3600000000LL, 3600016000LL, 3600020000LL, true));
  CHECK(!ValidateInput(WheelInput{0, 0, std::numeric_limits<double>::infinity(), 0, 0}));
  std::vector<PackItem> items{{1, 60, 40, 2}, {2, 40, 70, 1}, {3, 20, 20, 1.5}, {4, 12, 18, 1}};
  auto atlas = PackAtlas(160, 128, 2, items);
  CHECK(atlas);
  auto again = PackAtlas(160, 128, 2, items);
  CHECK(again && again.value().placements.size() == items.size());
  for (std::size_t i = 0; i < atlas.value().placements.size(); ++i) {
    auto a = atlas.value().placements[i];
    CHECK(a.outer == again.value().placements[i].outer);
    CHECK(a.outer.x >= 0 && a.outer.y >= 0 && a.outer.x + a.outer.width <= 160 &&
          a.outer.y + a.outer.height <= 128);
    for (std::size_t j = 0; j < i; ++j)
      CHECK(!Overlap(a.outer, atlas.value().placements[j].outer));
  }
  CHECK(PackAtlas(10, 10, 0, {{1, 11, 1, 1}}).error().code == ErrorCode::kLimitExceeded);
  CHECK(PackAtlas(10, 10, 1, {{1, 9, 9, 1}}).error().code == ErrorCode::kLimitExceeded);
  CHECK(!PackAtlas(10, 10, 0, {{1, 6, 10, 1}, {2, 6, 10, 1}}));
  CHECK(!PackAtlas(10, 10, 0, {{1, 1, 1, 1}, {1, 1, 1, 1}}));
  CHECK(!PackAtlas(10, 10, 0, {{1, 1, 1, 0}}));
  CHECK(!PackAtlas(10, 10, std::numeric_limits<int>::max(), {{1, 1, 1, 1}}));
  // Many deterministic layouts exercise MaxRects splitting and pruning.
  for (int n = 1; n <= 40; ++n) {
    std::vector<PackItem> small;
    for (int i = 0; i < n; ++i)
      small.push_back({static_cast<WebViewId>(i + 1), 3 + (i * 7) % 19, 3 + (i * 11) % 17, 1});
    auto packed = PackAtlas(256, 256, 1, small);
    CHECK(packed);
    for (std::size_t i = 0; i < packed.value().placements.size(); ++i)
      for (std::size_t j = 0; j < i; ++j)
        CHECK(!Overlap(packed.value().placements[i].outer, packed.value().placements[j].outer));
  }
  std::cout << "endpoint core tests passed\n";
}
