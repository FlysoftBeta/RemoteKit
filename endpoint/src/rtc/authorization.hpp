#pragma once
#include "util/common.hpp"
#include "media/sdk_loader.hpp"
#include "rtc/product_authorization.hpp"
#include "util/error.hpp"
#include <functional>
#include <mutex>
namespace remotekit {
class AuthorizationController {
 public:
  struct AdmissionToken {
    const uint64_t peer, stamp, epoch;
  };
  struct Hooks {
    std::function<uint64_t()> peer;
    std::function<std::string()> connection;
    std::function<void()> files_closed, revoked, wake;
    std::function<void(uint64_t)> opened, files_opened;
  };
  AuthorizationController(media::Sdk& sdk, Hooks hooks) : sdk_(sdk), hooks_(std::move(hooks)) {}
  auto LockTransition() { return std::unique_lock(transition_mutex_); }
  auto LockAdmission() { return std::unique_lock(admission_mutex_); }
  void Bind();
  void Close();
  Result<Json> Authorize(const Json&, uint64_t, const std::function<bool()>&);
  Result<void> ManagementLost(uint64_t generation);
  static Result<uint64_t> AuthorizationEpoch(const Json& request);
  Result<void> RequireAuthPeer(const Json& request);
  uint64_t Stamp() const { return authorization_.Stamp(); }
  uint64_t Epoch() const { return authorization_.Epoch(); }
  bool Current(uint64_t stamp) const { return authorization_.Current(stamp); }
  AdmissionToken Admit() const { return {hooks_.peer(), Stamp(), Epoch()}; }
  bool Current(const AdmissionToken& token) const {
    return token.peer && token.peer == hooks_.peer() && token.epoch == Epoch() &&
           Current(token.stamp);
  }
  uint64_t ManagementGeneration() const { return management_generation_.load(); }
  uint64_t Frame() const { return frame_authorization_.load(); }
  void SetFrame(uint64_t stamp) { frame_authorization_ = stamp; }
  uint64_t Input() const { return input_authorization_.load(); }
  void SetInput(uint64_t stamp) { input_authorization_ = stamp; }
  int64_t AudioAfter() const { return audio_authorized_after_.load(); }

 private:
  int RevokeProduct();
  media::Sdk& sdk_;
  Hooks hooks_;
  std::mutex transition_mutex_, admission_mutex_;
  ProductAuthorization authorization_;
  std::atomic<uint64_t> management_generation_{0}, frame_authorization_{0}, input_authorization_{0};
  std::atomic<int64_t> audio_authorized_after_{0};
};
}  // namespace remotekit
