#include "remotekit/browser/sdk/rtc_internal.h"
using namespace remotekit::rtc;
namespace remotekit::rtc {
// Preserve explicit Chromium trials. Our screenshare default changes only the
// ALR pacing factor; queue time, probing budgets and resource algorithms remain
// upstream. Strict pacing and screenshare trials must remain mutually exclusive.
class RemoteKitFieldTrials final : public webrtc::FieldTrialsView {
 public:
  explicit RemoteKitFieldTrials(std::unique_ptr<webrtc::FieldTrialsView> fallback)
      : fallback_(std::move(fallback)) {}
  std::string Lookup(absl::string_view key) const override {
    if (key == "WebRTC-RemoteKit-ScreenshareAdaptation")
      return "Enabled";
    if (key == "WebRTC-ProbingScreenshareBwe" && fallback_->Lookup(key).empty() &&
        fallback_->Lookup("WebRTC-StrictPacingAndProbing").empty())
      return "1.1,2875,80,40,-60,3";
    return fallback_->Lookup(key);
  }
  std::unique_ptr<webrtc::FieldTrialsView> CreateCopy() const override {
    return std::make_unique<RemoteKitFieldTrials>(fallback_->CreateCopy());
  }

 private:
  std::unique_ptr<webrtc::FieldTrialsView> fallback_;
};

Registry& GetRegistry() {
  static base::NoDestructor<Registry> r;
  return *r;
}
uint64_t NewID() {
  auto& r = GetRegistry();
  std::lock_guard lock(r.mutex);
  return r.next++;
}
bool SetSenderActive(webrtc::RtpSenderInterface* sender, bool active) {
  if (!sender)
    return true;
  auto parameters = sender->GetParameters();
  bool changed = false;
  for (auto& encoding : parameters.encodings) {
    changed |= encoding.active != active;
    encoding.active = active;
  }
  return !changed || sender->SetParameters(parameters).ok();
}
Peer::Peer(uint64_t id, const remotekit_rtc_options& options)
    : id(id),
      options(options),
      trace(std::make_shared<SdkTrace>(id)),
      authorization(std::make_shared<MediaAuthorization>(!options.auth_required)) {}

void Peer::Close() {
  closing.store(true);
  std::lock_guard audio_guard(audio_mutex);
  if (signaling_started)
    signaling->BlockingCall([this] {
      if (auth_data) {
        auth_data->UnregisterObserver();
        auth_data->Close();
        auth_data = nullptr;
      }
      if (data) {
        data->UnregisterObserver();
        data->Close();
        data = nullptr;
      }
      if (pc) {
        pc->Close();
        pc = nullptr;
      }
      source = nullptr;
      audio_source = nullptr;
      audio_sender = nullptr;
      video_sender = nullptr;
      factory = nullptr;
    });
  if (signaling)
    signaling->Stop();
  if (network)
    network->Stop();
  if (winsock_started) {
    WSACleanup();
    winsock_started = false;
  }
  // WebRTC can discard queued native frames after VideoSendStream teardown.
  // Their release callbacks are part of the host-context close barrier too.
  {
    std::unique_lock lock(leases->mutex);
    leases->done.wait(lock, [this] { return leases->active == 0; });
  }
  std::lock_guard lock(event_mutex);  // Wait for an already running callback.
  trace->Save();
}

void Peer::Event(uint32_t type,
                 const void* bytes,
                 size_t size,
                 const char* auxiliary,
                 int32_t value) {
  std::lock_guard lock(event_mutex);
  if (!closing.load())
    options.event(options.context, id, type, bytes, size, auxiliary, value);
}

void Peer::Error(const std::string& text) {
  Event(REMOTEKIT_RTC_ERROR, text.data(), text.size());
}

void Peer::AttachData(scoped_refptr<webrtc::DataChannelInterface> channel) {
  if (channel->label() != "remotekit" || data) {
    channel->Close();
    return;
  }
  data = std::move(channel);
  data->RegisterObserver(this);
  OnStateChange();
}

void Peer::OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) {}

void Peer::OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) {
  if (state == webrtc::PeerConnectionInterface::kIceGatheringComplete && pc &&
      pc->local_description()) {
    const auto* local = pc->local_description();
    auto sdp = local->ToString();
    Event(REMOTEKIT_RTC_ICE_COMPLETE, sdp.data(), sdp.size(), nullptr,
          local->GetType() == webrtc::SdpType::kOffer ? 1 : 0);
  }
}

void Peer::OnIceCandidate(const webrtc::IceCandidate* candidate) {
  auto text = candidate->ToString();
  auto mid = candidate->sdp_mid();
  Event(REMOTEKIT_RTC_ICE, text.data(), text.size(), mid.c_str(), candidate->sdp_mline_index());
}

void Peer::OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState s) {
  Event(REMOTEKIT_RTC_STATE, nullptr, 0, nullptr, static_cast<int32_t>(s));
}

void Peer::OnDataChannel(scoped_refptr<webrtc::DataChannelInterface> channel) {
  if (channel->label() == "remotekit-auth") {
    if (!options.auth_required || auth_data || !channel->ordered() ||
        channel->maxRetransmitsOpt() || channel->maxPacketLifeTime()) {
      channel->Close();
      return;
    }
    auth_data = std::move(channel);
    auth_data->RegisterObserver(&auth_observer);
    auth_observer.OnStateChange();
    return;
  }
  AttachData(std::move(channel));
}

void Peer::OnStateChange() {
  Event(REMOTEKIT_RTC_DATA_STATE, nullptr, 0, nullptr, data->state());
}

void Peer::OnMessage(const webrtc::DataBuffer& message) {
  if (message.data.size() <= kMaxMessage)
    Event(REMOTEKIT_RTC_DATA, message.data.data(), message.data.size(), nullptr,
          message.binary ? 1 : 0);
}
class LocalDescriptionObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  LocalDescriptionObserver(std::weak_ptr<Peer> p, std::string sdp, bool offer)
      : peer_(p), sdp_(std::move(sdp)), offer_(offer) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (auto p = peer_.lock(); p && !p->closing.load()) {
      if (!error.ok())
        p->Error(error.message());
      else {
        if (!offer_ && p->video_sender) {
          const auto parameters = p->video_sender->GetParameters();
          const bool transport_sequence = std::any_of(
              parameters.header_extensions.begin(), parameters.header_extensions.end(),
              [](const webrtc::RtpExtension& extension) {
                return extension.uri == webrtc::RtpExtension::kTransportSequenceNumberUri;
              });
          std::fprintf(stderr,
                       "RTC negotiated video sender: peer=%llu "
                       "transport_sequence_extension=%d\n",
                       p->id, transport_sequence);
        }
        p->Event(offer_ ? REMOTEKIT_RTC_SDP_OFFER : REMOTEKIT_RTC_SDP_ANSWER, sdp_.data(),
                 sdp_.size());
      }
    }
  }

 private:
  std::weak_ptr<Peer> peer_;
  std::string sdp_;
  bool offer_;
};
class CreateDescriptionObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  CreateDescriptionObserver(std::weak_ptr<Peer> p, bool offer) : peer_(p), offer_(offer) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* raw) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> sdp(raw);
    if (auto p = peer_.lock(); p && !p->closing.load()) {
      std::string text = sdp->ToString();
      p->pc->SetLocalDescription(std::move(sdp), webrtc::make_ref_counted<LocalDescriptionObserver>(
                                                     peer_, std::move(text), offer_));
    }
  }
  void OnFailure(webrtc::RTCError error) override {
    if (auto p = peer_.lock())
      p->Error(error.message());
  }

 private:
  std::weak_ptr<Peer> peer_;
  bool offer_;
};
class RemoteDescriptionObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  RemoteDescriptionObserver(std::weak_ptr<Peer> p, bool offer) : peer_(p), offer_(offer) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    if (auto p = peer_.lock(); p && !p->closing.load()) {
      if (!error.ok())
        p->Error(error.message());
      else if (offer_)
        p->Offer(false);
    }
  }

 private:
  std::weak_ptr<Peer> peer_;
  bool offer_;
};

int Peer::Start() {
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0)
    return REMOTEKIT_SDK_INVALID_STATE;
  winsock_started = true;
  network = webrtc::Thread::CreateWithSocketServer();
  signaling = webrtc::Thread::Create();
  if (!network->Start())
    return REMOTEKIT_SDK_INVALID_STATE;
  signaling_started = signaling->Start();
  if (!signaling_started)
    return REMOTEKIT_SDK_INVALID_STATE;
  return signaling->BlockingCall([this] {
    auto default_env = webrtc::CreateEnvironment();
    auto env = webrtc::CreateEnvironment(
        std::make_unique<RemoteKitFieldTrials>(default_env.field_trials().CreateCopy()));
    std::fprintf(stderr,
                 "RTC screenshare pacing configuration: peer=%llu trial=%s "
                 "rfc8888_enabled=%d explicit_screenshare_trial=%d explicit_strict_trial=%d "
                 "(configuration only; actual pacing rate is controller-owned)\n",
                 id, env.field_trials().Lookup("WebRTC-ProbingScreenshareBwe").c_str(),
                 env.field_trials().IsEnabled("WebRTC-RFC8888CongestionControlFeedback"),
                 !default_env.field_trials().Lookup("WebRTC-ProbingScreenshareBwe").empty(),
                 !default_env.field_trials().Lookup("WebRTC-StrictPacingAndProbing").empty());
    webrtc::PeerConnectionFactoryDependencies deps;
    deps.env = env;
    deps.network_thread = network.get();
    deps.socket_factory = network->socketserver();
    deps.signaling_thread = signaling.get();
    deps.adm = MakeAudioDevice();
    deps.audio_encoder_factory = MakeAudioEncoders();
    deps.audio_decoder_factory = MakeAudioDecoders();
    deps.video_encoder_factory =
        MakeVideoEncoders(id, options, remote_limits, playout_delay, trace, authorization);
    deps.video_decoder_factory = MakeVideoDecoders();
    const bool loopback_test =
        base::Environment::Create()->GetVar("REMOTEKIT_RTC_LOOPBACK_TEST").value_or("") == "1";
    webrtc::EnableMedia(deps);
    factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
    if (!factory)
      return REMOTEKIT_SDK_INVALID_STATE;
    if (loopback_test) {
      webrtc::PeerConnectionFactoryInterface::Options factory_options;
      factory_options.network_ignore_mask = 0;
      factory->SetOptions(factory_options);
      std::fprintf(stderr, "RTC explicit loopback candidate experiment enabled: peer=%llu\n", id);
    }
    webrtc::PeerConnectionInterface::RTCConfiguration config;
    config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    if (options.ice_server_url && *options.ice_server_url) {
      webrtc::PeerConnectionInterface::IceServer server;
      server.urls.emplace_back(options.ice_server_url);
      if (options.ice_username)
        server.username = options.ice_username;
      if (options.ice_password)
        server.password = options.ice_password;
      config.servers.push_back(std::move(server));
    }
    auto result =
        factory->CreatePeerConnectionOrError(config, webrtc::PeerConnectionDependencies(this));
    if (!result.ok()) {
      Error(result.error().message());
      return REMOTEKIT_SDK_INVALID_STATE;
    }
    pc = result.MoveValue();
    source = webrtc::make_ref_counted<TextureSource>(leases, [weak = weak_from_this()] {
      if (auto peer = weak.lock())
        peer->Event(REMOTEKIT_RTC_REFRESH_REQUEST);
    });
    auto track = factory->CreateVideoTrack(source, "remotekit-atlas");
    // JSEP only reuses unassociated transceivers created by AddTrack when
    // applying an incoming offer. AddTransceiver here would leave our sender
    // unassociated and create a second recvonly transceiver (inactive answer).
    // Audio uses a different stream id. A shared stream makes the receiver
    // lip-sync video to NetEq's delay, which disables the min=0 playout path.
    auto added = pc->AddTrack(track, {"remotekit-video"});
    if (!added.ok())
      return REMOTEKIT_SDK_INVALID_STATE;
    auto sender = added.MoveValue();
    video_sender = sender;
    for (auto& transceiver : pc->GetTransceivers()) {
      if (transceiver->sender() == sender &&
          !transceiver->SetDirectionWithError(webrtc::RtpTransceiverDirection::kSendOnly).ok())
        return REMOTEKIT_SDK_INVALID_STATE;
    }
    auto parameters = sender->GetParameters();
    for (auto& encoding : parameters.encodings) {
      encoding.active = !options.auth_required;
      encoding.max_framerate = 60.0;
      encoding.num_temporal_layers = 1;
      if (options.max_bitrate_bps)
        encoding.max_bitrate_bps = options.max_bitrate_bps;
    }
    parameters.degradation_preference = webrtc::DegradationPreference::BALANCED;
    if (!sender->SetParameters(parameters).ok())
      return REMOTEKIT_SDK_INVALID_STATE;
    webrtc::BitrateSettings bitrate;
    if (options.min_bitrate_bps)
      bitrate.min_bitrate_bps = options.min_bitrate_bps;
    if (options.start_bitrate_bps)
      bitrate.start_bitrate_bps = options.start_bitrate_bps;
    if (options.max_bitrate_bps)
      bitrate.max_bitrate_bps = options.max_bitrate_bps;
    auto error = pc->SetBitrate(bitrate);
    if (!error.ok())
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    return REMOTEKIT_SDK_OK;
  });
}
void Peer::Offer(bool offer) {
  auto observer = webrtc::make_ref_counted<CreateDescriptionObserver>(weak_from_this(), offer);
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions opts;
  if (offer)
    pc->CreateOffer(observer.get(), opts);
  else
    pc->CreateAnswer(observer.get(), opts);
}
std::shared_ptr<Peer> FindPeer(uint64_t id) {
  auto& r = GetRegistry();
  std::lock_guard lock(r.mutex);
  auto it = r.peers.find(id);
  return it == r.peers.end() ? nullptr : it->second;
}
bool ValidBytes(const void* data, size_t size, size_t max) {
  return data && size && size <= max;
}
}  // namespace remotekit::rtc
int remotekit_rtc_create(const remotekit_rtc_options* options, uint64_t* id) {
  if (id)
    *id = 0;
  if (!id || !options || options->struct_size != sizeof(*options) ||
      options->abi_version != REMOTEKIT_RTC_ABI_VERSION || !options->event ||
      options->auth_required > 1 || options->encoder.struct_size != sizeof(options->encoder) ||
      !options->encoder.create || !options->encoder.configure || !options->encoder.encode ||
      !options->encoder.set_rates || !options->encoder.destroy)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  if (RemoteKitSdkBeginRtc() != REMOTEKIT_SDK_OK)
    return REMOTEKIT_SDK_INVALID_STATE;
  static const bool ssl_initialized = webrtc::InitializeSSL();
  if (!ssl_initialized) {
    RemoteKitSdkEndRtc();
    return REMOTEKIT_SDK_INVALID_STATE;
  }
  auto peer = std::make_shared<Peer>(NewID(), *options);
  int result = peer->Start();
  if (result != REMOTEKIT_SDK_OK) {
    peer->Close();
    RemoteKitSdkEndRtc();
    return result;
  }
  auto& r = GetRegistry();
  std::lock_guard lock(r.mutex);
  r.peers.emplace(peer->id, peer);
  *id = peer->id;
  return REMOTEKIT_SDK_OK;
}
int remotekit_rtc_close(uint64_t id) {
  std::shared_ptr<Peer> p;
  auto& r = GetRegistry();
  {
    std::lock_guard lock(r.mutex);
    auto it = r.peers.find(id);
    if (it == r.peers.end())
      return REMOTEKIT_SDK_INVALID_STATE;
    p = std::move(it->second);
    r.peers.erase(it);
  }
  std::lock_guard lock(p->api_mutex);
  p->Close();
  RemoteKitSdkEndRtc();
  return REMOTEKIT_SDK_OK;
}
int remotekit_rtc_create_offer(uint64_t id) {
  return WithPeer(id, [](Peer& p) {
    p.Offer(true);
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_set_media_authorized(uint64_t id, int authorized) {
  if (authorized != 0 && authorized != 1)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  auto peer = FindPeer(id);
  if (!peer)
    return REMOTEKIT_SDK_INVALID_STATE;
  std::lock_guard api_lock(peer->api_mutex);
  std::lock_guard audio_lock(peer->audio_mutex);
  if (peer->closing.load())
    return REMOTEKIT_SDK_INVALID_STATE;
  auto& gate = *peer->authorization;
  auto epoch = gate.epoch.load();
  if (!authorized && (epoch & 1)) {
    std::lock_guard lock(gate.completion_mutex);
    gate.epoch.store(++epoch);
  }
  const bool applied = peer->signaling->BlockingCall([&] {
    const bool video = SetSenderActive(peer->video_sender.get(), authorized != 0);
    // Stopping the audio sender drains ChannelSend's encoder queue and resets
    // the encoder so a queued PCM block cannot reappear after authorization.
    const bool audio = SetSenderActive(peer->audio_sender.get(), authorized != 0);
    if (authorized && (!video || !audio)) {
      SetSenderActive(peer->video_sender.get(), false);
      SetSenderActive(peer->audio_sender.get(), false);
    }
    return video && audio;
  });
  if (!applied)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (authorized && !(epoch & 1)) {
    std::lock_guard lock(gate.completion_mutex);
    gate.epoch.store(epoch + 1);
  }
  return REMOTEKIT_SDK_OK;
}

int remotekit_rtc_set_remote_description(uint64_t id, int offer, const char* bytes, size_t size) {
  if (!ValidBytes(bytes, size) || (offer != 0 && offer != 1))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    webrtc::SdpParseError error;
    auto sdp =
        webrtc::CreateSessionDescription(offer ? webrtc::SdpType::kOffer : webrtc::SdpType::kAnswer,
                                         std::string(bytes, size), &error);
    if (!sdp) {
      p.Error(error.description);
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    }
    bool receives_audio = false;
    using Direction = webrtc::RtpTransceiverDirection;
    // No receiving RTP media is supported. Validate all sections first.
    for (const auto& section : sdp->description()->contents()) {
      if (section.rejected)
        continue;
      const auto* media = section.media_description();
      if ((media->as_audio() || media->as_video()) && (media->direction() == Direction::kSendOnly ||
                                                       media->direction() == Direction::kSendRecv))
        return REMOTEKIT_SDK_INVALID_ARGUMENT;
      if (const auto* audio = media->as_audio();
          audio && media->direction() == webrtc::RtpTransceiverDirection::kRecvOnly) {
        bool stereo_opus = false;
        for (const auto& codec : audio->codecs()) {
          const auto stereo = codec.params.find("stereo");
          if (codec.name == "opus" && codec.clockrate == 48000 && codec.channels == 2 &&
              stereo != codec.params.end() && stereo->second == "1")
            stereo_opus = true;
        }
        if (!stereo_opus)
          return REMOTEKIT_SDK_INVALID_ARGUMENT;
        receives_audio = true;
      }
    }
    if (receives_audio && !p.audio_source) {
      p.audio_source = webrtc::make_ref_counted<PageAudioSource>();
      auto audio_track = p.factory->CreateAudioTrack("remotekit-audio", p.audio_source.get());
      auto added = p.pc->AddTrack(audio_track, {"remotekit-audio"});
      if (!added.ok())
        return REMOTEKIT_SDK_INVALID_STATE;
      p.audio_sender = added.value();
      for (auto& transceiver : p.pc->GetTransceivers())
        if (transceiver->sender() == added.value() &&
            !transceiver->SetDirectionWithError(webrtc::RtpTransceiverDirection::kSendOnly).ok())
          return REMOTEKIT_SDK_INVALID_STATE;
      if (!(p.authorization->epoch.load() & 1) && !SetSenderActive(p.audio_sender.get(), false))
        return REMOTEKIT_SDK_INVALID_STATE;
    }
    // Level asymmetry lets our answer advertise a different receive level;
    // it does not increase the remote receiver's declared capability. Read the
    // parsed remote receiving video sections rather than trusting local fmtp.
    uint32_t remote_level = 0;
    for (const auto& section : sdp->description()->contents()) {
      const auto* media = section.media_description();
      if (section.rejected || !media->as_video() ||
          (media->direction() != webrtc::RtpTransceiverDirection::kRecvOnly &&
           media->direction() != webrtc::RtpTransceiverDirection::kSendRecv))
        continue;
      for (const auto& codec : media->codecs()) {
        if (codec.name != "H264")
          continue;
        auto mode = codec.params.find("packetization-mode");
        auto profile = webrtc::ParseSdpForH264ProfileLevelId(codec.params);
        if (mode == codec.params.end() || mode->second != "1" || !profile ||
            profile->profile != webrtc::H264Profile::kProfileConstrainedBaseline)
          continue;
        const uint32_t level = static_cast<uint32_t>(profile->level);
        remote_level = remote_level ? std::min(remote_level, level) : level;
      }
    }
    p.remote_limits->h264_level.store(remote_level);
    std::fprintf(stderr, "RTC remote H264 receive level: peer=%llu level=%u\n", p.id, remote_level);
    p.pc->SetRemoteDescription(std::move(sdp), webrtc::make_ref_counted<RemoteDescriptionObserver>(
                                                   p.weak_from_this(), offer != 0));
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_add_ice(uint64_t id,
                          const char* mid,
                          int32_t mline,
                          const char* bytes,
                          size_t size) {
  if (!mid || mline < 0 || !ValidBytes(bytes, size))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    webrtc::SdpParseError error;
    auto candidate = webrtc::IceCandidate::Create(mid, mline, std::string(bytes, size), &error);
    if (!candidate)
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    return p.pc->AddIceCandidate(candidate.get()) ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_INVALID_STATE;
  });
}

int remotekit_rtc_open_data_channel(uint64_t id) {
  return WithPeer(id, [](Peer& p) {
    if (p.data)
      return REMOTEKIT_SDK_INVALID_STATE;
    webrtc::DataChannelInit init;
    auto result = p.pc->CreateDataChannelOrError("remotekit", &init);
    if (!result.ok())
      return REMOTEKIT_SDK_INVALID_STATE;
    p.AttachData(result.MoveValue());
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_send_data(uint64_t id, const void* data, size_t size, int binary) {
  if (!ValidBytes(data, size))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  auto peer = FindPeer(id);
  if (!peer)
    return REMOTEKIT_SDK_INVALID_STATE;
  const auto authorization = peer->authorization->epoch.load();
  return WithPeer(id, [&](Peer& p) {
    if (!(authorization & 1) || p.authorization->epoch.load() != authorization || !p.data ||
        p.data->state() != webrtc::DataChannelInterface::kOpen)
      return REMOTEKIT_SDK_INVALID_STATE;
    if (p.data->buffered_amount() + size > kMaxMessage)
      return REMOTEKIT_SDK_BUSY;
    webrtc::DataBuffer buffer(webrtc::CopyOnWriteBuffer(static_cast<const uint8_t*>(data), size),
                              binary != 0);
    return p.data->Send(buffer) ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_BUSY;
  });
}
int remotekit_rtc_send_auth_data(uint64_t id, const void* data, size_t size, int binary) {
  if (!ValidBytes(data, size, kMaxAuthMessage))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    if (!p.auth_data || p.auth_data->state() != webrtc::DataChannelInterface::kOpen)
      return REMOTEKIT_SDK_INVALID_STATE;
    if (p.auth_data->buffered_amount() + size > kMaxAuthMessage)
      return REMOTEKIT_SDK_BUSY;
    webrtc::DataBuffer buffer(webrtc::CopyOnWriteBuffer(static_cast<const uint8_t*>(data), size),
                              binary != 0);
    return p.auth_data->Send(buffer) ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_BUSY;
  });
}

int remotekit_rtc_sample_clock(remotekit_rtc_clock_sample* sample) {
  if (!sample || sample->struct_size != sizeof(*sample))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  if (RemoteKitSdkBeginRtc() != REMOTEKIT_SDK_OK)
    return REMOTEKIT_SDK_INVALID_STATE;
  remotekit_rtc_clock_sample result{};
  result.struct_size = sizeof(result);
  result.consistent_across_processes = base::TimeTicks::IsConsistentAcrossProcesses();
  result.high_resolution = base::TimeTicks::IsHighResolution();
  LARGE_INTEGER before{}, after{}, frequency{};
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&before);
  result.monotonic_us = base::TimeTicks::Now().since_origin().InMicroseconds();
  QueryPerformanceCounter(&after);
  result.qpc_before = before.QuadPart;
  result.qpc_after = after.QuadPart;
  result.qpc_frequency = frequency.QuadPart;
  *sample = result;
  RemoteKitSdkEndRtc();
  return REMOTEKIT_SDK_OK;
}
