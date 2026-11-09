#include "cluster/tcp.hpp"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <atomic>
#include <mutex>
#include <algorithm>
namespace remotekit::cluster {
namespace {
using namespace std::chrono_literals;
using Clock = std::chrono::steady_clock;
Error Closed() {
  return {ErrorCode::kUnavailable, "TCP connection closed"};
}
Error Busy() {
  return {ErrorCode::kBusy, "TCP receive timeout"};
}
bool Initialize() {
  static const bool initialized = [] {
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }();
  return initialized;
}
bool Nonblocking(SOCKET socket) {
  u_long enabled = 1;
  return ioctlsocket(socket, FIONBIO, &enabled) == 0;
}
int Ready(SOCKET socket, bool write, std::chrono::milliseconds timeout) {
  fd_set set;
  FD_ZERO(&set);
  FD_SET(socket, &set);
  const auto ms = std::max<int64_t>(0, timeout.count());
  timeval wait{static_cast<long>(ms / 1000), static_cast<long>((ms % 1000) * 1000)};
  return select(0, write ? nullptr : &set, write ? &set : nullptr, nullptr, &wait);
}
struct Addresses {
  addrinfo* values{};
  ~Addresses() {
    if (values)
      freeaddrinfo(values);
  }
  bool Open(const std::string& address, bool listen) {
    const auto colon = address.rfind(':');
    if (!Initialize() || colon == std::string::npos || colon == 0 || colon + 1 == address.size())
      return false;
    auto host = address.substr(0, colon);
    if (host.starts_with('[') && host.ends_with(']'))
      host = host.substr(1, host.size() - 2);
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    hints.ai_flags = AI_NUMERICSERV | (listen ? AI_PASSIVE : 0);
    return getaddrinfo(host.c_str(), address.substr(colon + 1).c_str(), &hints, &values) == 0;
  }
};
class TcpCarrier final : public Carrier {
 public:
  explicit TcpCarrier(SOCKET socket) : socket_(socket) {
    BOOL enabled = TRUE;
    setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&enabled),
               sizeof(enabled));
  }
  ~TcpCarrier() override { Close(); }
  void Close() override {
    const auto socket = socket_.exchange(INVALID_SOCKET);
    if (socket != INVALID_SOCKET) {
      shutdown(socket, SD_BOTH);
      closesocket(socket);
    }
  }
  Result<void> Send(std::span<const uint8_t> bytes) override {
    std::lock_guard lock(send_mutex_);
    if (bytes.empty() || bytes.size() > kMaxCiphertext)
      return Closed();
    auto length = EncodeLength(static_cast<uint32_t>(bytes.size()));
    const auto deadline = Clock::now() + 20s;
    for (auto part : {std::span<const uint8_t>(length), bytes}) {
      while (!part.empty()) {
        const auto socket = socket_.load();
        if (socket == INVALID_SOCKET || Clock::now() >= deadline ||
            Ready(socket, true,
                  std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now())) <=
                0)
          return Closed();
        const auto count = send(socket, reinterpret_cast<const char*>(part.data()),
                                static_cast<int>(part.size()), 0);
        if (count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK)
          continue;
        if (count <= 0)
          return Closed();
        part = part.subspan(count);
      }
    }
    return {};
  }
  Result<Bytes> Receive(std::chrono::milliseconds timeout) override {
    const auto deadline = Clock::now() + timeout;
    while (true) {
      if (buffer_.size() >= 4) {
        const auto length = DecodeLength(std::span<const uint8_t, 4>(buffer_.data(), 4));
        if (!length || length > kMaxCiphertext) {
          Close();
          return Closed();
        }
        if (buffer_.size() == length + 4) {
          Bytes result(buffer_.begin() + 4, buffer_.end());
          buffer_.clear();
          return result;
        }
      }
      const auto socket = socket_.load();
      if (socket == INVALID_SOCKET)
        return Closed();
      const auto ready =
          Ready(socket, false,
                std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()));
      if (ready < 0)
        return Closed();
      if (!ready)
        return Busy();
      const size_t needed =
          buffer_.size() < 4
              ? 4 - buffer_.size()
              : DecodeLength(std::span<const uint8_t, 4>(buffer_.data(), 4)) + 4 - buffer_.size();
      std::array<uint8_t, 65536> chunk;
      const auto count = recv(socket, reinterpret_cast<char*>(chunk.data()),
                              static_cast<int>(std::min(needed, chunk.size())), 0);
      if (count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) {
        if (Clock::now() >= deadline)
          return Busy();
        continue;
      }
      if (count <= 0)
        return Closed();
      buffer_.insert(buffer_.end(), chunk.begin(), chunk.begin() + count);
    }
  }

 private:
  std::atomic<SOCKET> socket_;
  std::mutex send_mutex_;
  Bytes buffer_;
};
}  // namespace
Result<std::unique_ptr<Carrier>> ConnectTcp(const std::string& address) {
  Addresses addresses;
  if (!addresses.Open(address, false))
    return Error{ErrorCode::kInvalidRequest, "invalid peer address"};
  for (auto* item = addresses.values; item; item = item->ai_next) {
    const auto socket = ::socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (socket == INVALID_SOCKET)
      continue;
    bool connected = false;
    if (Nonblocking(socket)) {
      if (connect(socket, item->ai_addr, static_cast<int>(item->ai_addrlen)) == 0)
        connected = true;
      else if (WSAGetLastError() == WSAEWOULDBLOCK && Ready(socket, true, 5s) > 0) {
        int error = 0, size = sizeof(error);
        connected =
            getsockopt(socket, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size) == 0 &&
            error == 0;
      }
    }
    if (connected)
      return std::unique_ptr<Carrier>(new TcpCarrier(socket));
    closesocket(socket);
  }
  return Closed();
}
struct TcpListener::Impl {
  std::atomic<SOCKET> socket{INVALID_SOCKET};
  std::string address;
};
TcpListener::TcpListener(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
TcpListener::~TcpListener() {
  Close();
}
void TcpListener::Close() {
  auto socket = impl_->socket.exchange(INVALID_SOCKET);
  if (socket != INVALID_SOCKET)
    closesocket(socket);
}
const std::string& TcpListener::Address() const {
  return impl_->address;
}
Result<std::unique_ptr<TcpListener>> TcpListener::Listen(const std::string& address) {
  Addresses addresses;
  if (!addresses.Open(address, true))
    return Error{ErrorCode::kInvalidRequest, "invalid peer listen address"};
  for (auto* item = addresses.values; item; item = item->ai_next) {
    const auto socket = ::socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (socket == INVALID_SOCKET)
      continue;
    BOOL exclusive = TRUE;
    setsockopt(socket, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive),
               sizeof(exclusive));
    if (!Nonblocking(socket) ||
        bind(socket, item->ai_addr, static_cast<int>(item->ai_addrlen)) != 0 ||
        listen(socket, 8) != 0) {
      closesocket(socket);
      continue;
    }
    sockaddr_storage bound{};
    int length = sizeof(bound);
    char host[NI_MAXHOST]{}, port[NI_MAXSERV]{};
    if (getsockname(socket, reinterpret_cast<sockaddr*>(&bound), &length) != 0 ||
        getnameinfo(reinterpret_cast<sockaddr*>(&bound), length, host, sizeof(host), port,
                    sizeof(port), NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
      closesocket(socket);
      continue;
    }
    auto impl = std::make_unique<Impl>();
    impl->socket = socket;
    impl->address =
        (bound.ss_family == AF_INET6 ? "[" + std::string(host) + "]" : std::string(host)) + ":" +
        port;
    return std::unique_ptr<TcpListener>(new TcpListener(std::move(impl)));
  }
  return Error{ErrorCode::kUnavailable, "cannot listen on peer address"};
}
Result<std::unique_ptr<Carrier>> TcpListener::Accept(std::chrono::milliseconds timeout) {
  const auto socket = impl_->socket.load();
  if (socket == INVALID_SOCKET)
    return Closed();
  const auto ready = Ready(socket, false, timeout);
  if (ready < 0)
    return Closed();
  if (!ready)
    return Busy();
  const auto accepted = accept(socket, nullptr, nullptr);
  if (accepted == INVALID_SOCKET)
    return WSAGetLastError() == WSAEWOULDBLOCK ? Busy() : Closed();
  if (!Nonblocking(accepted)) {
    closesocket(accepted);
    return Closed();
  }
  return std::unique_ptr<Carrier>(new TcpCarrier(accepted));
}
}  // namespace remotekit::cluster
