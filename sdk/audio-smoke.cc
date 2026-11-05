// Signaling/ABI/timeline checks only: no GPU texture, OS audio, device or peer
// playback is created. Actual RTP reception and AV remain runtime QA.
#include "remotekit_rtc.h"
#include <windows.h>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <atomic>
#include <thread>
namespace {
struct Events {
  std::mutex mutex;
  std::condition_variable wake;
  std::string offer, answer, stats, error;
};
void Event(void* context,
           uint64_t,
           uint32_t type,
           const void* bytes,
           size_t size,
           const char*,
           int32_t) {
  auto& events = *static_cast<Events*>(context);
  std::lock_guard lock(events.mutex);
  const std::string value =
      size ? std::string(static_cast<const char*>(bytes), size) : std::string();
  if (type == REMOTEKIT_RTC_SDP_OFFER)
    events.offer = value;
  if (type == REMOTEKIT_RTC_SDP_ANSWER)
    events.answer = value;
  if (type == REMOTEKIT_RTC_STATS)
    events.stats = value;
  if (type == REMOTEKIT_RTC_ERROR)
    events.error = value;
  events.wake.notify_all();
}
int Create(void*, uint64_t, uint64_t) {
  return 0;
}
int Configure(void*, uint64_t, const remotekit_rtc_encoder_config*) {
  return 0;
}
int Encode(void*, uint64_t, const remotekit_rtc_frame*, int) {
  return 0;
}
void Rates(void*, uint64_t, uint32_t, uint32_t) {}
void Destroy(void*, uint64_t) {}
void Require(bool value, int line) {
  if (!value)
    throw std::runtime_error("audio SDK assertion line " + std::to_string(line));
}
#define Require(value) Require((value), __LINE__)
bool Wait(Events& events, const std::string& value) {
  std::unique_lock lock(events.mutex);
  return events.wake.wait_for(lock, std::chrono::seconds(5), [&] {
    return !value.empty() || !events.error.empty();
  }) && events.error.empty();
}
std::string AudioOffer(std::string offer) {
  const auto bundle = offer.find("a=group:BUNDLE ");
  Require(bundle != std::string::npos);
  offer.insert(offer.find("\r\n", bundle), " audio");
  for (size_t pos = 0; (pos = offer.find("a=sendonly", pos)) != std::string::npos; pos += 10)
    offer.replace(pos, 10, "a=recvonly");
  std::string transport;
  std::istringstream lines(offer);
  std::string line;
  while (std::getline(lines, line)) {
    if (!line.empty() && line.back() == '\r')
      line.pop_back();
    if (line.starts_with("a=ice-ufrag:") || line.starts_with("a=ice-pwd:") ||
        line.starts_with("a=fingerprint:") || line.starts_with("a=setup:"))
      transport += line + "\r\n";
  }
  return offer + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n" + transport +
         "a=mid:audio\r\na=recvonly\r\na=rtcp-mux\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 "
         "stereo=1;sprop-stereo=1;minptime=10;useinbandfec=1\r\n";
}

std::string MediaSection(const std::string& sdp, const std::string& media) {
  const auto start = sdp.find("m=" + media + " ");
  Require(start != std::string::npos);
  const auto end = sdp.find("\r\nm=", start);
  return sdp.substr(start, end == std::string::npos ? end : end - start);
}

std::string TimelineStats(uint64_t peer, Events& events) {
  {
    std::lock_guard lock(events.mutex);
    events.stats.clear();
  }
  Require(remotekit_rtc_request_stats(peer) == 0);
  Require(Wait(events, events.stats));
  std::lock_guard lock(events.mutex);
  const auto start = events.stats.find("\"audioTimeline\":{");
  Require(start != std::string::npos);
  const auto end = events.stats.find('}', start);
  Require(end != std::string::npos);
  return events.stats.substr(start, end - start + 1);
}
}  // namespace
int main() try {
  Require(remotekit_sdk_initialize() == 0);
  for (int synced : {0, 1}) {
    Events events;
    remotekit_rtc_options options{};
    options.struct_size = sizeof(options);
    options.abi_version = REMOTEKIT_RTC_ABI_VERSION;
    options.context = &events;
    options.event = Event;
    options.encoder = {sizeof(options.encoder), Create, Configure, Encode, Rates, nullptr, Destroy};
    uint64_t source = 0, sender = 0;
    Require(remotekit_rtc_create(&options, &source) == 0);
    Require(remotekit_rtc_create(&options, &sender) == 0);
    for (int invalid : {-1, 2}) {
      Require(remotekit_rtc_set_av_sync(sender, invalid) == REMOTEKIT_SDK_INVALID_ARGUMENT);
      Require(remotekit_rtc_set_audio_enabled(sender, invalid) == REMOTEKIT_SDK_INVALID_ARGUMENT);
    }
    Require(remotekit_rtc_set_av_sync(UINT64_MAX, 0) == REMOTEKIT_SDK_INVALID_STATE);
    Require(remotekit_rtc_set_audio_enabled(UINT64_MAX, 0) == REMOTEKIT_SDK_INVALID_STATE);
    Require(remotekit_rtc_set_av_sync(sender, synced) == REMOTEKIT_SDK_OK);
    Require(remotekit_rtc_create_offer(source) == 0);
    Require(Wait(events, events.offer));
    const auto offer = AudioOffer(events.offer);
    auto sending_offer = offer;
    const auto audio_direction = sending_offer.rfind("a=recvonly");
    Require(audio_direction != std::string::npos);
    sending_offer.replace(audio_direction, 10, "a=sendonly");
    Require(remotekit_rtc_set_remote_description(sender, 1, sending_offer.data(),
                                                 sending_offer.size()) ==
            REMOTEKIT_SDK_INVALID_ARGUMENT);
    auto mono_offer = offer;
    mono_offer.replace(mono_offer.find("stereo=1"), 8, "stereo=0");
    Require(remotekit_rtc_set_remote_description(sender, 1, mono_offer.data(), mono_offer.size()) ==
            REMOTEKIT_SDK_INVALID_ARGUMENT);
    Require(remotekit_rtc_set_remote_description(sender, 1, offer.data(), offer.size()) == 0);
    Require(remotekit_rtc_set_av_sync(sender, synced) == REMOTEKIT_SDK_INVALID_STATE);
    Require(Wait(events, events.answer));
    std::string answer;
    {
      std::lock_guard lock(events.mutex);
      answer = events.answer;
    }
    const auto audio = MediaSection(answer, "audio");
    Require(audio.find(std::string("a=msid:") + (synced ? "remotekit-video" : "remotekit-audio") +
                       " remotekit-audio\r\n") != std::string::npos);
    if (offer.find("m=video ") != std::string::npos)
      Require(MediaSection(answer, "video").find("a=msid:remotekit-video remotekit-atlas\r\n") !=
              std::string::npos);
    Require(audio.find("a=sendonly") != std::string::npos &&
            audio.find("opus/48000/2") != std::string::npos &&
            audio.find("stereo=1") != std::string::npos);
    LARGE_INTEGER now, freq;
    QueryPerformanceCounter(&now);
    QueryPerformanceFrequency(&freq);
    const auto origin = now.QuadPart - freq.QuadPart / 5;
    int16_t pcm[960]{};
    Require(remotekit_rtc_submit_audio(sender, pcm, 480, 1, 1, 0, origin, 1) == 0);
    Require(remotekit_rtc_submit_audio(sender, pcm, 480, 1, 2, 480 * 3,
                                       origin + freq.QuadPart * 3 / 100, 1) == 0);
    Require(remotekit_rtc_submit_audio(sender, pcm, 480, 1, 3, 480 * 20, origin + freq.QuadPart / 5,
                                       1) == 0);
    Require(remotekit_rtc_submit_audio(sender, pcm, 480, 1, 4, 480, now.QuadPart, 1) ==
            REMOTEKIT_SDK_INVALID_ARGUMENT);
    Require(remotekit_rtc_submit_audio(sender, pcm, 480, 2, 1, 0, origin + freq.QuadPart * 21 / 100,
                                       1) == 0);
    const auto active = TimelineStats(sender, events);
    Require(active.find("\"silenceBlocks\":2") != std::string::npos &&
            active.find("\"gapRestarts\":1") != std::string::npos &&
            active.find("\"epochRestarts\":1") != std::string::npos);
    Require(remotekit_rtc_set_audio_enabled(sender, 0) == REMOTEKIT_SDK_OK);
    for (uint64_t sequence = 1; sequence <= 3; ++sequence) {
      Require(remotekit_rtc_submit_audio(sender, pcm, 480, 3, sequence, (sequence - 1) * 480,
                                         origin + freq.QuadPart * (21 + sequence) / 100,
                                         1) == REMOTEKIT_SDK_OK);
      Require(TimelineStats(sender, events) == active);
    }
    Require(remotekit_rtc_set_audio_enabled(sender, 1) == REMOTEKIT_SDK_OK);
    Require(remotekit_rtc_submit_audio(sender, pcm, 480, 3, 4, 1440,
                                       origin + freq.QuadPart * 25 / 100, 1) == REMOTEKIT_SDK_OK);
    const auto resumed = TimelineStats(sender, events);
    Require(resumed.find("\"silenceBlocks\":2") != std::string::npos &&
            resumed.find("\"gapRestarts\":1") != std::string::npos &&
            resumed.find("\"epochRestarts\":2") != std::string::npos);
    std::atomic<int> submit_status{REMOTEKIT_SDK_BUSY};
    std::thread submit([&] {
      submit_status = remotekit_rtc_submit_audio(sender, pcm, 480, 4, 1, 0,
                                                 origin + freq.QuadPart * 26 / 100, 1);
    });
    const int close_status = remotekit_rtc_close(sender);
    submit.join();
    Require(close_status == 0 &&
            (submit_status == 0 || submit_status == REMOTEKIT_SDK_INVALID_STATE));
    Require(remotekit_rtc_close(source) == 0);
  }
  Require(remotekit_sdk_shutdown() == 0);
  std::cout << "audio SDP/ABI/timeline smoke passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
