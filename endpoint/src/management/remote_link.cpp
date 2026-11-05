#include "management/remote_link.hpp"
#include "remotekit/thread.hpp"
#include <windows.h>
#include <winhttp.h>
#include <objbase.h>
#include <json.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cwctype>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace remotekit {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr size_t kMaxMessage = 1024 * 1024, kMaxQueuedBytes = 4 * kMaxMessage;
Result<std::string> EndpointIncarnation() {
  GUID value{};
  if (FAILED(CoCreateGuid(&value)))
    return Error{ErrorCode::kUnavailable, "endpoint incarnation generation failed"};
  const auto* bytes = reinterpret_cast<const unsigned char*>(&value);
  std::string result;
  for (size_t i = 0; i < sizeof(value); ++i) {
    result += "0123456789abcdef"[bytes[i] >> 4];
    result += "0123456789abcdef"[bytes[i] & 15];
  }
  return result;
}
Result<std::wstring> Wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0);
  if (!size)
    return Error{ErrorCode::kInvalidRequest, "invalid control configuration encoding"};
  std::wstring result(size, 0);
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                      result.data(), size);
  return result;
}
struct Handle {
  HINTERNET value = nullptr;
  ~Handle() {
    if (value)
      WinHttpCloseHandle(value);
  }
};
}  // namespace
struct RemoteLink::Impl {
  std::wstring host, path, authorization;
  INTERNET_PORT port = 0;
  bool tls = false, stopping = false;
  std::string node;
  std::string endpoint_incarnation;
  std::mutex mutex, socket_mutex, callback_mutex;
  std::condition_variable wake;
  struct Message {
    uint64_t generation;
    std::string bytes;
  };
  std::deque<Message> incoming, outgoing;
  size_t incoming_bytes = 0, outgoing_bytes = 0;
  uint64_t serial = 0, active = 0, link = 0;
  bool sending = false;
  HINTERNET socket = nullptr;
  Clock::time_point last_receive{}, last_ping{};
  std::thread receiver, sender;

  std::function<void(uint64_t)> disconnected;
  Result<void> Initialize(std::string url, std::string id, std::string token) {
    node = std::move(id);
    auto incarnation = EndpointIncarnation();
    if (!incarnation)
      return incarnation.error();
    endpoint_incarnation = std::move(incarnation).value();
    if (node.empty() || node.size() > 128 ||
        !std::all_of(node.begin(), node.end(), [](unsigned char c) {
          return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                 c == '-' || c == '_';
        }))
      return Error{ErrorCode::kInvalidRequest, "remote control requires a valid --node-id"};
    if (token.empty() || token.size() > 4096 ||
        !std::all_of(token.begin(), token.end(),
                     [](unsigned char c) { return c >= 0x21 && c <= 0x7e; }))
      return Error{ErrorCode::kInvalidRequest, "remote control requires REMOTEKIT_ENDPOINT_TOKEN"};
    auto parsed_url = Wide(url);
    if (!parsed_url)
      return parsed_url.error();
    auto wide = std::move(parsed_url).value();
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength =
        parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(wide.c_str(), 0, 0, &parts) || parts.dwUserNameLength ||
        parts.dwPasswordLength || parts.dwExtraInfoLength)
      return Error{ErrorCode::kInvalidRequest, "invalid control URL"};
    host.assign(parts.lpszHostName, parts.dwHostNameLength);
    path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    port = parts.nPort;
    tls = parts.nScheme == INTERNET_SCHEME_HTTPS;
    if ((parts.nScheme != INTERNET_SCHEME_HTTP && !tls) || path != L"/api/endpoint")
      return Error{ErrorCode::kInvalidRequest, "control URL must be http(s)://host/api/endpoint"};
    std::wstring lower = host;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](wchar_t c) { return static_cast<wchar_t>(towlower(c)); });
    // Numeric loopback only: a configurable DNS hostname cannot turn plaintext into remote traffic.
    if (!tls && lower != L"127.0.0.1" && lower != L"::1" && lower != L"[::1]")
      return Error{ErrorCode::kInvalidRequest,
                   "remote control requires TLS; HTTP is limited to numeric loopback"};
    auto parsed_token = Wide(token);
    if (!parsed_token)
      return parsed_token.error();
    authorization = L"Authorization: Bearer " + std::move(parsed_token).value() + L"\r\n";
    return {};
  }
  void Start() {
    receiver = std::thread(
        [this] { RunThread("management receive", [this] { ReceiveLoop(); }, [this] { Fail(); }); });

    sender = std::thread(
        [this] { RunThread("management send", [this] { SendLoop(); }, [this] { Fail(); }); });
  }
  ~Impl() {
    {
      std::unique_lock lock(mutex);
      // Allow the explicit shutdown response to leave the bounded outbox.
      wake.wait_for(lock, std::chrono::seconds(2),
                    [&] { return !active || (outgoing.empty() && !sending); });
      stopping = true;
    }
    wake.notify_all();
    Disconnect();
    if (sender.joinable())
      sender.join();
    if (receiver.joinable())
      receiver.join();
  }
  void Fail() {
    {
      std::lock_guard lock(mutex);
      stopping = true;
    }
    wake.notify_all();
    Disconnect();
  }
  // A sender and receiver may run concurrently per WinHTTP's WebSocket contract.
  // Close is serialized against sends, and cancels the blocking receive.
  void Disconnect(uint64_t expected = 0) {
    std::lock_guard socket_lock(socket_mutex);
    uint64_t lost = 0;
    std::lock_guard callback_lock(callback_mutex);
    ManagementLink::Disconnect callback;
    {
      std::lock_guard lock(mutex);
      if (expected && expected != link)
        return;
      lost = active;
      callback = disconnected;
      active = link = 0;
      incoming.clear();
      outgoing.clear();
      incoming_bytes = outgoing_bytes = 0;
    }
    if (lost && callback)
      callback(lost);
    if (socket) {
      WinHttpCloseHandle(socket);
      socket = nullptr;
    }
    wake.notify_all();
  }
  bool Receive(HINTERNET ws, std::string& result) {
    result.clear();
    std::array<char, 16384> buffer;
    while (true) {
      DWORD count = 0;
      WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
      if (WinHttpWebSocketReceive(ws, buffer.data(), static_cast<DWORD>(buffer.size()), &count,
                                  &type) != NO_ERROR)
        return false;
      if (type != WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE &&
          type != WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)
        return false;
      if (result.size() + count > kMaxMessage)
        return false;
      result.append(buffer.data(), count);
      if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)
        return true;
    }
  }
  void ReceiveLoop() {
    unsigned backoff = 250;
    while (true) {
      {
        std::lock_guard lock(mutex);
        if (stopping)
          return;
      }
      bool ready = false;
      Handle session{
          WinHttpOpen(L"RemoteKit Endpoint/1",
                      tls ? WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY : WINHTTP_ACCESS_TYPE_NO_PROXY,
                      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
      if (session.value) {
        WinHttpSetTimeouts(session.value, 5000, 5000, 5000, 5000);
        Handle connection{WinHttpConnect(session.value, host.c_str(), port, 0)};
        Handle request{connection.value
                           ? WinHttpOpenRequest(connection.value, L"GET", path.c_str(), nullptr,
                                                WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                tls ? WINHTTP_FLAG_SECURE : 0)
                           : nullptr};
        DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        if (request.value &&
            WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirects,
                             sizeof(redirects)) &&
            WinHttpSetOption(request.value, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) &&
            WinHttpSendRequest(request.value, authorization.c_str(),
                               static_cast<DWORD>(authorization.size()), WINHTTP_NO_REQUEST_DATA, 0,
                               0, 0) &&
            WinHttpReceiveResponse(request.value, nullptr)) {
          DWORD status = 0, size = sizeof(status);
          if (WinHttpQueryHeaders(
                  request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                  WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) &&
              status == 101) {
            HINTERNET ws = WinHttpWebSocketCompleteUpgrade(request.value, 0);
            if (ws) {
              DWORD receive_timeout = 60000, keepalive = 15000;
              WinHttpSetOption(ws, WINHTTP_OPTION_RECEIVE_TIMEOUT, &receive_timeout,
                               sizeof(receive_timeout));
              WinHttpSetOption(ws, WINHTTP_OPTION_WEB_SOCKET_KEEPALIVE_INTERVAL, &keepalive,
                               sizeof(keepalive));
              {
                std::lock_guard socket_lock(socket_mutex);
                std::lock_guard lock(mutex);
                if (stopping) {
                  WinHttpCloseHandle(ws);
                  return;
                }
                socket = ws;
                link = ++serial;
                last_receive = Clock::now();
              }
              auto hello = Json({{"type", "node.hello"},
                                 {"version", 1},
                                 {"nodeId", node},
                                 {"endpointIncarnation", endpoint_incarnation}})
                               .dump();
              DWORD error;
              {
                std::lock_guard socket_lock(socket_mutex);
                error = socket ? WinHttpWebSocketSend(
                                     socket, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                     hello.data(), static_cast<DWORD>(hello.size()))
                               : ERROR_OPERATION_ABORTED;
              }
              std::string bytes;
              if (!error && Receive(ws, bytes)) {
                auto message = Json::parse(bytes, nullptr, false);
                if (message.is_object() && message.contains("type") &&
                    message["type"] == "node.ready" && message.contains("version") &&
                    message["version"] == 1 && message.contains("connectionEpoch") &&
                    message["connectionEpoch"].is_string() &&
                    !message["connectionEpoch"].get<std::string>().empty()) {
                  {
                    std::lock_guard lock(mutex);
                    active = link;
                    last_receive = last_ping = Clock::now();
                  }
                  ready = true;
                  wake.notify_all();
                  while (Receive(ws, bytes)) {
                    auto parsed = Json::parse(bytes, nullptr, false);
                    if (!parsed.is_object())
                      break;
                    std::lock_guard lock(mutex);
                    last_receive = Clock::now();
                    if (parsed.contains("type") && parsed["type"] == "node.pong")
                      continue;
                    if (stopping || !active || incoming.size() >= 256 ||
                        incoming_bytes + bytes.size() > kMaxQueuedBytes)
                      break;
                    incoming_bytes += bytes.size();
                    incoming.push_back({active, std::move(bytes)});
                    wake.notify_all();
                  }
                }
              }
            }
          }
        }
      }
      Disconnect();
      std::unique_lock lock(mutex);
      if (stopping)
        return;
      if (ready)
        backoff = 250;
      // Jitter prevents identically configured nodes reconnecting in lockstep.
      const unsigned delay = backoff + (GetTickCount() % 251);
      wake.wait_for(lock, std::chrono::milliseconds(delay), [&] { return stopping; });
      backoff = std::min(backoff * 2, 15000u);
    }
  }
  void SendLoop() {
    while (true) {
      Message message{};
      bool expired = false;
      uint64_t observed_link = 0;
      {
        std::unique_lock lock(mutex);
        wake.wait_for(lock, std::chrono::seconds(1), [&] { return stopping || !outgoing.empty(); });
        if (stopping)
          return;
        if (!link)
          continue;
        observed_link = link;
        expired = Clock::now() - last_receive >
                  (active ? std::chrono::seconds(45) : std::chrono::seconds(10));
        if (!active && !expired)
          continue;
        if (Clock::now() - last_ping > std::chrono::seconds(15)) {
          message = {active, "{\"type\":\"node.ping\"}"};
          last_ping = Clock::now();
          sending = true;
        } else if (!outgoing.empty()) {
          message = std::move(outgoing.front());
          outgoing.pop_front();
          outgoing_bytes -= message.bytes.size();
          sending = true;
        }
      }
      if (expired) {
        {
          std::lock_guard lock(mutex);
          sending = false;
        }
        Disconnect(observed_link);
        continue;
      }
      if (message.bytes.empty())
        continue;
      bool failed = false;
      {
        std::lock_guard socket_lock(socket_mutex);
        bool current;
        {
          std::lock_guard lock(mutex);
          current = active && active == message.generation;
        }
        if (socket && current) {
          failed = WinHttpWebSocketSend(socket, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                        message.bytes.data(),
                                        static_cast<DWORD>(message.bytes.size())) != NO_ERROR;
        }
      }
      {
        std::lock_guard lock(mutex);
        sending = false;
      }
      wake.notify_all();
      if (failed)
        Disconnect(observed_link);
    }
  }
};
RemoteLink::RemoteLink(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
Result<std::unique_ptr<RemoteLink>> RemoteLink::Create(std::string url,
                                                       std::string node,
                                                       std::string token) {
  auto impl = std::make_unique<Impl>();
  auto initialized = impl->Initialize(std::move(url), std::move(node), std::move(token));
  if (!initialized)
    return initialized.error();
  impl->Start();
  return std::unique_ptr<RemoteLink>(new RemoteLink(std::move(impl)));
}
RemoteLink::~RemoteLink() = default;
bool RemoteLink::Next(std::string& message, uint64_t& generation, bool& eof) {
  eof = false;
  std::unique_lock lock(impl_->mutex);
  impl_->wake.wait_for(lock, std::chrono::milliseconds(20),
                       [&] { return impl_->stopping || !impl_->incoming.empty(); });
  eof = impl_->stopping;
  if (impl_->incoming.empty())
    return false;
  auto next = std::move(impl_->incoming.front());
  impl_->incoming.pop_front();
  impl_->incoming_bytes -= next.bytes.size();
  message = std::move(next.bytes);
  generation = next.generation;
  return true;
}
bool RemoteLink::Current(uint64_t generation) {
  std::lock_guard lock(impl_->mutex);
  return generation && impl_->active == generation;
}
bool RemoteLink::TrySend(std::string message, uint64_t generation) {
  bool accepted = false;
  {
    std::lock_guard lock(impl_->mutex);
    if (!generation || !impl_->active || generation != impl_->active)
      return false;
    if (message.size() > kMaxMessage || impl_->outgoing.size() >= 256 ||
        impl_->outgoing_bytes + message.size() > kMaxQueuedBytes) {
      impl_->last_receive = Clock::time_point{};
    } else {
      impl_->outgoing_bytes += message.size();
      impl_->outgoing.push_back({impl_->active, std::move(message)});
      accepted = true;
    }
  }
  // Never block the service dispatcher on network IO, including overload close.
  impl_->wake.notify_all();
  return accepted;
}
bool RemoteLink::SendReply(uint64_t generation, const Json& reply) {
  return TrySend(reply.dump(), generation);
}
bool RemoteLink::SendEvent(const Json& event, uint64_t generation) {
  return TrySend(event.dump(), generation);
}
void RemoteLink::OnDisconnect(Disconnect callback) {
  std::lock_guard callback_lock(impl_->callback_mutex);
  std::lock_guard lock(impl_->mutex);
  impl_->disconnected = std::move(callback);
}
}  // namespace remotekit
