#pragma once
#include "remotekit/shared_audio.h"
#include <stdexcept>
#include <string>
namespace remotekit::media {
class AudioRing {
 public:
  ~AudioRing() { Close(); }
  void Open(const std::string& name, uint64_t generation, uint64_t session) {
    Close();
    handle_ = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                               0, sizeof(SharedAudio), name.c_str());
    const auto error = GetLastError();
    if (!handle_ || error == ERROR_ALREADY_EXISTS) { Close(); throw std::runtime_error("audio mapping creation failed"); }
    ring_ = static_cast<SharedAudio*>(MapViewOfFile(handle_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedAudio)));
    if (!ring_) { Close(); throw std::runtime_error("audio mapping view failed"); }
    std::memset(ring_, 0, sizeof(*ring_));
    ring_->magic = kAudioMagic; ring_->version = 1; ring_->size = sizeof(SharedAudio);
    ring_->sample_rate = 48000; ring_->generation = generation; ring_->session_id = session;
    LARGE_INTEGER frequency; QueryPerformanceFrequency(&frequency); ring_->qpc_frequency = frequency.QuadPart;
    next_ = 1;
  }
  void Close() {
    if (ring_) UnmapViewOfFile(ring_); ring_ = nullptr;
    if (handle_) CloseHandle(handle_); handle_ = nullptr;
  }
  bool IsOpen() const { return ring_ != nullptr; }
  bool Poll(AudioPacket& packet, uint64_t& gaps) {
    if (!ring_) return false;
    const auto latest = AudioPublished(ring_);
    if (latest < next_) return false;
    // Real-time audio must not replay an 80ms backlog after a stall. Deliver
    // the newest completed block, count skipped blocks, then resume normally.
    if (latest > next_ + 1) { gaps += latest - next_; next_ = latest; }
    if (!ReadAudio(ring_, next_, packet)) return false;
    ++next_; return true;
  }
 private:
  HANDLE handle_ = nullptr;
  SharedAudio* ring_ = nullptr;
  uint64_t next_ = 1;
};
}
