#pragma once
#include <memory>
#include <string>
#include "base/functional/callback.h"
#include "base/values.h"
#include "mojo/public/cpp/platform/named_platform_channel.h"
#include "mojo/public/cpp/system/isolated_connection.h"
#include "mojo/public/cpp/system/simple_watcher.h"

namespace remotekit::browser {
// One local testing client. Both processes retain their own Mojo process graph.
class ControlServer final {
 public:
  using Handler = base::RepeatingCallback<base::DictValue(const base::DictValue&)>;
  using AttachmentProvider = base::RepeatingCallback<mojo::ScopedMessagePipeHandle(
      const base::DictValue&, const base::DictValue&)>;
  ControlServer(const std::string& name, Handler handler,
                AttachmentProvider attachment_provider,
                base::OnceClosure disconnected = {});
  ~ControlServer();

 private:
  void OnReadable(MojoResult result);
  void Close();
  Handler handler_;
  AttachmentProvider attachment_provider_;
  base::OnceClosure disconnected_;
  std::unique_ptr<mojo::NamedPlatformChannel> channel_;
  mojo::IsolatedConnection connection_;
  mojo::ScopedMessagePipeHandle pipe_;
  mojo::SimpleWatcher watcher_;
};
}  // namespace remotekit::browser
