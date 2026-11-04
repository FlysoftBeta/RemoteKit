#include "remotekit/raw_camera.hpp"

#include <algorithm>
#include <limits>
#include <json.hpp>

namespace rk::auth {
namespace {
using Json = nlohmann::json;
constexpr size_t kHeader = 68, kChunk = 16384;
constexpr int64_t kInterval = 200, kCaptureTimeout = 1000;

uint64_t LittleEndian(const uint8_t* bytes, size_t count) {
  uint64_t value = 0;
  for (size_t i = 0; i < count; ++i) value |= uint64_t(bytes[i]) << (i * 8);
  return value;
}

uint64_t Unsigned(const Json& value, const char* field) {
  const auto found = value.find(field);
  return found != value.end() && found->is_number_unsigned() ? found->get<uint64_t>() : 0;
}
}  // namespace

bool CameraChallengeId(std::string_view id) {
  if (id.size() != 36) return false;
  for (size_t i = 0; i < id.size(); ++i) {
    const char c = id[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
    } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

void RawCamera::ResetCapture() {
  capture_ = 0;
  capture_deadline_ = 0;
  // Keep at most one reusable assembly allocation while the format is active.
  rgb_.clear();
}

void RawCamera::ResetFormat() {
  ResetCapture();
  std::vector<uint8_t>().swap(rgb_);
  ++revision_;
  width_ = height_ = 0;
  config_pending_ = config_sent_ = accepted_ = false;
}

void RawCamera::ResetChallenge() {
  ResetFormat();
  epoch_ = 0;
  deadline_ = 0;
  challenge_.clear();
}

void RawCamera::Bind(uint64_t peer) {
  std::lock_guard lock(mutex_);
  ResetChallenge();
  peer_ = peer;
  open_ = false;
  serial_ = 0;
  next_grant_ = 0;
}

void RawCamera::State(uint64_t peer, bool open) {
  std::lock_guard lock(mutex_);
  if (!peer || peer != peer_) return;
  if (open_ && !open) ResetFormat();
  open_ = open;
}

void RawCamera::Begin(uint64_t peer, uint64_t epoch, std::string challenge, int64_t deadline) {
  std::lock_guard lock(mutex_);
  ResetChallenge();
  if (!peer || peer != peer_ || !epoch || !CameraChallengeId(challenge)) return;
  epoch_ = epoch;
  challenge_ = std::move(challenge);
  deadline_ = deadline;
}

void RawCamera::Cancel() {
  std::lock_guard lock(mutex_);
  ResetChallenge();
}

void RawCamera::Cancel(uint64_t epoch, std::string_view challenge) {
  std::lock_guard lock(mutex_);
  if (epoch == epoch_ && challenge == challenge_) ResetChallenge();
}

bool RawCamera::Active() {
  std::lock_guard lock(mutex_);
  return epoch_ != 0;
}

bool RawCamera::Current(int64_t now, const Pending& pending) {
  if (!epoch_) return false;
  if (now >= deadline_ || !pending(epoch_, challenge_)) {
    ResetChallenge();
    return false;
  }
  if (capture_ && now >= capture_deadline_) ResetCapture();
  return open_;
}

void RawCamera::Receive(uint64_t peer, bool binary, const void* bytes, size_t size, int64_t now,
                        const Pending& pending, const Submit& submit) {
  if (!bytes || !size || (binary ? size > kHeader + kChunk : size > 512)) return;
  std::lock_guard lock(mutex_);
  if (!peer || peer != peer_ || !Current(now, pending)) return;
  const auto* data = static_cast<const uint8_t*>(bytes);
  if (!binary) {
    const auto message = Json::parse(data, data + size, nullptr, false);
    if (!message.is_object() || Unsigned(message, "version") != 1 ||
        Unsigned(message, "authEpoch") != epoch_ || message.value("challengeId", Json()) != challenge_ ||
        message.value("format", Json()) != "rgb24") return;
    const auto width = Unsigned(message, "width"), height = Unsigned(message, "height");
    if (std::min(width, height) < 64 || std::max(width, height) > 640 ||
        std::min(width, height) > 480 || width * height > 307200) return;
    const auto type = message.value("type", Json());
    if (type == "auth.camera.ready" && Unsigned(message, "maxFps") == 5) {
      ResetFormat();
      width_ = static_cast<int>(width);
      height_ = static_cast<int>(height);
      config_pending_ = true;
    } else if (type == "auth.camera.accept" && config_sent_ && Unsigned(message, "fps") == 5 &&
               width == static_cast<uint64_t>(width_) && height == static_cast<uint64_t>(height_)) {
      accepted_ = true;
    }
    return;
  }
  if (!capture_ || size <= kHeader || LittleEndian(data, 4) != 0x46414b52 ||
      LittleEndian(data + 4, 2) != 1 || LittleEndian(data + 6, 2) != kHeader ||
      LittleEndian(data + 8, 8) != epoch_ || LittleEndian(data + 16, 4) != capture_ ||
      std::string_view(reinterpret_cast<const char*>(data + 32), 36) != challenge_) return;
  const size_t offset = static_cast<size_t>(LittleEndian(data + 20, 4));
  const size_t total = static_cast<size_t>(width_) * height_ * 3;
  const size_t payload = size - kHeader;
  if (LittleEndian(data + 24, 4) != total ||
      LittleEndian(data + 28, 2) != static_cast<uint64_t>(width_) ||
      LittleEndian(data + 30, 2) != static_cast<uint64_t>(height_) ||
      offset != rgb_.size() || payload > total - rgb_.size()) {
    ResetCapture();
    return;
  }
  if (rgb_.empty()) rgb_.reserve(total);
  rgb_.insert(rgb_.end(), data + kHeader, data + size);
  if (rgb_.size() == total) {
    // Complete and submit under the same challenge lock. Cancel/Begin cannot
    // switch the inference worker between final chunk validation and handoff.
    submit(width_, height_, rgb_.data(), width_ * 3);
    ResetCapture();
  }
}

std::optional<RawCamera::Message> RawCamera::Next(int64_t now, const Pending& pending) {
  std::lock_guard lock(mutex_);
  if (!Current(now, pending)) return {};
  if (config_pending_) {
    Json config = {{"type", "auth.camera.config"}, {"version", 1}, {"authEpoch", epoch_},
                   {"challengeId", challenge_}, {"width", width_}, {"height", height_},
                   {"format", "rgb24"}, {"fps", 5}, {"chunkBytes", kChunk}};
    auto wire = config.dump();
    config_pending_ = false;
    config_sent_ = true;
    return Message{peer_, revision_, 0, std::move(wire)};
  }
  if (!accepted_ || capture_ || now < next_grant_ || serial_ == std::numeric_limits<uint32_t>::max()) return {};
  const uint32_t capture = serial_ + 1;
  Json grant = {{"type", "auth.camera.frame"}, {"version", 1}, {"authEpoch", epoch_},
                {"challengeId", challenge_}, {"captureId", capture}};
  auto wire = grant.dump();
  capture_ = serial_ = capture;
  capture_deadline_ = now + kCaptureTimeout;
  next_grant_ = now + kInterval;
  return Message{peer_, revision_, capture, std::move(wire)};
}

void RawCamera::Sent(const Message& message, int64_t now) {
  std::lock_guard lock(mutex_);
  if (message.peer == peer_ && message.capture)
    next_grant_ = std::max(next_grant_, now + kInterval);
}

void RawCamera::Failed(const Message& message) {
  std::lock_guard lock(mutex_);
  if (message.peer != peer_ || message.revision != revision_) return;
  if (message.capture) {
    if (capture_ == message.capture) ResetCapture();
  } else if (!accepted_) {
    config_pending_ = true;
    config_sent_ = false;
  }
}

}  // namespace rk::auth
