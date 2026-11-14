#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rk::auth {

bool CameraChallengeId(std::string_view id);

// One peer, challenge, and uncompleted capture. Time is monotonic milliseconds.
class RawCamera {
 public:
  using Pending = std::function<bool(uint64_t, std::string_view)>;
  using Submit = std::function<void(int, int, const uint8_t*, int)>;

  struct Message {
    uint64_t peer, revision;
    uint32_t capture;  // zero denotes configuration
    std::string json;
  };

  void Bind(uint64_t peer);
  void State(uint64_t peer, bool open);
  void Begin(uint64_t peer, uint64_t epoch, std::string challenge, int64_t deadline);
  void Cancel();
  void Cancel(uint64_t epoch, std::string_view challenge);
  bool Active();
  void Receive(uint64_t peer,
               bool binary,
               const void* bytes,
               size_t size,
               int64_t now,
               const Pending& pending,
               const Submit& submit);
  std::optional<Message> Next(int64_t now, const Pending& pending);
  bool CurrentMessage(const Message&, int64_t now, const Pending& pending);
  void Sent(const Message& message, int64_t now);
  void Failed(const Message& message);

 private:
  bool Current(int64_t now, const Pending& pending);
  void ResetCapture();
  void ResetFormat();
  void ResetChallenge();

  std::mutex mutex_;
  uint64_t peer_ = 0, epoch_ = 0, revision_ = 0;
  bool open_ = false, config_pending_ = false, config_sent_ = false, accepted_ = false;
  std::string challenge_;
  int width_ = 0, height_ = 0;
  int64_t deadline_ = 0, capture_deadline_ = 0, next_grant_ = 0;
  uint32_t serial_ = 0, capture_ = 0;
  std::vector<uint8_t> rgb_;
};

}  // namespace rk::auth
