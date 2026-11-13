#include "cluster/channel.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <atomic>
#include <future>
#include <iostream>
#include <stdexcept>
#include <source_location>
#include <thread>
using namespace remotekit;
using namespace remotekit::cluster;
using namespace std::chrono_literals;
namespace {
void Check(bool value, const std::source_location location = std::source_location::current()) {
  if (!value)
    throw std::runtime_error("cluster channel assertion failed at line " +
                             std::to_string(location.line()));
}
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}
void Take(Result<void> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
}
Key TestKey() {
  Key key;
  key.fill(7);
  return key;
}
Json Ready(const Json& hello, const Key& public_key) {
  Check(hello.value("type", "") == "node.hello");
  Key initiator;
  initiator.fill(6);
  Check(public_key == PublicKey(initiator));
  return {{"type", "node.ready"}};
}
std::pair<std::unique_ptr<Carrier>, std::unique_ptr<Carrier>> Pair() {
  HANDLE ar, aw, br, bw;
  Check(CreatePipe(&ar, &bw, nullptr, 65536) != FALSE);
  Check(CreatePipe(&br, &aw, nullptr, 65536) != FALSE);
  return {HandleCarrier(ar, aw), HandleCarrier(br, bw)};
}
class Tamper final : public Carrier {
 public:
  explicit Tamper(std::unique_ptr<Carrier> inner) : inner_(std::move(inner)) {}
  bool tamper = false;
  std::atomic<bool> drop{false};
  Result<void> Send(std::span<const uint8_t> bytes) override {
    if (drop)
      return {};
    Bytes copy(bytes.begin(), bytes.end());
    if (tamper)
      copy.back() ^= 1;
    return inner_->Send(copy);
  }
  Result<Bytes> Receive(std::chrono::milliseconds timeout) override {
    return inner_->Receive(timeout);
  }
  void Close() override { inner_->Close(); }

 private:
  std::unique_ptr<Carrier> inner_;
};
void NativeTests() {
  auto [a, b] = Pair();
  auto altered = std::make_unique<Tamper>(std::move(a));
  auto* raw = altered.get();
  auto responder =
      std::async(std::launch::async, [&] { return AcceptCarrier(std::move(b), TestKey(), Ready); });
  auto init = Take(ConnectCarrier(std::move(altered),
                                  [] {
                                    Key key;
                                    key.fill(6);
                                    return key;
                                  }(),
                                  PublicKey(TestKey()),
                                  {"endpoint", "test-node", "dev", std::string(32, '1')}));
  auto resp = Take(responder.get());
  Take(init.channel->Send({{"value", 42}}));
  Check(Take(resp.channel->Receive(2s)).json["value"].get<int>() == 42);
  Take(resp.channel->Send({{"type", "node.ping"}}));
  Take(resp.channel->Send({{"afterPing", true}}));
  Check(Take(init.channel->Receive(2s)).json.value("afterPing", false));
  auto timeout = resp.channel->Receive(150ms);
  Check(!timeout && timeout.error().code == ErrorCode::kBusy);
  Json header = {{"type", "blob"}};
  size_t n = kMaxPlaintext - 5 - header.dump().size();
  Bytes data(n, 37);
  Take(init.channel->SendBinary(header, data));
  auto binary = Take(resp.channel->Receive(5s));
  Check(binary.kind == Message::Kind::kBinary && binary.bytes == data);
  data.push_back(0);
  auto oversized = init.channel->SendBinary(header, data);
  Check(!oversized && oversized.error().code == ErrorCode::kLimitExceeded);
  auto json_limit = init.channel->Send({{"large", std::string(kMaxJson, 'x')}});
  Check(!json_limit);
  const Json clipboard{{"event", "session.event"},
                       {"type", "clipboard.changed"},
                       {"tenantId", "tenant"},
                       {"sessionId", "session"},
                       {"browserSequence", "1"},
                       {"text", std::string(1024 * 1024, 't')},
                       {"html", std::string(2 * 1024 * 1024, 'h')}};
  Take(init.channel->Send(clipboard));
  Check(Take(resp.channel->Receive(5s)).json == clipboard);
  const Json seed{{"method", "session.desired"},
                  {"clipboard",
                   {{"revision", "1"},
                    {"text", std::string(128 * 1024, '\x01')},
                    {"html", std::string(256 * 1024, '\x01')}}}};
  Take(resp.channel->Send(seed));
  Check(Take(init.channel->Receive(5s)).json == seed);
  auto oversized_clipboard = clipboard;
  oversized_clipboard["text"] = std::string(4 * 1024 * 1024, 't');
  Check(!init.channel->Send(oversized_clipboard));
  raw->tamper = true;
  Take(init.channel->Send({{"tampered", true}}));
  auto closed = resp.channel->Receive(2s);
  Check(!closed && closed.error().code == ErrorCode::kUnavailable);
  Check(resp.channel->Cause().reason == "decrypt_failure");
  init.channel->Close();
  resp.channel->Close();
  auto [c, d] = Pair();
  auto rejected = std::async(std::launch::async, [&] {
    return AcceptCarrier(std::move(d), TestKey(), [](const Json&, const Key&) -> Result<Json> {
      return Json{{"type", "node.reject"}, {"code", "no_release"}};
    });
  });
  auto reject = Take(ConnectCarrier(std::move(c), TestKey(), PublicKey(TestKey()),
                                    {"updater", "test-node", "dev", {}}));
  Check(reject.reply.value("type", "") == "node.reject");
  auto unavailable = reject.channel->Receive(0ms);
  Check(!unavailable && unavailable.error().code == ErrorCode::kUnavailable);
  Take(rejected.get());
  auto [e, f] = Pair();
  auto wrong = std::async(std::launch::async, [&] {
    Key bad{};
    return AcceptCarrier(std::move(f), bad, Ready);
  });
  Check(!ConnectCarrier(std::move(e), TestKey(), PublicKey(TestKey()),
                        {"updater", "test-node", "dev", {}}));
  Check(!wrong.get());
  Check(!DecodeFrame(Bytes{3}));
  Check(!DecodeFrame(Bytes{2, 255, 255, 255, 255}));
  Check(!DecodeKey(std::string(44, 'A')));
  Check(!ParseControlUrl("ws://user@host/api/node"));
  Check(!ParseControlUrl("ws://host/other"));
  Check(static_cast<bool>(ParseControlUrl("ws://nonloopback.example/api/node")));
  Check(!ParseControlUrl("ws://host:invalid/api/node"));
  Check(!ParseControlUrl("ws://:123/api/node"));
  HANDLE read, remote_write, write, remote_read;
  Check(CreatePipe(&read, &remote_write, nullptr, 0) != FALSE);
  Check(CreatePipe(&remote_read, &write, nullptr, 0) != FALSE);
  auto blocked = HandleCarrier(read, write);
  auto send =
      std::async(std::launch::async, [&] { return blocked->Send(Bytes(kMaxPlaintext, 1)); });
  Check(send.wait_for(5500ms) == std::future_status::timeout);
  Check(blocked->Cause().reason.empty());
  blocked->Close();
  Check(send.wait_for(1s) == std::future_status::ready);
  Check(!send.get());
  Check(blocked->Cause().reason == "local_close");
  CloseHandle(remote_read);
  CloseHandle(remote_write);
  auto [eof_reader, eof_peer] = Pair();
  eof_peer->Close();
  Check(!eof_reader->Receive(2s));
  Check(eof_reader->Cause().reason == "read_eof");
  eof_reader->Close();
  Check(eof_reader->Cause().reason == "read_eof");
  Check(CreatePipe(&read, &remote_write, nullptr, 0) != FALSE);
  Check(CreatePipe(&remote_read, &write, nullptr, 0) != FALSE);
  auto broken_write = HandleCarrier(read, write);
  CloseHandle(remote_read);
  Check(!broken_write->Send(Bytes(32, 1)));
  Check(broken_write->Cause().reason == "write_error");
  const auto write_error = broken_write->Cause().detail.at("win32");
  Check(write_error == ERROR_BROKEN_PIPE || write_error == ERROR_NO_DATA);
  broken_write->Close();
  CloseHandle(remote_write);
}
void CarrierBackpressure(bool bytes) {
  auto [sender, receiver] = Pair();
  const size_t payload = bytes ? kMaxCiphertext : 4096;
  const size_t count =
      bytes ? limits::managementQueueBytes / payload + 3 : limits::managementQueueMessages + 64;
  auto sending = std::async(std::launch::async, [&] {
    for (size_t i = 0; i < count; ++i)
      Take(sender->Send(Bytes(payload, static_cast<uint8_t>(i))));
  });
  Check(sending.wait_for(500ms) == std::future_status::timeout);
  Check(receiver->Cause().reason.empty());
  for (size_t i = 0; i < count; ++i) {
    const auto received = Take(receiver->Receive(5s));
    Check(received.size() == payload && received.front() == static_cast<uint8_t>(i));
  }
  sending.get();
  Check(receiver->Cause().reason.empty());
}
void ChannelBackpressure(bool bytes) {
  auto [a, b] = Pair();
  auto responder = std::async(std::launch::async, [&] {
    return AcceptCarrier(std::move(b), TestKey(), [](const Json&, const Key&) -> Result<Json> {
      return Json{{"type", "node.ready"}};
    });
  });
  auto init = Take(ConnectCarrier(std::move(a), TestKey(), PublicKey(TestKey()),
                                  {"endpoint", "test-node", "dev", std::string(32, '1')}));
  auto resp = Take(responder.get());
  Json message{{"event", "session.event"}, {"padding", ""}};
  if (bytes)
    message["padding"] = std::string(limits::documentBytes - message.dump().size(), 'x');
  const size_t count = bytes ? 2 * limits::managementQueueBytes / message.dump().size() + 4
                             : limits::managementQueueMessages + 2;
  auto sending = std::async(std::launch::async, [&] {
    for (size_t i = 0; i < count; ++i)
      Take(resp.channel->Send(message));
  });
  // The initiator must continue pinging while its downstream consumer is paused.
  std::this_thread::sleep_for(bytes ? 66s : 46s);
  if (bytes)
    Check(sending.wait_for(0ms) == std::future_status::timeout);
  Check(init.channel->Cause().reason.empty() && resp.channel->Cause().reason.empty());
  for (size_t i = 0; i < count; ++i)
    Check(Take(init.channel->Receive(5s)).json == message);
  sending.get();
  Take(resp.channel->Send({{"resumed", true}}));
  Check(Take(init.channel->Receive(5s)).json["resumed"] == true);
}
void HeartbeatSilence() {
  auto [a, b] = Pair();
  auto dropping = std::make_unique<Tamper>(std::move(a));
  auto* dropper = dropping.get();
  auto responder = std::async(std::launch::async, [&] {
    return AcceptCarrier(std::move(b), TestKey(), [](const Json&, const Key&) -> Result<Json> {
      return Json{{"type", "node.ready"}};
    });
  });
  auto init = Take(ConnectCarrier(std::move(dropping), TestKey(), PublicKey(TestKey()),
                                  {"endpoint", "test-node", "dev", std::string(32, '1')}));
  auto resp = Take(responder.get());
  dropper->drop = true;
  Check(!resp.channel->Receive(47s));
  const auto cause = resp.channel->Cause();
  Check(cause.reason == "heartbeat_silence" && cause.detail.at("silentMs") >= 45000);
}
}  // namespace
int main(int argc, char** argv) {
  try {
    if (argc == 1) {
      NativeTests();
      CarrierBackpressure(false);
      CarrierBackpressure(true);
      auto byte_pressure = std::async(std::launch::async, [] { ChannelBackpressure(true); });
      auto silence = std::async(std::launch::async, HeartbeatSilence);
      ChannelBackpressure(false);
      byte_pressure.get();
      silence.get();
      return 0;
    }
    Result<Established> connection = Error{ErrorCode::kInternal, "not connected"};
    std::string mode = argv[1];
    if (mode == "responder") {
      HANDLE read = nullptr, write = nullptr;
      Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_INPUT_HANDLE),
                            GetCurrentProcess(), &read, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE);
      Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE),
                            GetCurrentProcess(), &write, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE);
      connection = AcceptCarrier(HandleCarrier(read, write), TestKey(), Ready);
    } else if (argc == 3)
      connection = ConnectWebSocket(argv[2],
                                    [] {
                                      Key key;
                                      key.fill(6);
                                      return key;
                                    }(),
                                    PublicKey(TestKey()),
                                    {"endpoint", "test-node", "dev", std::string(32, '1')});
    else
      connection = ConnectStdio(
          [] {
            Key key;
            key.fill(6);
            return key;
          }(),
          PublicKey(TestKey()), {"endpoint", "test-node", "dev", std::string(32, '1')});
    auto established = Take(std::move(connection));
    if (mode == "reject") {
      Check(established.reply.value("type", "") == "node.reject");
      Check(!established.channel->Receive(0ms));
      return 0;
    }
    auto& channel = *established.channel;
    Take(channel.Send({{"side", "cpp"}}));
    Check(Take(channel.Receive(5s)).json.value("side", "") == "node");
    auto blob = Take(channel.Receive(10s));
    Check(blob.kind == Message::Kind::kBinary);
    Check(blob.bytes.size() == kMaxPlaintext - 5 - blob.json.dump().size());
    Take(channel.SendBinary(blob.json, blob.bytes));
    Take(channel.Send({{"done", true}}));
    auto end = Take(channel.Receive(25s));
    Check(end.json.value("stop", false));
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
