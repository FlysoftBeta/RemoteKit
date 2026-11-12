#include "util/log.hpp"
#include "management/cluster_link.hpp"
#include "cluster/node_files.hpp"
#include "util/thread.hpp"
#include "util/wire_error.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <mutex>
#include <map>
#include <set>
#include <thread>
namespace remotekit {
namespace {
using namespace std::chrono_literals;
constexpr size_t kMaxQueuedBytes = cluster::kMaxPlaintext;
bool ValidEpoch(const Json& value) {
  if (!value.is_string())
    return false;
  const auto& text = value.get_ref<const std::string&>();
  if (text.size() != 36)
    return false;
  for (size_t i = 0; i < text.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (text[i] != '-')
        return false;
    } else if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f')))
      return false;
  }
  return true;
}
}  // namespace
struct ClusterLink::Impl {
  struct Message {
    uint64_t generation;
    std::string bytes;
    DeliveryFlag delivery;
  };
  Connector connect;
  ValidateConfig validate;
  bool local, watch_stdin;
  std::string build_id, config_hash, connection_epoch, endpoint_incarnation;
  Json config, object_keys, peers;
  Peers peer_callback;
  std::mutex mutex, callback_mutex;
  std::condition_variable wake;
  std::deque<Message> incoming, outgoing;
  struct Pending {
    uint64_t generation;
    std::optional<Json> reply;
    DeliveryFlag delivery = std::make_shared<DeliveryState>();
  };
  std::map<std::string, Pending> pending;
  size_t incoming_bytes = 0, outgoing_bytes = 0;
  uint64_t serial = 0, active = 0;
  bool stopping = false, overload = false, ready = false, sending = false;
  int exit_code = 1;
  Disconnect disconnected;
  Binary binary;
  std::shared_ptr<cluster::Channel> channel;
  std::thread receiver, sender;
  bool Stopping() {
    std::lock_guard lock(mutex);
    return stopping;
  }
  void Finish(int code) {
    std::lock_guard lock(mutex);
    stopping = true;
    exit_code = code;
    wake.notify_all();
  }
  bool SupervisorStopped() {
    if (!watch_stdin)
      return false;
    DWORD available = 0;
    if (PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr))
      return false;
    Finish(0);
    return true;
  }
  void DisconnectChannel() {
    std::lock_guard callback_lock(callback_mutex);
    std::shared_ptr<cluster::Channel> closing;
    Disconnect callback;
    uint64_t generation;
    {
      std::lock_guard lock(mutex);
      generation = active;
      active = 0;
      overload = false;
      incoming.clear();
      outgoing.clear();
      incoming_bytes = outgoing_bytes = 0;
      closing = std::move(channel);
      callback = disconnected;
    }
    if (closing)
      closing->Close();
    wake.notify_all();
    if (generation && callback)
      callback(generation);
  }
  bool Accept(cluster::Established established) {
    const auto& reply = established.reply;
    if (reply.value("type", Json()) == "node.reject") {
      const auto code = reply.value("code", Json());
      LogEvent(LogLevel::kError, "cluster.rejected", {{"code", code}});
      Finish(code == "build_mismatch" ? 3 : 1);
      return false;
    }
    if (reply.value("type", Json()) != "node.ready" || !reply.contains("connectionEpoch") ||
        !ValidEpoch(reply["connectionEpoch"]) || reply.value("buildId", Json()) != build_id ||
        !reply.contains("configHash") || !reply["configHash"].is_string() ||
        !cluster::ValidBuildId(reply["configHash"].get<std::string>()) ||
        !reply.contains("config") || !reply.contains("objectKey") ||
        !reply["objectKey"].is_string() || !reply.contains("objectIdKey") ||
        !reply["objectIdKey"].is_string() ||
        !cluster::DecodeKey(reply["objectKey"].get<std::string>()) ||
        !cluster::DecodeKey(reply["objectIdKey"].get<std::string>())) {
      Finish(1);
      return false;
    }
    if (!reply["config"].is_object() || !reply["config"].contains("peer") ||
        !reply["config"].contains("rtc") || !reply.contains("peers") ||
        !reply["peers"].is_array()) {
      Finish(1);
      return false;
    }
    const auto text =
        Json{{"peer", reply["config"]["peer"]}, {"rtc", reply["config"]["rtc"]}}.dump();
    const auto hash =
        cluster::Hex(cluster::Sha256({reinterpret_cast<const uint8_t*>(text.data()), text.size()}));
    if (hash != reply["configHash"].get<std::string>()) {
      Finish(1);
      return false;
    }
    {
      std::lock_guard lock(mutex);
      if (ready && config_hash != hash) {
        stopping = true;
        exit_code = 4;
        wake.notify_all();
        return false;
      }
    }
    if (!validate(reply["config"])) {
      Finish(1);
      return false;
    }
    std::lock_guard callback_lock(callback_mutex);
    if (peer_callback && !peer_callback(reply["peers"])) {
      Finish(1);
      return false;
    }
    std::lock_guard lock(mutex);
    if (stopping)
      return false;
    peers = reply["peers"];
    config = reply["config"];
    connection_epoch = reply["connectionEpoch"].get<std::string>();
    object_keys = {{"objectKey", reply.value("objectKey", Json())},
                   {"objectIdKey", reply.value("objectIdKey", Json())}};
    config_hash = hash;
    ready = true;
    channel = std::move(established.channel);
    active = ++serial;
    wake.notify_all();
    return true;
  }
  void ReceiveLoop() {
    unsigned backoff = 250;
    while (!Stopping() && !SupervisorStopped()) {
      auto established = connect();
      bool accepted = false;
      bool protocol_error = false;
      if (!established)
        LogError(LogLevel::kWarn, "cluster.connect_failed", established.error());
      if (established) {
        accepted = Accept(std::move(established).value());
        if (accepted) {
          backoff = 250;
          while (!Stopping() && !SupervisorStopped()) {
            std::shared_ptr<cluster::Channel> current;
            {
              std::lock_guard lock(mutex);
              if (overload) {
                protocol_error = true;
                break;
              }
              current = channel;
            }
            auto received = current->Receive(20ms);
            if (!received) {
              if (received.error().code == ErrorCode::kBusy)
                continue;
              break;
            }
            if (received.value().kind == cluster::Message::Kind::kBinary) {
              std::lock_guard callback_lock(callback_mutex);
              if (!binary) {
                protocol_error = true;
                break;
              }
              binary(received.value().json, received.value().bytes);
              continue;
            }
            auto& json = received.value().json;
            if (json.value("type", Json()) == "node.peers") {
              std::lock_guard callback_lock(callback_mutex);
              if (!json.contains("peers") || !json["peers"].is_array() ||
                  (peer_callback && !peer_callback(json["peers"]))) {
                protocol_error = true;
                break;
              }
              std::lock_guard lock(mutex);
              peers = json["peers"];
              continue;
            }
            if (json.value("type", Json()) == "node.config") {
              if (!json.contains("config") || !json["config"].is_object() ||
                  !json["config"].contains("peer") || !json["config"].contains("rtc")) {
                protocol_error = true;
                break;
              }
              const auto text =
                  Json{{"peer", json["config"]["peer"]}, {"rtc", json["config"]["rtc"]}}.dump();
              const auto hash = cluster::Hex(
                  cluster::Sha256({reinterpret_cast<const uint8_t*>(text.data()), text.size()}));
              if (json.value("configHash", Json()) != hash || !validate(json["config"])) {
                protocol_error = true;
                break;
              }
              if (hash != config_hash) {
                Finish(4);
                break;
              }
              std::lock_guard lock(mutex);
              config = json["config"];
              continue;
            }
            // Control requests carry a method; anything else with a string id answers one of ours.
            if (json.is_object() && json.contains("id") && json["id"].is_string() &&
                !json.contains("method")) {
              std::lock_guard lock(mutex);
              auto found = pending.find(json["id"].get<std::string>());
              if (found != pending.end() && found->second.generation == active) {
                found->second.reply = std::move(json);
                wake.notify_all();
              }
              continue;
            }
            auto bytes = json.dump();
            std::lock_guard lock(mutex);
            if (incoming.size() >= limits::queuedMessages ||
                incoming_bytes + bytes.size() > kMaxQueuedBytes) {
              protocol_error = true;
              break;
            }
            incoming_bytes += bytes.size();
            incoming.push_back({active, std::move(bytes)});
            wake.notify_all();
          }
        }
      }
      DisconnectChannel();
      if (local && !Stopping())
        Finish(accepted && !protocol_error ? 0 : 1);
      if (Stopping())
        break;
      const unsigned delay =
          std::min(backoff + static_cast<unsigned>(GetTickCount() % 251), 15000u);
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(delay);
      while (!Stopping() && !SupervisorStopped() && std::chrono::steady_clock::now() < deadline) {
        std::unique_lock lock(mutex);
        wake.wait_for(lock, 20ms, [&] { return stopping; });
      }
      backoff = std::min(backoff * 2, 15000u);
    }
    DisconnectChannel();
  }
  void SendLoop() {
    while (true) {
      std::shared_ptr<cluster::Channel> current;
      Message message;
      {
        std::unique_lock lock(mutex);
        wake.wait(lock, [&] { return stopping || !outgoing.empty(); });
        if (stopping)
          return;
        message = std::move(outgoing.front());
        outgoing.pop_front();
        outgoing_bytes -= message.bytes.size();
        if (message.generation != active)
          continue;
        current = channel;
        sending = true;
      }
      const auto send = [&] { return bool(current->Send(Json::parse(message.bytes))); };
      const auto sent =
          message.delivery ? message.delivery->Dispatch(send) : std::optional<bool>(send());
      {
        std::lock_guard lock(mutex);
        sending = false;
        if (sent && !*sent && message.generation == active)
          overload = true;
        wake.notify_all();
      }
    }
  }
};
ClusterLink::ClusterLink(Connector connect,
                         bool local,
                         std::string build_id,
                         std::string incarnation,
                         ValidateConfig validate,
                         bool watch_stdin)
    : impl_(std::make_unique<Impl>()) {
  impl_->connect = std::move(connect);
  impl_->local = local;
  impl_->build_id = std::move(build_id);
  impl_->endpoint_incarnation = std::move(incarnation);
  impl_->validate = std::move(validate);
  impl_->watch_stdin = watch_stdin;
  impl_->receiver = std::thread([this] {
    RunThread(
        "cluster receiver", [&] { impl_->ReceiveLoop(); },
        [&] {
          impl_->Finish(1);
          impl_->DisconnectChannel();
        });
  });
  impl_->sender = std::thread([this] {
    RunThread("cluster sender", [&] { impl_->SendLoop(); }, [&] { impl_->Finish(1); });
  });
}
ClusterLink::~ClusterLink() {
  {
    std::lock_guard lock(impl_->callback_mutex);
    impl_->disconnected = {};
    impl_->peer_callback = {};
  }
  impl_->Finish(ExitCode());
  // The receiver retires the channel after leaving its receive loop.
  impl_->receiver.join();
  impl_->sender.join();
}
Result<Json> ClusterLink::WaitReady() {
  std::unique_lock lock(impl_->mutex);
  impl_->wake.wait(lock, [&] { return impl_->ready || impl_->stopping; });
  if (impl_->stopping)
    return Error{ErrorCode::kUnavailable, "cluster startup ended"};
  return impl_->config;
}
int ClusterLink::ExitCode() {
  std::lock_guard lock(impl_->mutex);
  return impl_->stopping ? impl_->exit_code : 0;
}
void ClusterLink::Flush() {
  std::unique_lock lock(impl_->mutex);
  impl_->wake.wait_for(
      lock, 5s, [&] { return impl_->stopping || (impl_->outgoing.empty() && !impl_->sending); });
}
bool ClusterLink::Next(std::string& bytes, uint64_t& generation, bool& eof) {
  std::unique_lock lock(impl_->mutex);
  impl_->wake.wait_for(lock, 20ms, [&] { return impl_->stopping || !impl_->incoming.empty(); });
  eof = impl_->stopping;
  if (eof || impl_->incoming.empty())
    return false;
  auto next = std::move(impl_->incoming.front());
  impl_->incoming.pop_front();
  impl_->incoming_bytes -= next.bytes.size();
  bytes = std::move(next.bytes);
  generation = next.generation;
  return true;
}
bool ClusterLink::Current(uint64_t generation) {
  std::lock_guard lock(impl_->mutex);
  return generation && generation == impl_->active && !impl_->stopping && !impl_->overload;
}
std::optional<ManagementLink::ReadyState> ClusterLink::ReadyConfiguration() {
  std::lock_guard lock(impl_->mutex);
  if (!impl_->active || impl_->stopping || impl_->overload)
    return {};
  return ReadyState{impl_->active, impl_->object_keys, impl_->connection_epoch};
}
bool ClusterLink::Queue(const Json& message, uint64_t generation, DeliveryFlag delivery) {
  auto bytes = message.dump();
  std::lock_guard lock(impl_->mutex);
  if (!generation || generation != impl_->active || impl_->stopping || impl_->overload)
    return false;
  if (bytes.size() > cluster::JsonLimit(message) ||
      impl_->outgoing.size() >= limits::queuedMessages ||
      impl_->outgoing_bytes + bytes.size() > kMaxQueuedBytes) {
    impl_->overload = true;
    return false;
  }
  if (message.contains("request")) {
    const auto found = impl_->pending.find(message.at("id").get<std::string>());
    if (found == impl_->pending.end())
      return false;
    delivery = found->second.delivery;
  }
  impl_->outgoing_bytes += bytes.size();
  impl_->outgoing.push_back({generation, std::move(bytes), std::move(delivery)});
  impl_->wake.notify_all();
  return true;
}
bool ClusterLink::SendReply(uint64_t generation, const Json& reply) {
  return Queue(reply, generation);
}
bool ClusterLink::SendEvent(const Json& event, uint64_t generation, DeliveryFlag delivery) {
  return Queue(event, generation, std::move(delivery));
}
void ClusterLink::OnDisconnect(Disconnect callback) {
  std::lock_guard lock(impl_->callback_mutex);
  impl_->disconnected = std::move(callback);
}
void ClusterLink::OnBinary(Binary callback) {
  std::lock_guard lock(impl_->callback_mutex);
  impl_->binary = std::move(callback);
}
void ClusterLink::OnPeers(Peers callback) {
  std::lock_guard callback_lock(impl_->callback_mutex);
  impl_->peer_callback = std::move(callback);
  Json peers;
  {
    std::lock_guard lock(impl_->mutex);
    if (!impl_->ready)
      return;
    peers = impl_->peers;
  }
  if (impl_->peer_callback && !impl_->peer_callback(peers))
    impl_->Finish(1);
}
Result<Json> ClusterLink::Request(const std::string& name, Json fields) {
  return RequestUntil(name, std::move(fields), std::chrono::steady_clock::now() + 20s);
}
Result<Json> ClusterLink::RequestUntil(const std::string& name,
                                       Json fields,
                                       std::chrono::steady_clock::time_point deadline) {
  if (std::chrono::steady_clock::now() >= deadline)
    return Error{ErrorCode::kUnavailable, "Control request budget exhausted"};
  std::array<uint8_t, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return Error{ErrorCode::kInternal, "request id generation failed"};
  random[6] = (random[6] & 15) | 64;
  random[8] = (random[8] & 63) | 128;
  const auto hex = cluster::Hex(random);
  const auto id = hex.substr(0, 8) + "-" + hex.substr(8, 4) + "-" + hex.substr(12, 4) + "-" +
                  hex.substr(16, 4) + "-" + hex.substr(20);
  uint64_t generation;
  {
    std::lock_guard lock(impl_->mutex);
    if (!impl_->active || impl_->stopping || impl_->overload)
      return Error{ErrorCode::kUnavailable, "Control disconnected"};
    if (impl_->pending.size() >= limits::pendingRequests)
      return Error{ErrorCode::kBusy, "too many in-flight requests"};
    generation = impl_->active;
    impl_->pending.emplace(id, Impl::Pending{generation, {}});
  }
  const auto tenant = fields.value("tenantId", Json(""));
  fields.erase("tenantId");
  fields = {{"id", id},
            {"request", name},
            {"tenantId", tenant},
            {"sessionId", nullptr},
            {"placementEpoch", nullptr},
            {"endpointIncarnation", impl_->endpoint_incarnation},
            {"opId", id},
            {"replay", false},
            {"params", std::move(fields)}};
  if (!Queue(fields, generation)) {
    std::lock_guard lock(impl_->mutex);
    impl_->pending.erase(id);
    return Error{ErrorCode::kUnavailable, "Control request not queued"};
  }
  std::unique_lock lock(impl_->mutex);
  impl_->wake.wait_until(lock, std::min(deadline, std::chrono::steady_clock::now() + 20s), [&] {
    return impl_->stopping || impl_->active != generation ||
           impl_->pending.at(id).reply.has_value();
  });
  const auto delivery = impl_->pending.at(id).delivery;
  auto reply = std::move(impl_->pending.at(id).reply);
  impl_->pending.erase(id);
  lock.unlock();
  const bool dispatched = delivery->CancelAndWasWritten();
  if (!reply)
    return Error{
        dispatched ? ErrorCode::kOutcomeUnknown : ErrorCode::kUnavailable,
        dispatched ? "Control request outcome unknown" : "Control request was not dispatched"};
  if (!reply->is_object() || !reply->contains("ok") || !(*reply)["ok"].is_boolean())
    return Error{ErrorCode::kOutcomeUnknown, "Invalid Control reply envelope"};
  if (reply->value("opId", Json()) != id)
    return Error{ErrorCode::kOutcomeUnknown, "Control RPC reply identity differs"};
  if ((*reply)["ok"] == true && reply->contains("result"))
    return (*reply)["result"];
  return ParseWireError(reply->value("error", Json()));
}
}  // namespace remotekit
