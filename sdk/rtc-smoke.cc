#include "remotekit_rtc.h"
#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <sstream>
#include <thread>

namespace {
struct Event {
  uint64_t peer;
  uint32_t type;
  std::string text, mid;
  int32_t value;
};
struct Events {
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<Event> pending;
  unsigned callbacks = 0;
  bool block_stats = false, stats_entered = false, release_stats = false;
};
void OnEvent(void* context, uint64_t peer, uint32_t type, const void* bytes,
             size_t size, const char* mid, int32_t value) {
  auto& q = *static_cast<Events*>(context);
  std::unique_lock lock(q.mutex);
  q.pending.push_back({peer, type,
      size ? std::string(static_cast<const char*>(bytes), size) : std::string(),
      mid ? mid : "", value});
  ++q.callbacks;
  if (type == REMOTEKIT_RTC_STATS && q.block_stats) {
    q.stats_entered = true;
    q.cv.notify_all();
    q.cv.wait(lock, [&] { return q.release_stats; });
  }
  q.cv.notify_all();
}
int Create(void*, uint64_t, uint64_t) { return 0; }
int Configure(void*, uint64_t, const remotekit_rtc_encoder_config*) { return 0; }
int Encode(void*, uint64_t, const remotekit_rtc_frame*, int) { return 0; }
void Rates(void*, uint64_t, uint32_t, uint32_t) {}
void Destroy(void*, uint64_t) {}
void RetainLease(void* context, uint64_t) {
  ++*static_cast<std::atomic<int>*>(context);
}
void ReleaseLease(void* context, uint64_t) {
  --*static_cast<std::atomic<int>*>(context);
}
}  // namespace

int main(int argc, char** argv) {
  const bool cross_thread = argc > 1 && std::strcmp(argv[1], "--cross-thread") == 0;
  const bool loopback = argc > 1 && std::strcmp(argv[1], "--loopback") == 0;
  const bool trickle = argc > 1 && !cross_thread && !loopback;
  Events events;
  remotekit_rtc_options options{};
  options.struct_size = sizeof(options);
  options.abi_version = REMOTEKIT_RTC_ABI_VERSION;
  options.context = &events;
  options.event = OnEvent;
  options.encoder = {sizeof(options.encoder), Create, Configure, Encode,
                     Rates, nullptr, Destroy};
  options.start_bitrate_bps = 24000000;
  options.max_bitrate_bps = 48000000;
  uint64_t a = 0, b = 0, answerer = 0;
  if (remotekit_rtc_create(&options, &a) != REMOTEKIT_SDK_INVALID_STATE || a)
    return 1;
  int initialize_status = REMOTEKIT_SDK_INVALID_STATE;
  if (cross_thread) {
    std::thread initialize([&] { initialize_status = remotekit_sdk_initialize(); });
    initialize.join();
  } else initialize_status = remotekit_sdk_initialize();
  if (initialize_status != REMOTEKIT_SDK_OK) return 2;
  auto old_options = options;
  old_options.abi_version = 1;
  uint64_t old_peer = 123;
  if (remotekit_rtc_create(&old_options, &old_peer) != REMOTEKIT_SDK_INVALID_ARGUMENT || old_peer)
    return 21;
  remotekit_rtc_clock_sample clock{};
  clock.struct_size = sizeof(clock);
  if (remotekit_rtc_sample_clock(&clock) != REMOTEKIT_SDK_OK ||
      clock.qpc_frequency <= 0 || clock.qpc_after < clock.qpc_before || clock.monotonic_us <= 0)
    return 25;
  int status = remotekit_rtc_create(&options, &a);
  if (status != REMOTEKIT_SDK_OK) {
    std::fprintf(stderr, "create A failed %d\n", status); return 3;
  }
  if (remotekit_rtc_set_media_policy(a,36000000,44000000,52)!=REMOTEKIT_SDK_OK ||
      remotekit_rtc_set_media_policy(a,36000000,44000000,52)!=REMOTEKIT_SDK_OK ||
      remotekit_rtc_set_media_policy(a,36000000,44000000,50)!=REMOTEKIT_SDK_OK ||
      remotekit_rtc_set_media_policy(a,36000000,48000000,60)!=REMOTEKIT_SDK_OK ||
      remotekit_rtc_set_media_policy(a,36000000,35000000,52)!=REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_set_media_policy(a,36000000,48000000,0)!=REMOTEKIT_SDK_INVALID_ARGUMENT)
    return 36;
  int16_t audio_pcm[960]{};
  if (remotekit_rtc_submit_audio(a, nullptr, 480, 1, 1, 0, 1, 0) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_submit_audio(a, audio_pcm, 479, 1, 1, 0, 1, 0) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_submit_audio(a, audio_pcm, 480, 1, 0, 0, 1, 0) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_submit_audio(a, audio_pcm, 480, 1, 1, 0, 1, 0) != REMOTEKIT_SDK_INVALID_STATE) return 38;
  if (remotekit_rtc_set_playout_delay(a, -1, -1) != REMOTEKIT_SDK_OK ||
      remotekit_rtc_set_playout_delay(a, -1, 0) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_set_playout_delay(a, 10, 0) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_set_playout_delay(a, 0, 40960) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_set_playout_delay(a, 0, 11) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_rtc_set_playout_delay(a, 0, 40950) != REMOTEKIT_SDK_OK)
    return 29;
  int playout_status = REMOTEKIT_SDK_INVALID_STATE;
  std::thread playout_setter([&] {
    playout_status = remotekit_rtc_set_playout_delay(a, 0, 0);
  });
  playout_setter.join();
  if (playout_status != REMOTEKIT_SDK_OK ||
      remotekit_rtc_set_playout_delay(a, -1, -1) != REMOTEKIT_SDK_INVALID_STATE)
    return 30;
  if (remotekit_rtc_request_stats(a) != REMOTEKIT_SDK_OK) return 31;
  {
    std::unique_lock lock(events.mutex);
    auto requested = [&] { return std::find_if(events.pending.begin(), events.pending.end(),
        [&](const Event& event) { return event.peer == a && event.type == REMOTEKIT_RTC_STATS; }); };
    if (!events.cv.wait_for(lock, std::chrono::seconds(5),
            [&] { return requested() != events.pending.end(); })) return 31;
    const auto it = requested();
    if (it->text.find("\"requestedPlayoutDelay\"") == std::string::npos ||
        it->text.find("\"minMs\":0") == std::string::npos ||
        it->text.find("\"maxMs\":0") == std::string::npos) return 31;
    events.pending.erase(it);
  }
  if (remotekit_rtc_set_playout_delay(a, 20, 100) != REMOTEKIT_SDK_OK) return 30;
  if (remotekit_sdk_shutdown() != REMOTEKIT_SDK_INVALID_STATE) return 4;
  if (remotekit_rtc_create(&options, &b) != REMOTEKIT_SDK_OK || b == a)
    return 5;
  if (remotekit_rtc_create(&options, &answerer) != REMOTEKIT_SDK_OK) return 21;
  Microsoft::WRL::ComPtr<ID3D11Device> device;
  if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
      nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, nullptr))) return 16;
  D3D11_TEXTURE2D_DESC descriptor{};
  descriptor.Width = descriptor.Height = 64;
  descriptor.MipLevels = descriptor.ArraySize = descriptor.SampleDesc.Count = 1;
  descriptor.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  if (FAILED(device->CreateTexture2D(&descriptor, nullptr, &texture))) return 17;
  std::atomic<int> leases{1};
  remotekit_rtc_frame frame{};
  frame.struct_size = sizeof(frame); frame.width = frame.height = 64;
  frame.d3d11_texture = texture.Get(); frame.frame_id = 123;
  LARGE_INTEGER counter{}, frequency{};
  QueryPerformanceCounter(&counter); QueryPerformanceFrequency(&frequency);
  frame.capture_qpc = counter.QuadPart; frame.qpc_frequency = frequency.QuadPart;
  frame.release_context = &leases; frame.retain = RetainLease; frame.release = ReleaseLease;
  if (remotekit_rtc_submit_texture(a, &frame) != REMOTEKIT_SDK_OK) return 18;
  if (remotekit_rtc_open_data_channel(a) != REMOTEKIT_SDK_OK ||
      remotekit_rtc_create_offer(a) != REMOTEKIT_SDK_OK) return 6;

  bool sent = false, received = false, h264 = false, answer_sends_video = false;
  bool tested_recvonly_offer = false;
  bool stats_requested = false, stats_received = false;
  bool remote_a = false, remote_b = false;
  std::deque<Event> ice;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
  while (std::chrono::steady_clock::now() < deadline && (!received || !answer_sends_video || !stats_received)) {
    Event e{};
    {
      std::unique_lock lock(events.mutex);
      if (!events.cv.wait_for(lock, std::chrono::milliseconds(100),
                             [&] { return !events.pending.empty(); })) continue;
      e = std::move(events.pending.front()); events.pending.pop_front();
    }
    uint64_t other = e.peer == a ? b : a;
    if (e.peer == answerer) {
      if (e.type == REMOTEKIT_RTC_SDP_ANSWER) {
        answer_sends_video = e.text.find("a=sendonly") != std::string::npos &&
                            e.text.find("a=msid:remotekit remotekit-atlas") != std::string::npos;
      }
      if (e.type == REMOTEKIT_RTC_ERROR) {
        std::fprintf(stderr, "answerer error: %s\n", e.text.c_str()); return 22;
      }
      continue;
    }
    if (e.type == REMOTEKIT_RTC_ERROR) {
      std::fprintf(stderr, "RTC error: %s\n", e.text.c_str()); return 7;
    }
    if (e.type == REMOTEKIT_RTC_SDP_OFFER || e.type == REMOTEKIT_RTC_SDP_ANSWER ||
        e.type == REMOTEKIT_RTC_ICE_COMPLETE) {
      if (e.type == REMOTEKIT_RTC_SDP_OFFER) {
        h264 = e.text.find("H264/90000") != std::string::npos &&
               e.text.find("profile-level-id=42e034") != std::string::npos &&
               e.text.find("packetization-mode=1") != std::string::npos;
        if (!tested_recvonly_offer) {
          // Unsupported remote senders are rejected without poisoning this
          // peer; it must still accept the following valid recvonly offer.
          if (remotekit_rtc_set_remote_description(answerer, 1,
              e.text.data(), e.text.size()) != REMOTEKIT_SDK_INVALID_ARGUMENT) return 26;
          auto sendrecv = e.text;
          sendrecv.replace(sendrecv.find("a=sendonly"), std::strlen("a=sendonly"), "a=sendrecv");
          if (remotekit_rtc_set_remote_description(answerer, 1,
              sendrecv.data(), sendrecv.size()) != REMOTEKIT_SDK_INVALID_ARGUMENT) return 27;
          auto audio = e.text;
          audio.replace(audio.find("m=video"), std::strlen("m=video"), "m=audio");
          if (remotekit_rtc_set_remote_description(answerer, 1,
              audio.data(), audio.size()) != REMOTEKIT_SDK_INVALID_ARGUMENT) return 28;
          auto recvonly = e.text;
          const auto direction = recvonly.find("a=sendonly");
          if (direction == std::string::npos) return 23;
          recvonly.replace(direction, std::strlen("a=sendonly"), "a=recvonly");
          if (remotekit_rtc_set_remote_description(answerer, 1,
              recvonly.data(), recvonly.size()) != REMOTEKIT_SDK_OK) return 24;
          tested_recvonly_offer = true;
        }
      }
      if (trickle ? e.type == REMOTEKIT_RTC_ICE_COMPLETE :
                    e.type != REMOTEKIT_RTC_ICE_COMPLETE) continue;
      if (!trickle && e.text.find("a=candidate:") == std::string::npos) return 15;
      auto remote_sdp = e.text;
      if (loopback) {
        if (remote_sdp.find(" 127.0.0.1 ") == std::string::npos) return 26;
        std::istringstream lines(remote_sdp);
        std::string filtered, line;
        while (std::getline(lines, line)) {
          if (line.rfind("a=candidate:", 0) == 0 && line.find(" 127.0.0.1 ") == std::string::npos) continue;
          filtered += line + "\n";
        }
        remote_sdp = std::move(filtered);
      }
      // The networking pair exercises DataChannel only; the separate answerer
      // above covers a valid receiver for our sending video track.
      auto sending = remote_sdp.find("a=sendonly");
      if (sending != std::string::npos)
        remote_sdp.replace(sending, std::strlen("a=sendonly"), "a=inactive");
      if (remotekit_rtc_set_remote_description(other,
          e.type == REMOTEKIT_RTC_ICE_COMPLETE ? e.value :
          e.type == REMOTEKIT_RTC_SDP_OFFER, remote_sdp.data(), remote_sdp.size()) !=
          REMOTEKIT_SDK_OK) return 8;
      if (other == a) remote_a = true; else remote_b = true;
    } else if (e.type == REMOTEKIT_RTC_ICE && trickle) ice.push_back(std::move(e));
    else if (e.type == REMOTEKIT_RTC_DATA_STATE && e.peer == a && e.value == 1 && !sent) {
      const unsigned char input[] = {0, 1, 255, 13, 0, 42};
      if (remotekit_rtc_send_data(a, input, sizeof(input), 1) != REMOTEKIT_SDK_OK)
        return 9;
      sent = true;
    } else if (e.type == REMOTEKIT_RTC_DATA && e.peer == b) {
      const unsigned char expected[] = {0, 1, 255, 13, 0, 42};
      received = e.value == 1 && e.text.size() == sizeof(expected) &&
                 std::memcmp(e.text.data(), expected, sizeof(expected)) == 0;
    } else if (e.type == REMOTEKIT_RTC_STATS && e.peer == a) {
      stats_received = e.text.find("\"type\":\"sender-rtc-stats\"") != std::string::npos &&
          e.text.find("\"selectedPair\"") != std::string::npos &&
          e.text.find("\"localCandidate\"") != std::string::npos &&
          e.text.find("\"remoteCandidate\"") != std::string::npos &&
          e.text.find("\"outbound\"") != std::string::npos &&
          (!loopback || e.text.find("127.0.0.1") != std::string::npos);
    }
    if (received && !stats_requested) {
      if (remotekit_rtc_request_stats(a) != REMOTEKIT_SDK_OK) return 22;
      stats_requested = true;
    }
    for (auto it = ice.begin(); it != ice.end();) {
      const auto target = it->peer == a ? b : a;
      if ((target == a && remote_a) || (target == b && remote_b)) {
        if (remotekit_rtc_add_ice(target, it->mid.c_str(), it->value,
                                 it->text.data(), it->text.size()) != REMOTEKIT_SDK_OK)
          return 10;
        it = ice.erase(it);
      } else ++it;
    }
  }
  if (!received || !h264 || !answer_sends_video || !stats_received) {
    std::fprintf(stderr, "timeout or invalid SDP received=%d h264=%d sendonly-answer=%d stats=%d\n",
                 received, h264, answer_sends_video, stats_received);
    return 11;
  }
  // A running stats callback holds the close barrier. This works whether
  // WebRTC delivers a cached report synchronously or collects it asynchronously.
  { std::lock_guard lock(events.mutex); events.block_stats = true; }
  std::atomic<int> stats_status{REMOTEKIT_SDK_INVALID_STATE};
  std::thread request_stats([&] { stats_status = remotekit_rtc_request_stats(a); });
  {
    std::unique_lock lock(events.mutex);
    if (!events.cv.wait_for(lock, std::chrono::seconds(5), [&] { return events.stats_entered; })) {
      events.release_stats = true; events.cv.notify_all();
      lock.unlock(); request_stats.join(); return 23;
    }
  }
  std::atomic<int> close_status{REMOTEKIT_SDK_INVALID_STATE};
  std::thread close_peer([&] { close_status = remotekit_rtc_close(a); });
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  const bool waited = close_status.load() == REMOTEKIT_SDK_INVALID_STATE;
  { std::lock_guard lock(events.mutex); events.block_stats = false; events.release_stats = true; events.cv.notify_all(); }
  request_stats.join(); close_peer.join();
  if (!waited || stats_status != REMOTEKIT_SDK_OK || close_status != REMOTEKIT_SDK_OK) return 24;
  // Also race close against a freshly requested report, before its user event.
  if (remotekit_rtc_request_stats(b) != REMOTEKIT_SDK_OK) return 25;
  if (remotekit_rtc_close(b) != REMOTEKIT_SDK_OK ||
      remotekit_rtc_close(answerer) != REMOTEKIT_SDK_OK ||
      remotekit_rtc_close(a) != REMOTEKIT_SDK_INVALID_STATE ||
      remotekit_rtc_create_offer(a) != REMOTEKIT_SDK_INVALID_STATE ||
      remotekit_rtc_request_stats(a) != REMOTEKIT_SDK_INVALID_STATE ||
      remotekit_rtc_set_playout_delay(a, 0, 0) != REMOTEKIT_SDK_INVALID_STATE) return 12;
  if (leases.load() != 0) return 19;
  remotekit_rtc_encoded_frame late{};
  const unsigned char access_unit[] = {0, 0, 0, 1, 0x65};
  late.struct_size = sizeof(late); late.annex_b = access_unit;
  late.size = sizeof(access_unit); late.width = late.height = 64;
  uint32_t wire_timestamp = 123;
  if (remotekit_rtc_encoded(UINT64_MAX, &late, &wire_timestamp) !=
      REMOTEKIT_SDK_INVALID_STATE || wire_timestamp != 0) return 20;
  unsigned callbacks;
  { std::lock_guard lock(events.mutex); callbacks = events.callbacks; }
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  { std::lock_guard lock(events.mutex); if (events.callbacks != callbacks) return 13; }
  int shutdown_status = REMOTEKIT_SDK_INVALID_STATE;
  if (cross_thread) {
    std::thread shutdown([&] { shutdown_status = remotekit_sdk_shutdown(); });
    shutdown.join();
  } else shutdown_status = remotekit_sdk_shutdown();
  if (shutdown_status != REMOTEKIT_SDK_OK) return 14;
  std::puts("RTC H264 SDP / ICE / DTLS-SCTP DataChannel / close barrier passed");
  return 0;
}
