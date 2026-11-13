#include "media/comp_engine.hpp"
#include "platform/process.hpp"
#include "protocol/atlas_plan.hpp"
#include "resources.hpp"
#include "video.hpp"

// Windows headers after windows.h, which the media core includes.
#include <bcrypt.h>
#include <tlhelp32.h>

#include <fstream>
#include <iostream>
#include <thread>

using namespace remotekit;
using namespace remotekit::media;
namespace {
std::mutex output_mutex;
void Emit(Json value) {
  std::lock_guard lock(output_mutex);
  std::cout << value.dump() << std::endl;
}
void Check(int status, const char* operation) {
  if (status)
    throw std::runtime_error(std::string(operation) + " SDK status " + std::to_string(status));
}
Json Modules() {
  Json paths = Json::array();
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
  if (snapshot == INVALID_HANDLE_VALUE)
    throw std::runtime_error("loaded module snapshot failed");
  MODULEENTRY32W module{sizeof(module)};
  if (Module32FirstW(snapshot, &module)) {
    do {
      paths.push_back(Utf8(module.szExePath));
    } while (Module32NextW(snapshot, &module));
  }
  CloseHandle(snapshot);
  return paths;
}
class Tenant final : public CompHost {
 public:
  Tenant(Sdk& sdk,
         const StreamingAdapter& adapter,
         const Json& config,
         const Json& tenant,
         schedlab::Resources& resources,
         FrameAdmission& admission)
      : sdk_(sdk),
        adapter_(adapter),
        index_(tenant.at("tenant")),
        directory_(Utf8Path(config.at("out")) / ("browser-" + std::to_string(index_))),
        browser_path_(Utf8Path(config.at("browser"))),
        fixture_(tenant.at("url")),
        width_(tenant.at("width")),
        height_(tenant.at("height")),
        dpr_(tenant.at("dpr")),
        slots_(admission) {
    const auto out = Utf8Path(config.at("out"));
    trace_ = ServerTrace::Create(std::to_string(index_), std::to_string(index_),
                                 ServerTrace::FlushMode::kAppend);
    if (!trace_)
      throw std::runtime_error("trace creation failed");
    slots_.SetTrace(trace_);
    snapshots_.open(out / ("snapshots-" + std::to_string(index_) + ".jsonl"));
    frames_.open(out / ("encoded-" + std::to_string(index_) + ".jsonl"));
    EncoderSettings settings;
    const auto& rate = config.at("media");
    settings.bitrate = rate.at("bitrate");
    settings.max_bitrate = rate.at("maxBitrate");
    encoders_ = std::make_unique<EncoderSet>(
        sdk_, settings, trace_,
        EncoderSet::Host{[this] { return std::optional<StreamingAdapter>(adapter_); },
                         [this](uint64_t) -> EncoderSet::Completion {
                           return [this](uint32_t rtp, uint64_t epoch, size_t bytes, bool key,
                                         const remotekit_rtc_frame& frame) {
                             std::lock_guard lock(frames_mutex_);
                             frames_ << Json{{"wireRtpTimestamp", rtp},
                                             {"frameId", frame.frame_id},
                                             {"layoutEpoch", epoch},
                                             {"bytes", bytes},
                                             {"key", key},
                                             {"beginQpc", RenderSlots::BeginQpc(frame)},
                                             {"qpc", QpcNow()},
                                             {"qpcFrequency", QpcFrequency()}}
                                            .dump()
                                     << '\n';
                           };
                         },
                         {},
                         {},
                         [this](uint32_t bitrate, uint32_t fps) { engine_->Rates(bitrate, fps); }});
    engine_ = std::make_unique<CompEngine>(
        sdk_, slots_, *encoders_, trace_,
        CompConfig{rate.at("idleIdrMs"), rate.at("maxEncodeWidth"), rate.at("maxEncodeHeight")});
    engine_->SetPolicy(60, REMOTEKIT_RTC_BALANCED);
    fs::create_directories(directory_);
    try {
      Launch();
      resources.AddRoot("browser-" + std::to_string(index_), browser_.Pid());
      Rpc({{"method", "view.create"},
           {"session", "1"},
           {"view", "1"},
           {"width", width_},
           {"height", height_},
           {"device", "desktop"},
           {"device_scale_factor", dpr_},
           {"visible", false},
           {"url", fixture_}});
      auto plan = protocol::PlanAtlas({{1, width_, height_, 1.0}}, float(dpr_), 1);
      if (!plan)
        throw std::runtime_error("atlas planning failed");
      Rpc({{"method", "output.configure"},
           {"width", plan->width},
           {"height", plan->height},
           {"device_scale", plan->scale},
           {"allocation_alignment", 1},
           {"viewConfigs", Json::array({{{"session", "1"},
                                         {"view", "1"},
                                         {"width", width_},
                                         {"height", height_},
                                         {"device", "desktop"},
                                         {"device_scale_factor", dpr_},
                                         {"visible", true},
                                         {"occludedBottom", 0},
                                         {"occlusionRevision", "0"}}})}});

      CreatePeer(rate);
      Emit({{"type", "tenant"},
            {"tenant", index_},
            {"pid", browser_.Pid()},
            {"adapter", AdapterLuid(adapter_.luid)},
            {"atlasWidth", plan->physical.width},
            {"atlasHeight", plan->physical.height}});
      media_ = std::thread([this] {
        try {
          MediaLoop();
        } catch (const std::exception& error) {
          failed_ = true;
          Emit({{"type", "fatal"}, {"tenant", index_}, {"message", error.what()}});
        }
      });
    } catch (...) {
      Stop();
      throw;
    }
  }
  ~Tenant() { Stop(); }
  void Offer(const std::string& sdp) {
    Check(sdk_.remotekit_rtc_set_remote_description(peer_, 1, sdp.data(), sdp.size()), "offer");
  }
  void Activity(double epoch) {
    const auto qpc =
        QpcNow() + static_cast<int64_t>((epoch - schedlab::EpochMs()) * QpcFrequency() / 1000);
    engine_->InputReceived(qpc);
  }
  void SetEpoch(int64_t epoch) {
    Rpc({{"method", "navigate"},
         {"session", "1"},
         {"view", "1"},
         {"url", fixture_ + "&t0=" + std::to_string(epoch)}});
  }
  void Snapshot() {
    if (peer_ && sdk_.request_stats)
      Check(sdk_.request_stats(peer_), "sender stats");
    const auto s = slots_.Stats();
    const auto d = engine_->Diagnostics();
    const auto encoder = encoders_->Snapshot();
    if (!encoder.at("error").is_null())
      throw std::runtime_error(encoder.at("error").get<std::string>());
    auto classes = [](const FrameAdmission::ClassStats& c) {
      return Json{{"grants", c.grants}, {"denials", c.denials}, {"waitUs", c.wait_us}};
    };
    const auto& a = s.admission;
    Json snapshot{{"type", "snapshot"},
                  {"epochMs", schedlab::EpochMs()},
                  {"tenant", index_},
                  {"engine",
                   {{"targetFps", d.comp.targetFps},
                    {"resumeMaxFps", d.comp.resumeMaxFps},
                    {"officialMaxFps", d.comp.officialMaxFps},
                    {"codecMaxFps", d.comp.codecMaxFps},
                    {"sourceWidth", d.comp.sourceWidth},
                    {"sourceHeight", d.comp.sourceHeight},
                    {"encodedWidth", d.comp.encodedWidth},
                    {"encodedHeight", d.comp.encodedHeight},
                    {"adaptRequests", d.comp.adaptRequests},
                    {"adaptDrops", d.comp.adaptDrops},
                    {"adaptErrors", d.comp.adaptErrors},
                    {"adaptSizeChanges", d.comp.adaptSizeChanges},
                    {"refresh",
                     {{"pending", d.comp.refresh.pending},
                      {"attempts", d.comp.refresh.attempts},
                      {"forcedBegins", d.comp.refresh.forced_begins},
                      {"successes", d.comp.refresh.successes}}},
                    {"sampling",
                     {{"width", d.sampling.width},
                      {"height", d.sampling.height},
                      {"scale", d.sampling.scale},
                      {"level", d.sampling.level},
                      {"fps", d.sampling.fps},
                      {"limitation", d.sampling.limitation}}},
                    {"samplingFps", d.sampling_fps},
                    {"effectiveIdleMs", d.effective_idle_ms},
                    {"maxFps", d.max_fps},
                    {"degradation", d.degradation},
                    {"iterationQpc", d.iteration_qpc},
                    {"sourceIntervalMs", d.source_interval_ms},
                    {"lastTailAgeMs", d.last_tail_age_ms},
                    {"tailSubmissions", d.tail_submissions},
                    {"tailCompletions", d.tail_completions}}},
                  {"slots",
                   {{"phase", int(s.phase)},
                    {"idle", s.idle},
                    {"depth", s.activeDepth},
                    {"occupancy", s.occupied},
                    {"retiredOccupied", s.retiredOccupied},
                    {"peakOccupied", s.peakOccupied},
                    {"heldSlots", s.heldSlots},
                    {"wakes", s.wakes},
                    {"idleEntries", s.idleEntries},
                    {"begins", s.begins},
                    {"rejectIdle", s.rejectIdle},
                    {"rejectNotReady", s.rejectNotReady},
                    {"rejectStopped", s.rejectStopped},
                    {"ready", s.readyObserved},
                    {"consumed", s.consumedCompleted},
                    {"stopSent", s.stopSent},
                    {"stopConfirmed", s.stopConfirmed},
                    {"retiredGenerations", s.retiredGenerations},
                    {"retiredGenerationsCompleted", s.retiredGenerationsCompleted},
                    {"unknownGpuRetainedGenerations", s.unknownGpuRetainedGenerations},
                    {"unknownGpuRetentions", s.unknownGpuRetentions}}},
                  {"admission",
                   {{"budget", a.budget},
                    {"inflight", a.inflight},
                    {"waiting", a.waiting},
                    {"tenantInflight", a.tenant_inflight},
                    {"tenantWaiting", a.tenant_waiting},
                    {"requests", a.requests},
                    {"grants", a.grants},
                    {"denials", a.denials},
                    {"returns", a.returns},
                    {"waitUs", a.wait_us},
                    {"currentWaitUs", a.current_wait_us},
                    {"lastWaitUs", a.last_wait_us},
                    {"pendingPriority", int(a.pending_priority)},
                    {"lastPriority", int(a.last_priority)},
                    {"normal", classes(a.normal)},
                    {"interactive", classes(a.interactive)}}},
                  {"encoder", encoder}};
    snapshots_ << snapshot.dump() << '\n';
    snapshots_.flush();
    Emit(snapshot);
    trace_->WallClock();
    auto flushed = trace_->Flush();
    if (!flushed)
      throw std::runtime_error(flushed.error().message);
  }
  bool Failed() const { return failed_; }
  void Shutdown() { Stop(); }
  void Drain() {
    draining_ = true;
    engine_->Wake();
  }

 private:
  Json Rpc(Json request) {
    std::lock_guard lock(rpc_mutex_);
    request["version"] = 1;
    request["id"] = ++serial_;
    const auto text = request.dump();
    std::vector<char> buffer(1024 * 1024);
    size_t count = 0;
    Check(sdk_.remotekit_sdk_control_request(control_, text.data(), text.size(), buffer.data(),
                                             buffer.size(), &count, 15000),
          "control request");
    auto reply = Json::parse(buffer.data(), buffer.data() + count);
    if (!reply.value("ok", false))
      throw std::runtime_error("Browser " + request["method"].get<std::string>() + ": " +
                               reply.dump());
    return reply;
  }
  void Launch() {
    const std::string channel = "RemoteKit.schedlab." + std::to_string(GetCurrentProcessId()) +
                                "." + std::to_string(index_);
    std::wstring command = BrowserProcess::Quote(browser_path_.wstring());
    for (const auto& argument : std::vector<std::string>{
             "--use-adapter-luid=" + AdapterLuid(adapter_.luid), "--control-channel=" + channel,
             "--browser-incarnation=schedlab" + std::to_string(GetCurrentProcessId()) + "t" +
                 std::to_string(index_),
             "--session-id=1", "--tenant-id=" + std::to_string(index_),
             "--data-path=" + directory_.generic_string(), "--atlas-width=1920",
             "--atlas-height=1080"})
      command += L" " + BrowserProcess::Quote(Utf8Path(argument).wstring());
    std::array<uint8_t, 32> key{};
    if (BCryptGenRandom(nullptr, key.data(), uint32_t(key.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG))
      throw std::runtime_error("profile key generation failed");
    auto launched = browser_.Launch(browser_path_, std::move(command), key);
    SecureZeroMemory(key.data(), key.size());
    if (!launched)
      throw std::runtime_error(launched.error().message);
    const auto deadline = QpcNow() + QpcFrequency() * 15;
    while (QpcNow() < deadline) {
      if (!sdk_.remotekit_sdk_control_connect(channel.c_str(), &control_))
        return;
      if (browser_.Exited())
        throw std::runtime_error("Browser exited during startup: " + browser_.Diagnostic());
      Sleep(50);
    }
    throw std::runtime_error("Browser control startup timed out");
  }

  static EncoderSet* Resolve(void* context) {
    return static_cast<Tenant*>(context)->encoders_.get();
  }
  void CreatePeer(const Json& rate) {
    remotekit_rtc_options config{};
    config.struct_size = sizeof(config);
    config.abi_version = REMOTEKIT_RTC_ABI_VERSION;
    config.context = this;
    config.event = [](void* p, uint64_t, uint32_t type, const void* bytes, size_t size, const char*,
                      int32_t value) {
      auto& self = *static_cast<Tenant*>(p);
      if (type == REMOTEKIT_RTC_ICE_COMPLETE)
        Emit({{"type", "answer"},
              {"tenant", self.index_},
              {"sdp", std::string(static_cast<const char*>(bytes), size)}});
      else if (type == REMOTEKIT_RTC_STATE) {
        self.connected_ = value == 2;
        self.engine_->Wake();
      } else if (type == REMOTEKIT_RTC_ERROR) {
        self.failed_ = true;
        Emit({{"type", "fatal"},
              {"tenant", self.index_},
              {"message", std::string(static_cast<const char*>(bytes), size)}});
      } else if (type == REMOTEKIT_RTC_REFRESH_REQUEST) {
        self.engine_->RequestRefresh();
      } else if (type == REMOTEKIT_RTC_STATS) {
        self.encoders_->SenderStats(
            Json::parse(static_cast<const char*>(bytes), static_cast<const char*>(bytes) + size));
      }
    };
    EncoderSet::BindCallbacks<Resolve>(config.encoder);
    config.min_bitrate_bps = rate.at("minBitrate");
    config.start_bitrate_bps = rate.at("bitrate");
    config.max_bitrate_bps = rate.at("maxBitrate");
    Check(sdk_.remotekit_rtc_create(&config, &peer_), "RTC create");
    Check(sdk_.remotekit_rtc_set_av_sync(peer_, 0), "AV sync");
    Check(sdk_.remotekit_rtc_set_audio_enabled(peer_, 0), "disable audio");
    Check(sdk_.remotekit_rtc_set_degradation_preference(peer_, REMOTEKIT_RTC_BALANCED),
          "degradation");
    Check(sdk_.remotekit_rtc_set_source_max_fps(peer_, 60), "max fps");
    Check(sdk_.remotekit_rtc_set_media_authorized(peer_, 1), "authorize media");
    Check(sdk_.remotekit_rtc_set_playout_delay(peer_, 0, 50), "playout delay");
  }
  Layout ObserveLayout(const SharedAtlasFrame& metadata) override {
    Json layout{{"generation", metadata.generation},
                {"width", metadata.width_pixels},
                {"height", metadata.height_pixels}};
    auto views = Json::array();
    for (uint32_t i = 0; i < metadata.view_count; ++i) {
      const auto& v = metadata.views[i];
      views.push_back({v.session_id, v.webview_id, v.instance_generation, v.document_generation,
                       v.x_pixels, v.y_pixels, v.width_pixels, v.height_pixels,
                       v.atlas_pixels_per_dip, v.page_device_scale_factor});
    }
    layout["views"] = views;
    if (layout != layout_) {
      layout_ = std::move(layout);
      ++layout_epoch_;
      RK_SERVER_TRACE(trace_, "bench_layout", TraceIds{},
                      rk_record.ids.layout_epoch = layout_epoch_;);
    }
    return {layout_epoch_, metadata.view_count == 1 && metadata.views[0].webview_id == 1};
  }
  std::optional<PresentationBarrier::Key> RefreshKey(uint64_t peer) override {
    return PresentationBarrier::Key{peer, slots_.Generation(), layout_epoch_};
  }
  void Invalidate(const char* reason) override {
    RK_SERVER_TRACE(trace_, "bench_invalidate", TraceIds{}, rk_record.reason = reason;);
  }
  void Reached(Milestone milestone) override {
    Emit({{"type", "milestone"},
          {"tenant", index_},
          {"epochMs", schedlab::EpochMs()},
          {"milestone", milestone == Milestone::source_frame ? "source_frame" : "submit"}});
  }
  bool Current(uint64_t scope) override { return scope == 1 && connected_ && !stopping_; }
  bool CanBegin() override { return !draining_ && !stopping_; }
  void MediaLoop() {
    while (!stopping_ && !connected_)
      Sleep(10);
    if (stopping_)
      return;
    CompStream stream{peer_, 0, 1, true};
    Check(sdk_.remotekit_rtc_get_receive_level(peer_, &stream.receive_level), "H264 level");
    remotekit_rtc_clock_sample clock{sizeof(clock)};
    Check(sdk_.sample_clock(&clock), "SDK clock");
    slots_.SetClock(clock);
    trace_->SdkClock(clock);
    remotekit_sdk_render_setup setup{sizeof(setup)};
    remotekit_sdk_failure failure{};
    Check(sdk_.remotekit_sdk_control_open_render(control_, GetCurrentProcessId(), &setup, 15000,
                                                 &failure),
          "open render");
    std::string error;
    if (!slots_.Open(setup, browser_.Pid(), sdk_, adapter_.luid, adapter_.device.Get(),
                     adapter_.context.Get(), error))
      throw std::runtime_error(error);
    auto check = [](const std::optional<CompFailure>& failure) {
      if (failure)
        throw std::runtime_error(failure->error.message);
    };
    check(engine_->StartGeneration());
    while (!stopping_) {
      check(engine_->UpdateCadence(stream));
      check(engine_->Step(stream, *this));
      check(engine_->Wait(stream));
    }
    engine_->StopGeneration();
  }
  void Stop() noexcept {
    if (stopping_.exchange(true))
      return;
    engine_->Wake();
    if (media_.joinable())
      media_.join();
    auto attempt = [this](auto action) {
      try {
        action();
      } catch (const std::exception& error) {
        failed_ = true;
        Emit({{"type", "shutdown_error"}, {"tenant", index_}, {"message", error.what()}});
      }
    };
    attempt([&] {
      if (peer_)
        Check(sdk_.remotekit_rtc_close(peer_), "RTC close");
    });
    peer_ = 0;
    encoders_->Drain();
    if (control_)
      attempt([&] { Rpc({{"method", "output.close"}}); });
    attempt([&] {
      std::string error;
      if (!slots_.Close(error))
        throw std::runtime_error(error);
    });
    attempt([&] { Snapshot(); });
    if (control_) {
      attempt([&] { Rpc({{"method", "browser.shutdown"}}); });
      sdk_.remotekit_sdk_control_close(control_);
      control_ = 0;
    }
    if (browser_.Present()) {
      if (!browser_.WaitCleanExit(10000))
        attempt([&] {
          auto r = browser_.Terminate();
          if (!r)
            throw std::runtime_error(r.error().message);
        });
      if (!browser_.JobEmpty()) {
        failed_ = true;
        Emit({{"type", "shutdown_error"}, {"message", "Browser job is not empty"}});
      }
      browser_.ReleaseExited();
    }
  }
  Sdk& sdk_;
  StreamingAdapter adapter_;
  int index_;
  fs::path directory_, browser_path_;
  std::string fixture_;
  int width_, height_;
  double dpr_;
  BrowserProcess browser_;
  uint64_t control_ = 0, peer_ = 0, serial_ = 0, layout_epoch_ = 0;
  Json layout_;
  std::shared_ptr<ServerTrace> trace_;
  RenderSlots slots_;
  std::unique_ptr<EncoderSet> encoders_;
  std::unique_ptr<CompEngine> engine_;
  std::mutex rpc_mutex_, frames_mutex_;
  std::ofstream snapshots_, frames_;
  std::thread media_;
  std::atomic<bool> stopping_{false}, connected_{false}, draining_{false}, failed_{false};
};
}  // namespace
int main(int argc, char** argv) {
  try {
    if (argc == 4 && std::string_view(argv[1]) == "make-video" &&
        std::string_view(argv[2]) == "--out") {
      schedlab::MakeVideo(Utf8Path(argv[3]));
      return 0;
    }
    if (argc != 2)
      throw std::runtime_error("usage: schedlab.exe <config.json> | make-video --out <mp4>");
    std::ifstream input(Utf8Path(argv[1]));
    Json config;
    input >> config;
    const auto out = fs::absolute(Utf8Path(config.at("out")));
    fs::create_directories(out);
    SetEnvironmentVariableW(L"REMOTEKIT_SERVER_TRACE", out.c_str());
    Sdk sdk;
    auto loaded = sdk.Open(Utf8Path(config.at("browser")).parent_path() / "remotekit_sdk.dll");
    if (!loaded)
      throw std::runtime_error(loaded.error().message);
    EncoderSettings settings;
    settings.bitrate = config.at("media").at("bitrate");
    settings.max_bitrate = config.at("media").at("maxBitrate");
    auto selected =
        SelectStreamingAdapter(sdk, {"auto", settings, config.at("media").at("maxEncodeWidth"),
                                     config.at("media").at("maxEncodeHeight")});
    if (!selected)
      throw std::runtime_error(selected.error().message);
    auto adapter = std::move(selected).value();
    schedlab::Resources resources(out / "resources.jsonl");
    resources.AddRoot("bench", GetCurrentProcessId());
    FrameAdmission admission;
    std::vector<std::unique_ptr<Tenant>> tenants;
    for (const auto& tenant : config.at("tenants"))
      tenants.push_back(
          std::make_unique<Tenant>(sdk, adapter, config, tenant, resources, admission));
    Emit({{"type", "ready"},
          {"pid", GetCurrentProcessId()},
          {"adapter", AdapterLuid(adapter.luid)},
          {"encoder", adapter.encoder},
          {"modules", Modules()},
          {"qpc", QpcNow()},
          {"qpcFrequency", QpcFrequency()},
          {"epochMs", schedlab::EpochMs()}});
    std::atomic<bool> monitor_stop{false}, monitor_failed{false};
    std::thread monitor([&] {
      try {
        while (!monitor_stop) {
          const auto start = QpcNow();
          Emit(resources.Sample());
          for (auto& tenant : tenants)
            tenant->Snapshot();
          while (!monitor_stop && QpcNow() - start < QpcFrequency())
            Sleep(20);
        }
      } catch (const std::exception& error) {
        monitor_failed = true;
        Emit({{"type", "fatal"}, {"message", error.what()}});
      }
    });
    try {
      std::string line;
      while (std::getline(std::cin, line)) {
        const auto message = Json::parse(line);
        const std::string type = message.at("type");
        if (type == "stop")
          break;
        if (type == "offer")
          tenants.at(message.at("tenant"))->Offer(message.at("sdp"));
        else if (type == "activity")
          tenants.at(message.at("tenant"))->Activity(message.at("epochMs"));
        else if (type == "receiver")
          resources.AddRoot("receiver", message.at("pid"));
        else if (type == "drain") {
          for (auto& tenant : tenants)
            tenant->Drain();
        } else if (type == "t0") {
          const int64_t epoch = message.at("t0");
          for (auto& tenant : tenants)
            tenant->SetEpoch(epoch);
          Emit({{"type", "epoch"}, {"t0", epoch}});
        }
      }
    } catch (...) {
      monitor_stop = true;
      monitor.join();
      throw;
    }
    monitor_stop = true;
    monitor.join();
    bool failed = monitor_failed;
    for (auto& tenant : tenants) {
      tenant->Shutdown();
      failed |= tenant->Failed();
    }
    tenants.clear();
    Emit({{"type", "stopped"}, {"modules", Modules()}});
    return failed ? 1 : 0;
  } catch (const std::exception& error) {
    Emit({{"type", "fatal"}, {"message", error.what()}});
    return 1;
  }
}
