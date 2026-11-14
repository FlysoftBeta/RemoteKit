#include "util/log.hpp"
#include "management/cluster_link.hpp"
#include "management/reply.hpp"
#include "cluster/node_files.hpp"
#include "util/thread.hpp"
#include "util/wire_error.hpp"
#include "util/retry_unit.hpp"
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
std::string MessageKind(const Json& message) {
  for (const auto* field : {"method", "request", "event", "type"})
    if (message.is_object() && message.contains(field) && message[field].is_string())
      return message[field].get<std::string>();
  return message.is_object() && message.contains("id") ? "reply" : "unknown";
}
void EndLink(cluster::Channel* channel) {
  channel->Close();
  auto cause = channel->Cause();
  LogEvent(LogLevel::kError, "cluster.link_lost",
           {{"reason", cause.reason.empty() ? "local_close" : cause.reason},
            {"detail", std::move(cause.detail)}});
}
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
    std::string observation;
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
  bool stopping = false, queue_full = false, ready = false, sending = false;
  int exit_code = 1;
  Disconnect disconnected;
  Binary binary;
  std::shared_ptr<cluster::Channel> channel;
  std::thread receiver, sender;
  RetryUnit reconnect{"cluster.reconnect"};
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
    const auto error = GetLastError();
    {
      std::lock_guard lock(mutex);
      if (channel)
        channel->RecordClose("read_eof", {{"source", "supervisor stdin"}, {"win32", error}});
    }
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
      queue_full = false;
      incoming.clear();
      outgoing.clear();
      incoming_bytes = outgoing_bytes = 0;
      closing = std::move(channel);
      callback = disconnected;
    }
    if (closing)
      EndLink(closing.get());
    wake.notify_all();
    if (generation && callback)
      callback(generation);
  }
  bool Accept(cluster::Established established) {
    std::unique_ptr<cluster::Channel, decltype(&EndLink)> end(established.channel.get(), EndLink);
    const auto& reply = established.reply;
    const auto reject = [&](const char* reason, int code, Json detail = Json::object()) {
      established.channel->RecordClose(reason, detail);
      Finish(code);
      return false;
    };
    if (reply.value("type", Json()) == "node.reject") {
      const auto code = reply.value("code", Json());
      LogEvent(LogLevel::kError, "cluster.rejected", {{"code", code}});
      return reject("peer_rejected", code == "build_mismatch" ? 3 : 1, {{"code", code}});
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
      return reject("invalid_ready", 1);
    }
    if (!reply["config"].is_object() || !reply["config"].contains("peer") ||
        !reply["config"].contains("rtc") || !reply.contains("peers") ||
        !reply["peers"].is_array()) {
      return reject("invalid_config", 1);
    }
    const auto text =
        Json{{"peer", reply["config"]["peer"]}, {"rtc", reply["config"]["rtc"]}}.dump();
    const auto hash =
        cluster::Hex(cluster::Sha256({reinterpret_cast<const uint8_t*>(text.data()), text.size()}));
    if (hash != reply["configHash"].get<std::string>()) {
      return reject("invalid_config", 1, {{"error", "config hash differs"}});
    }
    {
      std::lock_guard lock(mutex);
      if (ready && config_hash != hash) {
        established.channel->RecordClose("config_changed");
        stopping = true;
        exit_code = 4;
        wake.notify_all();
        return false;
      }
    }
    if (!validate(reply["config"])) {
      return reject("invalid_config", 1);
    }
    std::lock_guard callback_lock(callback_mutex);
    if (peer_callback && !peer_callback(reply["peers"])) {
      return reject("invalid_peers", 1);
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
    end.release();
    channel = std::move(established.channel);
    active = ++serial;
    wake.notify_all();
    return true;
  }
  void ReceiveLoop() {
    {
      std::lock_guard lock(mutex);
      reconnect.Input(build_id);
    }
    while (!Stopping() && !SupervisorStopped()) {
      {
        std::unique_lock lock(mutex);
        if (!reconnect.Ready()) {
          wake.wait_for(lock, 20ms, [&] { return stopping; });
          continue;
        }
      }
      auto established = connect();
      bool accepted = false;
      bool protocol_error = false;
      if (!established) {
        std::lock_guard lock(mutex);
        reconnect.Fail(established.error());
      }
      if (established) {
        accepted = Accept(std::move(established).value());
        if (accepted) {
          {
            std::lock_guard lock(mutex);
            reconnect.Success();
          }
          const auto lost = [&](const char* reason, Json fields = Json::object()) {
            std::lock_guard lock(mutex);
            channel->RecordClose(reason, std::move(fields));
          };
          while (!Stopping() && !SupervisorStopped()) {
            std::shared_ptr<cluster::Channel> current;
            {
              std::lock_guard lock(mutex);
              current = channel;
            }
            auto received = current->Receive(20ms);
            if (!received) {
              if (received.error().code == ErrorCode::kBusy)
                continue;
              const auto cause = current->Cause();
              if (cause.reason.empty())
                current->RecordClose("peer_closed", {{"error", received.error().message}});
              break;
            }
            if (received.value().kind == cluster::Message::Kind::kBinary) {
              std::lock_guard callback_lock(callback_mutex);
              if (!binary) {
                protocol_error = true;
                lost("unexpected_binary");
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
                lost("invalid_peers");
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
                lost("invalid_config");
                break;
              }
              const auto text =
                  Json{{"peer", json["config"]["peer"]}, {"rtc", json["config"]["rtc"]}}.dump();
              const auto hash = cluster::Hex(
                  cluster::Sha256({reinterpret_cast<const uint8_t*>(text.data()), text.size()}));
              if (json.value("configHash", Json()) != hash || !validate(json["config"])) {
                protocol_error = true;
                lost("invalid_config");
                break;
              }
              if (hash != config_hash) {
                lost("config_changed");
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
            std::unique_lock lock(mutex);
            while (!stopping && current->Cause().reason.empty() &&
                   (incoming.size() >= limits::managementQueueMessages ||
                    incoming_bytes + bytes.size() > limits::managementQueueBytes)) {
              wake.wait_for(lock, 20ms);
              lock.unlock();
              SupervisorStopped();
              lock.lock();
            }
            if (stopping || !current->Cause().reason.empty())
              break;
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
      bool finished;
      {
        std::lock_guard lock(mutex);
        if (accepted)
          reconnect.Fail({protocol_error ? ErrorCode::kInternal : ErrorCode::kUnavailable,
                          "cluster connection ended"});
        finished = reconnect.Status() == RetryUnit::State::kFaulted ||
                   reconnect.Status() == RetryUnit::State::kDropped;
      }
      if (finished) {
        Finish(1);
        break;
      }
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
        if (outgoing.size() < limits::managementQueueMessages &&
            outgoing_bytes < limits::managementQueueBytes)
          queue_full = false;
        wake.notify_all();
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
        if (sent && !*sent && message.generation == active) {
          current->RecordClose("write_error", {{"bytes", message.bytes.size()}});
          current->Close();
        }
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
    return impl_->reconnect.Failure().value_or(
        Error{ErrorCode::kUnavailable, "cluster startup ended"});
  return impl_->config;
}
int ClusterLink::ExitCode() {
  std::lock_guard lock(impl_->mutex);
  return impl_->stopping ? impl_->exit_code : 0;
}
RetryUnit::Snapshot ClusterLink::RetryStatus() const {
  std::lock_guard lock(impl_->mutex);
  return impl_->reconnect;
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
  impl_->wake.notify_all();
  bytes = std::move(next.bytes);
  generation = next.generation;
  return true;
}
bool ClusterLink::Current(uint64_t generation) {
  std::lock_guard lock(impl_->mutex);
  return generation && generation == impl_->active && !impl_->stopping;
}
std::optional<ManagementLink::ReadyState> ClusterLink::ReadyConfiguration() {
  std::lock_guard lock(impl_->mutex);
  if (!impl_->active || impl_->stopping)
    return {};
  return ReadyState{impl_->active, impl_->object_keys, impl_->connection_epoch};
}
bool ClusterLink::Queue(const Json& message, uint64_t generation, DeliveryFlag delivery) {
  auto bytes = message.dump();
  std::lock_guard lock(impl_->mutex);
  if (!generation || generation != impl_->active || impl_->stopping)
    return false;
  if (bytes.size() > cluster::JsonLimit(message)) {
    LogEvent(LogLevel::kWarn, "cluster.message_rejected",
             {{"kind", MessageKind(message)},
              {"bytes", bytes.size()},
              {"limit", cluster::JsonLimit(message)}});
    return false;
  }
  std::string observation;
  if (message.value("event", Json()) == "session.observed")
    observation = Json::array({message.at("tenantId"), message.at("sessionId")}).dump();
  auto replaced = impl_->outgoing.end();
  if (!observation.empty())
    replaced = std::find_if(impl_->outgoing.begin(), impl_->outgoing.end(),
                            [&](const auto& queued) { return queued.observation == observation; });
  const auto replaced_bytes = replaced == impl_->outgoing.end() ? 0 : replaced->bytes.size();
  // Replies are bounded by Control's in-flight requests and RTC signals by each peer's signal
  // queue; refusing either would lose them without retry.
  const bool reply = (message.contains("id") && message.contains("ok")) ||
                     message.value("event", Json()) == "rtc.signal";
  const auto queued_messages = impl_->outgoing.size() + (replaced == impl_->outgoing.end() ? 1 : 0);
  const auto queued_bytes = impl_->outgoing_bytes - replaced_bytes + bytes.size();
  if (!reply &&
      ((replaced == impl_->outgoing.end() && queued_messages > limits::managementQueueMessages) ||
       queued_bytes > limits::managementQueueBytes)) {
    if (!impl_->queue_full)
      LogEvent(LogLevel::kWarn, "cluster.queue_full",
               {{"kind", MessageKind(message)},
                {"queuedMessages", impl_->outgoing.size()},
                {"queuedBytes", impl_->outgoing_bytes}});
    impl_->queue_full = true;
    return false;
  }
  if (message.contains("request")) {
    const auto found = impl_->pending.find(message.at("id").get<std::string>());
    if (found == impl_->pending.end())
      return false;
    delivery = found->second.delivery;
  }
  impl_->outgoing_bytes = queued_bytes;
  Impl::Message queued{generation, std::move(bytes), std::move(delivery), std::move(observation)};
  if (replaced != impl_->outgoing.end()) {
    *replaced = std::move(queued);
    if (queued_bytes < limits::managementQueueBytes &&
        queued_messages < limits::managementQueueMessages)
      impl_->queue_full = false;
  } else {
    impl_->outgoing.push_back(std::move(queued));
  }
  impl_->wake.notify_all();
  return true;
}
bool ClusterLink::SendReply(uint64_t generation, const Json& reply) {
  const auto bytes = reply.dump().size();
  const auto limit = cluster::JsonLimit(reply);
  if (bytes > limit) {
    LogEvent(LogLevel::kWarn, "cluster.message_rejected",
             {{"kind", MessageKind(reply)}, {"bytes", bytes}, {"limit", limit}});
    return Queue(ManagementReply(reply, Error{ErrorCode::kOutcomeUnknown,
                                              "management reply exceeds encoded size limit"}),
                 generation);
  }
  return Queue(reply, generation);
}
ManagementLink::QueueBudget ClusterLink::EventBudget() {
  std::lock_guard lock(impl_->mutex);
  return {
      limits::managementQueueMessages -
          std::min(limits::managementQueueMessages, impl_->outgoing.size()),
      limits::managementQueueBytes - std::min(limits::managementQueueBytes, impl_->outgoing_bytes)};
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
  if (impl_->peer_callback && !impl_->peer_callback(peers)) {
    {
      std::lock_guard lock(impl_->mutex);
      if (impl_->channel)
        impl_->channel->RecordClose("invalid_peers");
    }
    impl_->Finish(1);
  }
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
    if (!impl_->active || impl_->stopping)
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
  const bool dispatched = delivery->CancelAndWasDispatched();
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
