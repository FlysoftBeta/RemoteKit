#include "browser/devtools.h"

#include <cstdint>
#include <memory>
#include <string>

#include "base/check.h"
#include "base/command_line.h"
#include "base/strings/string_number_conversions.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_socket_factory.h"
#include "content/public/common/content_switches.h"
#include "net/base/net_errors.h"
#include "net/log/net_log_source.h"
#include "net/socket/tcp_server_socket.h"

namespace remotekit::browser {
namespace {

class LoopbackSocketFactory final : public content::DevToolsSocketFactory {
 public:
  explicit LoopbackSocketFactory(uint16_t port) : port_(port) {}

  std::unique_ptr<net::ServerSocket> CreateForHttpServer() override {
    auto socket = std::make_unique<net::TCPServerSocket>(nullptr, net::NetLogSource());
    if (socket->ListenWithAddressAndPort("127.0.0.1", port_, 10) != net::OK)
      return nullptr;
    return socket;
  }

  std::unique_ptr<net::ServerSocket> CreateForTethering(std::string*) override { return nullptr; }

 private:
  const uint16_t port_;
};

}  // namespace

void StartDevTools(const base::FilePath& active_port_dir) {
  const auto& command_line = *base::CommandLine::ForCurrentProcess();
  if (!command_line.HasSwitch(switches::kRemoteDebuggingPort))
    return;

  unsigned int port = 0;
  const std::string value = command_line.GetSwitchValueASCII(switches::kRemoteDebuggingPort);
  CHECK(base::StringToUint(value, &port) && port <= 65535u)
      << "Invalid --remote-debugging-port: " << value;
  content::DevToolsAgentHost::StartRemoteDebuggingServer(
      std::make_unique<LoopbackSocketFactory>(static_cast<uint16_t>(port)), active_port_dir,
      base::FilePath());
}

void StopDevTools() {
  content::DevToolsAgentHost::StopRemoteDebuggingServer();
}

}  // namespace remotekit::browser
