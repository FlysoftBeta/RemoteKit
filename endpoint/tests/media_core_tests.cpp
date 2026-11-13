#include <cstdlib>
#include <iostream>
#include "media/comp_engine.hpp"

using namespace remotekit;
using namespace remotekit::media;
#define CHECK(x)                             \
  do {                                       \
    if (!(x)) {                              \
      std::cerr << __LINE__ << ": " #x "\n"; \
      std::exit(1);                          \
    }                                        \
  } while (false)
namespace {
int restriction_calls = 0;
int restriction_status = REMOTEKIT_SDK_OK;
int Restrictions(uint64_t peer, remotekit_rtc_source_restrictions* value) {
  CHECK(peer == 7);
  ++restriction_calls;
  value->max_fps = 24;
  return restriction_status;
}
class Host : public CompHost {
 public:
  Layout ObserveLayout(const SharedAtlasFrame&) override { std::abort(); }
  std::optional<PresentationBarrier::Key> RefreshKey(uint64_t) override { return {}; }
  void Invalidate(const char* reason) override { invalidation = reason; }
  void Reached(Milestone) override { std::abort(); }
  bool CanBegin() override {
    ++begin_checks;
    return true;
  }
  bool Current(uint64_t scope) override { return scope == 9; }
  std::string invalidation;
  uint32_t begin_checks = 0;
};
}  // namespace
int main() {
  EncoderSettings defaults;
  const auto qsv = SelectedEncoderSettings(defaults, "qsv");
  const auto nvenc = SelectedEncoderSettings(defaults, "nvenc");
  CHECK(qsv.target_usage == 7 && qsv.vbr);
  CHECK(nvenc.target_usage == 4 && !nvenc.vbr);
  defaults.target_usage = 2;
  defaults.vbr = false;
  defaults.target_usage_explicit = defaults.rate_control_explicit = true;
  const auto explicit_qsv = SelectedEncoderSettings(defaults, "qsv");
  CHECK(explicit_qsv.target_usage == 2 && !explicit_qsv.vbr);
  Sdk sdk;
  sdk.remotekit_rtc_get_source_restrictions = Restrictions;
  uint32_t observed_bitrate = 0, observed_fps = 0;
  EncoderSet encoders(sdk, {}, {},
                      {.adapter = []() -> std::optional<StreamingAdapter> { return {}; },
                       .rates =
                           [&](uint32_t bitrate, uint32_t fps) {
                             observed_bitrate = bitrate;
                             observed_fps = fps;
                           }});
  remotekit_rtc_encoder_callbacks callbacks{};
  EncoderSet::BindCallbacks(callbacks);
  CHECK(callbacks.struct_size == sizeof(callbacks));
  CHECK(callbacks.create(&encoders, 7, 1) == 1);
  remotekit_rtc_encoder_config config{};
  CHECK(callbacks.configure(&encoders, 1, &config) == 1);
  callbacks.set_rates(&encoders, 1, 12345, 17);
  CHECK(observed_bitrate == 12345 && observed_fps == 17);
  callbacks.request_keyframe(&encoders, 1);
  callbacks.destroy(&encoders, 1);
  struct Peer {
    EncoderSet* encoders;
  } peer{&encoders};
  EncoderSet::BindCallbacks<[](void* context) { return static_cast<Peer*>(context)->encoders; }>(
      callbacks);
  CHECK(callbacks.create(&peer, 7, 2) == 1);
  peer.encoders = nullptr;
  CHECK(callbacks.create(&peer, 7, 2) == REMOTEKIT_SDK_INVALID_STATE);
  encoders.SetError("test error");
  encoders.SenderStats({{"sample", 1}});
  CHECK(encoders.Snapshot()["senderRtcStats"]["sample"] == 1);
  CHECK(encoders.Completed() == 0 && encoders.Bytes() == 0 && encoders.Pending() == 0);
  encoders.Drain();
  CHECK(encoders.Snapshot()["senderRtcStats"].is_null());

  FrameAdmission admission;
  RenderSlots slots(admission);
  CompEngine engine(sdk, slots, encoders, {}, {150, 1920, 1080});
  CHECK(!engine.StartGeneration());
  Host host;
  CompStream stream{7, 31, 9, true};
  engine.SetPolicy(20, REMOTEKIT_RTC_BALANCED);
  engine.Rates(1000000, 60);
  CHECK(!engine.UpdateCadence(stream));
  CHECK(restriction_calls == 1);
  const auto diagnostics = engine.Diagnostics();
  CHECK(diagnostics.comp.officialMaxFps == 24);
  CHECK(diagnostics.comp.targetFps == 20);
  CHECK(diagnostics.effective_idle_ms == 150);
  CHECK(!engine.Step(stream, host));
  CHECK(host.begin_checks == 1);
  CHECK(!engine.Wait(stream));
  engine.Rates(0, 60);
  CHECK(!engine.UpdateCadence(stream));
  CHECK(engine.Diagnostics().comp.targetFps == 0);
  engine.ResetStream();
  restriction_status = REMOTEKIT_SDK_INVALID_STATE;
  auto failed = engine.UpdateCadence(stream);
  CHECK(failed && failed->error.code == ErrorCode::kInternal);
  CHECK(failed->error.message == "RTC source restrictions failed 2");
  CHECK(std::string_view(failed->invalidation).empty());
  stream.output_open = false;
  CHECK(!engine.UpdateCadence(stream));
  CHECK(!engine.Step(stream, host));
  CHECK(host.invalidation == "no-visible-views");
  engine.StopGeneration();
  CHECK(engine.Diagnostics().comp.targetFps == 0);
  auto waited = engine.Wait(stream);
  CHECK(waited && waited->error.code == ErrorCode::kInternal);
  CHECK(std::string_view(waited->invalidation) == "comp-pacing-failed");
  CHECK(!engine.StartGeneration());
  CHECK(engine.Diagnostics().source_interval_ms == 0);
}
