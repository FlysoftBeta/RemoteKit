#pragma once
#include "util/error.hpp"
#include <chrono>
#include <cstdint>
#include <memory>
#include <span>
#include <string>

namespace remotekit::cluster {
// Blocking byte stream over TCP, optionally wrapped in Schannel TLS. TLS here is transport cover
// only: the peer is authenticated by the Noise handshake that runs above it, so the certificate is
// never validated (self-signed, private-CA, wrong-name, expired or revoked certificates all work).
class StreamSocket {
 public:
  virtual ~StreamSocket() = default;
  // Blocks until at least one byte is available. EOF, timeout and errors are kUnavailable.
  virtual Result<size_t> Read(std::span<uint8_t> out) = 0;
  virtual Result<void> WriteAll(std::span<const uint8_t> bytes) = 0;
  virtual void SetReceiveTimeout(std::chrono::milliseconds timeout) = 0;
  // Thread-safe; unblocks pending Read and WriteAll calls.
  virtual void Shutdown() = 0;
};
Result<std::unique_ptr<StreamSocket>> ConnectStream(const std::wstring& host,
                                                    uint16_t port,
                                                    bool tls);
}  // namespace remotekit::cluster
