#include "cluster/channel.hpp"
#include "cluster/node_files.hpp"
#include "cluster/stream_socket.hpp"
#include <windows.h>
#include <bcrypt.h>
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
        if (queue_.size() >= limits::queuedMessages ||
            queued_ + message.value().size() > 16 * kMaxCiphertext)
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
bool RandomBytes(std::span<uint8_t> out) {
  return BCryptGenRandom(nullptr, out.data(), static_cast<ULONG>(out.size()),
                         BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
}
std::string Base64(std::span<const uint8_t> bytes) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    uint32_t chunk = bytes[i] << 16 | (i + 1 < bytes.size() ? bytes[i + 1] << 8 : 0) |
                     (i + 2 < bytes.size() ? bytes[i + 2] : 0);
    out += kAlphabet[chunk >> 18 & 63];
    out += kAlphabet[chunk >> 12 & 63];
    out += i + 1 < bytes.size() ? kAlphabet[chunk >> 6 & 63] : '=';
    out += i + 2 < bytes.size() ? kAlphabet[chunk & 63] : '=';
  }
  return out;
}
// RFC 6455 client over a StreamSocket: one binary message per Noise message.
class WebSocket final : public BufferedCarrier {
 public:
  std::unique_ptr<StreamSocket> stream;
  Bytes pending;
  ~WebSocket() override {
    Close();
    if (reader_.joinable())
      reader_.join();
  }
  void Open() { Start(); }
  void Close() override {
    closed_ = true;
    wake_.notify_all();
    if (stream)
      stream->Shutdown();
  }
  Result<void> Send(std::span<const uint8_t> bytes) override {
    if (bytes.size() > kMaxCiphertext)
      return Closed();
    return SendFrame(0x2, bytes);
  }

 private:
  Result<void> SendFrame(uint8_t opcode, std::span<const uint8_t> payload) {
    std::lock_guard lock(send_mutex_);
    if (closed_)
      return Closed();
    Bytes frame{static_cast<uint8_t>(0x80 | opcode)};
    if (payload.size() < 126) {
      frame.push_back(0x80 | static_cast<uint8_t>(payload.size()));
    } else if (payload.size() <= 0xFFFF) {
      frame.push_back(0x80 | 126);
      frame.push_back(static_cast<uint8_t>(payload.size() >> 8));
      frame.push_back(static_cast<uint8_t>(payload.size()));
    } else {
      frame.push_back(0x80 | 127);
      for (int shift = 56; shift >= 0; shift -= 8)
        frame.push_back(static_cast<uint8_t>(static_cast<uint64_t>(payload.size()) >> shift));
    }
    std::array<uint8_t, 4> mask;
    if (!RandomBytes(mask))
      return Closed();
    frame.insert(frame.end(), mask.begin(), mask.end());
    for (size_t i = 0; i < payload.size(); ++i)
      frame.push_back(payload[i] ^ mask[i % 4]);
    if (!stream->WriteAll(frame))
      return Closed();
    return {};
  }
  bool ReadExact(std::span<uint8_t> out) {
    while (!out.empty()) {
      if (!pending.empty()) {
        size_t n = std::min(out.size(), pending.size());
        std::copy_n(pending.begin(), n, out.begin());
        pending.erase(pending.begin(), pending.begin() + n);
        out = out.subspan(n);
        continue;
      }
      auto n = stream->Read(out);
      if (!n)
        return false;
      out = out.subspan(n.value());
    }
    return true;
  }
  Result<Bytes> Read() override {
    Bytes message;
    bool started = false;
    while (!closed_) {
      std::array<uint8_t, 2> head;
      if (!ReadExact(head))
        return Closed();
      bool fin = head[0] & 0x80;
      uint8_t opcode = head[0] & 0x0F;
      uint64_t length = head[1] & 0x7F;
      if ((head[0] & 0x70) || (head[1] & 0x80))
        return Closed();
      int extension = length == 126 ? 2 : length == 127 ? 8 : 0;
      if (extension) {
        std::array<uint8_t, 8> size{};
        if (!ReadExact(std::span(size).first(extension)))
          return Closed();
        length = 0;
        for (int i = 0; i < extension; ++i)
          length = length << 8 | size[i];
      }
      if (length > kMaxCiphertext)
        return Closed();
      Bytes payload(static_cast<size_t>(length));
      if (!ReadExact(payload))
        return Closed();
      if (opcode == 0x9) {
        if (!SendFrame(0xA, payload))
          return Closed();
        continue;
      }
      if (opcode == 0xA)
        continue;
      if (opcode != 0x2 && opcode != 0x0)
        return Closed();
      if ((opcode == 0x2) == started)
        return Closed();
      started = true;
      if (message.size() + payload.size() > kMaxCiphertext)
        return Closed();
      message.insert(message.end(), payload.begin(), payload.end());
      if (fin)
        return message;
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
      if (queue_.size() >= limits::queuedMessages || queued_ + size > 16 * kMaxPlaintext)
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
                              std::optional<Key> responder_public_key,
                              Role role,
                              const Hello& hello,
                              const HelloHandler& handler) {
  try {
    Noise noise(role, key, responder_public_key);
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
      auto response = handler(parsed, noise.remote_public_key());
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
                                   const Key& responder_public_key,
                                   const Hello& hello) {
  return Handshake(std::move(carrier), key, responder_public_key, Role::kInitiator, hello, {});
}
Result<Established> AcceptCarrier(std::unique_ptr<Carrier> carrier,
                                  const Key& key,
                                  const HelloHandler& handler) {
  return Handshake(std::move(carrier), key, {}, Role::kResponder, {}, handler);
}
Result<Established> ConnectStdio(const Key& key,
                                 const Key& responder_public_key,
                                 const Hello& hello) {
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
  return ConnectCarrier(HandleCarrier(read, write), key, responder_public_key, hello);
}
Result<Established> ConnectWebSocket(const std::string& url,
                                     const Key& key,
                                     const Key& responder_public_key,
                                     const Hello& hello) {
  auto address = ParseControlUrl(url);
  if (!address)
    return address.error();
  auto stream = ConnectStream(address.value().host, address.value().port, address.value().secure);
  if (!stream)
    return stream.error();
  int length = WideCharToMultiByte(CP_UTF8, 0, address.value().host.c_str(), -1, nullptr, 0,
                                   nullptr, nullptr);
  std::string host(length > 0 ? length - 1 : 0, '\0');
  WideCharToMultiByte(CP_UTF8, 0, address.value().host.c_str(), -1, host.data(), length, nullptr,
                      nullptr);
  if (host.find(':') != std::string::npos && !host.starts_with('['))
    host = "[" + host + "]";
  std::array<uint8_t, 16> nonce;
  if (!RandomBytes(nonce))
    return Closed();
  std::string request =
      "GET /api/node HTTP/1.1\r\nHost: " + host + ":" + std::to_string(address.value().port) +
      "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + Base64(nonce) +
      "\r\nSec-WebSocket-Version: 13\r\n\r\n";
  if (!stream.value()->WriteAll({reinterpret_cast<const uint8_t*>(request.data()), request.size()}))
    return Error{ErrorCode::kUnavailable, "cluster connect failed sending the upgrade request"};
  std::string response;
  std::array<uint8_t, 4096> chunk;
  size_t end = std::string::npos;
  while ((end = response.find("\r\n\r\n")) == std::string::npos) {
    if (response.size() > 16384)
      return Error{ErrorCode::kUnavailable, "cluster connect: oversized upgrade response"};
    auto n = stream.value()->Read(chunk);
    if (!n)
      return Error{ErrorCode::kUnavailable,
                   "cluster connect: the server closed the connection before answering the "
                   "WebSocket upgrade (not a RemoteKit Control endpoint, or a proxy dropped it)"};
    response.append(reinterpret_cast<const char*>(chunk.data()), n.value());
  }
  if (!response.starts_with("HTTP/1.1 101"))
    return Error{ErrorCode::kUnavailable,
                 "cluster connect: " + response.substr(0, response.find("\r\n")) +
                     " instead of a 101 upgrade"};
  auto ws = std::make_unique<WebSocket>();
  ws->pending.assign(response.begin() + end + 4, response.end());
  stream.value()->SetReceiveTimeout(60s);
  ws->stream = std::move(stream).value();
  ws->Open();
  auto established = ConnectCarrier(std::move(ws), key, responder_public_key, hello);
  if (!established && established.error().message == "cluster channel closed")
    return Error{ErrorCode::kUnavailable,
                 "Control closed the connection during the cluster handshake "
                 "(node identity mismatch with Control, or not a RemoteKit Control endpoint)"};
  return established;
}
}  // namespace remotekit::cluster
