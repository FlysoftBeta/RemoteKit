#pragma once
#include "cluster/frames.hpp"
#include <chrono>
#include <functional>
namespace remotekit::cluster {
class Channel {
 public:
  virtual ~Channel() = default;
  virtual Result<void> Send(const Json& message) = 0;
  virtual Result<void> SendBinary(const Json& header, std::span<const uint8_t> bytes) = 0;
  virtual Result<Message> Receive(std::chrono::milliseconds timeout) = 0;
  virtual void Close() = 0;
};
struct Hello {
  std::string role, node_id, build_id, incarnation;
};
struct Established {
  std::unique_ptr<Channel> channel;
  Json reply;
};
// Each carrier message is one Noise message. Receive timeout is kBusy; EOF is kUnavailable.
class Carrier {
 public:
  virtual ~Carrier() = default;
  virtual Result<void> Send(std::span<const uint8_t> message) = 0;
  virtual Result<Bytes> Receive(std::chrono::milliseconds timeout) = 0;
  virtual void Close() = 0;
};
// Takes ownership of both Windows handles; they must be distinct synchronous pipe/file handles.
std::unique_ptr<Carrier> HandleCarrier(void* read_handle, void* write_handle);
Result<Established> ConnectCarrier(std::unique_ptr<Carrier> carrier,
                                   const Key& key,
                                   const Hello& hello);
using HelloHandler = std::function<Result<Json>(const Json&)>;
Result<Established> AcceptCarrier(std::unique_ptr<Carrier> carrier,
                                  const Key& key,
                                  const HelloHandler& reply);
Result<Established> ConnectWebSocket(const std::string& url, const Key& key, const Hello& hello);
Result<Established> ConnectStdio(const Key& key, const Hello& hello);
}  // namespace remotekit::cluster
