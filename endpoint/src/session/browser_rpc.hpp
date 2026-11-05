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
  Result<Json> Request(Json command,
                       uint64_t expected_control = 0,
                       uint32_t timeout_ms = 10000,
                       bool opportunistic = false,
                       const std::function<bool()>& admitted = {});
  Result<void> OpenRender(remotekit_sdk_render_setup& setup);

 private:
  media::Sdk& sdk_;
  std::timed_mutex mutex_;
  std::atomic<uint64_t> control_{0};
  uint64_t serial_ = 0;
  std::atomic<std::shared_ptr<media::ServerTrace>> trace_;
  std::atomic<DWORD> producer_pid_{0};
};
}  // namespace remotekit
