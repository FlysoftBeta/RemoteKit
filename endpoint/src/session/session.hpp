#pragma once
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

#include <functional>
#include <charconv>
#include <json.hpp>
#include <windows.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <filesystem>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <atomic>
#include <array>
#include "media/adapter.hpp"
#include "common.hpp"
#include "options.hpp"
#include "management/link.hpp"
#include "session/browser.hpp"
#include "persistence/session_store.hpp"
#include "remotekit/thread.hpp"

namespace remotekit {
using namespace media;
class ManagementMethods;
class Session {
  friend class ManagementMethods;

  Sdk& sdk;
  const RuntimeOptions options;
  std::string tenant, id;
  fs::path directory;
  BrowserRuntime browser;
  SessionStore store;
  ManagementLink& management;
  uint64_t request_generation_ = 0;
  std::atomic<uint64_t> client_gestures_control{0};
  std::string last_confirmed_browser_exit;
  remotekit::FileUploadStore file_uploads;
  remotekit::FileLibrary file_library;
  std::mutex file_store_mutex;
  remotekit::DcFileServices file_services;
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
  std::atomic<uint64_t> management_generation{0}, peer_management_generation{0};
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
    uint64_t management_generation = 0;
  };

  std::mutex event_mutex;
  std::condition_variable event_wake;
  std::deque<Event> events;
  std::mutex signal_mutex;
  std::deque<Event> signal_events;
  bool signal_overflow = false;
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
    enum class Phase {
      kLoad,
      kSettling,
      kUnload,
      kBegin,
      kChunks,
      kCommit,
      kRestore,
      kWaiting,
      kVisible,
      kComplete,
      kFallback,
      kFallbackStarted,
      kFailed
    };
    Phase phase = Phase::kLoad;
    std::string error, transfer;
    const char* PhaseName() const;

    Json saved;
    size_t chunk = 0;
    uint64_t offset = 0, buffer_bytes = 0;
    int64_t deadline = 0, next_poll = 0;
    bool Pending() const {
      return phase != Phase::kComplete && phase != Phase::kFallbackStarted &&
             phase != Phase::kFailed;
    }
  };
  std::map<std::string, Recovery> recoveries;
  std::string recovery_cursor;

  struct Geometry {
    int width = 16, height = 16;
    float scale = 1;
  };

  // Called only by the JSONL dispatcher. One phase/one selected view per turn;
  // never sleep or poll inside a phase. Media/input workers do not own this map.

  // Only the dispatcher writes JSONL. SDK callback threads never write stdout.

  // authorization_mutex serializes this with authorization and peer replacement.

  using FileBinding = remotekit::FileUploadStore::Binding;
  using FileJob = remotekit::DcFileServices::Job;
  using LibrarySelection = remotekit::FileLibrary::Selection;
  using LibraryState = LibrarySelection::State;

  uint64_t Control() const { return browser.Rpc().Control(); }
  bool ProductCurrent(const Event& event) const;
  void MarkConnection(ConnectionPhase phase);
  Json ConnectionTimings() const;
  uint32_t SamplingFps() const;
  static fs::path FaceModels();
  Result<void> Save();
  Result<void> RecordClosed(const std::string& view, const std::string& reason);
  Result<void> AckClosed(const Json& views);

  bool Alive() const;
  bool ProducerExited() const;
  std::string ProcessDiagnostic() const;
  Result<void> Start();
  Result<Json> BrowserSnapshot();
  Result<Geometry> DesiredGeometry();
  bool PauseOutput(bool reconfiguring = false);
  Result<void> GeometryConfig(const Geometry& value);
  Result<void> RefitOutput();
  Result<void> ResumeOutput(bool active);
  Result<void> ReconcileOutput();
  Result<Json> ApplyView(const Json& config, bool create, bool recovering = false);
  static void NavigationOperation(Json& target, const Json& source);
  Result<Json> CreateView(const Json& config, bool recovering = false);
  bool Recovering(const std::string& view) const;
  Json RecoveryStatus(const Recovery& recovery) const;
  Json RecoverySnapshot() const;
  bool CancelRecovery(const std::string& view);
  void CaptureNavigation(const Json& browser_view);
  void MaintainNavigationExport();
  void FailRecovery(const std::string& view, Recovery& task, const Error& error);
  Json Stats();
  Json RtcSnapshot() const;
  Json InactiveSnapshot();
  Result<Json> Snapshot(bool output_diagnostics = false);
  static void AddCloseRequest(Json& output, const Json& requests);
  bool Stop();
  static int64_t CameraNow();
  bool FacePending(uint64_t epoch, std::string_view challenge);
  void WakeCamera();
  void CameraLoop();
  static void EventCallback(void* context,
                            uint64_t peer,
                            uint32_t type,
                            const void* bytes,
                            size_t size,
                            const char* auxiliary,
                            int32_t value);
  static int CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder);
  static int ConfigureEncoder(void* context,
                              uint64_t encoder,
                              const remotekit_rtc_encoder_config* config);
  static int Encode(void* context, uint64_t encoder, const remotekit_rtc_frame* frame, int key);
  static void Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps);
  static void Keyframe(void* context, uint64_t encoder);
  static void DestroyEncoder(void* context, uint64_t encoder);
  Result<void> OpenOutput(bool preserve_visibility = false);
  int SendData(uint64_t handle, uint64_t stamp, const std::string& encoded);
  void Send(const Json& message, uint64_t expected_stamp = 0);
  void FlushControl();
  bool ServiceMessage(const Event& event);
  void QueueLayout(const Json& mode = Json());
  static bool PresentationNumber(const Json& message, const char* field, uint64_t& result);
  bool PresentationMessage(const Event& event);
  void PublishLayout(Json next, uint64_t epoch);
  void InvalidateLayout(const char* reason);
  Json Layout(const remotekit::SharedAtlasFrame& frame);
  std::string GeometryKey(const remotekit::SharedAtlasFrame& frame);
  uint64_t ObserveLayout(const remotekit::SharedAtlasFrame& frame);
  void ReplyInput(Json reply, const Json& request, uint64_t stamp);
  static std::string ClientTouchSequence(const Json& request);
  static std::string ClientTouchTerminal(const Json& request);
  remotekit::TouchTerminalReceipt* ReserveTouchTerminal(remotekit::TouchTerminalReceipts& terminals,
                                                        const Event& event,
                                                        const Json& request,
                                                        const std::string& sequence,
                                                        uint64_t input_control);
  void RejectInput(const char* error,
                   const Json& request,
                   const Event& event,
                   remotekit::TouchTerminalReceipts* terminals = nullptr);
  void PollTouchTerminal(remotekit::TouchTerminalReceipt& receipt);
  void FlushTouchTerminals(remotekit::TouchTerminalReceipts& terminals);
  Result<void> RouteData(const Event& event);
  void HandleData(const Event& event, remotekit::TouchTerminalReceipts& terminals);
  void QueueInput(const Event& event);
  void InputLoop();
  void MediaLoop();
  Result<Json> Offer(const Json& request, uint64_t generation);
  int RevokeProduct();
  Result<uint64_t> AuthorizationEpoch(const Json& request);
  Result<void> RequireAuthPeer(const Json& request);
  Result<Json> Authorize(const Json& request,
                         uint64_t generation,
                         const std::function<bool()>& management_current);
  static Json FaceCapabilities();
  Result<Json> FaceCommand(const std::string& method,
                           const Json& request,
                           uint64_t generation,
                           const std::function<bool()>& management_current);
  void ClosePeer();
  Result<void> OpenAudio();
  void RequireFileJob(const FileJob& job);
  Result<Json> DirectFileRpc(const FileJob& job,
                             const char* method,
                             Json additions = Json::object());
  void SweepDirectFiles();
  static uint64_t FileUnsigned(const Json& value);
  Json SelectionBrowserCommand(const FileBinding& binding, const char* method);
  Json SelectionStatusCommand(const LibrarySelection& selection);
  std::string RetireUnsubmittedSelection(const std::string& selection_id);
  std::string ObserveSelection(const LibrarySelection& selection, const Json& status);
  Result<Json> DirectSelectionCommit(const FileJob& job, const std::string& selection_id);
  Result<Json> DirectLibraryCommand(const FileJob& job,
                                    const std::string& method,
                                    const Json& params);
  Result<Json> DirectFileCommand(const FileJob& job);
  Result<FileBinding> ParseFileBinding(const Json& value);
  Result<Json> FileBrowserCommand(const FileBinding& binding, const char* method);
  Result<Json> LibraryCommand(const std::string& method, const Json& request);
  Result<Json> AuthorizeFiles(const Json& request);
  Result<std::string> PrepareViewCommand(const Json& request, const std::string& method);
  Result<Json> ManageSessionEnsure(const Json& request);
  Result<Json> ManageSessionSnapshot(const Json& request);
  Result<Json> ManageSessionEventsAck(const Json& request);
  Result<Json> ManageSessionMediaPolicy(const Json& request);
  Result<Json> ManageSessionSitePreferences(const Json& request);
  Result<Json> ManageRtcActionResult(const Json& request);
  Result<Json> ManageRtcOffer(const Json& request);
  Result<Json> ManageRtcClose(const Json& request);
  Result<Json> ManageRtcIce(const Json& request);
  Result<Json> ManageViewNavigationAck(const Json& request);
  Result<Json> ManageViewEnsure(const Json& request);
  Result<Json> ManageViewClose(const Json& request);
  Result<Json> ManageViewCloseReply(const Json& request);
  Result<Json> ManageViewPageReply(const Json& request);
  Result<Json> ManageViewPageExitFullscreen(const Json& request);
  Result<Json> ManageViewCommand(const Json& request);
  Result<Json> ManageViewLifecycle(const Json& request);
  Result<Json> ManageViewNavigate(const Json& request);
  Result<Json> ManageViewConfigure(const Json& request);
  Result<Json> ManageRtcAuthorize(const Json& request);
  Result<Json> ManageAuthFaceCapabilities(const Json& request);
  Result<Json> ManageSessionFilesAuthorize(const Json& request);
  Result<Json> ManageAuthFaceBegin(const Json& request);
  Result<Json> ManageAuthFaceStatus(const Json& request);
  Result<Json> ManageAuthFaceCancel(const Json& request);
  Result<Json> ManageSessionLibraryDescribe(const Json& request);
  Result<Json> ManageSessionLibraryRetain(const Json& request);
  Result<Json> ManageSessionLibraryPrepare(const Json& request);
  Result<Json> ManageSessionLibrarySelectionStatus(const Json& request);

 public:
  Result<void> Initialize();
  void BeginManagementRequest(uint64_t generation) { request_generation_ = generation; }
  Session(Sdk& api,
          const RuntimeOptions& opts,
          std::string tenant_id,
          std::string session_id,
          ManagementLink& link);
  void MaintainRecovery();
  void FlushSignals();
  Result<void> ManagementLost(uint64_t generation);
  ~Session();
};
}  // namespace remotekit
