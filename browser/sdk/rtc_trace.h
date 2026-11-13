// Included inside the SDK implementation namespace. No public ABI additions.
class SdkTrace {
 public:
  explicit SdkTrace(uint64_t peer) : peer_(peer) {
    auto directory = base::Environment::Create()->GetVar("REMOTEKIT_SERVER_TRACE");
    if (!directory || directory->empty())
      return;
    directory_ = base::FilePath::FromUTF8Unsafe(*directory);
    LARGE_INTEGER frequency{}, before{}, after{};
    if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&before))
      return;
    frequency_ = frequency.QuadPart;
    monotonic_us_ = base::TimeTicks::Now().since_origin().InMicroseconds();
    webrtc_us_ = webrtc::TimeMicros();
    QueryPerformanceCounter(&after);
    before_ = before.QuadPart;
    after_ = after.QuadPart;
    events_.reserve(64000);
    enabled_ = true;
  }
  void Add(const char* name,
           uint64_t encoder = 0,
           const remotekit_rtc_frame* frame = nullptr,
           uint32_t rtp = 0,
           uint32_t wire_rtp = 0,
           int status = 0,
           int64_t media_us = 0,
           int64_t capture_us = 0) {
    if (!enabled_)
      return;
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    Event event{name,
                now.QuadPart,
                encoder,
                frame ? frame->frame_id : 0,
                frame ? frame->capture_qpc : 0,
                frame ? frame->capture_time_us : capture_us,
                media_us,
                frame ? frame->layout_epoch : 0,
                rtp,
                wire_rtp,
                status};
    std::lock_guard lock(mutex_);
    if (!closed_) {
      if (events_.size() < 64000)
        events_.push_back(event);
      else
        full_ = true;
    }
  }
  void Save() {
    if (!enabled_)
      return;
    std::vector<Event> events;
    bool full = false;
    {
      std::lock_guard lock(mutex_);
      if (closed_)
        return;
      closed_ = true;
      full = full_;
      events.swap(events_);
    }
    std::string bytes;
    auto append = [&](base::DictValue value) {
      if (auto json = base::WriteJson(value)) {
        bytes += *json;
        bytes += '\n';
      }
    };
    append(base::DictValue()
               .Set("event", "clock")
               .Set("schema", "remotekit-media-trace-v1")
               .Set("scope", "sdk")
               .Set("pid", static_cast<int>(base::GetCurrentProcId()))
               .Set("peer", std::to_string(peer_))
               .Set("qpc_frequency", std::to_string(frequency_))
               .Set("qpc_before", std::to_string(before_))
               .Set("qpc_after", std::to_string(after_))
               .Set("monotonic_us", static_cast<double>(monotonic_us_))
               .Set("webrtc_us", static_cast<double>(webrtc_us_))
               .Set("consistent_across_processes", base::TimeTicks::IsConsistentAcrossProcesses())
               .Set("trace_full", full));
    for (const auto& e : events) {
      append(base::DictValue()
                 .Set("event", e.name)
                 .Set("qpc", std::to_string(e.qpc))
                 .Set("peer", std::to_string(peer_))
                 .Set("encoder", std::to_string(e.encoder))
                 .Set("frame_id", std::to_string(e.frame_id))
                 .Set("capture_qpc", std::to_string(e.capture_qpc))
                 .Set("capture_time_us", static_cast<double>(e.capture_us))
                 .Set("media_timestamp_us", static_cast<double>(e.media_us))
                 .Set("layout_epoch", std::to_string(e.layout_epoch))
                 .Set("rtp_timestamp", static_cast<double>(e.rtp))
                 .Set("wire_rtp_timestamp", static_cast<double>(e.wire_rtp))
                 .Set("status", e.status));
    }
    if (!base::CreateDirectory(directory_)) {
      LOG(ERROR) << "Cannot create RTC trace directory " << directory_;
      return;
    }
    if (!base::WriteFile(directory_.AppendASCII("sdk-" + std::to_string(base::GetCurrentProcId()) +
                                                "-peer-" + std::to_string(peer_) + ".jsonl"),
                         bytes))
      LOG(ERROR) << "Cannot write RTC trace for peer " << peer_ << " in " << directory_;
  }

 private:
  struct Event {
    const char* name;
    int64_t qpc;
    uint64_t encoder, frame_id;
    int64_t capture_qpc, capture_us, media_us;
    uint64_t layout_epoch;
    uint32_t rtp, wire_rtp;
    int status;
  };
  uint64_t peer_;
  bool enabled_ = false, closed_ = false, full_ = false;
  int64_t frequency_ = 0, before_ = 0, after_ = 0, monotonic_us_ = 0, webrtc_us_ = 0;
  base::FilePath directory_;
  std::mutex mutex_;
  std::vector<Event> events_;
};
