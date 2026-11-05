#pragma once
#include <memory>
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "mojo/public/cpp/system/message_pipe.h"
#include "mojo/public/cpp/system/simple_watcher.h"
#include "remotekit/protocol/render_slots.h"
namespace remotekit::browser {
// Browser UI sequence only. Dedicated pipe; no per-success response.
class RenderChannel final {
 public:
  using Handler = base::RepeatingCallback<void(const RenderBegin&)>;
  using StopHandler = base::RepeatingCallback<void(uint64_t)>;
  RenderChannel(mojo::ScopedMessagePipeHandle pipe,
                Handler handler,
                StopHandler stop_handler,
                base::OnceClosure disconnected = {});
  ~RenderChannel();
  bool Reject(const RenderIdentity& identity, RenderRejectReason reason);
  bool Stopped(uint64_t generation);
  bool Wake(const RenderIdentity& identity);
  void Close();

 private:
  void OnReadable(MojoResult result);
  Handler handler_;
  StopHandler stop_handler_;
  base::OnceClosure disconnected_;
  mojo::ScopedMessagePipeHandle pipe_;
  mojo::SimpleWatcher watcher_;
  uint64_t last_value_ = 0;
  RenderGenerationState generation_state_;
  RenderWakeState wake_state_;
  base::WeakPtrFactory<RenderChannel> weak_factory_{this};
};
}  // namespace remotekit::browser
