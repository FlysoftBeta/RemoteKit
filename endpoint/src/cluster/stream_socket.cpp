#include "cluster/stream_socket.hpp"
#define SECURITY_WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <schannel.h>
#include <sspi.h>
#include <algorithm>
#include <atomic>
#include <mutex>
#include <vector>

namespace remotekit::cluster {
namespace {
using Buffer = std::vector<uint8_t>;

Error Failure(const std::string& stage, long code) {
  return {ErrorCode::kUnavailable,
          "cluster connect failed at " + stage + ", error 0x" +
              [&] {
                char text[16];
                snprintf(text, sizeof(text), "%lX", static_cast<unsigned long>(code));
                return std::string(text);
              }(),
          {},
          {},
          OsError{code < 0 ? OsError::Kind::kHresult : OsError::Kind::kWin32, code}};
}

bool InitializeWinsock() {
  static const bool initialized = [] {
    WSADATA data;
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }();
  return initialized;
}

void SetTimeouts(SOCKET socket, std::chrono::milliseconds receive) {
  DWORD send = 5000, recv = static_cast<DWORD>(receive.count());
  setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&send), sizeof(send));
  setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&recv), sizeof(recv));
}

class Stream final : public StreamSocket {
 public:
  explicit Stream(SOCKET socket) : socket_(socket) {}
  ~Stream() override {
    Shutdown();
    if (have_context_)
      DeleteSecurityContext(&context_);
    if (have_credentials_)
      FreeCredentialsHandle(&credentials_);
    closesocket(socket_);
  }

  Result<void> Handshake(const std::wstring& host) {
    tls_ = true;
    SCHANNEL_CRED credential{};
    credential.dwVersion = SCHANNEL_CRED_VERSION;
    credential.dwFlags = SCH_CRED_MANUAL_CRED_VALIDATION | SCH_CRED_NO_DEFAULT_CREDS |
                         SCH_USE_STRONG_CRYPTO;
    SECURITY_STATUS status = AcquireCredentialsHandleW(
        nullptr, const_cast<wchar_t*>(UNISP_NAME_W), SECPKG_CRED_OUTBOUND, nullptr, &credential,
        nullptr, nullptr, &credentials_, nullptr);
    if (status != SEC_E_OK)
      return Failure("TLS credentials", status);
    have_credentials_ = true;
    std::wstring target = host;
    constexpr DWORD kFlags = ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT |
                             ISC_REQ_CONFIDENTIALITY | ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM |
                             ISC_REQ_MANUAL_CRED_VALIDATION;
    Buffer input;
    bool read_first = false;
    for (;;) {
      if (read_first) {
        auto received = ReceiveRaw(input);
        if (!received)
          return Failure("TLS handshake (peer closed or timed out)", WSAGetLastError());
      }
      SecBuffer in[2] = {{static_cast<ULONG>(input.size()), SECBUFFER_TOKEN, input.data()},
                         {0, SECBUFFER_EMPTY, nullptr}};
      SecBufferDesc in_desc{SECBUFFER_VERSION, 2, in};
      SecBuffer out_buffer{0, SECBUFFER_TOKEN, nullptr};
      SecBufferDesc out_desc{SECBUFFER_VERSION, 1, &out_buffer};
      DWORD attributes = 0;
      status = InitializeSecurityContextW(
          &credentials_, have_context_ ? &context_ : nullptr, target.data(), kFlags, 0, 0,
          have_context_ ? &in_desc : nullptr, 0, &context_, &out_desc, &attributes, nullptr);
      if (status != SEC_E_INVALID_HANDLE && status != SEC_E_INVALID_TOKEN)
        have_context_ = true;
      if (out_buffer.pvBuffer) {
        bool sent = !out_buffer.cbBuffer ||
                    SendRaw({static_cast<const uint8_t*>(out_buffer.pvBuffer), out_buffer.cbBuffer});
        FreeContextBuffer(out_buffer.pvBuffer);
        if (!sent)
          return Failure("TLS handshake send", WSAGetLastError());
      }
      if (status == SEC_E_INCOMPLETE_MESSAGE) {
        read_first = true;
        continue;
      }
      if (status == SEC_E_OK) {
        if (in[1].BufferType == SECBUFFER_EXTRA && in[1].cbBuffer)
          encrypted_.assign(input.end() - in[1].cbBuffer, input.end());
        break;
      }
      if (status != SEC_I_CONTINUE_NEEDED && status != SEC_I_INCOMPLETE_CREDENTIALS)
        return Failure("TLS handshake", status);
      if (in[1].BufferType == SECBUFFER_EXTRA && in[1].cbBuffer) {
        input.erase(input.begin(), input.end() - in[1].cbBuffer);
        read_first = false;
      } else {
        input.clear();
        read_first = true;
      }
    }
    status = QueryContextAttributesW(&context_, SECPKG_ATTR_STREAM_SIZES, &sizes_);
    if (status != SEC_E_OK)
      return Failure("TLS stream sizes", status);
    return {};
  }

  Result<size_t> Read(std::span<uint8_t> out) override {
    if (out.empty())
      return size_t{0};
    if (!tls_) {
      int n = recv(socket_, reinterpret_cast<char*>(out.data()), static_cast<int>(out.size()), 0);
      if (n <= 0)
        return Closed();
      return static_cast<size_t>(n);
    }
    while (plain_at_ == plain_.size()) {
      plain_.clear();
      plain_at_ = 0;
      if (!encrypted_.empty()) {
        switch (Decrypt()) {
          case Decrypted::kData:
            continue;
          case Decrypted::kNeedMore:
            break;
          case Decrypted::kFailed:
            return Closed();
        }
      }
      if (!ReceiveRaw(encrypted_))
        return Closed();
    }
    size_t n = std::min(out.size(), plain_.size() - plain_at_);
    std::copy_n(plain_.begin() + plain_at_, n, out.begin());
    plain_at_ += n;
    return n;
  }

  Result<void> WriteAll(std::span<const uint8_t> bytes) override {
    if (!tls_)
      return SendRaw(bytes) ? Result<void>{} : Result<void>{Closed()};
    while (!bytes.empty()) {
      size_t n = std::min<size_t>(bytes.size(), sizes_.cbMaximumMessage);
      Buffer record(sizes_.cbHeader + n + sizes_.cbTrailer);
      std::copy_n(bytes.begin(), n, record.begin() + sizes_.cbHeader);
      SecBuffer buffers[4] = {
          {sizes_.cbHeader, SECBUFFER_STREAM_HEADER, record.data()},
          {static_cast<ULONG>(n), SECBUFFER_DATA, record.data() + sizes_.cbHeader},
          {sizes_.cbTrailer, SECBUFFER_STREAM_TRAILER, record.data() + sizes_.cbHeader + n},
          {0, SECBUFFER_EMPTY, nullptr}};
      SecBufferDesc desc{SECBUFFER_VERSION, 4, buffers};
      SECURITY_STATUS status;
      {
        std::lock_guard lock(crypt_mutex_);
        status = EncryptMessage(&context_, 0, &desc, 0);
      }
      if (status != SEC_E_OK)
        return Closed();
      size_t total = buffers[0].cbBuffer + buffers[1].cbBuffer + buffers[2].cbBuffer;
      if (!SendRaw({record.data(), total}))
        return Closed();
      bytes = bytes.subspan(n);
    }
    return {};
  }

  void SetReceiveTimeout(std::chrono::milliseconds timeout) override {
    SetTimeouts(socket_, timeout);
  }
  void Shutdown() override {
    if (!shut_.exchange(true))
      shutdown(socket_, SD_BOTH);
  }

 private:
  enum class Decrypted { kData, kNeedMore, kFailed };
  static Error Closed() { return {ErrorCode::kUnavailable, "cluster channel closed"}; }

  bool SendRaw(std::span<const uint8_t> bytes) {
    while (!bytes.empty()) {
      int n = send(socket_, reinterpret_cast<const char*>(bytes.data()),
                   static_cast<int>(std::min<size_t>(bytes.size(), 1 << 20)), 0);
      if (n <= 0)
        return false;
      bytes = bytes.subspan(static_cast<size_t>(n));
    }
    return true;
  }
  bool ReceiveRaw(Buffer& into) {
    uint8_t chunk[16384];
    int n = recv(socket_, reinterpret_cast<char*>(chunk), sizeof(chunk), 0);
    if (n <= 0)
      return false;
    into.insert(into.end(), chunk, chunk + n);
    return true;
  }
  Decrypted Decrypt() {
    SecBuffer buffers[4] = {{static_cast<ULONG>(encrypted_.size()), SECBUFFER_DATA,
                             encrypted_.data()},
                            {0, SECBUFFER_EMPTY, nullptr},
                            {0, SECBUFFER_EMPTY, nullptr},
                            {0, SECBUFFER_EMPTY, nullptr}};
    SecBufferDesc desc{SECBUFFER_VERSION, 4, buffers};
    SECURITY_STATUS status;
    {
      std::lock_guard lock(crypt_mutex_);
      status = DecryptMessage(&context_, &desc, 0, nullptr);
    }
    if (status == SEC_E_INCOMPLETE_MESSAGE)
      return Decrypted::kNeedMore;
    if (status != SEC_E_OK)
      return Decrypted::kFailed;
    size_t extra = 0;
    for (auto& buffer : buffers) {
      if (buffer.BufferType == SECBUFFER_DATA)
        plain_.assign(static_cast<uint8_t*>(buffer.pvBuffer),
                      static_cast<uint8_t*>(buffer.pvBuffer) + buffer.cbBuffer);
      else if (buffer.BufferType == SECBUFFER_EXTRA)
        extra = buffer.cbBuffer;
    }
    encrypted_.erase(encrypted_.begin(), encrypted_.end() - extra);
    return Decrypted::kData;
  }

  SOCKET socket_;
  std::atomic<bool> shut_{false};
  bool tls_ = false, have_credentials_ = false, have_context_ = false;
  CredHandle credentials_{};
  CtxtHandle context_{};
  SecPkgContext_StreamSizes sizes_{};
  std::mutex crypt_mutex_;
  Buffer encrypted_, plain_;
  size_t plain_at_ = 0;
};

Result<SOCKET> OpenSocket(const std::wstring& host, uint16_t port) {
  if (!InitializeWinsock())
    return Failure("winsock", WSAGetLastError());
  std::wstring name = host;
  if (name.size() > 2 && name.front() == L'[' && name.back() == L']')
    name = name.substr(1, name.size() - 2);
  ADDRINFOW hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;
  ADDRINFOW* addresses = nullptr;
  int resolved = GetAddrInfoW(name.c_str(), std::to_wstring(port).c_str(), &hints, &addresses);
  if (resolved != 0)
    return Failure("DNS lookup", resolved);
  int last = 0;
  for (auto* address = addresses; address; address = address->ai_next) {
    SOCKET socket = ::socket(address->ai_family, address->ai_socktype, address->ai_protocol);
    if (socket == INVALID_SOCKET) {
      last = WSAGetLastError();
      continue;
    }
    u_long nonblocking = 1;
    ioctlsocket(socket, FIONBIO, &nonblocking);
    bool connected = connect(socket, address->ai_addr, static_cast<int>(address->ai_addrlen)) == 0;
    if (!connected && WSAGetLastError() == WSAEWOULDBLOCK) {
      fd_set writable, failed;
      FD_ZERO(&writable);
      FD_ZERO(&failed);
      FD_SET(socket, &writable);
      FD_SET(socket, &failed);
      timeval wait{5, 0};
      int ready = select(0, nullptr, &writable, &failed, &wait);
      if (ready > 0 && FD_ISSET(socket, &writable)) {
        connected = true;
      } else {
        int error = 0, size = sizeof(error);
        getsockopt(socket, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size);
        WSASetLastError(ready == 0 ? WSAETIMEDOUT : error);
      }
    }
    if (!connected) {
      last = WSAGetLastError();
      closesocket(socket);
      continue;
    }
    nonblocking = 0;
    ioctlsocket(socket, FIONBIO, &nonblocking);
    BOOL nodelay = TRUE;
    setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay),
               sizeof(nodelay));
    SetTimeouts(socket, std::chrono::seconds(5));
    FreeAddrInfoW(addresses);
    return socket;
  }
  FreeAddrInfoW(addresses);
  return Failure("TCP connect", last);
}
}  // namespace

Result<std::unique_ptr<StreamSocket>> ConnectStream(const std::wstring& host,
                                                    uint16_t port,
                                                    bool tls) {
  auto socket = OpenSocket(host, port);
  if (!socket)
    return socket.error();
  auto stream = std::make_unique<Stream>(socket.value());
  if (tls) {
    std::wstring name = host;
    if (name.size() > 2 && name.front() == L'[' && name.back() == L']')
      name = name.substr(1, name.size() - 2);
    auto handshake = stream->Handshake(name);
    if (!handshake)
      return handshake.error();
  }
  return std::unique_ptr<StreamSocket>(std::move(stream));
}
}  // namespace remotekit::cluster
