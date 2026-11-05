#include "session/session.hpp"
namespace remotekit {
void Session::EventCallback(void* context,
                            uint64_t peer,
                            uint32_t type,
                            const void* bytes,
                            size_t size,
                            const char* auxiliary,
                            int32_t value) {
  auto* self = static_cast<Session*>(context);
  try {
    const auto rtc_received = type == REMOTEKIT_RTC_DATA && self->trace ? QpcNow() : 0;
    if (type == REMOTEKIT_RTC_AUTH_DATA_STATE) {
      self->raw_camera.State(peer, value == 1);
      self->WakeCamera();
      return;
    }
    if (type == REMOTEKIT_RTC_AUTH_DATA) {
      {
        self->raw_camera.Receive(
            peer, value == 1, bytes, size, CameraNow(),
            [&](uint64_t epoch, std::string_view challenge) {
              return self->FacePending(epoch, challenge);
            },
            [&](int width, int height, const uint8_t* rgb, int stride) {
              self->faces.SubmitRGB24(width, height, rgb, stride);
            });
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
    event.management_generation = self->peer_management_generation.load();
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
      {
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
      if (!self->signal_overflow) {
        if (self->signal_events.size() < 256)
          self->signal_events.push_back(event);
        else {
          self->signal_events.clear();
          self->signal_overflow = true;
          self->signal_events.push_back(
              Event{REMOTEKIT_RTC_ERROR, "RTC signaling queue exceeded bound", "", 0, peer});
          self->signal_events.back().management_generation = event.management_generation;
        }
      }
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
  } catch (const Json::exception& error) {
    fprintf(stderr, "data router invalid request: %s\n", error.what());
    self->Send({{"type", "error"},
                {"error", {{"code", "invalid_request"}, {"message", "invalid DataChannel JSON"}}}});
  } catch (const std::exception& error) {
    fprintf(stderr, "data router internal: %s\n", error.what());
  } catch (...) {
    fprintf(stderr, "data router internal: unknown exception\n");
  }
}

int Session::CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder) {
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

int Session::ConfigureEncoder(void* context,
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

int Session::Encode(void* context, uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
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

void Session::Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
  auto* self = static_cast<Session*>(context);
  self->comp_bitrate = bitrate;
  self->comp_fps = fps;
  self->event_wake.notify_one();
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Rates(bitrate, fps);
}

void Session::Keyframe(void* context, uint64_t encoder) {
  auto* self = static_cast<Session*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Keyframe();
}

void Session::DestroyEncoder(void* context, uint64_t encoder) {
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
}  // namespace remotekit
