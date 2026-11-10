#include "cluster/channel.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <winhttp.h>
#include <fcntl.h>
#include <io.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

namespace remotekit::cluster {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
Error Closed() {
  return {ErrorCode::kUnavailable, "cluster channel closed"};
}
Error Timeout() {
  return {ErrorCode::kBusy, "cluster receive timeout"};
}
class BufferedCarrier : public Carrier {
 public:
  Result<Bytes> Receive(std::chrono::milliseconds timeout) override {
    std::unique_lock lock(mutex_);
    if (!wake_.wait_for(lock, timeout, [&] { return closed_ || !queue_.empty(); }))
      return Timeout();
    if (queue_.empty())
      return Closed();
    auto bytes = std::move(queue_.front());
    queue_.pop_front();
    queued_ -= bytes.size();
    return bytes;
  }

 protected:
  std::mutex mutex_, send_mutex_;
  std::condition_variable wake_;
  std::deque<Bytes> queue_;
  size_t queued_ = 0;
  std::atomic<bool> closed_{false};
  std::thread reader_;
  void Start() {
    reader_ = std::thread([this] {
      while (!closed_) {
        auto message = Read();
        if (!message)
          break;
        std::lock_guard lock(mutex_);
        if (queue_.size() >= 256 || queued_ + message.value().size() > 16 * kMaxCiphertext)
          break;
        queued_ += message.value().size();
        queue_.push_back(std::move(message).value());
        wake_.notify_all();
      }
      closed_ = true;
      wake_.notify_all();
    });
  }
  virtual Result<Bytes> Read() = 0;
};
class Pipes final : public BufferedCarrier {
 public:
  Pipes(HANDLE read, HANDLE write) : read_(read), write_(write) { Start(); }
  ~Pipes() override { Close(); }
  void Close() override {
    std::lock_guard close_lock(close_mutex_);
    closed_ = true;
    wake_.notify_all();
    if (reader_.joinable())
      CancelSynchronousIo(reader_.native_handle());
    // Cancel any synchronous send without waiting on the send lock.
    {
      std::lock_guard lock(writer_mutex_);
      if (writer_)
        CancelSynchronousIo(writer_);
      writer_wake_.notify_all();
    }
    if (reader_.joinable())
      reader_.join();
    std::lock_guard send_lock(send_mutex_);
    if (read_)
      CloseHandle(std::exchange(read_, nullptr));
    if (write_)
      CloseHandle(std::exchange(write_, nullptr));
  }
  Result<void> Send(std::span<const uint8_t> bytes) override {
    std::lock_guard lock(send_mutex_);
    if (closed_ || bytes.size() > kMaxCiphertext)
      return Closed();
    {
      std::lock_guard writer_lock(writer_mutex_);
      if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &writer_,
                           0, FALSE, DUPLICATE_SAME_ACCESS))
        return Closed();
      writing_finished_ = false;
    }
    std::thread deadline([&] {
      std::unique_lock lock(writer_mutex_);
      if (!writer_wake_.wait_for(lock, 5s, [&] { return writing_finished_ || closed_; })) {
        closed_ = true;
        wake_.notify_all();
      }
      // Cancellation can race the start of a synchronous WriteFile. Repeat until
      // the sender acknowledges completion, so Close also covers that race.
      while (!writing_finished_) {
        CancelSynchronousIo(writer_);
        writer_wake_.wait_for(lock, 10ms, [&] { return writing_finished_; });
      }
    });
    auto n = EncodeLength(static_cast<uint32_t>(bytes.size()));
    bool ok = WriteAll(n) && WriteAll(bytes);
    {
      std::lock_guard writer_lock(writer_mutex_);
      writing_finished_ = true;
      writer_wake_.notify_all();
    }
    deadline.join();
    {
      std::lock_guard writer_lock(writer_mutex_);
      CloseHandle(writer_);
      writer_ = nullptr;
    }
    if (!ok)
      return Closed();
    return {};
  }

 private:
  HANDLE read_, write_, writer_ = nullptr;
  std::mutex writer_mutex_, close_mutex_;
  std::condition_variable writer_wake_;
  bool writing_finished_ = true;
  bool WriteAll(std::span<const uint8_t> bytes) {
    while (!bytes.empty() && !closed_) {
      DWORD n = 0;
      if (!WriteFile(write_, bytes.data(), static_cast<DWORD>(bytes.size()), &n, nullptr) || !n)
        return false;
      bytes = bytes.subspan(n);
    }
    return bytes.empty();
  }
  bool ReadAll(std::span<uint8_t> bytes) {
    while (!bytes.empty() && !closed_) {
      DWORD n = 0, available = 0;
      if (!PeekNamedPipe(read_, nullptr, 0, nullptr, &available, nullptr))
        return false;
      if (!available) {
        Sleep(10);
        continue;
      }
      if (!ReadFile(read_, bytes.data(),
                    static_cast<DWORD>(std::min<size_t>(bytes.size(), available)), &n, nullptr) ||
          !n)
        return false;
      bytes = bytes.subspan(n);
    }
    return bytes.empty();
  }
  Result<Bytes> Read() override {
    std::array<uint8_t, 4> prefix;
    if (!ReadAll(prefix))
      return Closed();
    uint32_t n = DecodeLength(prefix);
    if (n < 16 || n > kMaxCiphertext)
      return Closed();
    Bytes bytes(n);
    if (!ReadAll(bytes))
      return Closed();
    return bytes;
  }
};
struct HttpHandle {
  HINTERNET value = nullptr;
  ~HttpHandle() {
    if (value)
      WinHttpCloseHandle(value);
  }
};
class WebSocket final : public BufferedCarrier {
 public:
  HttpHandle session, connection;
  std::atomic<HINTERNET> socket{nullptr};
  ~WebSocket() override {
    Close();
    if (reader_.joinable())
      reader_.join();
  }
  void Open() { Start(); }
  void Close() override {
    closed_ = true;
    wake_.notify_all();
    std::lock_guard lock(send_mutex_);
    if (auto ws = socket.exchange(nullptr))
      WinHttpCloseHandle(ws);
  }
  Result<void> Send(std::span<const uint8_t> bytes) override {
    std::lock_guard lock(send_mutex_);
    if (closed_ || !socket || bytes.size() > kMaxCiphertext)
      return Closed();
    if (WinHttpWebSocketSend(socket.load(), WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE,
                             const_cast<uint8_t*>(bytes.data()), static_cast<DWORD>(bytes.size())))
      return Closed();
    return {};
  }

 private:
  Result<Bytes> Read() override {
    Bytes out;
    std::array<uint8_t, 16384> buffer;
    HINTERNET ws = socket.load();
    while (!closed_) {
      DWORD count = 0;
      WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
      if (WinHttpWebSocketReceive(ws, buffer.data(), static_cast<DWORD>(buffer.size()), &count,
                                  &type))
        return Closed();
      if (type != WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE &&
          type != WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE)
        return Closed();
      if (out.size() + count > kMaxCiphertext)
        return Closed();
      out.insert(out.end(), buffer.begin(), buffer.begin() + count);
      if (type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE)
        return out;
    }
    return Closed();
  }
};
class EncryptedChannel final : public Channel {
 public:
  EncryptedChannel(std::unique_ptr<Carrier> carrier, const TransportKeys& keys, bool initiator)
      : carrier_(std::move(carrier)),
        send_(keys.send),
        receive_(keys.receive),
        initiator_(initiator) {
    worker_ = std::thread([this] { Loop(); });
  }
  ~EncryptedChannel() override {
    Close();
    if (worker_.joinable())
      worker_.join();
  }
  void Close() override {
    closed_ = true;
    carrier_->Close();
    wake_.notify_all();
  }
  Result<void> Send(const Json& message) override { return SendFrame(EncodeJson(message)); }
  Result<void> SendBinary(const Json& header, std::span<const uint8_t> bytes) override {
    return SendFrame(EncodeBinary(header, bytes));
  }
  Result<Message> Receive(std::chrono::milliseconds timeout) override {
    std::unique_lock lock(mutex_);
    if (!wake_.wait_for(lock, timeout, [&] { return closed_ || !queue_.empty(); }))
      return Timeout();
    if (queue_.empty())
      return Closed();
    auto result = std::move(queue_.front());
    queue_.pop_front();
    queued_ -= result.bytes.size() + result.json.dump().size();
    return result;
  }

 private:
  std::unique_ptr<Carrier> carrier_;
  CipherState send_, receive_;
  bool initiator_;
  std::atomic<bool> closed_{false};
  std::mutex send_mutex_, mutex_;
  std::condition_variable wake_;
  std::deque<Message> queue_;
  size_t queued_ = 0;
  std::thread worker_;
  Result<void> SendFrame(Result<Bytes> frame) {
    if (!frame)
      return frame.error();
    std::lock_guard lock(send_mutex_);
    if (closed_)
      return Closed();
    auto wire = send_.Encrypt(frame.value());
    if (!wire) {
      Close();
      return wire.error();
    }
    auto sent = carrier_->Send(wire.value());
    if (!sent)
      Close();
    return sent;
  }
  void Loop() {
    auto last_receive = Clock::now(), last_ping = last_receive;
    while (!closed_) {
      auto now = Clock::now();
      if (now - last_receive >= 45s)
        break;
      if (initiator_ && now - last_ping >= 15s) {
        if (!Send({{"type", "node.ping"}}))
          break;
        last_ping = now;
      }
      auto wire = carrier_->Receive(100ms);
      if (!wire) {
        if (wire.error().code == ErrorCode::kBusy)
          continue;
        break;
      }
      auto plain = receive_.Decrypt(wire.value());
      if (!plain)
        break;
      auto frame = DecodeFrame(plain.value());
      if (!frame)
        break;
      last_receive = Clock::now();
      auto message = std::move(frame).value();
      if (message.kind == Message::Kind::kJson) {
        auto type = message.json.find("type");
        if (type != message.json.end() && *type == "node.pong")
          continue;
        if (type != message.json.end() && *type == "node.ping") {
          if (!Send({{"type", "node.pong"}}))
            break;
          continue;
        }
      }
      std::lock_guard lock(mutex_);
      size_t size = message.bytes.size() + message.json.dump().size();
      if (queue_.size() >= 256 || queued_ + size > 16 * kMaxPlaintext)
        break;
      queued_ += size;
      queue_.push_back(std::move(message));
      wake_.notify_all();
    }
    Close();
  }
};
Result<Established> Handshake(std::unique_ptr<Carrier> carrier,
                              const Key& key,
                              Role role,
                              const Hello& hello,
                              const HelloHandler& handler) {
  try {
    Noise noise(role, key);
    auto deadline = Clock::now() + 5s;
    std::mutex deadline_mutex;
    std::condition_variable deadline_wake;
    bool finished = false;
    Carrier* pending = carrier.get();
    std::jthread watchdog([&] {
      std::unique_lock lock(deadline_mutex);
      if (!deadline_wake.wait_until(lock, deadline, [&] { return finished; }))
        pending->Close();
    });
    struct FinishDeadline {
      std::mutex& mutex;
      std::condition_variable& wake;
      bool& finished;
      ~FinishDeadline() {
        std::lock_guard lock(mutex);
        finished = true;
        wake.notify_all();
      }
    } finish{deadline_mutex, deadline_wake, finished};
    Json reply;
    if (role == Role::kInitiator) {
      Json json = {{"type", "node.hello"},
                   {"role", hello.role},
                   {"nodeId", hello.node_id},
                   {"buildId", hello.build_id}};
      if (hello.role == "endpoint")
        json["incarnation"] = hello.incarnation;
      auto text = json.dump();
      auto wire = noise.Write({reinterpret_cast<const uint8_t*>(text.data()), text.size()});
      if (!wire) {
        carrier->Close();
        return wire.error();
      }
      auto sent = carrier->Send(wire.value());
      if (!sent) {
        carrier->Close();
        return sent.error();
      }
      auto response = carrier->Receive(
          std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()));
      if (!response) {
        carrier->Close();
        return response.error();
      }
      auto plain = noise.Read(response.value());
      if (!plain) {
        carrier->Close();
        return plain.error();
      }
      reply = Json::parse(plain.value(), nullptr, false);
    } else {
      auto wire = carrier->Receive(5s);
      if (!wire) {
        carrier->Close();
        return wire.error();
      }
      auto plain = noise.Read(wire.value());
      if (!plain) {
        carrier->Close();
        return plain.error();
      }
      auto parsed = Json::parse(plain.value(), nullptr, false);
      if (!parsed.is_object()) {
        carrier->Close();
        return Error{ErrorCode::kInvalidRequest, "invalid hello payload"};
      }
      auto response = handler(parsed);
      if (!response) {
        carrier->Close();
        return response.error();
      }
      reply = std::move(response).value();
      auto text = reply.dump();
      auto response_wire =
          noise.Write({reinterpret_cast<const uint8_t*>(text.data()), text.size()});
      if (!response_wire) {
        carrier->Close();
        return response_wire.error();
      }
      auto sent = carrier->Send(response_wire.value());
      if (!sent) {
        carrier->Close();
        return sent.error();
      }
    }
    if (Clock::now() > deadline) {
      carrier->Close();
      return Error{ErrorCode::kUnavailable, "Cluster handshake deadline exceeded"};
    }
    if (!reply.is_object() || !reply.contains("type") || !reply["type"].is_string() ||
        (reply["type"] != "node.ready" && reply["type"] != "node.release" &&
         reply["type"] != "node.reject")) {
      carrier->Close();
      return Error{ErrorCode::kInternal, "Invalid cluster handshake reply"};
    }
    auto keys = noise.Split();
    if (!keys) {
      carrier->Close();
      return keys.error();
    }
    {
      std::lock_guard lock(deadline_mutex);
      finished = true;
      deadline_wake.notify_all();
    }
    watchdog.join();
    auto channel = std::make_unique<EncryptedChannel>(std::move(carrier), keys.value(),
                                                      role == Role::kInitiator);
    if (reply["type"] == "node.reject")
      channel->Close();
    return Established{std::move(channel), std::move(reply)};
  } catch (const std::exception& error) {
    if (carrier)
      carrier->Close();
    return Error{ErrorCode::kInternal, error.what()};
  }
}
}  // namespace
std::unique_ptr<Carrier> HandleCarrier(void* read, void* write) {
  return std::make_unique<Pipes>(read, write);
}
Result<Established> ConnectCarrier(std::unique_ptr<Carrier> carrier,
                                   const Key& key,
                                   const Hello& hello) {
  return Handshake(std::move(carrier), key, Role::kInitiator, hello, {});
}
Result<Established> AcceptCarrier(std::unique_ptr<Carrier> carrier,
                                  const Key& key,
                                  const HelloHandler& handler) {
  return Handshake(std::move(carrier), key, Role::kResponder, {}, handler);
}
Result<Established> ConnectStdio(const Key& key, const Hello& hello) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  HANDLE read = nullptr, write = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_INPUT_HANDLE), GetCurrentProcess(),
                       &read, 0, FALSE, DUPLICATE_SAME_ACCESS))
    return Closed();
  if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(),
                       &write, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    CloseHandle(read);
    return Closed();
  }
  return ConnectCarrier(HandleCarrier(read, write), key, hello);
}
Error WinHttpFailure(const char* stage) {
  return {ErrorCode::kUnavailable, std::string("cluster connect failed at ") + stage +
                                       ", Win32 error " + std::to_string(GetLastError())};
}
Result<Established> ConnectWebSocket(const std::string& url, const Key& key, const Hello& hello) {
  auto address = ParseControlUrl(url);
  if (!address)
    return address.error();
  bool tls = address.value().secure;
  auto ws = std::make_unique<WebSocket>();
  ws->session.value = WinHttpOpen(
      L"RemoteKit Node", tls ? WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY : WINHTTP_ACCESS_TYPE_NO_PROXY,
      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!ws->session.value)
    return WinHttpFailure("open");
  WinHttpSetTimeouts(ws->session.value, 5000, 5000, 5000, 5000);
  ws->connection.value =
      WinHttpConnect(ws->session.value, address.value().host.c_str(), address.value().port, 0);
  if (!ws->connection.value)
    return WinHttpFailure("connect");
  HttpHandle request{WinHttpOpenRequest(ws->connection.value, L"GET", L"/api/node", nullptr,
                                        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                        tls ? WINHTTP_FLAG_SECURE : 0)};
  if (!request.value)
    return WinHttpFailure("request");
  DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
  if (!WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirects,
                        sizeof(redirects)) ||
      !WinHttpSetOption(request.value, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0))
    return WinHttpFailure("options");
  // The Noise handshake authenticates Control with the cluster key, so the TLS layer is only
  // transport cover: self-signed, private-CA and mismatched-name certificates are accepted.
  if (tls) {
    DWORD ignored = SECURITY_FLAG_IGNORE_UNKNOWN_CA | SECURITY_FLAG_IGNORE_CERT_DATE_INVALID |
                    SECURITY_FLAG_IGNORE_CERT_CN_INVALID | SECURITY_FLAG_IGNORE_CERT_WRONG_USAGE;
    if (!WinHttpSetOption(request.value, WINHTTP_OPTION_SECURITY_FLAGS, &ignored,
                          sizeof(ignored)))
      return WinHttpFailure("tls options");
  }
  if (!WinHttpSendRequest(request.value, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA,
                          0, 0, 0))
    return WinHttpFailure(tls ? "send request (TLS or network)" : "send request");
  if (!WinHttpReceiveResponse(request.value, nullptr))
    return WinHttpFailure("receive response");
  DWORD status = 0, size = sizeof(status);
  if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                           WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX))
    return WinHttpFailure("query status");
  if (status != 101)
    return Error{ErrorCode::kUnavailable,
                 "cluster connect: HTTP " + std::to_string(status) + " instead of 101 upgrade"};
  ws->socket = WinHttpWebSocketCompleteUpgrade(request.value, 0);
  if (!ws->socket)
    return WinHttpFailure("websocket upgrade");
  DWORD timeout = 5000;
  WinHttpSetOption(ws->socket, WINHTTP_OPTION_SEND_TIMEOUT, &timeout, sizeof(timeout));
  timeout = 60000;
  WinHttpSetOption(ws->socket, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));
  ws->Open();
  auto established = ConnectCarrier(std::move(ws), key, hello);
  if (!established && established.error().message == "cluster channel closed")
    return Error{ErrorCode::kUnavailable,
                 "Control closed the connection during the cluster handshake "
                 "(cluster key mismatch with Control, or not a RemoteKit Control endpoint)"};
  return established;
}
}  // namespace remotekit::cluster
