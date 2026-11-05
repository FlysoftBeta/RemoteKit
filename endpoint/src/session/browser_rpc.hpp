#pragma once
#include "util/common.hpp"
#include "media/sdk_loader.hpp"
#include "util/error.hpp"
#include <atomic>
#include <functional>
#include <mutex>
#include <memory>

namespace remotekit {
namespace media {
class ServerTrace;
}
class BrowserRpc {
 public:
  explicit BrowserRpc(media::Sdk& sdk) : sdk_(sdk) {}
  ~BrowserRpc() { Invalidate(); }
  void SetTrace(std::shared_ptr<media::ServerTrace> trace, DWORD pid);
  Result<void> Connect(const std::string& channel);
  void Invalidate();
  uint64_t Control() const { return control_.load(); }
  bool Disconnected() const { return disconnected_.load(); }
  bool NeedsHealthCheck() const { return needs_health_check_.load(); }
  // Sends one command and returns the Browser's reply object whether or not it
  // reports success. Only transport, identity and framing failures are errors.
  Result<Json> Exchange(Json command,
                        uint64_t expected_control = 0,
                        uint32_t timeout_ms = 10000,
                        bool opportunistic = false,
                        const std::function<bool()>& admitted = {});
  // Exchange plus mapping of an `ok:false` reply to a typed error.
  Result<Json> Request(Json command,
                       uint64_t expected_control = 0,
                       uint32_t timeout_ms = 10000,
                       bool opportunistic = false,
                       const std::function<bool()>& admitted = {});
  static Error ReplyError(const Json& reply);
  static Result<Json> CheckReply(Json reply);
  // True for Browser's busy rejection before the input was admitted, the only
  // input failure that may be retried with the same sequence.
  static bool IsBusyBeforeAdmission(const Json& reply);
  Result<void> OpenRender(remotekit_sdk_render_setup& setup);

 private:
  media::Sdk& sdk_;
  std::timed_mutex mutex_;
  std::atomic<uint64_t> control_{0};
  std::atomic<bool> disconnected_{false}, needs_health_check_{false};
  uint64_t serial_ = 0;
  std::atomic<std::shared_ptr<media::ServerTrace>> trace_;
  std::atomic<DWORD> producer_pid_{0};
};
}  // namespace remotekit
