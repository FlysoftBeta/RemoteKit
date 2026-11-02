#pragma once
#include <algorithm>
#include <mutex>
#include <vector>
#include "third_party/webrtc/api/notifier.h"
#include "third_party/webrtc/api/media_stream_interface.h"
// A page-output source. Never uses the ADM's microphone/processing path.
class PageAudioSource : public webrtc::Notifier<webrtc::AudioSourceInterface> {
 public:
  SourceState state() const override { return kLive; }
  bool remote() const override { return false; }
  const webrtc::AudioOptions options() const override {
    webrtc::AudioOptions result;
    result.echo_cancellation = false; result.auto_gain_control = false;
    result.noise_suppression = false; result.highpass_filter = false;
    result.stereo_swapping = false; result.init_recording_on_send = false;
    return result;
  }
  void AddSink(webrtc::AudioTrackSinkInterface* sink) override {
    std::lock_guard lock(mutex_);
    if (std::find(sinks_.begin(), sinks_.end(), sink) == sinks_.end()) sinks_.push_back(sink);
  }
  void RemoveSink(webrtc::AudioTrackSinkInterface* sink) override {
    std::lock_guard lock(mutex_); std::erase(sinks_, sink);
  }
  void Submit(const int16_t* pcm, int64_t time_ms) {
    std::lock_guard lock(mutex_);
    for (auto* sink : sinks_) sink->OnData(pcm, 16, 48000, 2, 480, time_ms);
  }
 private:
  std::mutex mutex_;
  std::vector<webrtc::AudioTrackSinkInterface*> sinks_;
};
