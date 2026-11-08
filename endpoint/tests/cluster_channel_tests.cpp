#include "cluster/channel.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <future>
#include <iostream>
#include <stdexcept>
using namespace remotekit;
using namespace remotekit::cluster;
using namespace std::chrono_literals;
namespace {
void Check(bool value) {
  if (!value)
    throw std::runtime_error("cluster channel assertion failed");
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
Json Ready(const Json& hello) {
  Check(hello.value("type", "") == "node.hello");
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
  Result<void> Send(std::span<const uint8_t> bytes) override {
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
  auto init = Take(ConnectCarrier(std::move(altered), TestKey(),
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
  const Json clipboard{{"type", "clipboard.changed"},
                       {"tenantId", "tenant"},
                       {"sessionId", "session"},
                       {"browserSequence", "1"},
                       {"text", std::string(1024 * 1024, 't')},
                       {"html", std::string(2 * 1024 * 1024, 'h')}};
  Take(init.channel->Send(clipboard));
  Check(Take(resp.channel->Receive(5s)).json == clipboard);
  const Json seed{{"method", "session.ensure"},
                  {"clipboard",
                   {{"revision", "1"},
                    {"text", std::string(1024 * 1024, '\x01')},
                    {"html", std::string(2 * 1024 * 1024, '\x01')}}}};
  Take(resp.channel->Send(seed));
  Check(Take(init.channel->Receive(5s)).json == seed);
  auto oversized_clipboard = clipboard;
  oversized_clipboard["text"] = std::string(4 * 1024 * 1024, 't');
  Check(!init.channel->Send(oversized_clipboard));
  raw->tamper = true;
  Take(init.channel->Send({{"tampered", true}}));
  auto closed = resp.channel->Receive(2s);
  Check(!closed && closed.error().code == ErrorCode::kUnavailable);
  init.channel->Close();
  resp.channel->Close();
  auto [c, d] = Pair();
  auto rejected = std::async(std::launch::async, [&] {
    return AcceptCarrier(std::move(d), TestKey(), [](const Json&) -> Result<Json> {
      return Json{{"type", "node.reject"}, {"code", "unknown_node"}};
    });
  });
  auto reject = Take(ConnectCarrier(std::move(c), TestKey(), {"updater", "test-node", "dev", {}}));
  Check(reject.reply.value("type", "") == "node.reject");
  auto unavailable = reject.channel->Receive(0ms);
  Check(!unavailable && unavailable.error().code == ErrorCode::kUnavailable);
  Take(rejected.get());
  auto [e, f] = Pair();
  auto wrong = std::async(std::launch::async, [&] {
    Key bad{};
    return AcceptCarrier(std::move(f), bad, Ready);
  });
  Check(!ConnectCarrier(std::move(e), TestKey(), {"updater", "test-node", "dev", {}}));
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
  Sleep(50);
  blocked->Close();
  Check(send.wait_for(1s) == std::future_status::ready);
  Check(!send.get());
  CloseHandle(remote_read);
  CloseHandle(remote_write);
}
}  // namespace
int main(int argc, char** argv) {
  try {
    if (argc == 1) {
      NativeTests();
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
      connection = ConnectWebSocket(argv[2], TestKey(),
                                    {"endpoint", "test-node", "dev", std::string(32, '1')});
    else
      connection = ConnectStdio(TestKey(), {"endpoint", "test-node", "dev", std::string(32, '1')});
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
