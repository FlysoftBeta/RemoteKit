#pragma once
#include "remotekit/sdk/include/remotekit_sdk.h"
#include "remotekit/endpoint/include/remotekit/shared_render_slots.h"
#include "remotekit/protocol/control.h"
#include "remotekit/browser/sdk/render_endpoint_pending.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>
#include <thread>
#include <cstring>
#include "remotekit/protocol/render_slots.h"

#include "base/at_exit.h"
#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_view_util.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "base/synchronization/waitable_event.h"
#include "base/threading/platform_thread.h"
#include "base/threading/thread.h"
#include "base/time/time.h"
#include "mojo/core/embedder/embedder.h"
#include "mojo/core/embedder/scoped_ipc_support.h"
#include "mojo/public/cpp/platform/named_platform_channel.h"
#include "mojo/public/cpp/system/isolated_connection.h"
#include "mojo/public/cpp/system/message_pipe.h"
#include "third_party/webrtc/rtc_base/time_utils.h"

namespace remotekit::sdk {
struct ControlChannel {
  std::mutex request_lock;
  std::mutex open_lock;
  remotekit::sdk::PendingRenderEndpoint pending_render;
  std::atomic<bool> closed{false};
  mojo::IsolatedConnection connection;
  mojo::ScopedMessagePipeHandle pipe;
};

// Kept alive until explicit shutdown so a host controls DLL teardown order.
struct RenderConnection {
  std::atomic<bool> failed{false};
  std::mutex lock;
  std::mutex close_lock;
  std::recursive_mutex callback_lock;
  std::atomic<bool> closed{false};
  mojo::ScopedMessagePipeHandle pipe;
  std::thread reader;
  std::thread::id reader_id;
  uint64_t last_value = 0;
  remotekit::RenderGenerationState generation_state;
  remotekit::RenderWakeState wake_state;
  std::array<std::optional<remotekit::RenderIdentity>, 4> pending;
  remotekit_sdk_render_callback callback = nullptr;
  void* context = nullptr;
};
struct SDKState {
  std::mutex lock;
  std::unique_ptr<base::AtExitManager> at_exit;
  std::unique_ptr<base::Thread> io_thread;
  std::unique_ptr<mojo::core::ScopedIPCSupport> ipc_support;
  std::map<uint64_t, std::shared_ptr<ControlChannel>> channels;
  std::map<uint64_t, std::shared_ptr<RenderConnection>> render_channels;
  std::condition_variable idle;
  size_t operations = 0;
  bool stopping = false;
  uint64_t next_handle = 1;
  bool stopped = false;
  bool owns_thread_pool = false;
  size_t rtc_peers = 0;
};

SDKState& State();
inline constexpr size_t kMaxMessageSize = 1024 * 1024;
void RetireChannel(uint64_t handle, const std::shared_ptr<ControlChannel>& channel);
int ControlRequestInternal(uint64_t handle,
                           const void* input,
                           size_t size,
                           void* output,
                           size_t capacity,
                           size_t* output_size,
                           uint32_t timeout_ms,
                           std::vector<mojo::ScopedHandle>* attachments);
int ExchangeJson(uint64_t handle,
                 std::string_view request,
                 uint32_t timeout_ms,
                 std::optional<base::DictValue>* reply,
                 std::vector<mojo::ScopedHandle>* attachments = nullptr);
// Declare before operation-owned Mojo objects: their destruction must finish
// before the last lease permits shutdown to tear down Mojo and base.
class OperationLease {
 public:
  OperationLease() {
    auto& state = State();
    std::lock_guard lock(state.lock);
    if (state.at_exit && !state.stopping && !state.stopped) {
      ++state.operations;
      acquired_ = true;
    }
  }
  ~OperationLease() {
    if (!acquired_)
      return;
    auto& state = State();
    std::lock_guard lock(state.lock);
    if (--state.operations == 0)
      state.idle.notify_all();
  }
  explicit operator bool() const { return acquired_; }
  OperationLease(const OperationLease&) = delete;
  OperationLease& operator=(const OperationLease&) = delete;

 private:
  bool acquired_ = false;
};

}  // namespace remotekit::sdk
int RemoteKitSdkBeginRtc();
void RemoteKitSdkEndRtc();
