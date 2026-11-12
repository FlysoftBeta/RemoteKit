#include "management/cluster_link.hpp"
#include "runtime_config_fixture.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <atomic>
#include <condition_variable>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
using namespace remotekit;
using namespace remotekit::cluster;
using namespace std::chrono_literals;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
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
template <class Predicate>
void Await(Predicate predicate) {
  auto deadline = std::chrono::steady_clock::now() + 5s;
  while (!predicate()) {
    Check(std::chrono::steady_clock::now() < deadline, "condition timed out");
    std::this_thread::sleep_for(10ms);
  }
}
Json Ready(Json config = TestConfig()) {
  auto text =
      Json{{"peer", config.value("peer", Json())}, {"rtc", config.value("rtc", Json())}}.dump();
  return {
      {"type", "node.ready"},
      {"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
      {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
      {"peers", Json::array()},
      {"buildId", "dev"},
      {"connectionEpoch", "12345678-1234-1234-1234-123456789abc"},
      {"config", config},
      {"configHash", Hex(Sha256({reinterpret_cast<const uint8_t*>(text.data()), text.size()}))}};
}
Json Reject(const char* code) {
  return {{"type", "node.reject"}, {"code", code}, {"buildId", "dev"}};
}
struct Responder {
  std::mutex mutex;
  std::vector<std::shared_ptr<Channel>> channels;
  std::vector<Json> replies;
  std::atomic<unsigned> attempts{0};
  unsigned failures = 0;
  explicit Responder(std::vector<Json> values) : replies(std::move(values)) {}
  Result<Established> Connect() {
    const auto attempt = attempts++;
    if (attempt < failures)
      return Error{ErrorCode::kUnavailable, "injected connection failure"};
    const size_t index = attempt - failures;
    if (index >= replies.size())
      return Error{ErrorCode::kUnavailable, "responder stopped"};
    HANDLE ar, aw, br, bw;
    Check(CreatePipe(&ar, &bw, nullptr, 65536) != FALSE, "pipe");
    Check(CreatePipe(&br, &aw, nullptr, 65536) != FALSE, "pipe");
    auto responder = std::async(std::launch::async, [&] {
      return AcceptCarrier(
          HandleCarrier(br, bw), Key{}, [&](const Json& hello, const Key&) -> Result<Json> {
            Check(hello["role"] == "endpoint" && hello["buildId"] == "dev" &&
                      hello["nodeId"] == "test" && hello["incarnation"] == std::string(32, 'a'),
                  "endpoint hello");
            return replies[index];
          });
    });
    auto connection = ConnectCarrier(HandleCarrier(ar, aw), Key{}, PublicKey(Key{}),
                                     {"endpoint", "test", "dev", std::string(32, 'a')});
    auto accepted = Take(responder.get());
    {
      std::lock_guard lock(mutex);
      channels.push_back(std::move(accepted.channel));
    }
    return connection;
  }
  std::shared_ptr<Channel> At(size_t index) {
    std::shared_ptr<Channel> result;
    Await([&] {
      std::lock_guard lock(mutex);
      if (channels.size() <= index)
        return false;
      result = channels[index];
      return true;
    });
    return result;
  }
};
Result<void> Validate(const Json& config) {
  if (config.contains("media"))
    return {};
  return Error{ErrorCode::kInvalidRequest, "invalid config"};
}
uint64_t Request(ClusterLink& link, Channel& server, int id) {
  Take(server.Send({{"id", id}, {"method", "session.snapshot"}, {"tenantId", "tenant"}}));
  std::string text;
  uint64_t generation = 0;
  bool eof = false;
  Await([&] { return link.Next(text, generation, eof); });
  Check(!eof && Json::parse(text)["id"] == id && link.Current(generation),
        "request delivered with current generation");
  return generation;
}
class IdleChannel final : public Channel {
 public:
  explicit IdleChannel(std::atomic<bool>& retired_by_receiver)
      : retired_by_receiver_(retired_by_receiver), receiver_(GetCurrentThreadId()) {}
  Result<void> Send(const Json&) override { return {}; }
  Result<void> SendBinary(const Json&, std::span<const uint8_t>) override { return {}; }
  Result<Message> Receive(std::chrono::milliseconds) override {
    std::this_thread::yield();
    return Error{ErrorCode::kBusy, "idle channel"};
  }
  void Close() override { retired_by_receiver_ = GetCurrentThreadId() == receiver_; }

 private:
  std::atomic<bool>& retired_by_receiver_;
  DWORD receiver_;
};
void Shutdown() {
  const auto ready = Ready();
  for (int i = 0; i < 1000; ++i) {
    std::atomic<bool> retired_by_receiver{false};
    {
      ClusterLink link(
          [&]() -> Result<Established> {
            return Established{std::make_unique<IdleChannel>(retired_by_receiver), ready};
          },
          true, "dev", std::string(32, 'a'), Validate);
      Take(link.WaitReady());
    }
    Check(retired_by_receiver, "receiver retires its channel before shutdown joins it");
  }
}
void Local() {
  Responder responder({Ready()});
  ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                   Validate);
  Check(Take(link.WaitReady())["media"]["fps"] == 60, "initial config");
  auto server = responder.At(0);
  auto generation = Request(link, *server, 1);
  Check(link.SendReply(generation, {{"id", 1}, {"ok", true}}), "reply enqueued");
  Check(Take(server->Receive(2s)).json["id"] == 1, "encrypted reply");
  Check(link.SendEvent({{"event", "rtc.signal"}}, generation), "event enqueued");
  Check(Take(server->Receive(2s)).json["event"] == "rtc.signal", "encrypted event");
  const Json clipboard{{"event", "session.event"},
                       {"tenantId", "tenant"},
                       {"sessionId", "session"},
                       {"browserSequence", "1"},
                       {"text", std::string(1024 * 1024 + 1, 't')},
                       {"html", ""}};
  Check(link.SendEvent(clipboard, generation), "large clipboard event enqueued");
  Check(Take(server->Receive(5s)).json == clipboard, "large clipboard event delivered");
  server->Close();
  bool eof = false;
  std::string bytes;
  Await([&] {
    link.Next(bytes, generation, eof);
    return eof;
  });
  Check(link.ExitCode() == 0 && responder.attempts == 1, "local EOF without reconnect");
}
void Reconnect() {
  Responder responder({Ready(), Ready()});
  ClusterLink link([&] { return responder.Connect(); }, false, "dev", std::string(32, 'a'),
                   Validate);
  Take(link.WaitReady());
  auto first = responder.At(0);
  auto old = Request(link, *first, 1);
  std::atomic<uint64_t> lost{0};
  link.OnDisconnect([&](uint64_t generation) { lost = generation; });
  first->Close();
  auto second = responder.At(1);
  auto current = Request(link, *second, 2);
  Check(lost == old && old != current && !link.Current(old), "disconnect retires generation");
  Check(!link.SendReply(old, {{"id", 1}}) && !link.SendEvent({{"event", "stale"}}, old),
        "stale replies and events rejected");
  Check(link.SendReply(current, {{"id", 2}}), "replacement reply");
  Check(Take(second->Receive(2s)).json["id"] == 2, "only replacement response delivered");
  link.OnDisconnect({});
}
void MediaAndPeers() {
  auto changed = TestConfig();
  changed["media"]["fps"] = 24;
  Responder responder({Ready(), Ready(changed)});
  ClusterLink link([&] { return responder.Connect(); }, false, "dev", std::string(32, 'a'),
                   Validate);
  Take(link.WaitReady());
  auto first = responder.At(0);
  std::atomic<int> peer_updates{0};
  link.OnPeers([&](const Json& peers) -> Result<void> {
    ++peer_updates;
    return {};
  });
  first->Close();
  auto second = responder.At(1);
  Request(link, *second, 1);
  Check(Take(link.WaitReady())["media"]["fps"] == 24 && link.ExitCode() == 0,
        "media reconnect does not restart");
  Take(second->Send({{"type", "node.peers"}, {"peers", Json::array()}}));
  Await([&] { return peer_updates.load() == 3; });
  auto config = Ready();
  config["type"] = "node.config";
  Take(second->Send(config));
  Await([&] { return Take(link.WaitReady())["media"]["fps"] == 60; });
  link.OnPeers({});
}
void ExitRules() {
  for (const auto& [reply, expected] :
       std::vector<std::pair<Json, int>>{{Ready([] {
                                            auto config = TestConfig();
                                            config["peer"]["listen"] = "127.0.0.1:3102";
                                            return config;
                                          }()),
                                          4},
                                         {Ready({{"unknown", 4}}), 1},
                                         {Reject("build_mismatch"), 3},
                                         {Reject("unknown_node"), 1}}) {
    Responder responder({Ready(), reply});
    ClusterLink link([&] { return responder.Connect(); }, false, "dev", std::string(32, 'a'),
                     Validate);
    Take(link.WaitReady());
    auto first = responder.At(0);
    auto generation = Request(link, *first, 1);
    first->Close();
    bool eof = false;
    std::string bytes;
    Await([&] {
      link.Next(bytes, generation, eof);
      return eof;
    });
    Check(link.ExitCode() == expected, "reconnect exit code");
  }
  for (const auto& [code, expected] :
       std::vector<std::pair<const char*, int>>{{"build_mismatch", 3}, {"unknown_node", 1}}) {
    Responder responder({Reject(code)});
    ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                     Validate);
    Check(!link.WaitReady() && link.ExitCode() == expected, "initial rejection exit code");
  }
  auto invalid = Ready();
  invalid["configHash"] = std::string(64, '0');
  Responder responder({invalid});
  ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                   Validate);
  Check(!link.WaitReady() && link.ExitCode() == 1, "config hash integrity");
}
void LimitsAndRetry() {
  {
    Responder responder({Ready()});
    responder.failures = 2;
    ClusterLink link([&] { return responder.Connect(); }, false, "dev", std::string(32, 'a'),
                     Validate);
    Take(link.WaitReady());
    Check(responder.attempts == 3, "retry failed connections");
    auto server = responder.At(0);
    auto generation = Request(link, *server, 1);
    Check(!link.SendReply(generation, {{"large", std::string(kMaxJson, 'x')}}),
          "oversized reply rejected without sending");
    Check(!link.Current(generation), "overload retires dispatch admission");
  }
  {
    Responder responder({Ready()});
    ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                     Validate);
    Take(link.WaitReady());
    auto server = responder.At(0);
    std::atomic<bool> lost{false};
    std::atomic<bool> received_boundary{false};
    link.OnDisconnect([&](uint64_t) { lost = true; });
    link.OnPeers([&](const Json&) -> Result<void> {
      received_boundary = true;
      return {};
    });
    received_boundary = false;
    for (size_t i = 0; i < limits::queuedMessages; ++i) {
      Take(server->Send({{"id", i}}));
      // Fill the management queue without overflowing the carrier's own queue.
      std::this_thread::sleep_for(1ms);
    }
    Take(server->Send({{"type", "node.peers"}, {"peers", Json::array()}}));
    Await([&] { return received_boundary.load(); });
    Check(!lost, "incoming queue accepts its exact bound");
    Take(server->Send({{"id", limits::queuedMessages}}));
    Await([&] { return lost.load(); });
    Await([&] { return link.ExitCode() == 1; });
    Check(link.ExitCode() == 1, "bounded incoming queue fails local carrier");
    link.OnDisconnect({});
    link.OnPeers({});
  }
}
void SupervisorEof() {
  const auto saved = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE read, write;
  Check(CreatePipe(&read, &write, nullptr, 0) != FALSE, "supervisor pipe");
  Check(SetStdHandle(STD_INPUT_HANDLE, read) != FALSE, "supervisor stdin");
  struct Restore {
    HANDLE saved, read, write;
    ~Restore() {
      SetStdHandle(STD_INPUT_HANDLE, saved);
      CloseHandle(read);
      if (write)
        CloseHandle(write);
    }
  } restore{saved, read, write};
  Responder responder({Ready()});
  ClusterLink link([&] { return responder.Connect(); }, false, "dev", std::string(32, 'a'),
                   Validate, true);
  Take(link.WaitReady());
  auto server = responder.At(0);
  auto generation = Request(link, *server, 1);
  CloseHandle(restore.write);
  restore.write = nullptr;
  bool eof = false;
  std::string bytes;
  Await([&] {
    link.Next(bytes, generation, eof);
    return eof;
  });
  Check(link.ExitCode() == 0 && !link.Current(generation), "supervisor EOF requests graceful stop");
}
void OutboundRequests() {
  Responder responder({Ready()});
  ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                   Validate);
  Take(link.WaitReady());
  auto server = responder.At(0);
  auto first = std::async(std::launch::async, [&] {
    return link.Request("object.committed",
                        {{"tenantId", "tenant"}, {"objectId", std::string(64, 'a')}});
  });
  auto second = std::async(std::launch::async, [&] {
    return link.Request("object.locate", {{"tenantId", "tenant"}, {"ids", Json::array()}});
  });
  auto a = Take(server->Receive(5s)).json;
  auto b = Take(server->Receive(5s)).json;
  Check(a["id"].is_string() && a["id"].get<std::string>().size() == 36 && a["id"] != b["id"],
        "request UUIDs");
  for (const auto& request : {b, a}) {
    if (request["request"] == "object.committed")
      Take(server->Send({{"id", request["id"]},
                         {"opId", request["opId"]},
                         {"ok", false},
                         {"error", {{"code", "conflict"}, {"message", "conflicting object"}}}}));
    else
      Take(server->Send({{"id", request["id"]},
                         {"opId", request["opId"]},
                         {"ok", true},
                         {"result", {{"sources", Json::object()}}}}));
  }
  const auto committed = first.get();
  Check(!committed && committed.error().code == ErrorCode::kConflict,
        "Control error routed to caller");
  Check(Take(second.get()).contains("sources"), "out of order replies without dispatcher pumping");
  for (const auto* code : {"locked", "canceled", "rate_limited", "internal", "future_code"}) {
    auto request =
        std::async(std::launch::async, [&] { return link.Request("test", Json::object()); });
    auto sent = Take(server->Receive(5s)).json;
    Take(server->Send({{"id", sent["id"]},
                       {"opId", sent["opId"]},
                       {"ok", false},
                       {"error",
                        {{"code", code},
                         {"message", "Control diagnosis"},
                         {"reason", "file_too_large"},
                         {"retryAfterMs", 200}}}}));
    auto result = request.get();
    Check(
        !result && result.error().code == ParseErrorCode(code).value_or(ErrorCode::kOutcomeUnknown),
        "reverse error code preserved");
    Check(result.error().retry_after_ms.has_value() == (std::string_view(code) == "rate_limited"),
          "reverse retry hint validated");
  }
  std::string bytes;
  uint64_t generation = 0;
  bool eof = false;
  Check(!link.Next(bytes, generation, eof), "replies stay out of dispatcher queue");
  auto pending = std::async(
      std::launch::async, [&] { return link.Request("object.locate", {{"tenantId", "tenant"}}); });
  Take(server->Receive(5s));
  server->Close();
  auto lost = pending.get();
  Check(!lost && lost.error().code == ErrorCode::kOutcomeUnknown, "disconnect outcome unknown");
}
void RequestTimeout() {
  Responder responder({Ready()});
  ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                   Validate);
  Take(link.WaitReady());
  const auto started = std::chrono::steady_clock::now();
  const auto result = link.Request("object.locate", {{"tenantId", "tenant"}});
  Check(!result && result.error().code == ErrorCode::kOutcomeUnknown &&
            std::chrono::steady_clock::now() - started >= 20s,
        "20 second request timeout");
}
void PendingRequestLimit() {
  Responder responder({Ready()});
  ClusterLink link([&] { return responder.Connect(); }, true, "dev", std::string(32, 'a'),
                   Validate);
  Take(link.WaitReady());
  auto server = responder.At(0);
  std::vector<std::future<Result<Json>>> pending;
  std::vector<std::jthread> workers;
  std::vector<Json> sent;
  for (size_t i = 0; i < limits::pendingRequests; ++i) {
    std::promise<Result<Json>> reply;
    pending.push_back(reply.get_future());
    workers.emplace_back([&link, reply = std::move(reply)]() mutable {
      reply.set_value(link.Request("test", Json::object()));
    });
  }
  for (size_t i = 0; i < limits::pendingRequests; ++i)
    sent.push_back(Take(server->Receive(5s)).json);
  const auto excess = link.Request("test", Json::object());
  Check(!excess && excess.error().code == ErrorCode::kBusy,
        "request past the exact pending bound is rejected");
  for (const auto& request : sent)
    Take(server->Send({{"id", request["id"]},
                       {"opId", request["opId"]},
                       {"ok", true},
                       {"result", Json::object()}}));
  for (auto& request : pending)
    Take(request.get());
}
}  // namespace
int main() {
  try {
    Shutdown();
    Local();
    Reconnect();
    MediaAndPeers();
    ExitRules();
    LimitsAndRetry();
    SupervisorEof();
    OutboundRequests();
    PendingRequestLimit();
    RequestTimeout();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
