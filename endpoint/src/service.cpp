#include "media/render_slots.hpp"
#include "media/encoder_worker.hpp"
#include "media/sdk_loader.hpp"
#include "media/audio_ring.hpp"
#include "remotekit/file_upload.hpp"
#include "remotekit/core.hpp"
#include "remotekit/sampling.hpp"
#include "remotekit/idle_idr.hpp"
#include "remotekit/tail_refresh.hpp"
#include "remotekit/media_feedback.hpp"
#include "remotekit/capture_clock.hpp"
#include "remotekit/comp_pacing.hpp"
#include "remotekit/atlas_dimensions.hpp"
#include "remotekit/atlas_plan.hpp"
#include "remotekit/coordinate_readiness.hpp"
#include "remotekit/input_sequence.hpp"
#include "remotekit/presentation_barrier.hpp"
#include "remotekit/presentation_refresh.hpp"
#include "remotekit/control_reliability.hpp"
#include "remotekit/product_authorization.hpp"
#include "remotekit/face_auth.hpp"
#include "remotekit/raw_camera.hpp"
#include "remotekit/dc_services.hpp"
#include "remotekit/dc_file_services.hpp"
#include "remotekit/file_library.hpp"
#include "remotekit/photo_processing.hpp"
#include "remotekit/navigation_export.hpp"
#include "control_transport.hpp"
#include <functional>
#include <charconv>
#include <json.hpp>
#include <windows.h>
#include <mmsystem.h>
#include <wincrypt.h>
#include <objbase.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>
#include <atomic>
#include <array>
using Json = nlohmann::json;
using namespace remotekit::media;
namespace fs = std::filesystem;
namespace {
std::function<void(std::string)> management_output = [](std::string bytes) {
  std::cout << bytes << '\n' << std::flush;
};
std::function<bool(std::string, uint64_t)> management_action = [](std::string bytes, uint64_t) {
  management_output(std::move(bytes));
  return bool(std::cout);
};
std::string Env(const char* key, std::string fallback = {}) {
  const char* v = std::getenv(key);
  return v ? v : fallback;
}
fs::path Utf8Path(const std::string& value) {
  return fs::u8path(value);
}
std::string Utf8(const fs::path& path) {
  auto v = path.u8string();
  return {reinterpret_cast<const char*>(v.data()), v.size()};
}
std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (auto c : value) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    if (c == L'\"') {
      result.append(slashes * 2 + 1, L'\\');
      result += c;
    } else {
      result.append(slashes, L'\\');
      result += c;
    }
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L"\"";
}
void SaveJson(const fs::path& path, const Json& value) {
  fs::create_directories(path.parent_path());
  auto temporary = path;
  temporary += L".new";
  {
    std::ofstream file(temporary, std::ios::binary);
    file << value.dump(2);
    if (!file)
      throw std::runtime_error("state write failed");
  }
  if (!MoveFileExW(temporary.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("state commit failed");
}
Json LoadJson(const fs::path& path, Json fallback = Json::object()) {
  std::ifstream file(path, std::ios::binary);
  if (!file)
    return fallback;
  Json result;
  file >> result;
  return result;
}
std::string Required(const Json& object, const char* name) {
  if (!object.contains(name) || !object[name].is_string() ||
      object[name].get<std::string>().empty())
    throw std::runtime_error(std::string("required string: ") + name);
  return object[name].get<std::string>();
}
std::string NewIncarnation() {
  GUID value{};
  if (FAILED(CoCreateGuid(&value)))
    throw std::runtime_error("browser incarnation generation failed");
  const auto* bytes = reinterpret_cast<const unsigned char*>(&value);
  std::string result;
  for (size_t i = 0; i < sizeof(value); ++i) {
    result += "0123456789abcdef"[bytes[i] >> 4];
    result += "0123456789abcdef"[bytes[i] & 15];
  }
  return result;
}
std::string ViewId(const Json& request) {
  auto id = Required(request, "viewId");
  if (id.size() > 20 || id[0] == '0' ||
      !std::all_of(id.begin(), id.end(), [](char c) { return c >= '0' && c <= '9'; }))
    throw std::runtime_error("viewId must be nonzero uint64 decimal");
  try {
    if (std::stoull(id) == 0)
      throw std::runtime_error("invalid viewId");
  } catch (...) {
    throw std::runtime_error("viewId out of uint64 range");
  }
  return id;
}
size_t DecodedSize(const std::string& text) {
  DWORD size = 0;
  if (!CryptStringToBinaryA(text.data(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64,
                            nullptr, &size, nullptr, nullptr))
    throw std::runtime_error("invalid navigation base64");
  std::vector<BYTE> bytes(size);
  if (!CryptStringToBinaryA(text.data(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64,
                            bytes.data(), &size, nullptr, nullptr))
    throw std::runtime_error("invalid navigation bytes");
  return size;
}
struct Options {
  std::string control_url, node_id;
  fs::path browser, data, browser_trace_directory;
  std::string encoder = "qsv", browser_enable_features, browser_disable_features;
  EncoderSettings encoding;
  uint32_t idle_idr_ms = 150, max_encode_width = 4096, max_encode_height = 4096;
  uint32_t atlas_allocation_alignment = 16;
  bool qsv_low_power_explicit = false;
  // Request WebRTC low-latency playout with room for video composition pacing.
  // The explicit -1 override leaves the RTP extension unset.
  int32_t rtc_playout_max_ms = 50;
  Options() {
    wchar_t executable[32768]{};
    GetModuleFileNameW(nullptr, executable, 32768);
    browser = Utf8Path(Env("REMOTEKIT_BROWSER",
                           Utf8(fs::path(executable).parent_path() / "remotekit_browser.exe")));
    data = Utf8Path(Env("REMOTEKIT_DATA_PATH", Env("LOCALAPPDATA", ".") + "/RemoteKit/streaming"));
    encoder = Env("REMOTEKIT_ENCODER", "qsv");
    encoding.bitrate = 36000000;
    encoding.max_bitrate = 48000000;
  }
  void Parse(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
      std::string arg = argv[i];
      auto equal = arg.find('=');
      if (equal == std::string::npos)
        throw std::runtime_error("arguments require --name=value");
      auto key = arg.substr(0, equal), value = arg.substr(equal + 1);
      if (key == "--control-url")
        control_url = value;
      else if (key == "--node-id")
        node_id = value;
      else if (key == "--browser")
        browser = Utf8Path(value);
      else if (key == "--data-path")
        data = Utf8Path(value);
      else if (key == "--browser-enable-features")
        browser_enable_features = value;
      else if (key == "--browser-disable-features")
        browser_disable_features = value;
      else if (key == "--browser-trace-dir")
        browser_trace_directory = Utf8Path(value);
      else if (key == "--encoder")
        encoder = value;
      else if (key == "--qsv-vpp") {
        if (value != "external" && value != "async")
          throw std::runtime_error("qsv-vpp must be external or async");
        encoding.qsv_async_vpp = value == "async";
      } else if (key == "--atlas-alignment") {
        if (value != "1" && value != "16")
          throw std::runtime_error("atlas-alignment must be 1 or 16");
        atlas_allocation_alignment = value == "16" ? 16 : 1;
      } else if (key == "--fps")
        encoding.fps = std::stoul(value);
      else if (key == "--bitrate")
        encoding.bitrate = std::stoul(value);
      else if (key == "--max-bitrate")
        encoding.max_bitrate = std::stoul(value);
      else if (key == "--async-depth")
        encoding.async_depth = std::stoul(value);
      else if (key == "--gop")
        encoding.gop = std::stoul(value);
      else if (key == "--target-usage") {
        encoding.target_usage = std::stoul(value);
        encoding.target_usage_explicit = true;
      } else if (key == "--qsv-low-power") {
        if (value != "auto" && value != "on" && value != "off")
          throw std::runtime_error("qsv-low-power must be auto, on or off");
        encoding.qsv_low_power = value == "on" ? 0x10u : (value == "off" ? 0x20u : 0u);
        qsv_low_power_explicit = true;
        encoding.qsv_low_power_explicit = true;
      } else if (key == "--buffer-ms")
        encoding.buffer_ms = std::stoul(value);
      else if (key == "--rate-control") {
        if (value != "cbr" && value != "vbr")
          throw std::runtime_error("rate-control must be cbr or vbr");
        encoding.vbr = value == "vbr";
        encoding.rate_control_explicit = true;
      } else if (key == "--idle-idr-ms")
        idle_idr_ms = std::stoul(value);
      else if (key == "--rtc-playout-max-ms") {
        size_t parsed = 0;
        rtc_playout_max_ms = std::stoi(value, &parsed);
        if (parsed != value.size())
          throw std::runtime_error("rtc-playout-max-ms must be an integer");
      } else if (key == "--max-encode-width")
        max_encode_width = std::stoul(value);
      else if (key == "--max-encode-height")
        max_encode_height = std::stoul(value);
      else
        throw std::runtime_error("unknown endpoint argument: " + key);
    }
    if ((encoder != "auto" && encoder != "qsv" && encoder != "nvenc") || encoding.fps < 1 ||
        encoding.fps > 120 || encoding.async_depth < 1 || encoding.async_depth > 8 ||
        encoding.target_usage < 1 || encoding.target_usage > 7 || encoding.bitrate < 100000 ||
        encoding.bitrate > 50000000 || encoding.max_bitrate > 60000000 ||
        encoding.bitrate > encoding.max_bitrate || encoding.gop < 1 || encoding.gop > 65535 ||
        encoding.buffer_ms < 50 || encoding.buffer_ms > 5000 || max_encode_width < 16 ||
        max_encode_height < 16 || max_encode_width > 4096 || max_encode_height > 4096)
      throw std::runtime_error("invalid encoder settings");
    browser = fs::absolute(browser);
    data = fs::absolute(data);
    if (encoding.qsv_async_vpp && (encoder != "qsv" || atlas_allocation_alignment != 16))
      throw std::runtime_error("qsv-vpp=async requires encoder=qsv and atlas-alignment=16");
    if (!qsv_low_power_explicit && encoder != "nvenc")
      encoding.qsv_low_power = 0x10u;
    if (encoder == "nvenc" && encoding.qsv_low_power)
      throw std::runtime_error("qsv-low-power requires qsv or auto encoder");
    if (rtc_playout_max_ms != -1 &&
        (rtc_playout_max_ms < 0 || rtc_playout_max_ms > 40950 || rtc_playout_max_ms % 10))
      throw std::runtime_error("rtc-playout-max-ms must be -1 or a multiple of 10 in 0..40950");
  }
};
std::string AdapterLuid(LUID luid) {
  return std::to_string(luid.HighPart) + "," + std::to_string(luid.LowPart);
}
struct StreamingAdapter {
  LUID luid;
  std::string encoder;
  ComPtr<ID3D11Device5> device;
  ComPtr<ID3D11DeviceContext4> context;
};
StreamingAdapter SelectStreamingAdapter(Sdk& sdk, const Options& options) {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
    throw std::runtime_error("streaming DXGI factory unavailable");
  const bool qsv_required =
      options.encoding.qsv_async_vpp ||
      (options.encoding.qsv_low_power && options.encoding.qsv_low_power_explicit);
  std::string failures;
  for (std::string_view backend : {"qsv", "nvenc"}) {
    if (options.encoder != "auto" && options.encoder != backend)
      continue;
    if (backend == "nvenc" && qsv_required)
      continue;
    const UINT vendor = backend == "qsv" ? 0x8086 : 0x10de;
    for (UINT index = 0;; ++index) {
      ComPtr<IDXGIAdapter1> adapter;
      const auto enumerated = factory->EnumAdapters1(index, &adapter);
      if (enumerated == DXGI_ERROR_NOT_FOUND)
        break;
      if (FAILED(enumerated))
        throw std::runtime_error("streaming DXGI adapter enumeration failed");
      DXGI_ADAPTER_DESC1 desc{};
      if (FAILED(adapter->GetDesc1(&desc)))
        throw std::runtime_error("streaming DXGI adapter identity unavailable");
      if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) || desc.VendorId != vendor)
        continue;
      StreamingAdapter candidate{desc.AdapterLuid, std::string(backend)};
      std::string error;
      if (CreateDevice(&candidate.luid, candidate.device, candidate.context, error)) {
        const auto probe_stats = std::make_shared<EncoderStats>();
        // Exercise the same hardware initialization and input-surface setup as RTC.
        EncoderWorker probe(sdk, 0, candidate.device.Get(), candidate.encoder, options.encoding,
                            probe_stats, {}, {}, 0, {});
        remotekit_rtc_encoder_config config{};
        config.struct_size = sizeof(config);
        config.width = std::min(1280u, options.max_encode_width) & ~1u;
        config.height = std::min(720u, options.max_encode_height) & ~1u;
        config.h264_level_idc = options.encoding.level_idc;
        if (probe.Configure(config))
          return candidate;
        error = probe_stats->error;
      }
      failures += "; " + candidate.encoder + " " + AdapterLuid(candidate.luid) + ": " + error;
    }
  }
  throw std::runtime_error("no hardware H264 streaming adapter for " + options.encoder + failures);
}
struct Session {
  Sdk& sdk;
  Options options;
  std::string tenant, id;
  fs::path directory;
  HANDLE process = nullptr, job = nullptr;
  std::atomic<uint64_t> control{0}, client_gestures_control{0};
  uint64_t request_id = 0;
  bool producer_stop_pending = false;
  bool process_in_job = false;
  std::string browser_incarnation, process_incarnation, last_confirmed_browser_exit;
  remotekit::FileUploadStore file_uploads;
  remotekit::FileLibrary file_library;
  std::mutex file_store_mutex;
  remotekit::DcFileServices file_services;
  struct FileOwner {
    remotekit::DcFileServices::Job job;
    int64_t touched;
  };
  std::map<std::string, FileOwner> file_owners;  // file worker only.
  struct SelectionWatch {
    remotekit::FileLibrary::Selection selection;
    uint64_t control;
    int64_t expires;
  };
  std::deque<SelectionWatch> selection_watches;  // file worker only.
  int64_t next_selection_watch = 0;
#ifdef RK_FILE_PHOTO
  remotekit::PhotoBurstSessions<remotekit::PhotoBurstAnalyzer> photo_bursts;  // file worker only.
  struct PhotoThumbnail {
    std::string asset_id;
    int64_t refresh_after;
  };
  std::map<std::string, PhotoThumbnail> photo_thumbnails;  // file worker only.
#endif
  std::timed_mutex rpc_mutex;
  std::map<std::string, Json> desired;
  int atlas_width = 1920, atlas_height = 1080;
  float atlas_scale = 1;
  RenderSlots pool;
  std::thread media_thread;
  std::atomic<bool> stop_media{false};
  AudioRing audio_ring;
  std::thread audio_thread;
  std::atomic<bool> stop_audio{false};
  std::atomic<uint64_t> audio_gaps{0}, audio_submitted{0}, audio_rejected{0};
  remotekit::CoordinateReadiness coordinate_readiness;
  std::atomic<uint64_t> peer{0};
  std::string connection;
  // Transitions serialize with peer creation/close. Admission never holds its
  // lock while calling an SDK operation that marshals to signaling.
  std::mutex authorization_mutex, admission_mutex;
  remotekit::ProductAuthorization authorization;
  std::atomic<uint64_t> management_generation{0};
  std::atomic<uint64_t> frame_authorization{0}, input_authorization{0};
  std::atomic<int64_t> audio_authorized_after{0};
  rk::auth::Faces faces;
  rk::auth::RawCamera raw_camera;
  std::mutex camera_mutex;
  std::condition_variable camera_wake;
  bool camera_changed = false;
  std::thread camera_thread;
  std::atomic<bool> stop_camera{false};

  std::shared_ptr<EncoderStats> stats = std::make_shared<EncoderStats>();
  remotekit::MediaFeedback media_feedback;
  std::atomic<uint32_t> comp_bitrate{1}, comp_fps{60};
  std::mutex encoder_mutex;
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> encoders;
  std::optional<StreamingAdapter> streaming_adapter;
  struct Event {
    uint32_t type;
    std::string bytes, auxiliary;
    int32_t value;
    uint64_t peer;
    uint64_t authorization = 0;
    const char* input_rejection = nullptr;
    uint64_t trace_input_sequence = 0;
  };
  bool ProductCurrent(const Event& event) const {
    return event.peer == peer.load() && authorization.Current(event.authorization);
  }
  std::mutex event_mutex;
  std::condition_variable event_wake;
  std::deque<Event> events;
  std::mutex signal_mutex;
  std::string answer, rtc_error;
  bool ice_complete = false;
  std::atomic<bool> trickle_signals{false};
  std::deque<Event> signal_events;
  bool signal_overflow = false;
  std::condition_variable signal_wake;
  std::mutex input_mutex;
  std::condition_variable input_wake;
  std::deque<Event> input_queue;
  remotekit::InputSequence input_sequence;
  std::thread input_thread;
  std::atomic<bool> stop_input{false};
  std::atomic<uint64_t> input_rejected{0}, input_coalesced{0};
  std::atomic<uint64_t> input_busy_retries{0}, input_busy_exhausted{0};
  Json layout;
  std::atomic<bool> data_open{false};
  remotekit::ReliableControlOutbox control_outbox;
  remotekit::DirectServices direct_services;
  std::optional<remotekit::PresentationBarrier::Key> layout_prepare;
  Json site_preferences = Json::object();
  std::mutex media_policy_mutex;
  Json requested_media_policy = nullptr;
  std::atomic<uint32_t> policy_max_fps{60}, policy_degradation{REMOTEKIT_RTC_BALANCED};
  std::atomic<double> capture_clock_uncertainty_ms{0};
  Json durable_events = Json::array();
  uint64_t next_event = 1;
  std::set<std::string> observed_closed;
  std::atomic<bool> output_suspended{false}, has_visible_output{false},
      reconciliation_pending{false};
  int64_t next_reconciliation = 0;
  std::string current_geometry;
  std::atomic<uint64_t> layout_epoch{0};
  remotekit::PresentationBarrier presentation;
  std::atomic<uint32_t> receive_level{0};
  enum class ConnectionPhase : size_t {
    answer,
    first_candidate,
    gather_complete,
    connected,
    data_open,
    output_open_start,
    output_open_end,
    source_frame,
    submit,
    encoder_configure_start,
    encoder_configure_end,
    encoded,
    count
  };
  std::atomic<int64_t> connection_started_qpc{0};
  std::array<std::atomic<int64_t>, static_cast<size_t>(ConnectionPhase::count)> connection_phases{};
  void MarkConnection(ConnectionPhase phase) {
    auto& stamp = connection_phases[static_cast<size_t>(phase)];
    if (!stamp.load()) {
      int64_t empty = 0;
      stamp.compare_exchange_strong(empty, QpcNow());
    }
  }
  Json ConnectionTimings() const {
    constexpr const char* names[] = {
        "answerReady",     "firstCandidate",        "gatherComplete",      "connected",
        "dataChannelOpen", "outputOpenStart",       "outputOpenEnd",       "firstSourceFrame",
        "firstSubmit",     "encoderConfigureStart", "encoderConfigureEnd", "firstEncoded"};
    const auto started = connection_started_qpc.load();
    Json phases = Json::object();
    if (started)
      for (size_t i = 0; i < connection_phases.size(); ++i)
        if (const auto at = connection_phases[i].load(); at >= started)
          phases[names[i]] = 1000.0 * (at - started) / QpcFrequency();
    return phases;
  }
  std::atomic<bool> refresh_connected{false};
  std::atomic<int64_t> last_media_refresh_qpc{0};
  // MediaLoop snapshots the policy once per iteration so layout and texture
  // submission cannot use different sampling budgets during a policy update.
  struct CompDiagnostics {
    uint32_t targetFps = 0, resumeMaxFps = 0, officialMaxFps = 0, codecMaxFps = 0, sourceWidth = 0,
             sourceHeight = 0, encodedWidth = 0, encodedHeight = 0;
    uint64_t adaptRequests = 0, adaptDrops = 0, adaptErrors = 0, adaptSizeChanges = 0;
    remotekit::PresentationRefresh::Stats refresh;
  };
  std::mutex comp_diagnostics_mutex;
  CompDiagnostics comp_diagnostics;
  uint32_t sampling_fps = 60;
  uint32_t SamplingFps() const { return sampling_fps; }
  std::atomic<bool> rtc_connected{false};
  std::atomic<uint32_t> effective_idle_ms{150};
  std::atomic<double> source_interval_ms{0}, last_tail_age_ms{0};
  std::atomic<uint64_t> tail_submissions{0}, tail_completions{0};
  remotekit::MediaSampling sampling;
  std::shared_ptr<ServerTrace> trace;
  std::map<std::string, std::string> recovery_revisions;
  remotekit::NavigationExport navigation_export;
  bool export_turn = false;
  struct Recovery {
    std::string phase = "load", error, transfer;
    Json saved;
    size_t chunk = 0;
    uint64_t offset = 0, buffer_bytes = 0;
    int64_t deadline = 0, next_poll = 0;
    bool Pending() const {
      return phase != "complete" && phase != "fallback_started" && phase != "failed";
    }
  };
  std::map<std::string, Recovery> recoveries;
  std::string recovery_cursor;
  static fs::path FaceModels() {
    wchar_t executable[32768]{};
    GetModuleFileNameW(nullptr, executable, 32768);
    return fs::path(executable).parent_path() / "face-models";
  }
  Session(Sdk& api, const Options& opts, std::string tenant_id, std::string session_id)
      : sdk(api),
        options(opts),
        tenant(std::move(tenant_id)),
        id(std::move(session_id)),
        directory(options.data / "sessions" / id),
        file_uploads(directory / "uploads"),
        file_library(directory / "file-library"),
        faces(FaceModels()) {
    effective_idle_ms = std::min(1000u, options.idle_idr_ms);
    trace = ServerTrace::Create(tenant, id);
    pool.SetTrace(trace);
    fs::create_directories(directory);
    auto saved = LoadJson(directory / "views.json", Json::array());
    site_preferences = LoadJson(directory / "site-preferences.json", Json::object());
    auto event_state =
        LoadJson(directory / "events.json", {{"next", 1}, {"events", Json::array()}});
    next_event = event_state.value("next", uint64_t(1));
    durable_events = event_state.value("events", Json::array());
    for (auto& view : saved)
      desired[ViewId(view)] = view;
    bool reconciled_closed = false;
    for (const auto& event : durable_events)
      if (event.value("type", std::string()) == "view.closed")
        reconciled_closed =
            desired.erase(event.at("viewId").get<std::string>()) != 0 || reconciled_closed;
    if (reconciled_closed)
      Save();
    file_services.Start([this](const auto& job) { return DirectFileCommand(job); },
                        [this] { SweepDirectFiles(); });
  }
  ~Session() {
    file_services.Bind(0);
    file_services.Stop();
    try {
      Stop();
    } catch (...) {
      fprintf(stderr, "session shutdown unfinished; atlas resources retained\n");
    }
    // Final OS handle cleanup is not proof of process exit. RenderSlots retains
    // any unsafe generation when its own destructor cannot establish a drain.
    if (job) {
      CloseHandle(job);
      job = nullptr;
    }
    if (process) {
      CloseHandle(process);
      process = nullptr;
    }
  }
  void Save() {
    Json values = Json::array();
    for (auto& [view, config] : desired)
      values.push_back(config);
    SaveJson(directory / "views.json", values);
  }
  void SaveEvents() {
    SaveJson(directory / "events.json", {{"next", next_event}, {"events", durable_events}});
  }
  void RecordClosed(const std::string& view, const std::string& reason) {
    if (!observed_closed.contains(view)) {
      const bool recorded =
          std::any_of(durable_events.begin(), durable_events.end(), [&](const Json& event) {
            return event.value("type", std::string()) == "view.closed" &&
                   event.value("viewId", std::string()) == view;
          });
      if (!recorded) {
        if (durable_events.size() >= 256)
          throw std::runtime_error(
              "closed event backlog full; acknowledge events before reconciliation");
        auto closed_events = durable_events;
        closed_events.push_back({{"eventId", std::to_string(next_event)},
                                 {"type", "view.closed"},
                                 {"viewId", view},
                                 {"reason", reason}});
        SaveJson(directory / "events.json", {{"next", next_event + 1}, {"events", closed_events}});
        durable_events = std::move(closed_events);
        ++next_event;
      }
      // Event is durable first. A crash before the second save is repaired by
      // constructor replay, which removes these IDs before starting a Browser.
      if (desired.contains(view)) {
        Json remaining = Json::array();
        for (const auto& [view_id, config] : desired)
          if (view_id != view)
            remaining.push_back(config);
        SaveJson(directory / "views.json", remaining);
        desired.erase(view);
      }
      observed_closed.insert(view);
    }
    navigation_export.Forget(view);
    recoveries.erase(view);
    recovery_revisions.erase(view);
    fs::remove(directory / "recovery" / (view + ".json"));
  }
  void AckClosed(const Json& views) {
    if (!views.empty())
      Rpc({{"method", "view.closed.ack"},
           {"session", id},
           {"views", views},
           {"browserIncarnation", browser_incarnation}});
  }
  Json Rpc(Json command,
           bool require_ok = true,
           uint64_t expected_control = 0,
           uint32_t timeout_ms = 10000,
           bool opportunistic = false,
           const std::function<bool()>& admitted = {}) {
    uint64_t trace_sequence = 0;
    if (trace && command.value("method", Json()) == "input")
      PresentationNumber(command, "sequence", trace_sequence);
    DWORD control_pid = 0;
    const auto trace_rpc = [&](const char* stage, int status = 0) {
      if (!trace_sequence)
        return;
      RK_SERVER_TRACE(trace, stage, TraceIds{}, rk_record.browser_sequence = trace_sequence;
                      rk_record.status = status; rk_record.producer_pid = control_pid;);
    };
    trace_rpc("input_rpc_lock_wait");
    std::unique_lock lock(rpc_mutex, std::defer_lock);
    if (opportunistic) {
      if (!lock.try_lock())
        return nullptr;
    } else
      lock.lock();
    if (trace_sequence)
      control_pid = GetProcessId(process);
    trace_rpc("input_rpc_lock_acquired");
    if (admitted && !admitted())
      throw std::runtime_error("authorization_changed");
    if (expected_control && control.load() != expected_control)
      throw std::runtime_error("stale_file_browser");
    if (!control)
      throw std::runtime_error("browser control unavailable");
    auto result = remotekit::BrowserRpc(
        command, request_id,
        [&](const std::string& encoded, std::vector<char>& response, size_t& count) {
          trace_rpc("input_rpc_sdk_call");
          const int status = sdk.remotekit_sdk_control_request(control, encoded.data(),
                                                               encoded.size(), response.data(),
                                                               response.size(), &count, timeout_ms);
          trace_rpc("input_rpc_sdk_return", status);
          if (status != 0) {
            control = 0;
            const auto error = "browser request transport " + std::to_string(status) +
                               " method=" + command.value("method", std::string()) + " " +
                               ProcessDiagnostic() +
                               " browser_log=" + Utf8(directory / "browser.log");
            // Snapshot can recover a transport failure into an inactive result. Keep
            // the initiating method and process identity visible before that fallback.
            fprintf(stderr, "session %s %s\n", id.c_str(), error.c_str());
            throw std::runtime_error(error);
          }
          return status;
        });
    if (command.value("method", std::string()) == "snapshot")
      client_gestures_control = result.value("clientGestures", Json()) == 1 ? control.load() : 0;
    return require_ok ? remotekit::RequireBrowserOk(std::move(result)) : std::move(result);
  }
  bool Alive() const { return process && WaitForSingleObject(process, 0) == WAIT_TIMEOUT; }
  bool ProducerExited() const {
    return process && WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
  }
  std::string ProcessDiagnostic() const {
    if (!process)
      return "process=absent";
    std::ostringstream detail;
    detail << "pid=" << GetProcessId(process);
    const auto wait = WaitForSingleObject(process, 0);
    detail << " process="
           << (wait == WAIT_TIMEOUT    ? "running"
               : wait == WAIT_OBJECT_0 ? "exited"
                                       : "query-failed");
    if (wait == WAIT_FAILED)
      detail << " wait_windows=" << GetLastError();
    DWORD code = 0;
    if (GetExitCodeProcess(process, &code))
      detail << " exit_code=0x" << std::hex << code;
    else
      detail << " exit_query_windows=" << GetLastError();
    return detail.str();
  }
  void Start() {
    if (!producer_stop_pending && Alive() && control)
      return;
    if (process || job)
      fprintf(stderr, "session %s browser replacement control=%d stop_pending=%d peer=%llu %s\n",
              id.c_str(), control.load() != 0, producer_stop_pending, peer.load(),
              ProcessDiagnostic().c_str());
    if (!Stop())
      throw std::runtime_error(
          "previous browser termination unfinished; retry the retained producer before restart");
    streaming_adapter = SelectStreamingAdapter(sdk, options);
    const auto luid = AdapterLuid(streaming_adapter->luid);
    fprintf(stderr, "session %s selected streaming encoder=%s adapter_luid=%s\n", id.c_str(),
            streaming_adapter->encoder.c_str(), luid.c_str());
    job = CreateJobObjectW(nullptr, nullptr);
    if (!job)
      throw std::runtime_error("CreateJobObject failed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
      throw std::runtime_error("job limits failed");
    std::string channel = "RemoteKit.service." + std::to_string(GetCurrentProcessId()) + "." + id +
                          "." + std::to_string(QpcNow());
    client_gestures_control = 0;
    browser_incarnation = NewIncarnation();
    std::wstring command = Quote(options.browser.wstring());
    auto append = [&](std::wstring arg) { command += L" " + Quote(arg); };
    append(L"--use-adapter-luid=" + std::wstring(luid.begin(), luid.end()));
    append(L"--control-channel=" + std::wstring(channel.begin(), channel.end()));
    append(L"--browser-incarnation=" +
           std::wstring(browser_incarnation.begin(), browser_incarnation.end()));
    append(L"--session-id=" + std::wstring(id.begin(), id.end()));
    append(L"--tenant-id=" + std::wstring(id.begin(), id.end()));
    append(L"--data-path=" + directory.wstring());
    append(L"--atlas-width=1920");
    append(L"--atlas-height=1080");
    if (!options.browser_enable_features.empty())
      append(L"--enable-features=" + std::wstring(options.browser_enable_features.begin(),
                                                  options.browser_enable_features.end()));
    if (!options.browser_disable_features.empty())
      append(L"--disable-features=" + std::wstring(options.browser_disable_features.begin(),
                                                   options.browser_disable_features.end()));
    if (!options.browser_trace_directory.empty()) {
      fs::create_directories(options.browser_trace_directory);
      const auto file = options.browser_trace_directory /
                        ("session-" + id + "-" + std::to_string(QpcNow()) + ".json");
      append(
          L"--trace-startup=gpu.capture,viz,gpu,toplevel,toplevel.flow,disabled-by-default-gpu."
          L"service,disabled-by-default-gpu.device");
      append(L"--trace-startup-duration=16");
      append(L"--trace-startup-format=json");
      append(L"--trace-startup-file=" + file.wstring());
      append(L"--trace-startup-record-mode=record-until-full");
      append(L"--default-trace-buffer-size-limit-in-kb=32768");
    }
    fprintf(stderr, "session %s browser command %s\n", id.c_str(), Utf8(fs::path(command)).c_str());
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION info{};
    if (!CreateProcessW(options.browser.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                        options.browser.parent_path().c_str(), &startup, &info))
      throw std::runtime_error("browser launch Windows " + std::to_string(GetLastError()));
    process = info.hProcess;
    process_incarnation = browser_incarnation;
    process_in_job = false;
    if (!AssignProcessToJobObject(job, process)) {
      const auto error = GetLastError();
      CloseHandle(info.hThread);
      // This exact process was created suspended by us and never joined the job.
      // Terminating the empty job cannot release it. Retain the process handle
      // for Stop's confirmation/retry even if the targeted termination fails.
      const bool terminated = TerminateProcess(process, 1) != FALSE;
      const auto waited = WaitForSingleObject(process, 5000);
      fprintf(stderr, "unassigned browser cleanup terminated=%d wait=%lu\n", terminated, waited);
      throw std::runtime_error("browser job assignment Windows " + std::to_string(error) + " " +
                               ProcessDiagnostic());
    }
    process_in_job = true;
    if (ResumeThread(info.hThread) == DWORD(-1)) {
      const auto error = GetLastError();
      CloseHandle(info.hThread);
      throw std::runtime_error("browser resume Windows " + std::to_string(error) + " " +
                               ProcessDiagnostic());
    }
    CloseHandle(info.hThread);
    fprintf(stderr, "session %s browser launched pid %lu browser_log=%s\n", id.c_str(),
            GetProcessId(process), Utf8(directory / "browser.log").c_str());
    const auto started = QpcNow(), deadline = started + QpcFrequency() * 15;
    int status = 1;
    unsigned attempts = 0;
    while (Alive() && QpcNow() < deadline) {
      uint64_t connected_control = 0;
      ++attempts;
      status = sdk.remotekit_sdk_control_connect(channel.c_str(), &connected_control);
      if (status == 0)
        control = connected_control;
      if (status == 0)
        break;
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (status != 0 || !control)
      throw std::runtime_error(
          "browser control connect failed " + std::to_string(status) + " " + ProcessDiagnostic() +
          " elapsed_ms=" + std::to_string((QpcNow() - started) * 1000 / QpcFrequency()) +
          " attempts=" + std::to_string(attempts) +
          " browser_log=" + Utf8(directory / "browser.log"));
    fprintf(stderr, "session %s browser pid %lu\n", id.c_str(), GetProcessId(process));
    observed_closed.clear();
    navigation_export.Clear();
    recovery_revisions.clear();
    recoveries.clear();
    recovery_cursor.clear();
    Rpc({{"method", "session.sitePreferences"}, {"session", id}, {"sites", site_preferences}});
    BrowserSnapshot();
    if (!desired.empty()) {
      // Hidden construction never requires the previous/final atlas to fit an
      // intermediate set of specs. One transaction applies the complete layout.
      for (auto& [view, config] : desired)
        CreateView(config, true);
      GeometryConfig(DesiredGeometry());
    }
    reconciliation_pending = false;
  }
  Json BrowserSnapshot() { return Rpc({{"method", "snapshot"}}); }
  struct Geometry {
    int width = 16, height = 16;
    float scale = 1;
  };
  Geometry DesiredGeometry() {
    std::vector<remotekit::PackItem> items;
    float scale = .5f;
    for (auto& [view, config] : desired) {
      if (!config.value("visible", false))
        continue;
      const auto device = config.value("device", Json::object());
      int w = config.value("width", device.value("width", 1440));
      int h = config.value("height", device.value("height", 900));
      if (w < 1 || h < 1 || w > 8192 || h > 8192)
        throw std::runtime_error("invalid viewport dimensions");
      items.push_back({std::stoull(view), w, h, 1.0});
      scale = std::max(scale, device.value("deviceScaleFactor", 1.0f));
    }
    const auto plan = remotekit::PlanAtlas(items, items.empty() ? 1.f : scale,
                                           options.atlas_allocation_alignment);
    if (!plan)
      throw std::runtime_error(
          "visible source atlas cannot be packed within the aligned 16-megapixel/8192-pixel "
          "resource budget");
    return {plan->width, plan->height, plan->scale};
  }
  bool PauseOutput(bool reconfiguring = false) {
    const bool active = peer.load() != 0;
    const bool had_media_thread = media_thread.joinable();
    if (active || had_media_thread) {
      stop_media = true;
      event_wake.notify_all();
      if (media_thread.joinable())
        media_thread.join();
    }
    InvalidateLayout(reconfiguring ? "reconfigure" : "output-paused");
    try {
      Rpc({{"method", "output.close"}});
    } catch (const std::exception& error) {
      fprintf(stderr,
              "output close unfinished: %s; resources retained until producer stop confirmed\n",
              error.what());
    }
    // A joined MediaLoop already ran its render exit barrier. Without an owner
    // thread (e.g. output-open failure), this caller must perform that barrier.
    if (!had_media_thread) {
      std::string render_error;
      if (!pool.Close(render_error, ProducerExited()))
        fprintf(stderr, "paused render drain: %s\n", render_error.c_str());
    }
    return active;
  }
  void GeometryConfig(const Geometry& value) {
    if (!remotekit::AtlasAllocationDimensions(value.width, value.height, value.scale,
                                              options.atlas_allocation_alignment))
      throw std::runtime_error(
          "source atlas exceeds the aligned 16-megapixel/8192-pixel resource budget");
    Json configs = Json::array();
    bool visible_output = false;
    for (const auto& [view, config] : desired) {
      const auto device = config.value("device", Json::object());
      const bool visible = !Recovering(view) && config.value("visible", false);
      visible_output |= visible;
      configs.push_back({{"session", id},
                         {"view", view},
                         {"width", config.value("width", device.value("width", 1440))},
                         {"height", config.value("height", device.value("height", 900))},
                         {"device", device.value("mode", std::string("desktop"))},
                         {"device_scale_factor", device.value("deviceScaleFactor", 1.0f)},
                         {"visible", visible}});
    }
    Rpc({{"method", "output.configure"},
         {"width", value.width},
         {"height", value.height},
         {"viewConfigs", std::move(configs)},
         {"device_scale", value.scale},
         {"allocation_alignment", options.atlas_allocation_alignment}});
    atlas_width = value.width;
    atlas_height = value.height;
    atlas_scale = value.scale;
    has_visible_output = visible_output;
  }
  void RefitOutput() {
    const auto geometry = DesiredGeometry();
    if (!reconciliation_pending && geometry.width == atlas_width &&
        geometry.height == atlas_height && geometry.scale == atlas_scale)
      return;
    ReconcileOutput();
  }
  void ResumeOutput(bool active) {
    if (!active)
      return;
    OpenOutput();
    stop_media = false;
    media_thread = std::thread([this] { MediaLoop(); });
  }
  void ReconcileOutput() {
    const bool active = PauseOutput();
    try {
      GeometryConfig(DesiredGeometry());
      Save();
      ResumeOutput(active);
      reconciliation_pending = false;
    } catch (...) {
      reconciliation_pending = true;
      next_reconciliation = QpcNow() + QpcFrequency();
      output_suspended = true;
      throw;
    }
  }
  Json ApplyView(const Json& config, bool create, bool recovering = false) {
    auto view = ViewId(config);
    auto old = desired.find(view);
    Json previous = old == desired.end() ? Json() : old->second;
    auto normalized = [](Json value) {
      value.erase("id");
      value.erase("method");
      return value;
    };
    if (!previous.is_null() && normalized(previous) == normalized(config)) {
      if (reconciliation_pending || (output_suspended && has_visible_output && rtc_connected))
        ReconcileOutput();
      return {{"accepted", true}, {"completed", true}};
    }
    bool source_applied = false;
    desired[view] = config;
    Geometry geometry;
    try {
      geometry = DesiredGeometry();
    } catch (...) {
      if (previous.is_null())
        desired.erase(view);
      else
        desired[view] = previous;
      throw;
    }
    const bool reconfiguring = !create && !recovering && !Recovering(view) && !previous.is_null() &&
                               previous.value("visible", false) && config.value("visible", false);
    const bool active = PauseOutput(reconfiguring);
    try {
      Json result = {{"accepted", true}, {"completed", true}};
      if (create) {
        result = CreateView(config, recovering);
        source_applied = true;
      }
      GeometryConfig(geometry);
      source_applied = true;
      reconciliation_pending = true;
      Save();
      ResumeOutput(active);
      reconciliation_pending = false;
      return result;
    } catch (const std::exception& failure) {
      const std::string original = failure.what();
      // Before commit the candidate can be discarded. After a source/adoption
      // commit the accepted desired state must survive persistence/media failure.
      if (!source_applied) {
        if (previous.is_null())
          desired.erase(view);
        else
          desired[view] = previous;
      }
      reconciliation_pending = true;
      next_reconciliation = QpcNow() + QpcFrequency();
      output_suspended = true;
      if (reconfiguring)
        InvalidateLayout("reconfigure-failed");
      {
        std::lock_guard lock(stats->mutex);
        stats->error = original;
      }
      throw;
    }
  }
  static void NavigationOperation(Json& target, const Json& source) {
    for (const auto* key : {"operationId", "operationGeneration", "operationSequence"})
      if (source.contains(key))
        target[key] = source[key];
  }
  Json CreateView(const Json& config, bool recovering = false) {
    auto view = ViewId(config);
    auto device = config.value("device", Json::object());
    std::string mode =
        device.is_object() ? device.value("mode", std::string("desktop")) : std::string("desktop");
    Json request = {{"method", "view.create"},
                    {"session", id},
                    {"view", view},
                    {"url", recovering && fs::exists(directory / "recovery" / (view + ".json"))
                                ? std::string("about:blank")
                                : config.value("url", std::string("about:blank"))},
                    {"width", config.value("width", device.value("width", 1440))},
                    {"height", config.value("height", device.value("height", 900))},
                    {"device", mode},
                    {"visible", false}};
    if (!recovering && config.value("method", std::string()) == "view.adopt") {
      request["method"] = "view.adopt";
      request["provisionalId"] = Required(config, "provisionalId");
    }
    if (!recovering)
      NavigationOperation(request, config);
    if (device.contains("deviceScaleFactor"))
      request["device_scale_factor"] = device["deviceScaleFactor"];
    if (recovering && fs::exists(directory / "recovery" / (view + ".json")))
      request["visible"] = false;
    auto result = Rpc(request);
    if (recovering && fs::exists(directory / "recovery" / (view + ".json")))
      recoveries[view] = Recovery{};
    return result;
  }
  bool Recovering(const std::string& view) const {
    const auto found = recoveries.find(view);
    return found != recoveries.end() && found->second.Pending();
  }
  Json RecoveryStatus(const Recovery& recovery) const {
    return {{"pending", recovery.Pending()}, {"phase", recovery.phase}, {"error", recovery.error}};
  }
  Json RecoverySnapshot() const {
    Json views = Json::object();
    bool pending = false;
    for (const auto& [view, recovery] : recoveries) {
      views[view] = RecoveryStatus(recovery);
      pending |= recovery.Pending();
    }
    return {{"pending", pending},
            {"views", std::move(views)},
            {"exportPending", navigation_export.Pending()}};
  }
  bool CancelRecovery(const std::string& view) {
    auto found = recoveries.find(view);
    if (found == recoveries.end())
      return false;
    const bool pending = found->second.Pending();
    const auto transfer = found->second.transfer;
    recoveries.erase(found);
    recovery_revisions.erase(view);
    if (!transfer.empty() && control) {
      try {
        Rpc({{"method", "navigation.transfer.cancel"},
             {"session", id},
             {"view", view},
             {"transfer", transfer}});
      } catch (const std::exception& error) {
        fprintf(stderr, "recovery transfer cancel: %s\n", error.what());
      }
    }
    return pending;
  }
  // Called only by the JSONL dispatcher. One phase/one selected view per turn;
  // never sleep or poll inside a phase. Media/input workers do not own this map.
  void MaintainRecovery() {
    // Alternate with restore/reconciliation so neither bulk direction starves
    // another Session or the normal JSONL dispatcher.
    export_turn = !export_turn;
    if (export_turn && navigation_export.Pending() && Alive() && control &&
        !producer_stop_pending) {
      MaintainNavigationExport();
      return;
    }
    if (reconciliation_pending && Alive() && control && !producer_stop_pending &&
        QpcNow() >= next_reconciliation) {
      try {
        ReconcileOutput();
      } catch (const std::exception& error) {
        fprintf(stderr, "session %s reconciliation: %s\n", id.c_str(), error.what());
      }
      return;
    }
    if (recoveries.empty() || !Alive() || !control || producer_stop_pending)
      return;
    auto selected = recoveries.upper_bound(recovery_cursor);
    const auto now = QpcNow();
    for (size_t count = 0; count < recoveries.size(); ++count) {
      if (selected == recoveries.end())
        selected = recoveries.begin();
      if (selected->second.Pending() && selected->second.next_poll <= now)
        break;
      ++selected;
    }
    if (selected == recoveries.end() || !selected->second.Pending() ||
        selected->second.next_poll > now)
      return;
    const auto view = selected->first;
    recovery_cursor = view;
    auto& task = selected->second;
    if (!desired.contains(view)) {
      CancelRecovery(view);
      return;
    }
    try {
      if (task.phase == "load") {
        const auto path = directory / "recovery" / (view + ".json");
        const auto file_bytes = fs::file_size(path);
        if (file_bytes > 96 * 1024 * 1024)
          throw std::runtime_error("navigation recovery file exceeds bound");
        uint64_t buffered = 0;
        for (const auto& [key, recovery] : recoveries)
          buffered += recovery.buffer_bytes;
        if (buffered + file_bytes > 96 * 1024 * 1024) {
          task.next_poll = now + QpcFrequency() / 20;
          return;
        }
        task.saved = LoadJson(path);
        const auto size = std::stoull(task.saved.at("size").get<std::string>());
        if (!size || size > 64 * 1024 * 1024 || !task.saved.at("chunks").is_array() ||
            task.saved["chunks"].size() > 256)
          throw std::runtime_error("invalid navigation recovery size/chunks");
        task.buffer_bytes = file_bytes;
        task.phase = "settling";
        task.deadline = now + QpcFrequency();
      } else if (task.phase == "settling" || task.phase == "waiting") {
        const auto snapshot = BrowserSnapshot();
        const Json* current = nullptr;
        for (const auto& session : snapshot.at("sessions"))
          for (const auto& candidate : session.at("views"))
            if (candidate.value("view", std::string()) == view)
              current = &candidate;
        if (!current || current->value("close_state", std::string()) == "closed") {
          CancelRecovery(view);
          return;
        }
        if (task.phase == "settling") {
          if (!current->value("loading", false) || now >= task.deadline)
            task.phase = "unload";
        } else if (!current->value("pending", true)) {
          const auto last = current->value("last_lifecycle", Json::object());
          if (current->value("actual", -1) != 0 || !last.value("succeeded", false))
            throw std::runtime_error(
                last.value("detail", std::string("navigation recovery failed")));
          task.phase = "visible";
        } else if (now >= task.deadline)
          throw std::runtime_error("navigation recovery did not finish");
        task.next_poll = now + QpcFrequency() / 20;
      } else if (task.phase == "unload") {
        Rpc({{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", "unload"}});
        task.phase = "begin";
      } else if (task.phase == "begin") {
        auto reply = Rpc({{"method", "navigation.import.begin"},
                          {"session", id},
                          {"view", view},
                          {"size", task.saved.at("size")}});
        task.transfer = reply.at("transfer");
        task.phase = "chunks";
      } else if (task.phase == "chunks") {
        if (task.chunk == task.saved.at("chunks").size()) {
          task.phase = "commit";
          return;
        }
        const auto& chunk = task.saved["chunks"][task.chunk];
        const auto bytes = chunk.at("bytes").get<uint64_t>();
        if (!bytes || bytes > 256 * 1024 ||
            DecodedSize(chunk.at("data").get<std::string>()) != bytes)
          throw std::runtime_error("invalid navigation recovery chunk");
        Rpc({{"method", "navigation.import.chunk"},
             {"session", id},
             {"view", view},
             {"transfer", task.transfer},
             {"offset", std::to_string(task.offset)},
             {"data", chunk.at("data")}});
        task.offset += bytes;
        ++task.chunk;
      } else if (task.phase == "commit") {
        Rpc({{"method", "navigation.import.commit"},
             {"session", id},
             {"view", view},
             {"transfer", task.transfer}});
        task.transfer.clear();
        task.saved = nullptr;
        task.buffer_bytes = 0;
        task.phase = "restore";
      } else if (task.phase == "restore") {
        Rpc({{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", "restore"}});
        task.phase = "waiting";
        task.deadline = now + QpcFrequency() * 11;
      } else if (task.phase == "visible") {
        task.phase = "complete";
        try {
          ReconcileOutput();
        } catch (const std::exception& error) {
          task.error = error.what();
        }
      } else if (task.phase == "fallback") {
        // Fresh GET of the product URL, never automatic replay of imported POST.
        Rpc({{"method", "view.recreate"},
             {"session", id},
             {"view", view},
             {"url", desired.at(view).value("url", std::string("about:blank"))}});
        task.saved = nullptr;
        task.buffer_bytes = 0;
        task.transfer.clear();
        task.phase = "fallback_started";
        try {
          ReconcileOutput();
        } catch (const std::exception& error) {
          task.error += "; output reconciliation: " + std::string(error.what());
        }
      }
    } catch (const std::exception& error) {
      fprintf(stderr, "session %s view %s navigation recovery: %s\n", id.c_str(), view.c_str(),
              error.what());
      task.error = error.what();
      task.saved = nullptr;
      task.buffer_bytes = 0;
      task.phase = task.phase == "fallback" ? "failed" : "fallback";
    }
  }
  void CaptureNavigation(const Json& browser_view) {
    const auto view = browser_view.at("view").get<std::string>();
    const auto revision = browser_view.value("navigationRevision", std::string());
    const auto saved = recovery_revisions.find(view);
    navigation_export.Observe(browser_view, browser_incarnation,
                              desired.contains(view) && !Recovering(view) &&
                                  (saved == recovery_revisions.end() || saved->second != revision));
  }
  void MaintainNavigationExport() {
    try {
      navigation_export.Tick(
          browser_incarnation,
          [&](const std::string& view) -> Json {
            const auto snapshot = BrowserSnapshot();
            for (const auto& session : snapshot.at("sessions"))
              for (const auto& item : session.at("views"))
                if (item.value("view", std::string()) == view && desired.contains(view) &&
                    !Recovering(view))
                  return item;
            return nullptr;
          },
          [&](Json command) {
            command["session"] = id;
            return Rpc(std::move(command));
          },
          [](const std::string& data) { return DecodedSize(data); },
          [&](const std::string& view, const Json& saved) {
            SaveJson(directory / "recovery" / (view + ".json"), saved);
            recovery_revisions[view] = saved.at("navigationRevision").get<std::string>();
          });
    } catch (const std::exception& error) {
      fprintf(stderr, "navigation save: %s\n", error.what());
    }
  }
  Json Stats() {
    auto value = stats->Snapshot();
    Json requested_policy;
    {
      std::lock_guard lock(media_policy_mutex);
      requested_policy = requested_media_policy;
    }
    const auto degradation = policy_degradation.load();
    const char* preference =
        degradation == REMOTEKIT_RTC_MAINTAIN_RESOLUTION  ? "maintain-resolution"
        : degradation == REMOTEKIT_RTC_MAINTAIN_FRAMERATE ? "maintain-framerate"
                                                          : "balanced";
    const Json applied_policy =
        peer.load() ? Json{{"maxFps", policy_max_fps.load()}, {"degradationPreference", preference}}
                    : Json(nullptr);
    value["mediaPolicy"] = {{"requested", requested_policy}, {"applied", applied_policy}};
    const auto slots = pool.Stats();
    CompDiagnostics comp;
    {
      std::lock_guard lock(comp_diagnostics_mutex);
      comp = comp_diagnostics;
    }
    value["comp"] = {{"idle", slots.idle},
                     {"idleEntries", slots.idleEntries},
                     {"wakes", slots.wakes},
                     {"begins", slots.begins},
                     {"rejectIdle", slots.rejectIdle},
                     {"rejectNotReady", slots.rejectNotReady},
                     {"rejectStopped", slots.rejectStopped},
                     {"readyObserved", slots.readyObserved},
                     {"consumedCompleted", slots.consumedCompleted},
                     {"stopSent", slots.stopSent},
                     {"stopConfirmed", slots.stopConfirmed},
                     {"activeDepth", slots.activeDepth},
                     {"occupied", slots.occupied},
                     {"retiredOccupied", slots.retiredOccupied},
                     {"peakOccupied", slots.peakOccupied},
                     {"retiredGenerations", slots.retiredGenerations},
                     {"retiredGenerationsCompleted", slots.retiredGenerationsCompleted},
                     {"unknownGpuRetainedGenerations", slots.unknownGpuRetainedGenerations},
                     {"unknownGpuRetentions", slots.unknownGpuRetentions},
                     {"targetFps", slots.idle ? 0 : comp.targetFps},
                     {"resumeMaxFps", comp.resumeMaxFps},
                     {"officialMaxFps", comp.officialMaxFps},
                     {"codecMaxFps", comp.codecMaxFps},
                     {"adaptRequests", comp.adaptRequests},
                     {"adaptDrops", comp.adaptDrops},
                     {"adaptErrors", comp.adaptErrors},
                     {"adaptSizeChanges", comp.adaptSizeChanges},
                     {"presentationRefreshPending", comp.refresh.pending},
                     {"presentationRefreshAttempts", comp.refresh.attempts},
                     {"presentationRefreshForcedBegins", comp.refresh.forced_begins},
                     {"presentationRefreshSuccesses", comp.refresh.successes}};
    value["sourceWidth"] = comp.sourceWidth;
    value["sourceHeight"] = comp.sourceHeight;
    value["encodedWidth"] = comp.encodedWidth;
    value["encodedHeight"] = comp.encodedHeight;
    value["configuredIdleIdrMs"] = options.idle_idr_ms;
    value["connectionTimingMs"] = ConnectionTimings();
    value["connectionTimingOrigin"] = "endpoint-offer-monotonic";
    value["connectionTimingConnectionId"] = connection;
    value["qsvVpp"] = options.encoding.qsv_async_vpp ? "async" : "external";
    value["atlasAllocationAlignment"] = options.atlas_allocation_alignment;
    value["reconciliationPending"] = reconciliation_pending.load();
    value.update(media_feedback.Snapshot(QpcNow(), QpcFrequency()));
    value["audio"] = {{"submitted", audio_submitted.load()},
                      {"gaps", audio_gaps.load()},
                      {"rejected", audio_rejected.load()}};
    value["rtcPlayoutDelayRequested"] = {{"minMs", options.rtc_playout_max_ms < 0 ? -1 : 0},
                                         {"maxMs", options.rtc_playout_max_ms}};
    value["effectiveIdleIdrMs"] = effective_idle_ms.load();
    value["tailIdrSubmissions"] = tail_submissions.load();
    value["tailIdrCompletions"] = tail_completions.load();
    const auto interval = source_interval_ms.load(), age = last_tail_age_ms.load();
    value["sourceFrameIntervalMs"] = interval > 0 ? Json(interval) : Json(nullptr);
    value["atlasReadyGateEnabled"] = pool.ready_gate_enabled();
    value["encoderSelection"] = options.encoder;
    value["atlasInput"] = "render-slots";
    value["atlasSharedBorrows"] = pool.shared_borrows();
    value["atlasSharedHeldSlots"] = pool.shared_held_slots();
    value["lastTailAfterSourceMs"] = age > 0 ? Json(age) : Json(nullptr);
    return value;
  }
  Json RtcSnapshot() const {
    const bool active = peer.load() != 0;
    return {{"active", active}, {"connectionId", active ? Json(connection) : Json(nullptr)}};
  }
  Json InactiveSnapshot() {
    // Only a signaled process handle proves producer exit. Retire its GPU state
    // through the existing stop boundary; observing a Session never launches it.
    if (ProducerExited()) {
      fprintf(stderr, "session %s inactive snapshot observed producer exit peer=%llu %s\n",
              id.c_str(), peer.load(), ProcessDiagnostic().c_str());
      Stop();
    }
    return {{"sessionId", id},
            {"browserPid", 0},
            {"views", Json::array()},
            {"pendingPopups", Json::array()},
            {"events", durable_events},
            {"running", false},
            {"browserIncarnation", nullptr},
            {"rtc", RtcSnapshot()},
            {"stats", Stats()},
            {"recovery", RecoverySnapshot()}};
  }
  Json Snapshot(bool output_diagnostics = false) {
    if (!Alive() || producer_stop_pending)
      return InactiveSnapshot();
    try {
      auto snapshot = BrowserSnapshot();
      Json views = Json::array(), closed_acks = Json::array();
      bool removed = false;
      for (auto& session : snapshot.at("sessions"))
        for (auto& view : session.at("views")) {
          std::string view_id = view.at("view");
          if (view.value("close_state", std::string()) == "closed") {
            removed |= desired.contains(view_id);
            RecordClosed(view_id, view.value("close_reason", std::string("closed")));
            closed_acks.push_back(view_id);
            continue;
          }
          Json item = view;
          item["viewId"] = view_id;
          if (const auto recovery = recoveries.find(view_id); recovery != recoveries.end()) {
            item["recovery"] = RecoveryStatus(recovery->second);
            item["browserPending"] = item.value("pending", false);
            // Includes Endpoint import/restore work. actual and browserPending retain
            // the observed Browser state while Control can avoid a conflicting thaw.
            item["pending"] = item.value("pending", false) || recovery->second.Pending();
            if (recovery->second.Pending()) {
              item["browserDesired"] = item["desired"];
              item["desired"] = 0;
            }
          }
          auto requests = Rpc({{"method", "page.requests"}, {"session", id}, {"view", view_id}});
          if (view.value("close_state", std::string()) == "closing")
            AddCloseRequest(item, requests);
          item["pageRequests"] = requests.value("requests", requests);
          CaptureNavigation(view);
          views.push_back(std::move(item));
        }
      if (removed)
        RefitOutput();
      AckClosed(closed_acks);
      // Explicit, read-only diagnostic sampling; routine Control snapshots do not
      // add an output RPC. Preserve the normal snapshot if output is unavailable.
      Json output_status;
      if (output_diagnostics) {
        try {
          output_status = Rpc({{"method", "output.status"}});
        } catch (...) {
          output_status = {{"ok", false}, {"error", "output_status_unavailable"}};
        }
      }
      return {
          {"sessionId", id},
          {"browserPid", process ? GetProcessId(process) : 0},
          {"views", views},
          {"pendingPopups", snapshot.at("sessions").at(0).value("pendingPopups", Json::array())},
          {"events", durable_events},
          {"running", true},
          {"browserIncarnation", browser_incarnation},
          {"rtc", RtcSnapshot()},
          {"stats", Stats()},
          {"recovery", RecoverySnapshot()},
          {"outputDiagnostics", std::move(output_status)}};
    } catch (...) {
      // A producer can exit between the liveness check and any snapshot RPC.
      // Preserve desired views and confirmed events; an exit is not window.close.
      if (!control || ProducerExited())
        return InactiveSnapshot();
      throw;
    }
  }
  static void AddCloseRequest(Json& output, const Json& requests) {
    // page.requests wraps its snapshot in "requests". Handle its documented
    // pending list without relying on JSON field order.
    const Json* data = &requests;
    if (requests.contains("requests"))
      data = &requests["requests"];
    if (!data->contains("pending"))
      return;
    for (auto& pending : (*data)["pending"]) {
      if (pending.value("kind", std::string()) == "beforeunload" ||
          pending.value("beforeunload", false)) {
        output["pending_close"] = {{"requestId", pending.at("request")}};
        output["requestId"] = pending.at("request");
        output["pending"] = true;
        return;
      }
    }
  }
  bool Stop() {
    navigation_export.Clear();
    recoveries.clear();
    recovery_cursor.clear();
    recovery_revisions.clear();
    reconciliation_pending = false;
    has_visible_output = false;
    browser_incarnation.clear();
    producer_stop_pending = process || job;
    ClosePeer();
    {
      std::lock_guard lock(rpc_mutex);
      if (control) {
        sdk.remotekit_sdk_control_close(control);
        control = 0;
      }
    }
    // Keep the job/process identity until this exact process is confirmed gone.
    // Closing the job first would lose the retry identity after a stop timeout.
    if (job && !TerminateJobObject(job, 0))
      fprintf(
          stderr,
          "producer job termination request failed (Windows=%lu); waiting for retained process\n",
          GetLastError());
    if (process) {
      if (!process_in_job && WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
          !TerminateProcess(process, 1))
        fprintf(stderr,
                "unassigned producer termination failed (Windows=%lu); retaining exact process\n",
                GetLastError());
      const auto exited = WaitForSingleObject(process, 5000);
      if (exited == WAIT_OBJECT_0) {
        last_confirmed_browser_exit = process_incarnation;
        {
          std::lock_guard lock(file_store_mutex);
          file_uploads.ConfirmBrowserStopped(process_incarnation);
        }
        process_incarnation.clear();
        // A crash may leave the last mapping status Running. Preserve confirmed
        // producer termination on retained generations before closing its handle.
        std::string error;
        if (!pool.Close(error, true))
          fprintf(stderr, "pool close after producer exit unfinished: %s\n", error.c_str());
      } else {
        fprintf(stderr,
                "producer termination not confirmed (wait=%lu); process/job identity and atlas "
                "resources retained\n",
                exited);
        return false;
      }
      CloseHandle(process);
      process = nullptr;
      process_in_job = false;
    }
    if (job) {
      CloseHandle(job);
      job = nullptr;
    }
    streaming_adapter.reset();
    producer_stop_pending = false;
    // A new browser may restart its local generation counters at one. Its
    // resources/documents still belong to a new presentation incarnation.
    current_geometry.clear();
    return true;
  }
  static int64_t CameraNow() { return static_cast<int64_t>(1000.0 * QpcNow() / QpcFrequency()); }
  bool FacePending(uint64_t epoch, std::string_view challenge) {
    const auto result = faces.Status(epoch, challenge);
    return result && result->state == rk::auth::FaceState::pending;
  }
  void WakeCamera() {
    {
      std::lock_guard lock(camera_mutex);
      camera_changed = true;
    }
    camera_wake.notify_one();
  }
  void CameraLoop() {
    const auto pending = [&](uint64_t epoch, std::string_view challenge) {
      return FacePending(epoch, challenge);
    };
    while (!stop_camera) {
      try {
        if (auto message = raw_camera.Next(CameraNow(), pending)) {
          if (sdk.remotekit_rtc_send_auth_data(message->peer, message->json.data(),
                                               message->json.size(), 0) != 0)
            raw_camera.Failed(*message);
          else
            raw_camera.Sent(*message, CameraNow());
        }
      } catch (const std::exception&) {
      }
      const bool active = raw_camera.Active();
      std::unique_lock lock(camera_mutex);
      const auto ready = [&] { return stop_camera || camera_changed; };
      if (active)
        camera_wake.wait_for(lock, std::chrono::milliseconds(20), ready);
      else
        camera_wake.wait(lock, ready);
      camera_changed = false;
    }
  }
  static void EventCallback(void* context,
                            uint64_t peer,
                            uint32_t type,
                            const void* bytes,
                            size_t size,
                            const char* auxiliary,
                            int32_t value) {
    auto* self = static_cast<Session*>(context);
    const auto rtc_received = type == REMOTEKIT_RTC_DATA && self->trace ? QpcNow() : 0;
    if (type == REMOTEKIT_RTC_AUTH_DATA_STATE) {
      self->raw_camera.State(peer, value == 1);
      self->WakeCamera();
      return;
    }
    if (type == REMOTEKIT_RTC_AUTH_DATA) {
      try {
        self->raw_camera.Receive(
            peer, value == 1, bytes, size, CameraNow(),
            [&](uint64_t epoch, std::string_view challenge) {
              return self->FacePending(epoch, challenge);
            },
            [&](int width, int height, const uint8_t* rgb, int stride) {
              self->faces.SubmitRGB24(width, height, rgb, stride);
            });
      } catch (const std::exception&) {
      }
      self->WakeCamera();
      return;
    }
    if (type == REMOTEKIT_RTC_DATA && (peer != self->peer.load() || size > 65536))
      return;
    const auto stamp = self->authorization.Stamp();
    Event event{type,
                std::string(static_cast<const char*>(bytes ? bytes : ""), size),
                auxiliary ? auxiliary : "",
                value,
                peer,
                stamp};
    if (peer == self->peer.load()) {
      if (type == REMOTEKIT_RTC_SDP_ANSWER)
        self->MarkConnection(ConnectionPhase::answer);
      else if (type == REMOTEKIT_RTC_ICE)
        self->MarkConnection(ConnectionPhase::first_candidate);
      else if (type == REMOTEKIT_RTC_ICE_COMPLETE)
        self->MarkConnection(ConnectionPhase::gather_complete);
      else if (type == REMOTEKIT_RTC_STATE && value == 2)
        self->MarkConnection(ConnectionPhase::connected);
      else if (type == REMOTEKIT_RTC_DATA_STATE && value == 1)
        self->MarkConnection(ConnectionPhase::data_open);
    }
    if (type == REMOTEKIT_RTC_DATA) {
      auto message = Json::parse(event.bytes, nullptr, false);
      if (self->authorization.Required()) {
        if (!message.is_object())
          return;
        const auto epoch = message.find("authEpoch");
        if (epoch == message.end() || !epoch->is_number_unsigned() ||
            epoch->get<uint64_t>() != self->authorization.Epoch())
          return;
      }
      if (!self->ProductCurrent(event) &&
          (!message.is_object() || message.value("type", Json()) != "media.presentation"))
        return;
      if (rtc_received && message.is_object() && message.value("type", Json()) == "input" &&
          PresentationNumber(message, "sequence", event.trace_input_sequence)) {
        RK_SERVER_TRACE(self->trace, "input_dc_received", TraceIds{}, rk_record.qpc = rtc_received;
                        rk_record.peer = peer;
                        rk_record.client_sequence = event.trace_input_sequence;
                        PresentationNumber(message, "view", rk_record.view);
                        PresentationNumber(message, "instance", rk_record.instance);
                        PresentationNumber(message, "document", rk_record.document);
                        PresentationNumber(message, "focus", rk_record.focus););
      }
      if (message.is_object() && message.value("type", Json()) == "files.request") {
        std::lock_guard admission(self->admission_mutex);
        if (self->ProductCurrent(event) && value == 0 &&
            remotekit::FileRequestEnvelope(message, size))
          self->file_services.Admit(peer, message);
        return;
      }
      if (message.is_object() && message.value("type", Json()) == "media.refresh") {
        if (self->ProductCurrent(event) && size <= 256) {
          const auto now = QpcNow();
          auto previous = self->last_media_refresh_qpc.load();
          if ((!previous || now - previous >= QpcFrequency()) &&
              self->last_media_refresh_qpc.compare_exchange_strong(previous, now)) {
            self->refresh_connected = true;
            self->event_wake.notify_one();
          }
        }
        return;
      }
      if (message.is_object() && message.value("type", Json()) == "media.feedback") {
        if (self->ProductCurrent(event))
          self->media_feedback.Receive(peer, message, QpcNow(), size);
        return;
      }
    }
    if (type == REMOTEKIT_RTC_SDP_ANSWER || type == REMOTEKIT_RTC_ICE ||
        type == REMOTEKIT_RTC_ICE_COMPLETE || type == REMOTEKIT_RTC_ERROR) {
      std::lock_guard lock(self->signal_mutex);
      if (self->trickle_signals && !self->signal_overflow) {
        if (self->signal_events.size() < 256)
          self->signal_events.push_back(event);
        else {
          self->signal_events.clear();
          self->signal_overflow = true;
          self->signal_events.push_back(
              Event{REMOTEKIT_RTC_ERROR, "RTC signaling queue exceeded bound", "", 0, peer});
        }
      }
      if (type == REMOTEKIT_RTC_ICE_COMPLETE) {
        self->answer = event.bytes;
        self->ice_complete = true;
      } else if (type == REMOTEKIT_RTC_ERROR)
        self->rtc_error = event.bytes;
      self->signal_wake.notify_all();
    }
    {
      std::lock_guard lock(self->event_mutex);
      if (event.trace_input_sequence) {
        RK_SERVER_TRACE(self->trace, "input_comp_queue", TraceIds{}, rk_record.peer = peer;
                        rk_record.client_sequence = event.trace_input_sequence;
                        rk_record.queue = static_cast<int>(self->events.size());
                        rk_record.status = self->events.size() >= 1024;);
      }
      if (self->events.size() < 1024)
        self->events.push_back(std::move(event));
    }
    self->event_wake.notify_all();
  }
  static int CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder) {
    auto* self = static_cast<Session*>(context);
    std::lock_guard lock(self->encoder_mutex);
    if (!self->streaming_adapter)
      return 1;
    const auto& adapter = *self->streaming_adapter;
    self->encoders.emplace(
        encoder,
        std::make_unique<EncoderWorker>(
            self->sdk, encoder, adapter.device.Get(), adapter.encoder, self->options.encoding,
            self->stats,
            [self, encoder_peer, first_encoded = true](uint32_t timestamp, uint64_t epoch,
                                                       size_t encoded_bytes, bool keyframe,
                                                       const remotekit_rtc_frame& source) mutable {
              const auto stamp = self->frame_authorization.load();
              if (!self->authorization.Current(stamp) || epoch != self->layout_epoch.load())
                return;
              if (first_encoded) {
                if (encoder_peer == self->peer.load())
                  self->MarkConnection(ConnectionPhase::encoded);
                first_encoded = false;
              }
              // Enqueue only: signaling-thread destroy joins this encoder worker.
              Json message = {{"type", "frame"},
                              {"rtpTimestamp", timestamp},
                              {"layoutEpoch", std::to_string(epoch)},
                              {"encodedBytes", encoded_bytes},
                              {"keyframe", keyframe}};
              LARGE_INTEGER before{}, after{};
              FILETIME utc{};
              QueryPerformanceCounter(&before);
              GetSystemTimePreciseAsFileTime(&utc);
              QueryPerformanceCounter(&after);
              ULARGE_INTEGER ticks{};
              ticks.LowPart = utc.dwLowDateTime;
              ticks.HighPart = utc.dwHighDateTime;
              if (auto clock = remotekit::MapCaptureClock(
                      source.capture_qpc, source.qpc_frequency, before.QuadPart, after.QuadPart,
                      double(ticks.QuadPart - 116444736000000000ULL) / 10000.0,
                      self->capture_clock_uncertainty_ms.load())) {
                message["captureWallTimeMs"] = clock->wall_ms;
                message["captureMonotonicMs"] = clock->monotonic_ms;
                message["captureClockUncertaintyMs"] = clock->uncertainty_ms;
                message["sourceCaptureId"] = std::to_string(source.capture_qpc);
              }
              std::lock_guard event_lock(self->event_mutex);
              if (self->events.size() < 1024)
                self->events.push_back(Event{0x10000, message.dump(), "", 0, encoder_peer, stamp});
              self->event_wake.notify_one();
            },
            self->trace, encoder_peer,
            [self, encoder_peer](const remotekit_rtc_frame& source, bool keyframe,
                                 const std::function<bool()>& send) {
              const auto stamp = self->frame_authorization.load();
              if (!self->authorization.Current(stamp) ||
                  source.layout_epoch != self->layout_epoch.load())
                return false;
              return self->presentation.Send(encoder_peer, source.layout_epoch, keyframe, [&] {
                if (!self->authorization.Current(stamp))
                  return false;
                const bool sent = send();
                if (sent && keyframe)
                  self->input_authorization = stamp;
                return sent;
              });
            }));
    return 0;
  }
  static int ConfigureEncoder(void* context,
                              uint64_t encoder,
                              const remotekit_rtc_encoder_config* config) {
    auto* self = static_cast<Session*>(context);
    std::lock_guard lock(self->encoder_mutex);
    auto found = self->encoders.find(encoder);
    if (found == self->encoders.end())
      return 1;
    auto limited = *config;
    self->MarkConnection(ConnectionPhase::encoder_configure_start);
    const bool ok = found->second->Configure(limited);
    self->MarkConnection(ConnectionPhase::encoder_configure_end);
    return ok ? 0 : 1;
  }
  static int Encode(void* context, uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
    auto* self = static_cast<Session*>(context);
    std::lock_guard lock(self->encoder_mutex);
    // A source-queue timeout/new source can supersede a tail before Encode runs.
    // Reject that old tag before GPU work; independent PLI requests already went
    // through Keyframe() and remain pending on the worker.
    if (!remotekit::TailRefreshLease::BeginEncoding(*frame))
      return REMOTEKIT_SDK_BUSY;
    auto found = self->encoders.find(encoder);
    if (found != self->encoders.end() &&
        found->second->Enqueue(*frame, key != 0 || remotekit::TailRefreshLease::From(*frame)))
      return 0;
    remotekit::TailRefreshLease::Finish(*frame, false);
    return REMOTEKIT_SDK_BUSY;
  }
  static void Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
    auto* self = static_cast<Session*>(context);
    self->comp_bitrate = bitrate;
    self->comp_fps = fps;
    self->event_wake.notify_one();
    std::lock_guard lock(self->encoder_mutex);
    auto found = self->encoders.find(encoder);
    if (found != self->encoders.end())
      found->second->Rates(bitrate, fps);
  }
  static void Keyframe(void* context, uint64_t encoder) {
    auto* self = static_cast<Session*>(context);
    std::lock_guard lock(self->encoder_mutex);
    auto found = self->encoders.find(encoder);
    if (found != self->encoders.end())
      found->second->Keyframe();
  }
  static void DestroyEncoder(void* context, uint64_t encoder) {
    auto* self = static_cast<Session*>(context);
    std::unique_ptr<EncoderWorker> worker;
    {
      std::lock_guard lock(self->encoder_mutex);
      auto found = self->encoders.find(encoder);
      if (found != self->encoders.end()) {
        worker = std::move(found->second);
        self->encoders.erase(found);
      }
    }
    if (worker)
      worker->Stop();
  }
  void OpenOutput(bool preserve_visibility = false) {
    MarkConnection(ConnectionPhase::output_open_start);
    // OSR output resources require a subscribed view. With no visible output,
    // keep RTC/DataChannel alive without opening a render generation.
    // MediaLoop's resource replacement uses its existing subscription state.
    // Control may already be changing desired before PauseOutput joins us.
    if (!preserve_visibility)
      output_suspended = !has_visible_output.load();
    if (output_suspended || !rtc_connected || !authorization.Stamp())
      return;
    remotekit_rtc_clock_sample clock{};
    clock.struct_size = sizeof(clock);
    if (!sdk.sample_clock || sdk.sample_clock(&clock) != 0 || !clock.qpc_frequency)
      throw std::runtime_error("SDK monotonic clock mapping unavailable");
    pool.SetClock(clock);
    if (trace)
      trace->SdkClock(clock);
    remotekit_sdk_render_setup setup{};
    setup.struct_size = sizeof(setup);
    int result;
    {
      std::lock_guard lock(rpc_mutex);
      result = sdk.remotekit_sdk_control_open_render(control, GetCurrentProcessId(), &setup, 15000);
    }
    if (result != 0) {
      // The SDK's DATA_MISMATCH also covers a browser-side non-pending error.
      // Preserve the producer's actual status/error rather than infer device loss.
      try {
        fprintf(stderr, "session %s atlas open failed sdk=%d desired=%dx%d@%.3f browser=%s\n",
                id.c_str(), result, atlas_width, atlas_height, atlas_scale,
                Rpc({{"method", "output.status"}}).dump().c_str());
      } catch (const std::exception& diagnostic) {
        fprintf(stderr, "session %s atlas open failed sdk=%d status_query=%s\n", id.c_str(), result,
                diagnostic.what());
      }
      throw std::runtime_error("output open SDK " + std::to_string(result));
    }
    capture_clock_uncertainty_ms = pool.clock_uncertainty_us() / 1000;
    const auto& adapter = *streaming_adapter;
    std::string error;
    if (!pool.Open(setup, GetProcessId(process), sdk, adapter.luid, adapter.device.Get(),
                   adapter.context.Get(), error))
      throw std::runtime_error(
          error + " expected_adapter=" + AdapterLuid(adapter.luid) +
          " render_adapter=" + AdapterLuid({setup.adapter_luid_low, setup.adapter_luid_high}));
    MarkConnection(ConnectionPhase::output_open_end);
  }
  int SendData(uint64_t handle, uint64_t stamp, const std::string& encoded) {
    if (!authorization.Current(stamp))
      return 1;
    if (!authorization.Required())
      return sdk.remotekit_rtc_send_data(handle, encoded.data(), encoded.size(), 0);
    // All outboxes serialize objects. Append the active wire epoch at actual
    // admission, while the queue's local generation still owns this send.
    if (encoded.size() < 2 || encoded.front() != '{' || encoded.back() != '}')
      return 1;
    std::string wire = encoded.substr(0, encoded.size() - 1);
    if (wire.size() > 1)
      wire += ',';
    wire += "\"authEpoch\":" + std::to_string(authorization.Epoch()) + "}";
    return authorization.Current(stamp)
               ? sdk.remotekit_rtc_send_data(handle, wire.data(), wire.size(), 0)
               : 1;
  }
  void Send(const Json& message, uint64_t expected_stamp = 0) {
    const auto stamp = authorization.Stamp();
    auto handle = peer.load();
    if (!stamp || (expected_stamp && stamp != expected_stamp) || !handle || !data_open ||
        stamp != frame_authorization.load())
      return;
    FlushControl();
    control_outbox.Transient(
        handle, message.dump(),
        [&](const std::string& encoded) { return SendData(handle, stamp, encoded); },
        message.value("type", std::string()) == "frame" ||
            message.value("type", std::string()) == "stats");
  }
  void FlushControl() {
    const auto stamp = authorization.Stamp();
    const auto handle = peer.load();
    if (!stamp || !handle || !data_open || stamp != frame_authorization.load())
      return;
    control_outbox.Flush(
        handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    // Layout and prepare always have admission priority over service replies.
    control_outbox.Transient(handle, std::string(), [&](const std::string&) {
      direct_services.Flush(
          handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
      return 0;
    });
    control_outbox.Transient(handle, std::string(), [&](const std::string&) {
      file_services.Flush(
          handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
      return 0;
    });
  }
  bool ServiceMessage(const Event& event) {
    if (event.value != 0 || !ProductCurrent(event))
      return false;
    const auto message = Json::parse(event.bytes, nullptr, false);
    if (!message.is_object())
      return false;
    const auto type = message.value("type", Json());
    if (type == "clock.ping") {
      if (event.bytes.size() > 512 || message.value("version", Json()) != 1 ||
          !message.contains("requestId") || !remotekit::BoundedServiceId(message["requestId"]))
        return true;
      LARGE_INTEGER before{}, after{};
      FILETIME utc{};
      QueryPerformanceCounter(&before);
      GetSystemTimePreciseAsFileTime(&utc);
      QueryPerformanceCounter(&after);
      ULARGE_INTEGER ticks{};
      ticks.LowPart = utc.dwLowDateTime;
      ticks.HighPart = utc.dwHighDateTime;
      Send({{"type", "clock.pong"},
            {"version", 1},
            {"requestId", message["requestId"]},
            {"serverTimeMs", double(ticks.QuadPart - 116444736000000000ULL) / 10000.0},
            {"serverMonotonicMs",
             1000.0 * (before.QuadPart + (after.QuadPart - before.QuadPart) / 2) / QpcFrequency()}},
           event.authorization);
      return true;
    }
    if (type != "product.action")
      return false;
    std::unique_lock admission(admission_mutex);
    if (!ProductCurrent(event))
      return true;
    if (!remotekit::ProductActionEnvelope(message, event.bytes.size()))
      return true;
    const bool accepted =
        direct_services.Admit(event.peer, message, 1000.0 * QpcNow() / QpcFrequency());
    admission.unlock();
    if (!accepted)
      Send({{"type", "product.result"},
            {"version", 1},
            {"operationId", message["operationId"]},
            {"connectionId", connection},
            {"operationGeneration", message["operationGeneration"]},
            {"ok", false},
            {"error", "endpoint_backpressure"}},
           event.authorization);
    return true;
  }
  void QueueLayout(const Json& mode = Json()) {
    Json prepare;
    if (layout_prepare && !layout.empty()) {
      const auto& key = *layout_prepare;
      prepare = {{"type", "presentation.prepare"},
                 {"version", 1},
                 {"barrierId", std::to_string(key.barrier)},
                 {"outputGeneration", std::to_string(key.generation)},
                 {"layoutEpoch", std::to_string(key.epoch)}};
    }
    control_outbox.Replace(peer.load(), mode.is_null() ? std::string() : mode.dump(),
                           layout.empty() ? std::string() : layout.dump(),
                           prepare.is_null() ? std::string() : prepare.dump());
    FlushControl();
  }
  static bool PresentationNumber(const Json& message, const char* field, uint64_t& result) {
    const auto found = message.find(field);
    if (found == message.end() || !found->is_string())
      return false;
    const auto& value = found->get_ref<const std::string&>();
    if (value.empty() || (value.size() > 1 && value[0] == '0'))
      return false;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
    return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
  }
  bool PresentationMessage(const Event& event) {
    const auto message = Json::parse(event.bytes, nullptr, false);
    if (!message.is_object())
      return false;
    const auto type = message.value("type", Json());
    if (type != "media.presentation" && type != "presentation.ready")
      return false;
    if (event.bytes.size() > 512 || message.value("version", Json()) != 1)
      return true;
    if (type == "media.presentation") {
      if (message.value("backend", Json()) != "video")
        return true;
      const bool restart = authorization.Required() && ProductCurrent(event) &&
                           message.value("restart", Json()) == true;
      layout_prepare = presentation.Video(event.peer, restart);
      if (restart) {
        input_authorization = 0;
        control_outbox.Bind(event.peer);
        refresh_connected = true;
      }
      // Mode() installs the gate before any video support confirmation leaves.
      QueueLayout({{"type", "presentation.mode"}, {"version", 1}, {"backend", "video"}});
    } else {
      remotekit::PresentationBarrier::Key key;
      if (PresentationNumber(message, "barrierId", key.barrier) &&
          PresentationNumber(message, "outputGeneration", key.generation) &&
          PresentationNumber(message, "layoutEpoch", key.epoch) &&
          presentation.Ready(event.peer, key)) {
        layout_prepare.reset();
        refresh_connected = true;
      }
    }
    return true;
  }
  void PublishLayout(Json next, uint64_t epoch) {
    // Serialize replacement with the last encoded publication, including old
    // hardware jobs already in flight. Metadata is sent only after gate closure.
    const auto prepare =
        presentation.Layout(std::stoull(next.at("generation").get<std::string>()), epoch);
    std::map<std::string, bool> ready;
    std::set<std::string> feedback_views;
    for (const auto& view : next.at("views"))
      feedback_views.insert(view.at("id").get<std::string>());
    media_feedback.Bind(peer.load(), next.at("epoch").get<std::string>(),
                        next.at("generation").get<std::string>(), std::move(feedback_views));
    for (const auto& view : next.at("views"))
      ready[view.at("id").get<std::string>()] = !view.value("stale", false);
    coordinate_readiness.Set(epoch, std::move(ready));
    // Layout() returns no new key for an identical epoch. Preserve the current
    // key so a repeated transaction retries the same idempotent barrier.
    if (prepare)
      layout_prepare = prepare;
    next = remotekit::LayoutCapabilities(
        std::move(next), control.load() != 0 && client_gestures_control.load() == control.load());
    if (next.at("generation") != "0" && !layout.empty() && layout.value("reconfiguring", false))
      direct_services.RefreshEditable();
    layout = std::move(next);
    QueueLayout();
  }
  void InvalidateLayout(const char* reason) {
    current_geometry = std::string("invalid:") + reason;
    const auto epoch = layout_epoch.fetch_add(1) + 1;
    Json invalid = {{"type", "layout"},
                    {"generation", "0"},
                    {"width", 16},
                    {"height", 16},
                    {"mediaScale", 1},
                    {"views", Json::array()},
                    {"epoch", std::to_string(epoch)}};
    if (std::string_view(reason) == "reconfigure")
      invalid["reconfiguring"] = true;
    direct_services.RefreshEditable();
    PublishLayout(std::move(invalid), epoch);
  }
  Json Layout(const remotekit::SharedAtlasFrame& frame) {
    auto fit = sampling;
    if (!fit.width)
      fit = {frame.width_pixels, frame.height_pixels, 1};
    const double sx = double(fit.width) / frame.width_pixels,
                 sy = double(fit.height) / frame.height_pixels;
    Json views = Json::array();
    for (uint32_t i = 0; i < frame.view_count; ++i) {
      auto& v = frame.views[i];
      views.push_back(
          {{"id", std::to_string(v.webview_id)},
           {"session", std::to_string(v.session_id)},
           {"instance", std::to_string(v.instance_generation)},
           {"document", std::to_string(v.document_generation)},
           {"focus", std::to_string(v.focus_generation)},
           {"x", std::lround(v.x_pixels * sx)},
           {"y", std::lround(v.y_pixels * sy)},
           {"width",
            std::lround((v.x_pixels + v.width_pixels) * sx) - std::lround(v.x_pixels * sx)},
           {"height",
            std::lround((v.y_pixels + v.height_pixels) * sy) - std::lround(v.y_pixels * sy)},
           {"deviceScaleFactor", v.page_device_scale_factor},
           {"mediaScale", fit.scale * v.atlas_pixels_per_dip / v.page_device_scale_factor},
           {"mediaScaleX", sx * v.atlas_pixels_per_dip / v.page_device_scale_factor},
           {"mediaScaleY", sy * v.atlas_pixels_per_dip / v.page_device_scale_factor},
           {"stale", (v.reserved & remotekit::kSharedAtlasViewStale) != 0}});
    }
    return {{"type", "layout"},        {"generation", std::to_string(frame.generation)},
            {"width", fit.width},      {"height", fit.height},
            {"mediaScale", fit.scale}, {"mediaScaleX", sx},
            {"mediaScaleY", sy},       {"views", views}};
  }
  std::string GeometryKey(const remotekit::SharedAtlasFrame& frame) {
    auto value = Layout(frame);
    for (auto& view : value["views"])
      view.erase("focus");
    return value.dump();
  }
  uint64_t ObserveLayout(const remotekit::SharedAtlasFrame& frame) {
    const auto key = GeometryKey(frame);
    if (key != current_geometry) {
      current_geometry = key;
      layout_epoch.fetch_add(1);
    }
    return layout_epoch.load();
  }
  void ReplyInput(Json reply, const Json& request, uint64_t stamp) {
    const bool focus = request.is_object() && request.value("type", Json()) == "focus";
    reply["type"] = focus ? "focus" : "input.result";
    if (focus) {
      reply["focusRequestId"] = request.value("focusRequestId", Json());
      reply["layoutEpoch"] = request.value("layoutEpoch", Json());
    } else if (request.is_object() && request.contains("sequence")) {
      reply["clientSequence"] = request["sequence"];
    } else if (request.is_object() && request.contains("clientSequence")) {
      reply["clientSequence"] = request["clientSequence"];
    }
    Send(reply, stamp);
  }
  static std::string ClientTouchSequence(const Json& request) {
    if (request.value("type", std::string()) == "input.touchRetire")
      return request.value("sequenceId", std::string());
    const auto raw = request.find("event");
    if (raw == request.end() || !raw->is_object() || raw->value("type", std::string()) != "touch" ||
        raw->value("gestureMode", std::string()) != "client-v1")
      return {};
    return raw->value("sequenceId", std::string());
  }
  static std::string ClientTouchTerminal(const Json& request) {
    const auto sequence = ClientTouchSequence(request);
    if (sequence.empty() || sequence.size() > 128)
      return {};
    const auto client_sequence = request.value("sequence", std::string());
    if (client_sequence.empty() || client_sequence.size() > 20)
      return {};
    if (request.value("type", std::string()) == "input.touchRetire")
      return sequence;
    const auto action = request.at("event").value("action", std::string());
    if (action != "end" && action != "cancel")
      return {};
    return sequence;
  }
  remotekit::TouchTerminalReceipt* ReserveTouchTerminal(remotekit::TouchTerminalReceipts& terminals,
                                                        const Event& event,
                                                        const Json& request,
                                                        const std::string& sequence,
                                                        uint64_t input_control) {
    remotekit::TouchTerminalReceipt candidate;
    candidate.peer = event.peer;
    candidate.authorization = event.authorization;
    candidate.control = input_control;
    candidate.client_sequence = request.value("sequence", std::string());
    candidate.sequence = sequence;
    candidate.query = {{"method", "input.touchStatus"}, {"sequenceId", sequence}};
    for (const auto* key : {"session", "view", "instance", "document", "focus"})
      if (request.contains(key))
        candidate.query[key] = request[key];
    return terminals.Reserve(std::move(candidate));
  }
  void RejectInput(const char* error,
                   const Json& request,
                   const Event& event,
                   remotekit::TouchTerminalReceipts* terminals = nullptr) {
    ++input_rejected;
    if (terminals) {
      const auto sequence = ClientTouchTerminal(request);
      if (!sequence.empty()) {
        const auto client_sequence = request.value("sequence", std::string());
        // A stale duplicate may never overwrite the original request's receipt.
        if (terminals->Find(event.peer, event.authorization, client_sequence, sequence))
          return;
        remotekit::TouchTerminalReceipt rejection;
        rejection.peer = event.peer;
        rejection.authorization = event.authorization;
        rejection.client_sequence = client_sequence;
        rejection.sequence = sequence;
        if (auto* receipt = terminals->Reserve(std::move(rejection))) {
          receipt->Finish("rejected", false, error);
          return;
        }
      }
    }
    Json reply = {{"ok", false}, {"error", error}};
    if (const auto sequence = ClientTouchSequence(request); !sequence.empty()) {
      reply["touchState"] = "rejected";
      reply["touchSequenceId"] = sequence;
    }
    ReplyInput(std::move(reply), request, event.authorization);
  }
  void PollTouchTerminal(remotekit::TouchTerminalReceipt& receipt) {
    const auto current = [&] {
      return peer.load() == receipt.peer && authorization.Current(receipt.authorization) &&
             control.load() == receipt.control;
    };
    const auto now = QpcNow();
    if (!current() || now >= receipt.deadline) {
      receipt.Finish("terminal-unconfirmed", false,
                     !current() ? "touch_terminal_identity_changed" : "touch_terminal_timeout");
      return;
    }
    try {
      const auto status = Rpc(receipt.query, false, receipt.control, 10000, true, current);
      if (!current())
        receipt.Finish("terminal-unconfirmed", false, "touch_terminal_identity_changed");
      else if (status.is_null() || !remotekit::ApplyTouchTerminalStatus(receipt, status))
        receipt.due = QpcNow() + QpcFrequency() / 200;
    } catch (const std::exception& error) {
      receipt.Finish("terminal-unconfirmed", false, error.what());
    }
  }
  void FlushTouchTerminals(remotekit::TouchTerminalReceipts& terminals) {
    FlushControl();
    terminals.Flush([&](const auto& receipt, const Json& message) {
      bool sent = false;
      control_outbox.Transient(receipt.peer, message.dump(), [&](const std::string& encoded) {
        sent = peer.load() == receipt.peer && data_open &&
               frame_authorization.load() == receipt.authorization &&
               SendData(receipt.peer, receipt.authorization, encoded) == 0;
      });
      return sent;
    });
  }
  void HandleData(const Event& event, remotekit::TouchTerminalReceipts& terminals) {
    const auto admitted = [&] {
      return ProductCurrent(event) && input_authorization.load() == event.authorization;
    };
    if (event.value != 0 || !ProductCurrent(event))
      return;
    auto command = Json::parse(event.bytes, nullptr, false);
    if (command.is_discarded() || !command.is_object())
      return;
    auto type = command.value("type", std::string());
    if (type == "input.touchStatus") {
      const auto client_sequence = command.value("clientSequence", std::string());
      const auto sequence = command.value("sequenceId", std::string());
      if (client_sequence.empty() || client_sequence.size() > 20 || sequence.empty() ||
          sequence.size() > 128)
        return;
      if (auto* receipt =
              terminals.Find(event.peer, event.authorization, client_sequence, sequence)) {
        const auto state = receipt->result.is_object()
                               ? receipt->result.value("touchState", std::string())
                               : std::string();
        if (receipt->polling)
          receipt->send_acceptance = receipt->acceptance.is_object();
        else if (state == "terminal-unconfirmed" && receipt->control == control.load())
          receipt->Schedule(QpcNow(), 2 * QpcFrequency());
        else
          receipt->send_result = true;
      } else
        ReplyInput({{"ok", false},
                    {"error", "unknown_touch_terminal"},
                    {"touchState", "terminal-unconfirmed"},
                    {"touchSequenceId", sequence}},
                   command, event.authorization);
      return;
    }
    if (type != "input" && type != "focus" && type != "input.touchRetire")
      return;
    const auto request = command;
    if (event.input_rejection) {
      RejectInput(event.input_rejection, request, event, &terminals);
      return;
    }
    if (type == "input.touchRetire") {
      const auto sequence = ClientTouchTerminal(request);
      uint64_t old_epoch = 0, token_id = 0;
      if (sequence.empty() || !PresentationNumber(request, "layoutEpoch", old_epoch) ||
          old_epoch >= layout_epoch.load() || request.value("session", std::string()) != id ||
          !PresentationNumber(request, "view", token_id) ||
          !PresentationNumber(request, "instance", token_id) ||
          !PresentationNumber(request, "document", token_id) ||
          !PresentationNumber(request, "focus", token_id)) {
        RejectInput("invalid_touch_retirement_identity", request, event, &terminals);
        return;
      }
      const auto input_control = control.load();
      auto* receipt = ReserveTouchTerminal(terminals, event, request, sequence, input_control);
      if (!receipt) {
        RejectInput("touch_terminal_queue_busy", request, event);
        return;
      }
      auto retire = receipt->query;
      retire["method"] = "input.touchRetire";
      // This command has no coordinates and only operates on the exact old
      // Browser owner. Keep the normal coordinate/keyframe gates below.
      const auto current = [&] { return ProductCurrent(event) && input_control == control.load(); };
      try {
        const auto reply = Rpc(retire, false, input_control, 10000, 0, current);
        if (!current())
          receipt->Finish("terminal-unconfirmed", false, "touch_terminal_identity_changed");
        else if (!remotekit::ApplyTouchTerminalStatus(*receipt, reply))
          receipt->Accept(QpcNow(), 2 * QpcFrequency());
      } catch (const std::exception& error) {
        receipt->Finish("terminal-unconfirmed", false, error.what());
      }
      return;
    }
    if (!admitted()) {
      RejectInput("input_not_authorized", request, event, &terminals);
      return;
    }
    const auto request_epoch = layout_epoch.load();
    if (command.value("layoutEpoch", std::string()) != std::to_string(request_epoch)) {
      RejectInput("stale_layout_epoch", request, event, &terminals);
      return;
    }
    command.erase("layoutEpoch");
    command.erase("focusRequestId");
    if (command.value("session", std::string()) != id) {
      RejectInput("wrong_session", request, event, &terminals);
      return;
    }
    if (type == "input" && command.contains("event") && command["event"].is_object()) {
      const auto event_type = command["event"].value("type", std::string());
      if ((event_type == "mouse" || event_type == "wheel" || event_type == "touch" ||
           event_type == "gesture") &&
          !coordinate_readiness.Allows(command.value("view", std::string()), request_epoch)) {
        RejectInput("view_not_ready", request, event, &terminals);
        return;
      }
    }
    command["method"] = type;
    command.erase("type");
    if (type == "input") {
      const auto sequence = input_sequence.NextBrowser();
      if (!sequence) {
        RejectInput("input_sequence_exhausted", request, event, &terminals);
        return;
      }
      command["sequence"] = std::to_string(*sequence);
      if (event.trace_input_sequence) {
        RK_SERVER_TRACE(trace, "input_browser_assigned", TraceIds{}, rk_record.peer = event.peer;
                        rk_record.client_sequence = event.trace_input_sequence;
                        rk_record.browser_sequence = *sequence;);
      }
    }
    if (command.contains("outputGeneration")) {
      command["output_generation"] = command["outputGeneration"];
      command.erase("outputGeneration");
    }
    // This connection is already bound to this Session by authenticated Control.
    // The browser validates membership and all token/sequence/output generations.
    const auto input_control = control.load();
    const auto touch_sequence = ClientTouchSequence(request);
    remotekit::TouchTerminalReceipt* receipt = nullptr;
    if (!touch_sequence.empty()) {
      const auto action = request.at("event").value("action", std::string());
      if (action == "end" || action == "cancel") {
        receipt = ReserveTouchTerminal(terminals, event, request, touch_sequence, input_control);
        if (!receipt) {
          RejectInput("touch_terminal_queue_busy", request, event);
          return;
        }
      }
    }
    try {
      // Only Browser's pre-admission BUSY is retryable. Keep the exact browser
      // sequence; an accepted asynchronous injection is never replayed.
      const auto deadline = QpcNow() + QpcFrequency() / 4;
      auto reply =
          type == "input"
              ? remotekit::RetryBrowserInput(
                    command,
                    [&](const Json& request) {
                      return Rpc(request, false, input_control, 10000, 0, admitted);
                    },
                    [&] {
                      return !stop_input && admitted() && request_epoch == layout_epoch.load();
                    },
                    [&] { return QpcNow() >= deadline; },
                    [] { std::this_thread::sleep_for(std::chrono::milliseconds(5)); },
                    [&] { ++input_busy_retries; }, [&] { ++input_busy_exhausted; })
              : Rpc(command, false, 0, 10000, 0, admitted);
      const auto invalidated = reply.value("touchState", std::string()) == "terminal-invalidated" &&
                               reply.value("touchSequenceId", std::string()) == touch_sequence;
      if (receipt && !invalidated && reply.value("touchTerminal", false) &&
          (reply.value("ok", false) || reply.value("inputAdmitted", false))) {
        if (reply.value("touchSequenceId", std::string()) == touch_sequence)
          receipt->Accept(QpcNow(), 2 * QpcFrequency());
        else
          receipt->Finish("terminal-unconfirmed", false, "touch_terminal_identity_mismatch");
        return;
      }
      if (!touch_sequence.empty() && !reply.value("ok", false)) {
        const auto state = invalidated                           ? "terminal-invalidated"
                           : reply.value("inputAdmitted", false) ? "terminal-unconfirmed"
                                                                 : "rejected";
        if (receipt) {
          receipt->Finish(state, false, reply.value("error", std::string()));
          return;
        }
        reply["touchState"] = state;
        reply["touchSequenceId"] = touch_sequence;
      }
      if (receipt) {
        terminals.Remove(receipt);
        receipt = nullptr;
      }
      if (type == "input")
        reply["browserSequence"] = command["sequence"];
      if (admitted())
        ReplyInput(std::move(reply), request, event.authorization);
    } catch (const std::exception& error) {
      if (receipt)
        receipt->Finish("terminal-unconfirmed", false, error.what());
      else if (admitted()) {
        Json reply = {{"ok", false}, {"error", error.what()}};
        if (!touch_sequence.empty()) {
          reply["touchState"] = "terminal-unconfirmed";
          reply["touchSequenceId"] = touch_sequence;
        }
        ReplyInput(std::move(reply), request, event.authorization);
      }
    }
  }
  void QueueInput(const Event& event) {
    std::lock_guard lock(input_mutex);
    if (!ProductCurrent(event) || event.value != 0)
      return;
    if (event.trace_input_sequence) {
      RK_SERVER_TRACE(trace, "input_comp_dequeue", TraceIds{}, rk_record.peer = event.peer;
                      rk_record.client_sequence = event.trace_input_sequence;);
    }
    auto parsed = Json::parse(event.bytes, nullptr, false);
    if (!parsed.is_object())
      return;
    const auto reject = [&](const char* error) {
      // Keep a bounded spill area for terminal rejections when the normal input
      // backlog is full. The worker retains the result across SDK BUSY.
      if (input_queue.size() < 256 + remotekit::TouchTerminalReceipts::kCapacity &&
          !ClientTouchTerminal(parsed).empty()) {
        input_queue.push_back(event);
        input_queue.back().input_rejection = error;
        input_wake.notify_one();
      } else
        RejectInput(error, parsed, event);
    };
    const auto type = parsed.value("type", std::string());
    if (type != "input.touchStatus" && type != "input.touchRetire" &&
        input_authorization.load() != event.authorization) {
      reject("input_not_authorized");
      return;
    }
    // Validate arrival order before move coalescing can replace a newer packet.
    // The Browser keeps its independent Session counter across RTC reconnects.
    if ((type == "input" || type == "input.touchRetire") &&
        (!parsed.contains("sequence") || !parsed["sequence"].is_string() ||
         !input_sequence.Admit(event.peer, parsed["sequence"].get<std::string>()))) {
      reject("stale_client_sequence");
      return;
    }
    bool move = !parsed.is_discarded() && parsed.value("type", std::string()) == "input" &&
                parsed.contains("event") &&
                parsed["event"].value("type", std::string()) == "mouse" &&
                parsed["event"].value("action", std::string()) == "move";
    if (move && !input_queue.empty()) {
      auto before = Json::parse(input_queue.back().bytes, nullptr, false);
      if (input_queue.back().peer == event.peer &&
          input_queue.back().authorization == event.authorization && !before.is_discarded() &&
          before.value("view", std::string()) == parsed.value("view", std::string()) &&
          before.contains("event") && before["event"].value("type", std::string()) == "mouse" &&
          before["event"].value("action", std::string()) == "move") {
        input_queue.back() = event;
        ++input_coalesced;
        input_wake.notify_one();
        return;
      }
    }
    if (input_queue.size() >= 256) {
      reject("input_queue_busy");
      return;
    }
    if (event.trace_input_sequence) {
      RK_SERVER_TRACE(trace, "input_worker_queue", TraceIds{}, rk_record.peer = event.peer;
                      rk_record.client_sequence = event.trace_input_sequence;
                      rk_record.queue = static_cast<int>(input_queue.size()););
    }
    input_queue.push_back(event);
    input_wake.notify_one();
  }
  void InputLoop() {
    remotekit::TouchTerminalReceipts terminals;
    while (true) {
      std::optional<Event> event;
      {
        std::unique_lock lock(input_mutex);
        const auto ready = [&] { return stop_input || !input_queue.empty(); };
        if (terminals.Busy())
          input_wake.wait_for(lock, std::chrono::milliseconds(5), ready);
        else
          input_wake.wait(lock, ready);
        if (stop_input)
          break;
        if (!input_queue.empty()) {
          event = std::move(input_queue.front());
          input_queue.pop_front();
        }
      }
      terminals.Prune([&](const auto& receipt) {
        return peer.load() == receipt.peer && authorization.Current(receipt.authorization);
      });
      if (event) {
        if (event->trace_input_sequence) {
          RK_SERVER_TRACE(trace, "input_worker_begin", TraceIds{}, rk_record.peer = event->peer;
                          rk_record.client_sequence = event->trace_input_sequence;);
        }
        try {
          HandleData(*event, terminals);
        } catch (const std::exception& error) {
          ++input_rejected;
          if (ProductCurrent(*event))
            ReplyInput({{"ok", false}, {"error", error.what()}},
                       Json::parse(event->bytes, nullptr, false), event->authorization);
        }
      }
      // One due status read per input turn. A pending sequence does not hold
      // dispatch while waiting for its next query.
      if (auto* receipt = terminals.Due(QpcNow()))
        PollTouchTerminal(*receipt);
      if (terminals.HasNotices())
        FlushTouchTerminals(terminals);
    }
  }
  void MediaLoop() {
    std::shared_ptr<remotekit::TailIdrAttempt> tail_attempt;
    // All exits, including early return and source/Begin failure, stop this
    // generation. Block-local locks unwind before this function-scope guard.
    struct RenderExit {
      Session& owner;
      std::shared_ptr<remotekit::TailIdrAttempt>& tail;
      ~RenderExit() {
        if (tail)
          tail->CancelWaiting();
        std::string error;
        if (!owner.pool.Close(error))
          fprintf(stderr, "media exit render drain: %s\n", error.c_str());
      }
    } render_exit{*this, tail_attempt};
    remotekit::PresentationRefresh presentation_refresh;
    struct TargetReset {
      std::mutex& mutex;
      CompDiagnostics& value;
      ~TargetReset() {
        std::lock_guard lock(mutex);
        value.targetFps = 0;
        value.refresh.pending = false;
      }
    } target_reset{comp_diagnostics_mutex, comp_diagnostics};
    HANDLE pace_timer =
        CreateWaitableTimerExW(nullptr, nullptr, 0x2, TIMER_MODIFY_STATE | SYNCHRONIZE);
    if (!pace_timer) {
      InvalidateLayout("comp-timer-unavailable");
      std::lock_guard lock(stats->mutex);
      stats->error = "high resolution Comp timer unavailable";
      return;
    }
    struct TimerCloser {
      HANDLE value;
      ~TimerCloser() { CloseHandle(value); }
    } timer_closer{pace_timer};
    uint64_t observed_wakes = pool.Stats().wakes;
    remotekit::CompBeginSchedule begin_schedule;
    auto observe_wake = [&] {
      const auto wakes = pool.Stats().wakes;
      if (wakes != observed_wakes) {
        observed_wakes = wakes;
        begin_schedule.Wake();
      }
    };
    int64_t last_stats = QpcNow();
    uint32_t official_max_fps = 240, codec_max_fps = 240;
    remotekit::CompCadence cadence;
    uint64_t previous_encoded = stats->completed.load(), previous_bytes = stats->bytes.load(),
             previous_copies = pool.copied_frames();
    uint64_t previous_delivered = pool.delivered_frames();
    remotekit::IdleIdrPolicy idle(options.idle_idr_ms);
    bool has_current_view = false;

    bool first_source = true, first_submit = true;
    unsigned consecutive_reconfigures = 0;
    double next_tail_attempt_ms = 0;
    uint32_t tail_begins = 0;
    constexpr double tail_retry_ms = 250;
    effective_idle_ms = idle.delay_ms();
    source_interval_ms = 0;
    uint64_t active_authorization = authorization.Stamp();
    frame_authorization = active_authorization;
    auto update_refresh = [&](uint64_t handle, double now_ms) {
      std::optional<remotekit::PresentationRefresh::Scope> scope;
      if (has_current_view && !output_suspended && authorization.Current(active_authorization)) {
        if (auto key = presentation.RefreshKey(handle, layout_epoch.load()))
          scope = remotekit::PresentationRefresh::Scope{handle, active_authorization, *key};
      }
      presentation_refresh.SetScope(scope);
      if (scope)
        presentation_refresh.Update(refresh_connected.exchange(false), now_ms);
    };
    while (!stop_media) {
      const auto stamp = authorization.Stamp();
      if (stamp != active_authorization) {
        frame_authorization = 0;
        if (tail_attempt)
          tail_attempt->CancelWaiting();
        tail_attempt.reset();
        presentation_refresh.SetScope(std::nullopt);
        has_current_view = false;
        next_tail_attempt_ms = 0;
        begin_schedule.Reset();
        InvalidateLayout(stamp ? "authorization-resuming" : "authorization-locked");
        if (rtc_connected) {
          try {
            if (pool.EventHandle()) {
              Rpc({{"method", "output.close"}});
              std::string drain_error;
              if (!pool.Close(drain_error))
                throw std::runtime_error(drain_error);
            }
            if (stamp && authorization.Current(stamp))
              OpenOutput();
          } catch (const std::exception& error) {
            fprintf(stderr, "authorization output transition: %s\n", error.what());
            return;
          }
        }
        active_authorization = stamp;
        frame_authorization = stamp;
        if (stamp)
          refresh_connected = true;
      }
      sampling_fps = cadence.Update(comp_bitrate.load(), comp_fps.load(), policy_max_fps.load(),
                                    std::min(official_max_fps, codec_max_fps), pool.HasCapacity(),
                                    static_cast<int64_t>(1000000.0 * QpcNow() / QpcFrequency()));
      {
        std::lock_guard lock(comp_diagnostics_mutex);
        comp_diagnostics.targetFps = rtc_connected.load() &&
                                             authorization.Current(active_authorization) &&
                                             !output_suspended.load()
                                         ? sampling_fps
                                         : 0;
        comp_diagnostics.officialMaxFps = official_max_fps;
        comp_diagnostics.codecMaxFps = codec_max_fps;
        comp_diagnostics.resumeMaxFps =
            std::min({policy_max_fps.load(), official_max_fps, codec_max_fps});
        comp_diagnostics.refresh = presentation_refresh.Snapshot();
      }
      std::deque<Event> incoming;
      {
        std::lock_guard lock(event_mutex);
        incoming.swap(events);
      }
      for (auto& event : incoming) {
        if (event.peer != peer.load())
          continue;
        if (event.type == 0x10000 && ProductCurrent(event)) {
          auto message = Json::parse(event.bytes, nullptr, false);
          if (!message.is_discarded())
            Send(message, event.authorization);
        } else if (event.type == REMOTEKIT_RTC_STATS) {
          auto sample = Json::parse(event.bytes, nullptr, false);
          if (sample.is_object()) {
            std::lock_guard lock(stats->mutex);
            stats->sender_rtc_stats = std::move(sample);
          }
        } else if (event.type == REMOTEKIT_RTC_REFRESH_REQUEST) {
          refresh_connected = true;
        } else if (event.type == REMOTEKIT_RTC_STATE) {
          const bool connected = event.value == 2;
          if (connected != rtc_connected.exchange(connected)) {
            if (tail_attempt)
              tail_attempt->CancelWaiting();
            tail_attempt.reset();
            presentation_refresh.SetScope(std::nullopt);
            has_current_view = false;
            next_tail_attempt_ms = 0;
            begin_schedule.Reset();
            InvalidateLayout(connected ? "rtc-resuming" : "rtc-disconnected");
            try {
              if (connected) {
                if (authorization.Current(active_authorization))
                  OpenOutput();
                refresh_connected = true;
              } else {
                Rpc({{"method", "output.close"}});
                std::string drain_error;
                if (!pool.Close(drain_error))
                  fprintf(stderr, "disconnected render drain: %s\n", drain_error.c_str());
              }
            } catch (const std::exception& failure) {
              {
                std::lock_guard lock(stats->mutex);
                stats->error = failure.what();
              }
              InvalidateLayout("rtc-output-error");
              try {
                Rpc({{"method", "output.close"}});
              } catch (const std::exception& close_error) {
                fprintf(stderr, "session %s fatal output stop: %s\n", id.c_str(),
                        close_error.what());
              }
              fprintf(stderr, "session %s RTC output: %s\n", id.c_str(), failure.what());
              return;
            }
          }
        } else if (event.type == REMOTEKIT_RTC_DATA_STATE) {
          const bool opened = event.value == 1;
          if (opened && !data_open.exchange(opened))
            refresh_connected = true;
          if (!opened)
            data_open = false;
          if (data_open) {
            QueueLayout();
            direct_services.RefreshEditable();
          }
        } else if (event.type == REMOTEKIT_RTC_DATA) {
          // The presentation backend can be declared while the product is locked.
          // Its ACK still has to match the fresh layout transaction on unlock.
          if (!ProductCurrent(event)) {
            const auto message = Json::parse(event.bytes, nullptr, false);
            if (message.is_object() && message.value("type", Json()) == "media.presentation")
              PresentationMessage(event);
            continue;
          }
          try {
            if (!ServiceMessage(event) && !PresentationMessage(event))
              QueueInput(event);
          } catch (const std::exception& error) {
            ++input_rejected;
            Send({{"type", "input.result"}, {"ok", false}, {"error", error.what()}},
                 event.authorization);
          }
        } else if (event.type == REMOTEKIT_RTC_ERROR)
          fprintf(stderr, "RTC %s: %s\n", id.c_str(), event.bytes.c_str());
      }
      FlushControl();
      if (!rtc_connected || !authorization.Current(active_authorization)) {
        std::unique_lock lock(event_mutex);
        event_wake.wait_for(lock, std::chrono::milliseconds(20),
                            [&] { return stop_media || !events.empty(); });
        continue;
      }
      remotekit_rtc_frame frame{};
      remotekit::SharedAtlasFrame metadata{};
      std::string error;
      auto result =
          output_suspended ? RenderSlots::Result::idle : pool.Poll(frame, metadata, error);
      observe_wake();
      if (first_source && result == RenderSlots::Result::ready) {
        MarkConnection(ConnectionPhase::source_frame);
        first_source = false;
      }
      if (result == RenderSlots::Result::reconfigure) {
        InvalidateLayout("reconfigure");
        if (tail_attempt)
          tail_attempt->CancelWaiting();
        tail_attempt.reset();
        presentation_refresh.SetScope(std::nullopt);
        has_current_view = false;
        next_tail_attempt_ms = 0;
        begin_schedule.Reset();
        idle = remotekit::IdleIdrPolicy(options.idle_idr_ms);
        effective_idle_ms = idle.delay_ms();
        source_interval_ms = 0;
        last_tail_age_ms = 0;
        try {
          if (++consecutive_reconfigures > 3)
            throw std::runtime_error("atlas repeatedly requested reconfiguration before a frame");
          if (stop_media.load())
            break;
          // Rpc and OpenOutput each acquire rpc_mutex independently. PauseOutput
          // sets stop_media and joins without holding it; never nest those locks.
          Rpc({{"method", "output.close"}});
          if (stop_media.load())
            break;
          // Open retires the old generation, preserving all SDK/worker leases and
          // their GPU consumed barriers. RTC and WebContents keep their identity.
          OpenOutput(true);
          if (stop_media.load())
            break;
          previous_copies = pool.copied_frames();
          previous_delivered = pool.delivered_frames();
          previous_encoded = stats->completed.load();
          previous_bytes = stats->bytes.load();
          last_stats = QpcNow();
          refresh_connected = true;
          {
            std::lock_guard lock(encoder_mutex);
            for (auto& [encoder, worker] : encoders)
              worker->Keyframe();
          }
          continue;
        } catch (const std::exception& failure) {
          error = std::string("atlas reconfigure failed: ") + failure.what();
          result = RenderSlots::Result::error;
        }
      }
      if (result == RenderSlots::Result::error) {
        InvalidateLayout("fatal");
        try {
          Rpc({{"method", "output.close"}});
        } catch (const std::exception& close_error) {
          fprintf(stderr, "session %s fatal output stop: %s\n", id.c_str(), close_error.what());
        }
        {
          std::lock_guard lock(stats->mutex);
          stats->error = error;
        }
        fprintf(stderr, "session %s media: %s\n", id.c_str(), error.c_str());
        break;
      }
      const auto current_metadata =
          output_suspended ? remotekit::SharedAtlasFrame{} : pool.LatestMetadata();
      if (output_suspended) {
        if (current_geometry != "invalid:no-visible-views")
          InvalidateLayout("no-visible-views");
      }
      const auto handle = peer.load();
      const auto now = QpcNow();
      const double now_ms = 1000.0 * now / QpcFrequency();
      update_refresh(handle, now_ms);
      if (tail_attempt) {
        using State = remotekit::TailIdrAttempt::State;
        if (now_ms >= next_tail_attempt_ms)
          tail_attempt->CancelWaiting();
        const auto state = tail_attempt->state();
        if (state == State::succeeded && idle.CompleteRefresh(now_ms, true)) {
          ++tail_completions;
          last_tail_age_ms = idle.age_ms(now_ms);
        }
        if (state != State::source_wait && state != State::encoding)
          tail_attempt.reset();
      }
      const bool tail_ready = idle.TailDue(now_ms) && !tail_attempt &&
                              now_ms >= next_tail_attempt_ms && !presentation_refresh.Pending();
      if (!output_suspended && comp_bitrate.load() && sampling_fps && begin_schedule.Due(now)) {
        const auto interval = static_cast<uint32_t>((1000000ull + sampling_fps - 1) / sampling_fps);
        pool.Pressure(stats->pending.load() > 1);
        bool sent = false;
        const bool force_tail = tail_ready && tail_begins < 3;
        const bool force_refresh =
            result != RenderSlots::Result::ready && presentation_refresh.CanForce(now_ms);
        if (!pool.Begin(interval, force_tail || force_refresh, error, &sent)) {
          if (frame.release)
            frame.release(frame.release_context, frame.frame_id);
          {
            std::lock_guard lock(stats->mutex);
            stats->error = error;
          }
          InvalidateLayout("render-begin-failed");
          break;
        }
        if (sent && force_tail)
          ++tail_begins;
        if (sent && force_refresh)
          presentation_refresh.Forced(now_ms);
        // Begin can drain a Wake queued after Poll. A sent Begin satisfies it.
        observe_wake();
        begin_schedule.Attempted(now, std::max<int64_t>(1, QpcFrequency() / sampling_fps), sent);
      }
      if (result == RenderSlots::Result::ready) {
        consecutive_reconfigures = 0;
        const bool fresh =
            idle.Observe(metadata.generation, metadata.frame_id, metadata.capture_time_us, now_ms);
        if (fresh) {
          if (tail_attempt)
            tail_attempt->CancelWaiting();
          tail_attempt.reset();
          next_tail_attempt_ms = 0;
          tail_begins = 0;
          effective_idle_ms = idle.delay_ms();
          source_interval_ms = idle.interval_ms();
        }
        remotekit_rtc_adaptation adapted{};
        adapted.struct_size = sizeof(adapted);
        const auto stamp = pool.MonotonicMicros();
        const auto adapt_begin = trace ? QpcNow() : 0;
        const auto adaptation_status =
            handle && stamp ? sdk.remotekit_rtc_adapt_frame(handle, metadata.width_pixels,
                                                            metadata.height_pixels, stamp, &adapted)
                            : REMOTEKIT_SDK_INVALID_STATE;
        RK_SERVER_TRACE(trace, "comp_adapt_begin", TraceIds::Frame(frame),
                        rk_record.qpc = adapt_begin;
                        rk_record.peer = handle;);
        RK_SERVER_TRACE(trace, "comp_adapt_return", TraceIds::Frame(frame),
                        rk_record.status = adaptation_status;
                        rk_record.peer = handle;
                        rk_record.reason = adapted.drop ? "drop" : "keep";);
        if (adaptation_status == 0)
          official_max_fps = adapted.max_fps ? adapted.max_fps : 240;
        {
          std::lock_guard lock(comp_diagnostics_mutex);
          auto& d = comp_diagnostics;
          if (handle && stamp)
            ++d.adaptRequests;
          if (adaptation_status == 0 && adapted.drop)
            ++d.adaptDrops;
          else if (adaptation_status != 0)
            ++d.adaptErrors;
          d.officialMaxFps = official_max_fps;
          d.sourceWidth = metadata.width_pixels;
          d.sourceHeight = metadata.height_pixels;
        }
        if (adaptation_status != 0 || adapted.drop || !comp_bitrate.load() || !sampling_fps) {
          frame.release(frame.release_context, frame.frame_id);
        } else {
          // Retain hard H264 texture/frame limits, without trading product quality
          // against cadence. Official AdaptFrame remains the network controller.
          const auto hard =
              remotekit::FitH264Sampling(adapted.width, adapted.height, 1, receive_level.load(),
                                         options.max_encode_width, options.max_encode_height);
          codec_max_fps = hard.width ? remotekit::H264FrameRateLimit(hard.width, hard.height,
                                                                     receive_level.load())
                                     : 0;
          {
            std::lock_guard lock(comp_diagnostics_mutex);
            comp_diagnostics.codecMaxFps = codec_max_fps;
          }
          if (!codec_max_fps) {
            frame.release(frame.release_context, frame.frame_id);
            const std::string failure =
                "no legal H264 frame rate for selected encoder dimensions " +
                std::to_string(hard.width) + "x" + std::to_string(hard.height) +
                " level=" + std::to_string(receive_level.load());
            {
              std::lock_guard lock(stats->mutex);
              stats->error = failure;
            }
            InvalidateLayout("codec-capability-error");
            fprintf(stderr, "session %s media: %s\n", id.c_str(), failure.c_str());
            try {
              Rpc({{"method", "output.close"}});
            } catch (const std::exception& close_error) {
              fprintf(stderr, "codec failure output stop: %s\n", close_error.what());
            }
            break;
          }
          sampling_fps = std::min(sampling_fps, codec_max_fps);
          {
            std::lock_guard lock(comp_diagnostics_mutex);
            comp_diagnostics.targetFps = sampling_fps;
            comp_diagnostics.resumeMaxFps =
                std::min({policy_max_fps.load(), official_max_fps, codec_max_fps});
          }
          sampling = hard;
          sampling.scale = std::min(double(hard.width) / metadata.width_pixels,
                                    double(hard.height) / metadata.height_pixels);
          frame.width = sampling.width;
          frame.height = sampling.height;
          {
            std::lock_guard lock(comp_diagnostics_mutex);
            auto& d = comp_diagnostics;
            if (d.encodedWidth &&
                (d.encodedWidth != frame.width || d.encodedHeight != frame.height))
              ++d.adaptSizeChanges;
            d.encodedWidth = frame.width;
            d.encodedHeight = frame.height;
          }
          // Build the epoch from this exact GPU-observed texture and chosen sample.
          // No old texture is relabeled using the latest-layout publication.
          auto next = remotekit::LayoutCapabilities(
              Layout(metadata),
              control.load() != 0 && client_gestures_control.load() == control.load());
          const auto epoch = ObserveLayout(metadata);
          next["epoch"] = std::to_string(epoch);
          if (next != layout) {
            has_current_view = std::ranges::any_of(
                next.at("views"), [](const auto& view) { return !view.value("stale", false); });
            PublishLayout(std::move(next), epoch);
          }
          frame.layout_epoch = epoch;
          update_refresh(handle, now_ms);
          auto attempt = presentation_refresh.TryStart(now_ms, 1000.0 / sampling_fps);
          const bool tail = !fresh && tail_ready && !presentation_refresh.Pending();
          if (tail) {
            tail_attempt = std::make_shared<remotekit::TailIdrAttempt>();
            next_tail_attempt_ms = now_ms + tail_retry_ms;
            attempt = tail_attempt;
          }
          if (attempt) {
            auto wrapped = remotekit::TailRefreshLease::Wrap(frame, std::move(attempt));
            frame.release(frame.release_context, frame.frame_id);
            frame = wrapped;
          }
          if (first_submit) {
            MarkConnection(ConnectionPhase::submit);
            first_submit = false;
          }
          const int status = authorization.Current(active_authorization)
                                 ? sdk.remotekit_rtc_submit_texture(handle, &frame)
                                 : 1;
          if (status != 0)
            frame.release(frame.release_context, frame.frame_id);
          else if (tail)
            ++tail_submissions;
        }
      }
      direct_services.Editable(peer.load(), current_metadata, output_suspended);
      if (now - last_stats >= QpcFrequency()) {
        if (trace)
          trace->WallClock();
        if (handle && sdk.request_stats)
          sdk.request_stats(handle);
        auto report = Stats();
        report["type"] = "stats";
        const double seconds = static_cast<double>(now - last_stats) / QpcFrequency();
        const auto encoded = stats->completed.load(), bytes = stats->bytes.load(),
                   copies = pool.copied_frames();
        report["encodedFps"] = (encoded - previous_encoded) / seconds;
        report["encodedBitrateBps"] = 8.0 * (bytes - previous_bytes) / seconds;
        report["atlasCopies"] = copies;
        report["atlasCopyFps"] = (copies - previous_copies) / seconds;
        const auto delivered = pool.delivered_frames();
        report["atlasDeliveredFrames"] = delivered;
        report["atlasDeliveredFps"] = (delivered - previous_delivered) / seconds;
        previous_delivered = delivered;
        previous_encoded = encoded;
        previous_bytes = bytes;
        previous_copies = copies;
        report["atlasPoolDrops"] = pool.drops();
        report["lastGpuCopyMs"] = pool.shared_input() ? Json(nullptr) : Json(pool.last_copy_ms());
        report["sourceAtlasWidth"] = current_metadata.width_pixels;
        report["sourceAtlasHeight"] = current_metadata.height_pixels;
        report["mediaScale"] = sampling.scale;
        report["negotiatedReceiveLevel"] = receive_level.load();
        report["samplingFpsBudget"] = SamplingFps();
        report["resolutionLimitation"] = sampling.limitation;
        report["samplingMaxFrameMacroblocks"] = sampling.max_frame_macroblocks;
        report["samplingMaxMacroblocksPerSecond"] = sampling.max_macroblocks_per_second;
        report["receiveLevel"] = receive_level.load();
        report["inputRejected"] = input_rejected.load();
        report["inputCoalesced"] = input_coalesced.load();
        report["inputBusyRetries"] = input_busy_retries.load();
        report["inputBusyExhausted"] = input_busy_exhausted.load();
        {
          std::lock_guard lock(input_mutex);
          report["inputQueue"] = input_queue.size();
        }
        const auto latency = pool.capture_to_ready_ms();
        report["captureToReadyMs"] = latency ? Json(*latency) : Json(nullptr);
        report["captureClock"] = latency ? "measured SDK TimeTicks to QPC mapping" : "unavailable";
        report["clockUncertaintyUs"] = pool.clock_uncertainty_us();
        Send(report);
        last_stats = now;
      }
      const auto remaining = std::max<int64_t>(0, begin_schedule.deadline() - QpcNow());
      const auto wait_us = std::min<int64_t>(
          1000, remaining ? std::max<int64_t>(1, remaining * 1000000 / QpcFrequency()) : 1000);
      LARGE_INTEGER due{};
      due.QuadPart = -wait_us * 10;
      const HANDLE wait_handles[] = {pace_timer, output_suspended ? nullptr : pool.EventHandle()};
      if (!SetWaitableTimerEx(pace_timer, &due, 0, nullptr, nullptr, nullptr, 0) ||
          WaitForMultipleObjects(wait_handles[1] ? 2 : 1, wait_handles, FALSE, 2) == WAIT_FAILED) {
        InvalidateLayout("comp-pacing-failed");
        std::lock_guard lock(stats->mutex);
        stats->error = "Comp pacing wait failed";
        break;
      }
    }
  }
  Json Offer(const Json& request, uint64_t generation) {
    Start();
    ClosePeer();
    for (auto& phase : connection_phases)
      phase = 0;
    connection_started_qpc = QpcNow();
    connection = Required(request, "connectionId");
    {
      std::lock_guard lock(signal_mutex);
      answer.clear();
      rtc_error.clear();
      ice_complete = false;
      signal_events.clear();
      signal_overflow = false;
    }
    trickle_signals = request.value("trickle", false);
    remotekit_rtc_options config{};
    config.struct_size = sizeof(config);
    config.abi_version = REMOTEKIT_RTC_ABI_VERSION;
    config.auth_required = request.value("authRequired", false);
    config.context = this;
    config.event = EventCallback;
    config.encoder.struct_size = sizeof(config.encoder);
    config.encoder.create = CreateEncoder;
    config.encoder.configure = ConfigureEncoder;
    config.encoder.encode = Encode;
    config.encoder.set_rates = Rates;
    config.encoder.request_keyframe = Keyframe;
    config.encoder.destroy = DestroyEncoder;
    config.min_bitrate_bps = 500000;
    config.start_bitrate_bps = options.encoding.bitrate;
    config.max_bitrate_bps = options.encoding.max_bitrate;
    comp_bitrate = options.encoding.bitrate;
    comp_fps = policy_max_fps.load();
    uint64_t handle = 0;
    if (sdk.remotekit_rtc_create(&config, &handle) != 0)
      throw std::runtime_error("RTC create failed");
    if (sdk.remotekit_rtc_set_degradation_preference(handle, policy_degradation) != 0 ||
        sdk.remotekit_rtc_set_source_max_fps(handle, policy_max_fps) != 0) {
      sdk.remotekit_rtc_close(handle);
      throw std::runtime_error("RTC media policy rejected");
    }
    {
      std::lock_guard transition(authorization_mutex);
      std::lock_guard admission(admission_mutex);
      authorization.Bind(config.auth_required != 0);
      raw_camera.Bind(config.auth_required ? handle : 0);
      management_generation = generation;
      receive_level = 0;
      refresh_connected = false;
      presentation.Bind(handle);
      control_outbox.Bind(handle);
      if (authorization.Stamp()) {
        direct_services.Bind(handle, connection);
        file_services.Bind(handle, connection);
      }
      layout_prepare.reset();
      peer = handle;
      input_sequence.Bind(handle);
      stop_media = false;
      data_open = false;
      layout = Json();
    }
    last_media_refresh_qpc = 0;
    if (options.rtc_playout_max_ms >= 0) {
      const int status = sdk.remotekit_rtc_set_playout_delay(handle, 0, options.rtc_playout_max_ms);
      if (status != 0) {
        ClosePeer();
        throw std::runtime_error("RTC playout delay rejected (SDK " + std::to_string(status) + ")");
      }
    }
    auto sdp = Required(request, "sdp");
    if (sdk.remotekit_rtc_set_remote_description(handle, 1, sdp.data(), sdp.size()) != 0) {
      ClosePeer();
      throw std::runtime_error("RTC remote offer rejected");
    }
    if (config.auth_required) {
      stop_camera = false;
      try {
        camera_thread = std::thread([this] { CameraLoop(); });
      } catch (...) {
        ClosePeer();
        throw;
      }
    }
    if (sdp.find("m=audio ") != std::string::npos) {
      try {
        OpenAudio();
      } catch (...) {
        ClosePeer();
        throw;
      }
    }
    if (trickle_signals) {
      uint32_t level = 0;
      if (sdk.remotekit_rtc_get_receive_level(handle, &level) != 0 || !level) {
        ClosePeer();
        throw std::runtime_error("peer has no compatible receiving H264 level");
      }
      receive_level = level;
      stop_input = false;
      input_thread = std::thread([this] { InputLoop(); });
      media_thread = std::thread([this] { MediaLoop(); });
      return {{"accepted", true}, {"pending", true}, {"connectionId", connection}};
    }
    std::unique_lock lock(signal_mutex);
    signal_wake.wait_for(lock, std::chrono::seconds(20),
                         [&] { return ice_complete || !rtc_error.empty(); });
    if (!ice_complete) {
      auto error = rtc_error.empty() ? "ICE gathering timed out" : rtc_error;
      lock.unlock();
      ClosePeer();
      throw std::runtime_error(error);
    }
    const auto gathered_answer = answer;
    lock.unlock();
    uint32_t level = 0;
    if (sdk.remotekit_rtc_get_receive_level(handle, &level) != 0 || !level) {
      ClosePeer();
      throw std::runtime_error("peer has no compatible receiving H264 level");
    }
    receive_level = level;
    stop_input = false;
    input_thread = std::thread([this] { InputLoop(); });
    media_thread = std::thread([this] { MediaLoop(); });
    event_wake.notify_all();
    return {{"sdp", gathered_answer}, {"type", "answer"}, {"connectionId", connection}};
  }
  // Only the dispatcher writes JSONL. SDK callback threads never write stdout.
  void FlushSignals() {
    const auto stamp = authorization.Stamp();
    if (stamp)
      direct_services.DispatchPending(
          peer.load(), 1000.0 * QpcNow() / QpcFrequency(), [&](const Json& message) {
            if (!authorization.Current(stamp))
              return false;
            return management_action(Json({{"event", "client.action"},
                                           {"tenantId", tenant},
                                           {"connectionId", connection},
                                           {"authEpoch", authorization.Epoch()},
                                           {"operationGeneration", message["operationGeneration"]},
                                           {"operationId", message["operationId"]},
                                           {"action", message["action"]}})
                                         .dump(),
                                     management_generation);
          });
    std::deque<Event> pending;
    {
      std::lock_guard lock(signal_mutex);
      pending.swap(signal_events);
    }
    for (const auto& event : pending) {
      if (!trickle_signals || !peer.load() || event.peer != peer.load())
        continue;
      Json signal;
      if (event.type == REMOTEKIT_RTC_SDP_ANSWER)
        signal = {{"type", "answer"}, {"sdp", event.bytes}};
      else if (event.type == REMOTEKIT_RTC_ICE)
        signal = {{"type", "ice"},
                  {"candidate",
                   {{"candidate", event.bytes},
                    {"sdpMid", event.auxiliary},
                    {"sdpMLineIndex", event.value}}}};
      else if (event.type == REMOTEKIT_RTC_ICE_COMPLETE)
        signal = {{"type", "complete"}};
      else if (event.type == REMOTEKIT_RTC_ERROR)
        signal = {{"type", "error"}, {"message", event.bytes}};
      else
        continue;
      management_output(Json({{"event", "rtc.signal"},
                              {"tenantId", tenant},
                              {"connectionId", connection},
                              {"signal", signal}})
                            .dump());
    }
  }
  // authorization_mutex serializes this with authorization and peer replacement.
  int RevokeProduct() {
    {
      std::lock_guard admission(admission_mutex);
      authorization.Close();
      frame_authorization = 0;
      input_authorization = 0;
      file_services.Bind(0);
    }
    raw_camera.Cancel();
    faces.Cancel();
    WakeCamera();
    const auto handle = peer.load();
    const int status =
        handle && authorization.Required() ? sdk.remotekit_rtc_set_media_authorized(handle, 0) : 0;
    direct_services.Bind(0);
    {
      std::lock_guard lock(input_mutex);
      input_queue.clear();
    }
    event_wake.notify_all();
    return status;
  }
  void ManagementLost(uint64_t generation) {
    std::lock_guard transition(authorization_mutex);
    if (authorization.Required() && management_generation == generation) {
      if (RevokeProduct() != 0)
        fprintf(stderr, "RTC media authorization revoke failed\n");
    }
  }
  uint64_t AuthorizationEpoch(const Json& request) {
    const auto& value = request.at("epoch");
    if (!value.is_number_unsigned() || !value.get<uint64_t>() ||
        value.get<uint64_t>() > 9007199254740991ULL)
      throw std::runtime_error("invalid_authorization_epoch");
    return value.get<uint64_t>();
  }
  void RequireAuthPeer(const Json& request) {
    if (!peer.load() || !authorization.Required() ||
        Required(request, "connectionId") != connection)
      throw std::runtime_error("stale_rtc_connection");
  }
  Json Authorize(const Json& request,
                 uint64_t generation,
                 const std::function<bool()>& management_current) {
    std::lock_guard transition(authorization_mutex);
    RequireAuthPeer(request);
    if (!management_current())
      throw std::runtime_error("management_disconnected");
    const auto epoch = AuthorizationEpoch(request);
    const bool unlocked = request.at("unlocked").get<bool>();
    const auto decision = authorization.Check(epoch, unlocked);
    using Decision = remotekit::ProductAuthorization::Decision;
    if (decision == Decision::reject)
      throw std::runtime_error("stale_authorization_epoch");
    if (decision == Decision::change) {
      management_generation = generation;
      if (RevokeProduct() != 0)
        throw std::runtime_error("rtc_media_authorization_failed");
      if (unlocked) {
        const auto handle = peer.load();
        if (sdk.remotekit_rtc_set_media_authorized(handle, 1) != 0)
          throw std::runtime_error("rtc_media_authorization_failed");
        direct_services.Bind(handle, connection);
        {
          std::lock_guard admission(admission_mutex);
          file_services.Bind(handle, connection);
          audio_authorized_after = QpcNow();
          authorization.Commit(epoch, true);
          authorization.Open();
        }
        if (!management_current()) {
          RevokeProduct();
          throw std::runtime_error("management_disconnected");
        }
      }
      if (!unlocked)
        authorization.Commit(epoch, false);
      event_wake.notify_all();
    }
    management_generation = generation;
    return {{"applied", true}, {"epoch", epoch}};
  }
  static Json FaceCapabilities() {
    const auto capability = rk::auth::Faces::Capabilities(FaceModels());
    Json result = {{"available", capability.available}, {"modelVersion", capability.model_version}};
    if (!capability.reason.empty())
      result["reason"] = capability.reason;
    return result;
  }
  Json FaceCommand(const std::string& method,
                   const Json& request,
                   uint64_t generation,
                   const std::function<bool()>& management_current) {
    std::lock_guard transition(authorization_mutex);
    RequireAuthPeer(request);
    const auto epoch = AuthorizationEpoch(request);
    if (epoch != authorization.Epoch() || management_generation != generation ||
        !management_current())
      throw std::runtime_error("stale_authorization_epoch");
    const auto challenge = Required(request, "challengeId");
    if (!rk::auth::CameraChallengeId(challenge))
      throw std::runtime_error("invalid_face_challenge");
    if (method == "auth.face.cancel") {
      raw_camera.Cancel(epoch, challenge);
      faces.Cancel(epoch, challenge);
      return {{"cancelled", true}};
    }
    if (method == "auth.face.status") {
      const auto result = faces.Status(epoch, challenge);
      if (!result)
        throw std::runtime_error("stale_face_challenge");
      using State = rk::auth::FaceState;
      const char* state = nullptr;
      switch (result->state) {
        case State::pending:
          state = "pending";
          break;
        case State::matched:
          state = "matched";
          break;
        case State::enrolled:
          state = "enrolled";
          break;
        case State::absent:
          state = "absent";
          break;
        case State::failed:
          state = "failed";
          break;
        case State::expired:
          state = "expired";
          break;
      }
      Json reply = {{"challengeId", challenge}, {"status", state}};
      if (result->state == State::enrolled && result->face_template)
        reply["template"] = *result->face_template;
      if (!result->reason.empty())
        reply["reason"] = result->reason;
      return reply;
    }
    if (method != "auth.face.begin")
      throw std::runtime_error("unknown_face_method");
    using Purpose = rk::auth::FacePurpose;
    const auto purpose = Required(request, "purpose");
    Purpose kind;
    uint32_t maximum;
    if (purpose == "enroll") {
      kind = Purpose::enroll;
      maximum = 60000;
    } else if (purpose == "verify") {
      kind = Purpose::verify;
      maximum = 30000;
    } else if (purpose == "presence") {
      kind = Purpose::presence;
      maximum = 120000;
    } else
      throw std::runtime_error("invalid_face_purpose");
    const bool unlocked = authorization.Stamp() != 0;
    if ((kind == Purpose::enroll && !unlocked) || (kind == Purpose::verify && unlocked))
      throw std::runtime_error("invalid_face_authorization");
    const auto& timeout = request.at("timeoutMs");
    if (!timeout.is_number_unsigned() || !timeout.get<uint64_t>() ||
        timeout.get<uint64_t>() > maximum)
      throw std::runtime_error("invalid_face_timeout");
    rk::auth::FaceChallenge input{epoch, challenge, kind, timeout.get<uint32_t>(), {}};
    const auto model = request.find("template");
    if (kind == Purpose::enroll) {
      if (model != request.end())
        throw std::runtime_error("unexpected_face_template");
    } else {
      rk::auth::FaceTemplate value{};
      if (model == request.end() || !model->is_array() || model->size() != value.size())
        throw std::runtime_error("invalid_face_template");
      double norm = 0;
      for (size_t i = 0; i < value.size(); ++i) {
        if (!(*model)[i].is_number())
          throw std::runtime_error("invalid_face_template");
        const double sample = (*model)[i].get<double>();
        if (!std::isfinite(sample) || std::abs(sample) > 1.01)
          throw std::runtime_error("invalid_face_template");
        value[i] = static_cast<float>(sample);
        norm += sample * sample;
      }
      if (std::abs(norm - 1) > 0.01)
        throw std::runtime_error("invalid_face_template");
      input.face_template = value;
    }
    // Do not let a final chunk from the old challenge enter the new worker.
    raw_camera.Cancel();
    if (!faces.Begin(std::move(input)))
      throw std::runtime_error("face_challenge_unavailable");
    raw_camera.Begin(peer.load(), epoch, challenge, CameraNow() + timeout.get<uint32_t>());
    WakeCamera();
    return {{"accepted", true}};
  }
  void ClosePeer() {
    {
      std::lock_guard transition(authorization_mutex);
      RevokeProduct();
      management_generation = 0;
    }
    stop_camera = true;
    raw_camera.Bind(0);
    WakeCamera();
    if (camera_thread.joinable())
      camera_thread.join();
    const bool had_audio = audio_ring.IsOpen();
    stop_audio = true;
    if (audio_thread.joinable())
      audio_thread.join();
    if (had_audio && control && Alive())
      try {
        Rpc({{"method", "audio.close"}});
      } catch (const std::exception& error) {
        fprintf(stderr, "audio close: %s\n", error.what());
      }
    audio_ring.Close();
    trickle_signals = false;
    stop_input = true;
    input_wake.notify_all();
    if (input_thread.joinable())
      input_thread.join();
    stop_media = true;
    event_wake.notify_all();
    if (media_thread.joinable())
      media_thread.join();
    rtc_connected = false;
    presentation.Bind(0);
    control_outbox.Bind(0);
    direct_services.Bind(0);
    layout_prepare.reset();
    InvalidateLayout("rtc-closed");
    {
      std::lock_guard lock(input_mutex);
      input_queue.clear();
      input_sequence.Bind(0);
    }
    auto handle = peer.exchange(0);
    media_feedback.Bind(0, "", "");
    if (handle)
      sdk.remotekit_rtc_close(handle);
    std::map<uint64_t, std::unique_ptr<EncoderWorker>> remaining;
    {
      std::lock_guard lock(encoder_mutex);
      remaining.swap(encoders);
    }
    remaining.clear();
    // Product output stop and the render generation FIFO barrier are separate.
    // Stop/Stopped can drain accepted Begins even if the control RPC failed.
    bool producer_exited = ProducerExited();
    if (control && !producer_exited) {
      try {
        Rpc({{"method", "output.close"}});
      } catch (const std::exception& error) {
        fprintf(stderr, "product output close unfinished: %s\n", error.what());
      }
    }
    producer_exited = producer_exited || ProducerExited();
    std::string close_error;
    if (!pool.Close(close_error, producer_exited))
      fprintf(stderr, "render close: %s\n", close_error.c_str());
    data_open = false;
    connection.clear();
    {
      std::lock_guard lock(stats->mutex);
      stats->sender_rtc_stats = nullptr;
    }
    {
      std::lock_guard lock(event_mutex);
      events.clear();
    }
    if (trace)
      trace->Flush();
  }
  void OpenAudio() {
    const uint64_t generation = static_cast<uint64_t>(QpcNow());
    const std::string name =
        "Local\\RemoteKit.audio." + browser_incarnation + "." + std::to_string(generation);
    audio_ring.Open(name, generation, std::stoull(id));
    try {
      Rpc({{"method", "audio.open"},
           {"mapping", name},
           {"generation", std::to_string(generation)},
           {"session", id}});
    } catch (...) {
      audio_ring.Close();
      throw;
    }
    audio_gaps = 0;
    audio_submitted = 0;
    audio_rejected = 0;
    stop_audio = false;
    audio_thread = std::thread([this, generation] {
      uint64_t gaps = 0, stale = 0;
      while (!stop_audio.load()) {
        remotekit::AudioPacket packet{};
        if (!audio_ring.Poll(packet, gaps)) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        audio_gaps = gaps + stale;
        const auto handle = peer.load();
        const auto stamp = authorization.Stamp();
        if (!handle || !stamp || !rtc_connected.load() ||
            packet.first_sample_qpc < audio_authorized_after.load())
          continue;
        // Bound age independently of the video encoder and never await its queue.
        if (QpcNow() - packet.first_sample_qpc > QpcFrequency() / 20) {
          ++stale;
          audio_gaps = gaps + stale;
          continue;
        }
        if (!authorization.Current(stamp))
          continue;
        const int status = sdk.remotekit_rtc_submit_audio(
            handle, packet.pcm, 480, generation, packet.sequence, packet.sample_index,
            packet.first_sample_qpc, packet.discontinuity);
        if (status == 0)
          ++audio_submitted;
        else
          ++audio_rejected;
      }
    });
  }
  using FileBinding = remotekit::FileUploadStore::Binding;
  using FileJob = remotekit::DcFileServices::Job;
  using LibrarySelection = remotekit::FileLibrary::Selection;
  using LibraryState = LibrarySelection::State;
  void RequireFileJob(const FileJob& job) {
    if (!authorization.Stamp() || !file_services.Current(job))
      throw std::runtime_error("file_transfer_interrupted");
  }
  Json DirectFileRpc(const FileJob& job, const char* method, Json additions = Json::object()) {
    RequireFileJob(job);
    Json command = {{"method", method},
                    {"session", id},
                    {"view", job.binding.view},
                    {"instance", job.binding.instance},
                    {"document", job.binding.document},
                    {"request", job.binding.request}};
    command.update(additions);
    return Rpc(std::move(command), true, job.control, 10000, 0,
               [&] { return authorization.Stamp() && file_services.Current(job); });
  }
  void SweepDirectFiles() {
    const auto now = QpcNow();
#ifdef RK_FILE_PHOTO
    photo_bursts.Sweep([&](uint64_t grant) {
      return authorization.Stamp() && file_services.CurrentLibraryGrant(grant);
    });
#endif
    for (auto it = file_owners.begin(); it != file_owners.end();) {
      if (file_services.Current(it->second.job) &&
          now - it->second.touched < QpcFrequency() * 15 * 60) {
        ++it;
        continue;
      }
      {
        std::lock_guard lock(file_store_mutex);
        file_uploads.Cancel(it->first);
      }
      it = file_owners.erase(it);
    }
    file_library.Sweep();
    if (selection_watches.empty() || now < next_selection_watch)
      return;
    next_selection_watch = now + QpcFrequency() / 10;
    auto watch = std::move(selection_watches.front());
    selection_watches.pop_front();
    if (watch.control != control.load() || now >= watch.expires)
      return;
    try {
      const auto status =
          Rpc(SelectionStatusCommand(watch.selection), false, watch.control, 10000, true);
      const auto state = ObserveSelection(watch.selection, status);
      if (state != "selected" && state != "cancelled")
        selection_watches.push_back(std::move(watch));
    } catch (...) {
      if (watch.control == control.load())
        selection_watches.push_back(std::move(watch));
    }
  }
  static uint64_t FileUnsigned(const Json& value) {
    if (!value.is_number_unsigned() && (!value.is_number_integer() || value.get<int64_t>() < 0))
      throw std::runtime_error("invalid_file_integer");
    return value.get<uint64_t>();
  }
  Json SelectionBrowserCommand(const FileBinding& binding, const char* method) {
    return {{"method", method},
            {"session", id},
            {"view", binding.view},
            {"instance", binding.instance},
            {"document", binding.document},
            {"request", binding.request}};
  }
  Json SelectionStatusCommand(const LibrarySelection& selection) {
    auto command = SelectionBrowserCommand(selection.binding, "page.fileStatus");
    if (selection.state != LibraryState::pending)
      command["selection_id"] = selection.id;
    return command;
  }
  std::string RetireUnsubmittedSelection(const std::string& selection_id) {
    // Claim persists submitted before sending Browser the callback. A retired
    // target proves cancellation only if the manifest never crossed that boundary.
    const auto state =
        file_library.Finish(selection_id, LibraryState::cancelled, LibraryState::pending);
    if (state == LibraryState::selected)
      return "selected";
    return state == LibraryState::cancelled ? "cancelled" : "unknown";
  }
  std::string ObserveSelection(const LibrarySelection& selection, const Json& status) {
    const auto current = file_library.FindSelection(selection.id);
    if (!current)
      return "unknown";
    if (current->state == LibraryState::selected)
      return "selected";
    if (current->state == LibraryState::cancelled)
      return "cancelled";
    if (!status.is_object())
      return "unknown";
    const auto error = status.value("error", std::string());
    if (error == "stale_page_request_target" || error == "view_not_in_session")
      return RetireUnsubmittedSelection(selection.id);
    const auto state = status.value("state", std::string("unknown"));
    const bool matched = status.value("selection_id", std::string()) == selection.id;
    if (state == "selected" && matched && current->state == LibraryState::submitted) {
      return file_library.Finish(selection.id, LibraryState::selected) == LibraryState::selected
                 ? "selected"
                 : "cancelled";
    }
    if (state == "cancelled" && matched && current->state == LibraryState::submitted) {
      return file_library.Finish(selection.id, LibraryState::cancelled) == LibraryState::cancelled
                 ? "cancelled"
                 : "selected";
    }
    if (state == "cancelled" || (state == "selected" && !matched))
      return RetireUnsubmittedSelection(selection.id);
    if (state == "pending" || state == "validating")
      return current->state == LibraryState::pending && state == "pending" ? "pending"
                                                                           : "validating";
    return "unknown";
  }
  Json DirectSelectionCommit(const FileJob& job, const std::string& selection_id) {
    const auto selection = file_library.FindSelection(selection_id);
    if (!selection || selection->binding != job.binding ||
        selection->request_id != job.message["params"]["requestId"].get_ref<const std::string&>())
      throw std::runtime_error("unknown_file_selection");
    const auto result = [&](const std::string& state) {
      return Json{{"state", state}, {"selectionId", selection_id}};
    };
    if (selection->state == LibraryState::selected)
      return result("selected");
    if (selection->state == LibraryState::cancelled)
      return result("cancelled");
    auto browser_status = [&] {
      RequireFileJob(job);
      return Rpc(SelectionStatusCommand(*selection), false, job.control, 10000, 0,
                 [&] { return authorization.Stamp() && file_services.Current(job); });
    };
    const auto initial = ObserveSelection(*selection, browser_status());
    if (initial != "pending" || selection->state != LibraryState::pending)
      return result(initial);
    std::vector<remotekit::FileUploadStore::Source> sources;
    for (const auto& file : selection->files) {
      const auto asset = file_library.Describe(file.asset_id);
      sources.push_back({{file.name, file.type, asset.size}, file_library.Path(file.asset_id)});
    }
    Json files = Json::array();
    {
      std::lock_guard lock(file_store_mutex);
      const auto check = [&] { RequireFileJob(job); };
      const auto& batch = file_uploads.Stage(job.binding, sources, check);
      const auto upload = batch.id;
      try {
        for (const auto& file : batch.files)
          files.push_back({{"path", Utf8(file.path)}, {"displayName", file.name}});
        if (!file_library.Claim(selection_id, check))
          throw std::runtime_error("file_selection_already_submitted");
        file_uploads.MarkSubmitted(upload);
      } catch (...) {
        file_uploads.Cancel(upload);
        throw;
      }
    }
    // The claim is durable before the callback is sent. A lost reply or a
    // retired chooser grant can be reconciled only with a matching Browser receipt.
    if (selection_watches.size() < 64) {
      auto submitted = *selection;
      submitted.state = LibraryState::submitted;
      selection_watches.push_back(
          {std::move(submitted), job.control, QpcNow() + QpcFrequency() * 120});
    }
    auto response = DirectFileRpc(
        job, "page.reply",
        {{"file_only", true}, {"accept", true}, {"files", files}, {"selection_id", selection_id}});
    return result(ObserveSelection(*selection, response));
  }
  Json DirectLibraryCommand(const FileJob& job, const std::string& method, const Json& params) {
    const auto check = [&] { RequireFileJob(job); };
    if (method == "asset.begin")
      return file_library.Begin(job.grant, Required(params, "operationId"),
                                {Required(params, "name"), params.value("type", std::string()),
                                 FileUnsigned(params.at("size"))},
                                check);
    if (method == "asset.chunk")
      return {{"offset", file_library.Chunk(job.grant, Required(params, "uploadId"),
                                            FileUnsigned(params.at("offset")),
                                            remotekit::DecodeFileChunk(params.at("data")), check)}};
    if (method == "asset.seal")
      return file_library.Seal(job.grant, Required(params, "uploadId"), check).Json();
    if (method == "asset.cancel") {
      file_library.Cancel(job.grant, Required(params, "uploadId"), check);
      return {{"cancelled", true}};
    }
    if (method == "asset.describe") {
      const auto asset = file_library.Describe(Required(params, "assetId"));
      check();
      return asset.Json();
    }
    if (method == "asset.read") {
      const auto offset = FileUnsigned(params.at("offset"));
      const auto [asset, bytes] = file_library.Read(Required(params, "assetId"), offset);
      check();
      return {{"data", remotekit::EncodeFileChunk(bytes)},
              {"offset", offset + bytes.size()},
              {"total", asset.size}};
    }
#ifdef RK_FILE_PHOTO
    const auto cancelled = [&] { return !authorization.Stamp() || !file_services.Current(job); };
    if (remotekit::PhotoBurstMethod(method))
      return photo_bursts.Execute(job.grant, method, params, cancelled);
    if (method == "photo.thumbnail") {
      const auto asset_id = Required(params, "assetId");
      const auto source = file_library.Path(asset_id);
      const auto now = QpcNow();
      const auto cached = photo_thumbnails.find(asset_id);
      if (cached != photo_thumbnails.end()) {
        std::optional<remotekit::FileLibrary::Asset> thumbnail;
        if (now < cached->second.refresh_after) {
          try {
            thumbnail = file_library.Describe(cached->second.asset_id);
          } catch (const std::runtime_error&) {
          }  // An expired derivative can be regenerated.
        }
        if (thumbnail) {
          check();
          return thumbnail->Json();
        }
        photo_thumbnails.erase(cached);
      }
      const auto thumbnail = file_library.CreateDerivative(
          [&](const fs::path& output) {
            const auto dimensions = remotekit::CreatePhotoThumbnail(source, output, cancelled);
            return remotekit::FileLibrary::Derivative{dimensions.width, dimensions.height};
          },
          check);
      check();
      constexpr size_t kThumbnailCacheEntries = 256;
      if (photo_thumbnails.size() >= kThumbnailCacheEntries) {
        const auto oldest =
            std::min_element(photo_thumbnails.begin(), photo_thumbnails.end(),
                             [](const auto& left, const auto& right) {
                               return left.second.refresh_after < right.second.refresh_after;
                             });
        photo_thumbnails.erase(oldest);
      }
      // Renew before the derivative's two-hour raw asset expiration so a caller
      // can fetch its chunks after receiving this descriptor.
      photo_thumbnails.emplace(asset_id,
                               PhotoThumbnail{thumbnail.id, QpcNow() + QpcFrequency() * 3600});
      return thumbnail.Json();
    }
    if (method == "photo.rank") {
      const auto& ids = params.at("assetIds");
      if (!ids.is_array() || ids.empty() || ids.size() > 6)
        throw std::runtime_error("invalid_photo_count");
      std::vector<fs::path> paths;
      for (const auto& asset : ids)
        paths.push_back(file_library.Path(asset.get<std::string>()));
      const auto ranked = remotekit::RankPhotos(paths, cancelled);
      check();
      Json candidates = Json::array();
      for (const auto& candidate : ranked.candidates)
        candidates.push_back({{"assetId", ids.at(candidate.index)}, {"score", candidate.score}});
      return {{"selectedAssetId", ids.at(ranked.selected_index)},
              {"uncertain", ranked.uncertain},
              {"candidates", std::move(candidates)},
              {"reason", ranked.reason}};
    }
    if (method == "photo.process") {
      const auto source = file_library.Path(Required(params, "assetId"));
      const auto mode = Required(params, "mode");
      if (mode != "rectify" && mode != "scan")
        throw std::runtime_error("invalid_photo_mode");
      std::optional<std::array<remotekit::PhotoPoint, 4>> corners;
      if (const auto found = params.find("corners"); found != params.end()) {
        if (!found->is_array() || found->size() != 4)
          throw std::runtime_error("invalid_photo_corners");
        corners.emplace();
        for (size_t i = 0; i < 4; ++i)
          (*corners)[i] = {found->at(i).at("x").get<double>(), found->at(i).at("y").get<double>()};
      }
      std::string geometry;
      auto asset =
          file_library
              .CreateDerivative(
                  [&](const fs::path& output) {
                    const auto dimensions =
                        remotekit::ProcessPhoto(source, output,
                                                mode == "scan" ? remotekit::PhotoMode::kScan
                                                               : remotekit::PhotoMode::kRectify,
                                                corners, cancelled);
                    geometry = dimensions.geometry;
                    return remotekit::FileLibrary::Derivative{dimensions.width, dimensions.height};
                  },
                  check, remotekit::FileLibrary::DerivativeFormat::png)
              .Json();
      asset["geometry"] = std::move(geometry);
      return asset;
    }
#endif
    throw std::runtime_error("photo_processing_unavailable");
  }
  Json DirectFileState(const FileJob& job, const std::string& upload) {
    RequireFileJob(job);
    std::vector<uint64_t> offsets;
    {
      std::lock_guard lock(file_store_mutex);
      const auto* batch = file_uploads.Find(upload);
      if (!batch || !(batch->binding == job.binding))
        throw std::runtime_error("unknown_file_upload");
      offsets = file_uploads.Offsets(upload, job.binding);
      if (batch->state == remotekit::FileUploadStore::State::selected)
        return {{"uploadId", upload}, {"state", "selected"}, {"offsets", offsets}};
    }
    auto status = DirectFileRpc(job, "page.fileStatus");
    const auto state = status.value("state", std::string("unknown"));
    {
      std::lock_guard lock(file_store_mutex);
      if (file_uploads.Find(upload)) {
        if (state == "selected")
          file_uploads.MarkSelected(upload);
        else if (state == "cancelled")
          file_uploads.DiscardUnselected(upload);
      }
    }
    if (state == "cancelled")
      file_owners.erase(upload);
    return {{"uploadId", upload}, {"state", state}, {"offsets", offsets}};
  }
  Json DirectFileCommand(const FileJob& job) {
    RequireFileJob(job);
    const auto method = Required(job.message, "method");
    const auto& params = job.message.at("params");
    if (remotekit::LibraryFileMethod(method))
      return DirectLibraryCommand(job, method, params);
    if (method == "selection.commit")
      return DirectSelectionCommit(job, Required(params, "selectionId"));
    if (method == "begin") {
      if (DirectFileRpc(job, "page.fileStatus").value("state", std::string()) != "pending")
        throw std::runtime_error("file_request_not_pending");
      const auto& values = params.at("files");
      if (!values.is_array() || values.empty() || values.size() > 64)
        throw std::runtime_error("invalid_file_count");
      std::vector<remotekit::FileUploadStore::Spec> specs;
      for (const auto& value : values)
        specs.push_back({Required(value, "name"), value.value("type", std::string()),
                         FileUnsigned(value.at("size"))});
      std::lock_guard lock(file_store_mutex);
      RequireFileJob(job);
      if (const auto* existing = file_uploads.FindBinding(job.binding)) {
        const auto owner = file_owners.find(existing->id);
        if (owner == file_owners.end() || owner->second.job.peer != job.peer ||
            owner->second.job.epoch != job.epoch)
          throw std::runtime_error("file_upload_owned_by_other_peer");
      }
      const auto& batch = file_uploads.BeginOrResume(job.binding, specs);
      file_owners[batch.id] = {job, QpcNow()};
      return {{"uploadId", batch.id}, {"offsets", file_uploads.Offsets(batch.id, job.binding)}};
    }
    if (method == "cancel") {
      std::string upload = params.value("uploadId", std::string());
      {
        std::lock_guard lock(file_store_mutex);
        if (!upload.empty()) {
          const auto* batch = file_uploads.Find(upload);
          if (batch && !(batch->binding == job.binding))
            throw std::runtime_error("unknown_file_upload");
        } else if (const auto* batch = file_uploads.FindBinding(job.binding))
          upload = batch->id;
      }
      const auto status = DirectFileRpc(job, "page.fileStatus");
      auto state = status.value("state", std::string("unknown"));
      if (state == "pending" || state == "validating") {
        DirectFileRpc(job, "page.reply", {{"file_only", true}, {"accept", false}});
        state = DirectFileRpc(job, "page.fileStatus").value("state", std::string("unknown"));
      }
      if (state == "selected" || state == "cancelled") {
        std::lock_guard lock(file_store_mutex);
        if (!upload.empty() && file_uploads.Find(upload)) {
          if (state == "selected")
            file_uploads.MarkSelected(upload);
          else
            file_uploads.DiscardUnselected(upload);
        }
      }
      if (state == "cancelled" && !upload.empty())
        file_owners.erase(upload);
      if (state != "selected" && state != "cancelled")
        state = "validating";
      return {{"state", state}};
    }
    const auto upload = Required(params, "uploadId");
    const auto owner = file_owners.find(upload);
    if (owner == file_owners.end() || owner->second.job.peer != job.peer ||
        owner->second.job.epoch != job.epoch || !(owner->second.job.binding == job.binding))
      throw std::runtime_error("file_upload_owned_by_other_peer");
    owner->second.touched = QpcNow();
    if (method == "chunk") {
      const auto bytes = remotekit::DecodeFileChunk(params.at("data"));
      const auto index = FileUnsigned(params.at("fileIndex")),
                 offset = FileUnsigned(params.at("offset"));
      if (index > 63)
        throw std::runtime_error("invalid_file_index");
      std::lock_guard lock(file_store_mutex);
      RequireFileJob(job);
      return {{"offset",
               file_uploads.Write(upload, job.binding, static_cast<size_t>(index), offset, bytes)}};
    }
    if (method == "status")
      return DirectFileState(job, upload);
    if (method != "commit")
      throw std::runtime_error("unknown_file_upload_method");
    bool submitted = false;
    {
      std::lock_guard lock(file_store_mutex);
      const auto* batch = file_uploads.Find(upload);
      if (!batch || !(batch->binding == job.binding))
        throw std::runtime_error("unknown_file_upload");
      submitted = batch->state == remotekit::FileUploadStore::State::submitted ||
                  batch->state == remotekit::FileUploadStore::State::selected;
    }
    if (submitted)
      return DirectFileState(job,
                             upload);  // Never replay a Browser callback after an uncertain submit.
    if (DirectFileRpc(job, "page.fileStatus").value("state", std::string()) != "pending")
      throw std::runtime_error("file_request_not_pending");
    Json files = Json::array();
    {
      std::lock_guard lock(file_store_mutex);
      RequireFileJob(job);
      const auto& batch = file_uploads.Seal(upload, job.binding);
      for (const auto& file : batch.files)
        files.push_back({{"path", Utf8(file.path)}, {"displayName", file.name}});
      file_uploads.MarkSubmitted(upload);
    }
    DirectFileRpc(job, "page.reply", {{"file_only", true}, {"accept", true}, {"files", files}});
    return DirectFileState(job, upload);
  }
  FileBinding ParseFileBinding(const Json& value) {
    return {Required(value, "browserIncarnation"), Required(value, "view"),
            Required(value, "instance"), Required(value, "document"), Required(value, "request")};
  }
  Json FileBrowserCommand(const FileBinding& binding, const char* method) {
    if (!Alive() || !control || producer_stop_pending ||
        binding.browser_incarnation != browser_incarnation || !desired.contains(binding.view))
      throw std::runtime_error("stale_file_request_target");
    return SelectionBrowserCommand(binding, method);
  }
  Json LibraryCommand(const std::string& method, const Json& request) {
    if (method == "session.library.describe")
      return file_library.Describe(Required(request, "assetId")).Json();
    if (method == "session.library.retain" || method == "session.library.references") {
      const auto& values = request.at("assetIds");
      if (!values.is_array() || values.size() > (method == "session.library.retain" ? 64 : 8192))
        throw std::runtime_error("invalid_library_assets");
      std::vector<std::string> assets;
      assets.reserve(values.size());
      for (const auto& value : values)
        assets.push_back(value.get<std::string>());
      if (method == "session.library.retain")
        file_library.Retain(assets);
      else
        file_library.References(FileUnsigned(request.at("revision")), assets);
      return {{"accepted", true}};
    }
    const auto selection_id = Required(request, "selectionId");
    if (method == "session.library.prepare") {
      LibrarySelection selection{selection_id,
                                 Required(request, "requestId"),
                                 ParseFileBinding(request.at("binding")),
                                 {}};
      const auto& values = request.at("files");
      if (!values.is_array() || values.empty() || values.size() > 64)
        throw std::runtime_error("invalid_file_count");
      for (const auto& value : values)
        selection.files.push_back({Required(value, "assetId"), Required(value, "name"),
                                   value.value("type", std::string())});
      if (!file_library.FindSelection(selection_id) &&
          Rpc(FileBrowserCommand(selection.binding, "page.fileStatus"))
                  .value("state", std::string()) != "pending")
        throw std::runtime_error("file_request_not_pending");
      file_library.Prepare(selection);
      return {{"accepted", true}};
    }
    if (method == "session.library.selectionStatus") {
      const auto selection = file_library.FindSelection(selection_id);
      std::string state = "unknown";
      if (selection) {
        if (selection->state == LibraryState::selected)
          state = "selected";
        else if (selection->state == LibraryState::cancelled)
          state = "cancelled";
        else if (selection->state == LibraryState::pending &&
                 (!desired.contains(selection->binding.view) ||
                  selection->binding.browser_incarnation == last_confirmed_browser_exit ||
                  (ProducerExited() &&
                   selection->binding.browser_incarnation == process_incarnation) ||
                  (!browser_incarnation.empty() &&
                   selection->binding.browser_incarnation != browser_incarnation)))
          state = RetireUnsubmittedSelection(selection->id);
        else if (Alive() && control && !producer_stop_pending &&
                 selection->binding.browser_incarnation == browser_incarnation) {
          Json status;
          try {
            status = Rpc(SelectionStatusCommand(*selection), false);
          } catch (const std::exception&) {
            return {{"state", "unknown"}};
          }
          state = ObserveSelection(*selection, status);
        }
      }
      return {{"state", state}};
    }
    throw std::runtime_error("unknown_library_method");
  }
  Json FileStatus(const std::string& upload, const FileBinding& binding) {
    {
      std::lock_guard lock(file_store_mutex);
      const auto* batch = file_uploads.Find(upload);
      if (!batch || !(batch->binding == binding))
        throw std::runtime_error("unknown_file_upload");
      if (batch->state == remotekit::FileUploadStore::State::selected)
        return {
            {"uploadId", upload}, {"state", "selected"}, {"pending", false}, {"selected", true}};
    }
    auto status = Rpc(FileBrowserCommand(binding, "page.fileStatus"));
    const auto state = status.value("state", std::string("unknown"));
    {
      std::lock_guard lock(file_store_mutex);
      if (file_uploads.Find(upload)) {
        if (state == "selected")
          file_uploads.MarkSelected(upload);
        else if (state == "cancelled")
          file_uploads.DiscardUnselected(upload);
      }
    }
    Json result = {{"uploadId", upload},
                   {"state", state},
                   {"pending", state == "pending" || state == "validating"},
                   {"selected", state == "selected"}};
    if (status.contains("error"))
      result["error"] = status["error"];
    return result;
  }
  Json FileCommand(const std::string& method, const Json& request) {
    if (method == "session.files.authorize") {
      std::map<std::string, FileBinding> bindings;
      const auto& requests = request.at("requests");
      if (!requests.is_array() || requests.size() > 64)
        throw std::runtime_error("invalid_file_authorization_count");
      for (const auto& item : requests) {
        const auto token = Required(item, "id");
        if (token.size() > 128 || token == "library")
          throw std::runtime_error("invalid_file_request_id");
        const auto binding = ParseFileBinding(item.at("binding"));
        if (binding.browser_incarnation != browser_incarnation || !desired.contains(binding.view))
          throw std::runtime_error("stale_file_request_target");
        if (!bindings.emplace(token, binding).second)
          throw std::runtime_error("duplicate_file_authorization");
      }
      std::lock_guard admission(admission_mutex);
      if (!authorization.Stamp())
        throw std::runtime_error("authorization_changed");
      if (authorization.Required()) {
        const auto epoch = request.find("authEpoch");
        if (epoch == request.end() || !epoch->is_number_unsigned() ||
            epoch->get<uint64_t>() != authorization.Epoch())
          throw std::runtime_error("stale_authorization_epoch");
      }
      file_services.Authorize(Required(request, "connectionId"), control.load(), bindings,
                              request.value("library", false));
      return {{"accepted", true}};
    }
    if (method == "session.files.revoke") {
      file_services.RevokeAuthorization();
      std::lock_guard lock(file_store_mutex);
      file_uploads.RevokeUncommitted();
      return {{"accepted", true}};
    }
    if (method == "session.files.cancel") {
      const auto upload = request.value("uploadId", std::string());
      if (request.value("cancelRequest", false)) {
        const auto binding = ParseFileBinding(request.at("binding"));
        bool known = false;
        {
          std::lock_guard lock(file_store_mutex);
          known = !upload.empty() && file_uploads.Find(upload);
        }
        if (known) {
          const auto status = FileStatus(upload, binding);
          if (status.value("state", std::string()) == "selected" ||
              status.value("state", std::string()) == "cancelled")
            return status;
        }
        auto status = Rpc(FileBrowserCommand(binding, "page.fileStatus"));
        const auto state = status.value("state", std::string());
        if (state == "pending" || state == "validating") {
          auto command = FileBrowserCommand(binding, "page.reply");
          command["file_only"] = true;
          command["accept"] = false;
          Rpc(command);
        }
        {
          std::lock_guard lock(file_store_mutex);
          file_uploads.CancelBinding(binding);
        }
        {
          std::lock_guard lock(file_store_mutex);
          known = !upload.empty() && file_uploads.Find(upload);
        }
        if (known)
          return FileStatus(upload, binding);
        status = Rpc(FileBrowserCommand(binding, "page.fileStatus"));
        return {{"accepted", true}, {"state", status.value("state", std::string("unknown"))}};
      }
      if (upload.empty()) {
        std::lock_guard lock(file_store_mutex);
        file_uploads.RevokeUncommitted();
        return {{"accepted", true}};
      }
      std::optional<FileBinding> pending;
      {
        std::lock_guard lock(file_store_mutex);
        const auto* batch = file_uploads.Find(upload);
        if (!batch)
          return {{"accepted", true}, {"state", "cancelled"}};
        const auto binding = batch->binding;
        if (!file_uploads.Cancel(upload))
          pending = binding;
      }
      if (pending)
        return FileStatus(upload, *pending);
      return {{"accepted", true}, {"state", "cancelled"}};
    }
    const auto binding = ParseFileBinding(request.at("binding"));
    if (method == "session.files.begin") {
      if (Rpc(FileBrowserCommand(binding, "page.fileStatus")).value("state", std::string()) !=
          "pending")
        throw std::runtime_error("file_request_not_pending");
      const auto& values = request.at("files");
      if (!values.is_array() || values.empty() || values.size() > 64)
        throw std::runtime_error("invalid_file_count");
      std::vector<remotekit::FileUploadStore::Spec> specs;
      for (const auto& value : values) {
        if (!value.at("size").is_number_unsigned() &&
            (!value.at("size").is_number_integer() || value.at("size").get<int64_t>() < 0))
          throw std::runtime_error("invalid_file_size");
        specs.push_back({Required(value, "name"), value.value("type", std::string()),
                         value.at("size").get<uint64_t>()});
      }
      std::lock_guard lock(file_store_mutex);
      const auto& batch = file_uploads.BeginOrResume(binding, specs);
      Json files = Json::array();
      for (const auto& file : batch.files)
        files.push_back({{"ticket", file.ticket}, {"path", Utf8(file.path)}});
      return {{"uploadId", batch.id}, {"files", files}};
    }
    const auto upload = Required(request, "uploadId");
    if (method == "session.files.status")
      return FileStatus(upload, binding);
    if (method != "session.files.commit")
      throw std::runtime_error("unknown_file_upload_method");
    bool submitted = false;
    {
      std::lock_guard lock(file_store_mutex);
      const auto* existing = file_uploads.Find(upload);
      if (!existing || !(existing->binding == binding))
        throw std::runtime_error("unknown_file_upload");
      submitted = existing->state == remotekit::FileUploadStore::State::submitted ||
                  existing->state == remotekit::FileUploadStore::State::selected;
    }
    if (submitted)
      return FileStatus(upload, binding);
    if (Rpc(FileBrowserCommand(binding, "page.fileStatus")).value("state", std::string()) !=
        "pending")
      throw std::runtime_error("file_request_not_pending");
    Json files = Json::array();
    {
      std::lock_guard lock(file_store_mutex);
      const auto& batch = file_uploads.Seal(upload, binding);
      for (const auto& file : batch.files)
        files.push_back({{"path", Utf8(file.path)}, {"displayName", file.name}});
      file_uploads.MarkSubmitted(
          upload);  // An RPC timeout can occur after Browser received these paths.
    }
    auto command = FileBrowserCommand(binding, "page.reply");
    command["file_only"] = true;
    command["accept"] = true;
    command["files"] = files;
    Rpc(command);
    return FileStatus(upload, binding);
  }
  Json Command(const Json& request,
               uint64_t generation,
               const std::function<bool()>& management_current) {
    const auto method = Required(request, "method");
    if (method == "rtc.authorize")
      return Authorize(request, generation, management_current);
    if (method == "auth.face.capabilities")
      return FaceCapabilities();
    if (method.starts_with("auth.face."))
      return FaceCommand(method, request, generation, management_current);
    if (method.starts_with("session.files."))
      return FileCommand(method, request);
    if (method.starts_with("session.library."))
      return LibraryCommand(method, request);
    if (method == "session.ensure") {
      Start();
      return {{"sessionId", id},
              {"browserPid", GetProcessId(process)},
              {"running", true},
              {"accepted", true},
              {"browserIncarnation", browser_incarnation},
              {"recovery", RecoverySnapshot()}};
    }
    if (method == "session.snapshot")
      return Snapshot(request.value("outputDiagnostics", false));
    if (method == "session.events.ack") {
      const auto ids = request.at("eventIds");
      if (!ids.is_array() || ids.size() > 256)
        throw std::runtime_error("invalid event ids");
      std::set<std::string> acknowledged;
      for (const auto& value : ids) {
        if (!value.is_string())
          throw std::runtime_error("invalid event id");
        acknowledged.insert(value.get<std::string>());
      }
      Json remaining = Json::array();
      for (const auto& event : durable_events)
        if (!acknowledged.contains(event.at("eventId").get<std::string>()))
          remaining.push_back(event);
      durable_events = std::move(remaining);
      SaveEvents();
      return {{"accepted", true}, {"remaining", durable_events.size()}};
    }
    if (method == "session.mediaPolicy") {
      const auto& value = request.at("maxFps");
      if (!value.is_number_integer() || value.get<int64_t>() < 1 || value.get<int64_t>() > 240)
        throw std::runtime_error("invalid media policy maxFps");
      const auto preference = Required(request, "degradationPreference");
      uint32_t degradation;
      if (preference == "maintain-resolution")
        degradation = REMOTEKIT_RTC_MAINTAIN_RESOLUTION;
      else if (preference == "balanced")
        degradation = REMOTEKIT_RTC_BALANCED;
      else if (preference == "maintain-framerate")
        degradation = REMOTEKIT_RTC_MAINTAIN_FRAMERATE;
      else
        throw std::runtime_error("invalid degradation preference");
      {
        std::lock_guard lock(media_policy_mutex);
        if (peer && (sdk.remotekit_rtc_set_degradation_preference(peer, degradation) != 0 ||
                     sdk.remotekit_rtc_set_source_max_fps(peer, value.get<uint32_t>()) != 0))
          throw std::runtime_error("RTC media policy rejected");
        policy_max_fps = value.get<uint32_t>();
        policy_degradation = degradation;
        requested_media_policy = {{"maxFps", policy_max_fps.load()},
                                  {"degradationPreference", preference}};
      }
      event_wake.notify_one();
      return {{"accepted", true}, {"applied", peer.load() != 0}};
    }

    if (method == "session.sitePreferences") {
      const auto sites = request.at("sites");
      if (!sites.is_object() || sites.size() > 4096)
        throw std::runtime_error("invalid site preferences");
      for (auto& [origin, value] : sites.items()) {
        if (origin.size() > 2048 ||
            !(origin.starts_with("https://") || origin.starts_with("http://")) ||
            !value.is_object() || !value.contains("tabletUa") || !value["tabletUa"].is_boolean())
          throw std::runtime_error("invalid site preference");
      }
      if (Alive() && control)
        Rpc({{"method", "session.sitePreferences"}, {"session", id}, {"sites", sites}});
      site_preferences = sites;
      SaveJson(directory / "site-preferences.json", site_preferences);
      return {{"accepted", true}, {"applied", Alive() && control != 0}};
    }
    if (method == "rtc.actionResult") {
      if (request.value("connectionId", std::string()) != connection || !peer.load() ||
          !authorization.Stamp())
        return {{"accepted", false}};
      if (authorization.Required() && request.value("authEpoch", Json()) != authorization.Epoch())
        return {{"accepted", false}};
      if (!request.contains("operationId") ||
          !remotekit::BoundedServiceId(request["operationId"], 36) ||
          !request.contains("operationGeneration") ||
          !remotekit::BoundedServiceId(request["operationGeneration"]) || !request.contains("ok") ||
          !request["ok"].is_boolean())
        throw std::runtime_error("invalid action result");
      Json result = {{"connectionId", connection},
                     {"operationId", request["operationId"]},
                     {"operationGeneration", request["operationGeneration"]},
                     {"ok", request["ok"]}};
      if (request.contains("result"))
        result["result"] = request["result"];
      if (request.contains("error"))
        result["error"] = request["error"];
      const bool accepted = direct_services.Result(peer.load(), result);
      event_wake.notify_one();
      return {{"accepted", accepted}};
    }
    if (method == "rtc.offer") {
      auto result = Offer(request, generation);
      if (!management_current()) {
        ManagementLost(generation);
        throw std::runtime_error("management_disconnected");
      }
      return result;
    }
    if (method == "rtc.close") {
      if (request.value("connectionId", std::string()) == connection)
        ClosePeer();
      return {{"closed", true}};
    }
    if (method == "rtc.ice") {
      if (request.value("connectionId", std::string()) != connection || !peer)
        throw std::runtime_error("stale RTC connection");
      auto ice = request.at("candidate");
      if (ice.is_null())
        return Json::object();
      auto candidate = ice.value("candidate", std::string()),
           mid = ice.value("sdpMid", std::string("0"));
      if (sdk.remotekit_rtc_add_ice(peer.load(), mid.c_str(), ice.value("sdpMLineIndex", 0),
                                    candidate.data(), candidate.size()) != 0)
        throw std::runtime_error("ICE candidate rejected");
      return Json::object();
    }
    if (method == "view.navigation.ack") {
      if (!Alive() || !control || producer_stop_pending ||
          request.value("browserIncarnation", std::string()) != browser_incarnation)
        throw std::runtime_error("stale_browser_incarnation");
      Json command = {{"method", "navigation.ack"}, {"session", id}, {"view", ViewId(request)}};
      NavigationOperation(command, request);
      return Rpc(command);
    }
    const bool guarded_page = method == "view.page.reply" || method == "view.close.reply" ||
                              method == "view.page.exitFullscreen";
    if (guarded_page &&
        (!Alive() || !control || producer_stop_pending || browser_incarnation.empty() ||
         request.value("browserIncarnation", std::string()) != browser_incarnation))
      throw std::runtime_error("stale_browser_incarnation");
    const bool lifecycle = method == "view.lifecycle";
    const bool guarded_lifecycle =
        lifecycle && (request.contains("lifecycleGeneration") ||
                      request.value("action", std::string()) == "unload");
    if (guarded_lifecycle &&
        (!request.value("requireRunning", false) ||
         request.value("browserIncarnation", std::string()) != browser_incarnation ||
         browser_incarnation.empty()))
      throw std::runtime_error("stale_lifecycle_recovery");
    const bool require_running = guarded_page || ((method == "view.configure" || lifecycle) &&
                                                  request.value("requireRunning", false));
    if (require_running) {
      if (!Alive() || !control || producer_stop_pending)
        throw std::runtime_error("browser not running; guarded maintenance cannot start it");
    } else
      Start();
    auto view = ViewId(request);
    if (method == "view.ensure" || method == "view.adopt") {
      if (!desired.contains(view) && durable_events.size() + desired.size() >= 256)
        throw std::runtime_error(
            "closed event capacity reserved; acknowledge events before creating views");
      if (method == "view.adopt" && desired.contains(view)) {
        if (desired.at(view).value("provisionalId", std::string()) !=
            Required(request, "provisionalId"))
          throw std::runtime_error("view already belongs to another popup");
        return {{"accepted", true}, {"completed", true}};
      }
      if (desired.contains(view))
        return ApplyView(request, false);
      return ApplyView(request, true);
    }
    if (method == "view.close") {
      CancelRecovery(view);
      const auto snapshot = BrowserSnapshot();
      Json identity = {{"browserIncarnation", browser_incarnation}};
      for (const auto& session : snapshot.at("sessions"))
        for (const auto& current : session.at("views"))
          if (current.value("view", std::string()) == view && current.contains("instance") &&
              current.contains("document")) {
            identity["instance"] = current["instance"];
            identity["document"] = current["document"];
          }
      auto result = Rpc({{"method", "view.close"},
                         {"session", id},
                         {"view", view},
                         {"force", request.value("force", false)}});
      bool closed = result.value("completed", false);
      if (closed) {
        RecordClosed(view, "requested");
        AckClosed(Json::array({view}));
        RefitOutput();
        identity["closed"] = true;
        identity["completed"] = true;
        return identity;
      }
      auto requests = Rpc({{"method", "page.requests"}, {"session", id}, {"view", view}});
      Json output = {{"accepted", true}, {"pageRequests", requests.value("requests", requests)}};
      output.update(identity);
      AddCloseRequest(output, requests);
      return output;
    }
    if (method == "view.close.reply") {
      auto close_request_id = Required(request, "requestId");
      if (!request.contains("accept") || !request["accept"].is_boolean())
        throw std::runtime_error("accept boolean required");
      auto result = Rpc({{"method", "page.reply"},
                         {"session", id},
                         {"view", view},
                         {"request", close_request_id},
                         {"accept", request["accept"]},
                         {"instance", Required(request, "instance")},
                         {"document", Required(request, "document")},
                         {"close_only", true}});
      return {{"accepted", true}, {"browser", result}};
    }
    if (method == "view.page.reply") {
      if (!desired.contains(view))
        throw std::runtime_error("view not found");
      if (!request.contains("accept") || !request["accept"].is_boolean())
        throw std::runtime_error("accept boolean required");
      Json command = {{"method", "page.reply"},
                      {"session", id},
                      {"view", view},
                      {"request", Required(request, "requestId")},
                      {"instance", Required(request, "instance")},
                      {"document", Required(request, "document")},
                      {"accept", request["accept"]},
                      {"dialog_only", true}};
      if (request.contains("text")) {
        if (!request["text"].is_string() ||
            request["text"].get_ref<const std::string&>().size() > 16384)
          throw std::runtime_error("invalid or oversized dialog text");
        command["text"] = request["text"];
      }
      return {{"accepted", true}, {"browser", Rpc(command)}};
    }
    if (method == "view.page.exitFullscreen") {
      if (!desired.contains(view))
        throw std::runtime_error("view not found");
      return Rpc({{"method", "page.exitFullscreen"},
                  {"session", id},
                  {"view", view},
                  {"instance", Required(request, "instance")},
                  {"document", Required(request, "document")}});
    }
    if (method == "view.command") {
      const auto action = Required(request, "command");
      if (action != "back" && action != "forward" && action != "reload" && action != "stop")
        throw std::runtime_error("unsupported page command");
      if (CancelRecovery(view)) {
        Rpc({{"method", "view.recreate"},
             {"session", id},
             {"view", view},
             {"url", desired.at(view).value("url", std::string("about:blank"))}});
        fs::remove(directory / "recovery" / (view + ".json"));
        ReconcileOutput();
      }
      Json command = {
          {"method", "page.command"}, {"session", id}, {"view", view}, {"action", action}};
      NavigationOperation(command, request);
      return Rpc(command);
    }
    if (method == "view.lifecycle") {
      const auto action = Required(request, "action");
      if (guarded_lifecycle && action != "unload" && action != "restore")
        throw std::runtime_error("unsupported guarded lifecycle action");
      if (action != "discard" && action != "freeze" && action != "restore" && action != "unload")
        throw std::runtime_error("unsupported lifecycle action");
      if (Recovering(view)) {
        if (guarded_lifecycle)
          throw std::runtime_error("navigation_recovery_pending");
        return {{"accepted", true},
                {"pending", true},
                {"completed", false},
                {"recovery", RecoveryStatus(recoveries.at(view))}};
      }
      Json command = {{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", action}};
      if (guarded_lifecycle)
        command["expected_lifecycle_generation"] = Required(request, "lifecycleGeneration");
      return Rpc(std::move(command));
    }
    if (method == "view.navigate") {
      const auto url = Required(request, "url");
      navigation_export.Forget(view);
      const bool cancelled = CancelRecovery(view);
      Json command = {{"method", cancelled ? "view.recreate" : "navigate"},
                      {"session", id},
                      {"view", view},
                      {"url", url}};
      NavigationOperation(command, request);
      auto result = Rpc(command);
      fs::remove(directory / "recovery" / (view + ".json"));
      recovery_revisions.erase(view);
      if (desired.contains(view)) {
        desired[view]["url"] = request["url"];
        Save();
      }
      if (cancelled)
        ReconcileOutput();
      return result;
    }
    if (method == "view.configure") {
      if (!desired.contains(view))
        throw std::runtime_error("view not found");
      auto config = desired.at(view);
      for (auto& [key, value] : request.items())
        if (key != "id" && key != "method" && key != "requireRunning")
          config[key] = value;
      return ApplyView(config, false);
    }
    throw std::runtime_error("unknown endpoint method: " + method);
  }
};
// stdin may remain idle for minutes while navigation completion still needs
// progress. The reader owns only its queue; Session state stays on dispatcher.
class ServiceRequests {
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::string> queue_;
  bool stopping_ = false, eof_ = false;
  size_t queued_bytes_ = 0;
  std::thread reader_;

 public:
  ServiceRequests(bool enabled, std::function<void()> disconnected) {
    if (enabled)
      reader_ = std::thread([this, disconnected = std::move(disconnected)] {
        std::string line;
        while (remotekit::ReadServiceLine(std::cin, line)) {
          std::unique_lock lock(mutex_);
          wake_.wait(lock, [&] {
            return stopping_ ||
                   (queue_.size() < 256 && queued_bytes_ + line.size() <= 4 * 1024 * 1024);
          });
          if (stopping_)
            break;
          queued_bytes_ += line.size();
          queue_.push_back(std::move(line));
          wake_.notify_all();
        }
        disconnected();
        {
          std::lock_guard lock(mutex_);
          eof_ = true;
        }
        wake_.notify_all();
      });
  }
  ~ServiceRequests() {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    wake_.notify_all();
    // Cancel a synchronous stdin pipe read on shutdown. Repeating closes the
    // small race between the reader checking stopping_ and entering ReadFile.
    if (!reader_.joinable())
      return;
    while (WaitForSingleObject(reader_.native_handle(), 20) == WAIT_TIMEOUT)
      CancelSynchronousIo(reader_.native_handle());
    reader_.join();
  }
  bool Next(std::string& line, bool& eof) {
    std::unique_lock lock(mutex_);
    wake_.wait_for(lock, std::chrono::milliseconds(20), [&] { return eof_ || !queue_.empty(); });
    eof = eof_ && queue_.empty();
    if (queue_.empty())
      return false;
    line = std::move(queue_.front());
    queued_bytes_ -= line.size();
    queue_.pop_front();
    wake_.notify_all();
    return true;
  }
};
}  // namespace
int main(int argc, char** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  try {
    struct TimerResolution {
      TimerResolution() { timeBeginPeriod(1); }
      ~TimerResolution() { timeEndPeriod(1); }
    } timer_resolution;
    Options options;
    options.Parse(argc, argv);
    fs::create_directories(options.data);
    Sdk sdk;
    sdk.Open(options.browser.parent_path() / "remotekit_sdk.dll");
    auto registry =
        LoadJson(options.data / "sessions.json", {{"next", 1}, {"tenants", Json::object()}});
    std::mutex sessions_mutex;
    std::map<std::string, std::unique_ptr<Session>> sessions;
    std::atomic<bool> local_connected{true};
    const auto disconnected = [&](uint64_t generation) {
      std::lock_guard lock(sessions_mutex);
      for (auto& [tenant, session] : sessions)
        session->ManagementLost(generation);
    };
    const auto clear_sessions = [&] {
      // Session shutdown joins workers and must run outside the registry lock.
      decltype(sessions) closing;
      {
        std::lock_guard lock(sessions_mutex);
        closing.swap(sessions);
      }
    };
    std::unique_ptr<remotekit::ControlTransport> remote;
    if (!options.control_url.empty()) {
      remote = std::make_unique<remotekit::ControlTransport>(
          options.control_url, options.node_id, Env("REMOTEKIT_ENDPOINT_TOKEN"), disconnected);
      management_output = [&](std::string bytes) { remote->Send(std::move(bytes)); };
      management_action = [&](std::string bytes, uint64_t generation) {
        return remote->TrySend(std::move(bytes), generation);
      };
    } else if (!options.node_id.empty())
      throw std::runtime_error("--node-id requires --control-url");
    ServiceRequests requests(!remote, [&] {
      local_connected = false;
      disconnected(0);
    });
    std::string maintenance_cursor, line;
    while (true) {
      bool eof = false;
      uint64_t generation = 0;
      const bool received = remote ? remote->Next(line, generation) : requests.Next(line, eof);
      if (eof)
        break;
      if (received) {
        if (remote && !remote->Current(generation))
          continue;
        auto reply = [&](const Json& message) {
          if (remote)
            remote->Send(message.dump(), generation);
          else
            management_output(message.dump());
        };
        if (line.size() > 1024 * 1024) {
          reply({{"id", nullptr}, {"ok", false}, {"error", "request exceeds 1 MiB"}});
          continue;
        }
        Json request = Json::parse(line, nullptr, false),
             response = {
                 {"id", request.is_object() ? request.value("id", Json(nullptr)) : Json(nullptr)}};
        bool shutdown = false;
        try {
          if (!request.is_object())
            throw std::runtime_error("invalid JSON request");
          auto method = Required(request, "method");
          if (method == "__oversized_request")
            throw std::runtime_error("request exceeds 1 MiB");
          if (method == "shutdown") {
            clear_sessions();
            response["result"] = {{"closed", true}};
            shutdown = true;
          } else {
            auto tenant = Required(request, "tenantId");
            if (tenant.size() > 128 || !std::all_of(tenant.begin(), tenant.end(), [](char c) {
                  return isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_';
                }))
              throw std::runtime_error("invalid tenant identity");
            if (!sessions.contains(tenant)) {
              if (!registry["tenants"].contains(tenant)) {
                uint64_t id = registry["next"].get<uint64_t>();
                registry["next"] = id + 1;
                registry["tenants"][tenant] = std::to_string(id);
                SaveJson(options.data / "sessions.json", registry);
              }
              auto session = std::make_unique<Session>(
                  sdk, options, tenant, registry["tenants"][tenant].get<std::string>());
              {
                std::lock_guard lock(sessions_mutex);
                sessions.emplace(tenant, std::move(session));
              }
            }
            response["result"] = sessions.at(tenant)->Command(request, generation, [&] {
              return remote ? remote->Current(generation) : local_connected.load();
            });
          }
          response["ok"] = true;
        } catch (const std::exception& error) {
          response["ok"] = false;
          response["error"] = error.what();
          fprintf(stderr, "endpoint: %s\n", error.what());
        }
        reply(response);
        if (shutdown)
          break;
      }
      for (auto& [tenant, session] : sessions)
        session->FlushSignals();
      // Round-robin Sessions even when no more JSONL calls arrive. A single
      // recovery step never contains a navigation completion wait.
      if (!sessions.empty()) {
        auto selected = sessions.upper_bound(maintenance_cursor);
        if (selected == sessions.end())
          selected = sessions.begin();
        maintenance_cursor = selected->first;
        selected->second->MaintainRecovery();
      }
    }
    clear_sessions();
    return 0;
  } catch (const std::exception& error) {
    fprintf(stderr, "endpoint startup: %s\n", error.what());
    return 1;
  }
}
