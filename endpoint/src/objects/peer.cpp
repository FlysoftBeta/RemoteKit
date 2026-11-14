#include "objects/peer.hpp"
#include "objects/digest.hpp"
#include "cluster/node_files.hpp"
#include "util/result_macros.hpp"
#include "util/wire_error.hpp"
#include "util/retry_unit.hpp"
#include <windows.h>
#include <fstream>
#include <algorithm>
#include <set>
namespace remotekit::objects {
namespace {
using namespace std::chrono_literals;
namespace fs = std::filesystem;
Error Invalid() {
  return {ErrorCode::kInternal, "Invalid object transfer"};
}
bool Number(const Json& value) {
  return value.is_number_unsigned() || (value.is_number_integer() && value.get<int64_t>() >= 0);
}
}  // namespace
Result<void> PeerSet::Update(const Json& peers) {
  if (!peers.is_array())
    return Error{ErrorCode::kInvalidRequest, "invalid peer set"};
  std::map<std::string, PeerIdentity> next;
  std::set<Key> keys;
  for (const auto& peer : peers) {
    if (!peer.is_object() || peer.size() != 3 || !peer.contains("nodeId") ||
        !peer["nodeId"].is_string() || !peer.contains("address") || !peer["address"].is_string() ||
        !peer.contains("publicKey") || !peer["publicKey"].is_string())
      return Invalid();
    const auto node = peer["nodeId"].get<std::string>();
    auto key = cluster::DecodeKey(peer["publicKey"].get<std::string>());
    if (!cluster::ValidNodeId(node) || !key || !keys.insert(key.value()).second ||
        next.contains(node) || peer["address"].get_ref<const std::string&>().empty())
      return Invalid();
    next.emplace(node, PeerIdentity{node, peer["address"].get<std::string>(), key.value()});
  }
  std::lock_guard lock(mutex_);
  peers_ = std::move(next);
  return {};
}
std::optional<PeerIdentity> PeerSet::Find(const std::string& node) const {
  std::lock_guard lock(mutex_);
  const auto found = peers_.find(node);
  return found == peers_.end() ? std::nullopt : std::optional(found->second);
}
std::optional<PeerIdentity> PeerSet::Find(const Key& key) const {
  std::lock_guard lock(mutex_);
  for (const auto& [node, peer] : peers_)
    if (peer.public_key == key)
      return peer;
  return {};
}
PeerServer::PeerServer(ObjectStore& store,
                       const Key& key,
                       std::string node,
                       std::string build,
                       PeerSet& peers)
    : store_(store), key_(key), peers_(peers), node_(std::move(node)), build_(std::move(build)) {}
PeerServer::~PeerServer() {
  stopping_ = true;
  if (listener_)
    listener_->Close();
  {
    std::lock_guard lock(mutex_);
    for (const auto& [channel, peer] : channels_)
      channel->Close();
  }
  for (auto& worker : workers_)
    worker.join();
  SecureZeroMemory(key_.data(), key_.size());
}
Result<void> PeerServer::Start(const std::string& address) {
  RK_ASSIGN_OR_RETURN(listener, cluster::TcpListener::Listen(address));
  listener_ = std::move(listener);
  for (int i = 0; i < 8; ++i)
    workers_.emplace_back([this] { Loop(); });
  return {};
}
std::string PeerServer::Address() const {
  return listener_ ? listener_->Address() : std::string();
}
void PeerServer::Revoke() {
  std::lock_guard lock(mutex_);
  for (const auto& [channel, peer] : channels_) {
    const auto current = peers_.Find(peer.node_id);
    if (!current || current->public_key != peer.public_key)
      channel->Close();
  }
}
void PeerServer::Loop() {
  while (!stopping_) {
    std::shared_ptr<cluster::Channel> channel;
    try {
      auto carrier = AcceptOne(listener_->Address(), [&] { return listener_->Accept(100ms); });
      if (!carrier) {
        if (stopping_)
          break;
        std::this_thread::sleep_for(20ms);
        continue;
      }
      std::optional<PeerIdentity> identity;
      auto established = cluster::AcceptCarrier(
          std::move(carrier).value(), key_,
          [&](const Json& hello, const Key& public_key) -> Result<Json> {
            identity = peers_.Find(public_key);
            if (!identity || hello.value("type", Json()) != "node.hello" ||
                hello.value("role", Json()) != "peer")
              return Error{ErrorCode::kUnauthenticated, "peer identity is not admitted"};
            if (hello.value("buildId", Json()) != build_)
              return Json{{"type", "node.reject"}, {"code", "build_mismatch"}, {"buildId", build_}};
            return Json{{"type", "node.ready"}, {"nodeId", node_}, {"buildId", build_}};
          });
      if (!established || established.value().reply["type"] == "node.reject")
        continue;
      channel = std::move(established.value().channel);
      {
        std::lock_guard lock(mutex_);
        const auto current = peers_.Find(identity->node_id);
        if (stopping_ || !current || current->public_key != identity->public_key) {
          channel->Close();
          continue;
        }
        channels_.emplace(channel, *identity);
      }
      auto served = Serve(*channel);
      if (!served) {
        auto error = WireError(served.error());
        error["type"] = "object.error";
        channel->Send(error);
      }
    } catch (const std::filesystem::filesystem_error& failure) {
      if (channel) {
        auto error = WireError(WithOsError(ErrorCode::kUnavailable, failure.what(),
                                           OsError::Kind::kWin32, failure.code().value()));
        error["type"] = "object.error";
        channel->Send(error);
      }
    } catch (const std::exception& failure) {
      if (channel) {
        auto error = WireError({ErrorCode::kInternal, failure.what()});
        error["type"] = "object.error";
        channel->Send(error);
      }
    }
    if (channel) {
      channel->Close();
      std::lock_guard lock(mutex_);
      channels_.erase(channel);
    }
  }
}
RetryUnit::Snapshot PeerServer::AcceptRetryStatus() const {
  std::lock_guard lock(accept_mutex_);
  return accept_retry_;
}
Result<std::unique_ptr<cluster::Carrier>> PeerServer::AcceptOne(
    const std::string& input,
    const std::function<Result<std::unique_ptr<cluster::Carrier>>()>& accept) {
  std::lock_guard lock(accept_mutex_);
  accept_retry_.Input(input);
  if (!accept_retry_.Ready())
    return *accept_retry_.Failure();
  const auto receive = [&]() -> Result<std::unique_ptr<cluster::Carrier>> {
    try {
      return accept();
    } catch (const fs::filesystem_error& error) {
      return WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                         error.code().value());
    } catch (const std::exception& error) {
      return Error{ErrorCode::kInternal, error.what()};
    } catch (...) {
      return Error{ErrorCode::kInternal, "peer accept failed"};
    }
  };
  auto result = receive();
  if (result)
    accept_retry_.Success();
  else if (!stopping_ && result.error().code != ErrorCode::kBusy)
    accept_retry_.Fail(result.error());
  return result;
}
Result<void> PeerServer::Serve(cluster::Channel& channel) {
  RK_ASSIGN_OR_RETURN(message, channel.Receive(20s));
  const auto& request = message.json;
  if (message.kind != cluster::Message::Kind::kJson ||
      request.value("type", Json()) != "object.get" || !request.contains("id") ||
      !request["id"].is_string() || !request.contains("offset") || !Number(request["offset"]))
    return Invalid();
  const auto id = request["id"].get<std::string>();
  RK_ASSIGN_OR_RETURN(path, store_.StoredPath(id));
  std::ifstream input(path, std::ios::binary);
  if (!input)
    return Error{ErrorCode::kNotFound, "object not found"};
  input.seekg(0, std::ios::end);
  const auto end = input.tellg();
  if (end < 0)
    return Error{ErrorCode::kUnavailable, "object size unavailable"};
  const auto stored_size = static_cast<uint64_t>(end);
  const auto offset = request["offset"].get<uint64_t>();
  if (offset > stored_size)
    return Invalid();
  input.seekg(0);
  cluster::Bytes buffer(kSegmentSize);
  Digest digest;
  uint64_t position = 0;
  while (position < stored_size && !stopping_) {
    const auto count =
        static_cast<size_t>(std::min<uint64_t>(buffer.size(), stored_size - position));
    input.read(reinterpret_cast<char*>(buffer.data()), count);
    if (!input)
      return Error{ErrorCode::kUnavailable, "object read failed"};
    digest.Add({buffer.data(), count});
    const auto skip =
        static_cast<size_t>(std::min<uint64_t>(count, offset > position ? offset - position : 0));
    if (skip < count)
      RK_RETURN_IF_ERROR(channel.SendBinary({{"type", "object.chunk"}, {"offset", position + skip}},
                                            {buffer.data() + skip, count - skip}));
    position += count;
  }
  if (stopping_)
    return Error{ErrorCode::kUnavailable, "peer stopping"};
  return channel.Send(
      {{"type", "object.end"}, {"size", stored_size}, {"sha256", cluster::Hex(digest.Finish())}});
}
PeerClient::PeerClient(ObjectStore& store,
                       const Key& key,
                       std::string node,
                       std::string build,
                       PeerSet& peers)
    : store_(store), key_(key), peers_(peers), node_(std::move(node)), build_(std::move(build)) {}
PeerClient::~PeerClient() {
  SecureZeroMemory(key_.data(), key_.size());
}
Result<ObjectInfo> PeerClient::Fetch(const std::string& id, const std::string& node) {
  RK_ASSIGN_OR_RETURN(path, store_.StoredPath(id));
  auto lock = store_.Lock(id);
  fs::create_directories(path.parent_path());
  auto partial = path;
  partial += ".partial";
  std::error_code error;
  uint64_t offset = fs::exists(partial, error) ? fs::file_size(partial, error) : 0;
  if (error)
    return Error{ErrorCode::kUnavailable, "object partial unavailable"};
  const auto peer = peers_.Find(node);
  if (!peer)
    return Error{ErrorCode::kUnauthenticated, "unknown peer"};
  RK_ASSIGN_OR_RETURN(carrier, cluster::ConnectTcp(peer->address));
  RK_ASSIGN_OR_RETURN(connection,
                      cluster::ConnectCarrier(std::move(carrier), key_, peer->public_key,
                                              {"peer", node_, build_, {}}));
  if (connection.reply.value("type", Json()) == "node.reject")
    return Error{ErrorCode::kUnavailable, "Peer capability negotiation refused"};
  if (connection.reply.value("buildId", Json()) != build_)
    return Invalid();
  auto& channel = *connection.channel;
  RK_RETURN_IF_ERROR(channel.Send({{"type", "object.get"}, {"id", id}, {"offset", offset}}));
  std::ofstream output(partial, std::ios::binary | std::ios::app);
  if (!output)
    return Error{ErrorCode::kUnavailable, "object partial unavailable"};
  const auto invalid_transfer = [&]() {
    output.close();
    fs::remove(partial, error);
    return Invalid();
  };
  while (true) {
    RK_ASSIGN_OR_RETURN(message, channel.Receive(20s));
    const auto& header = message.json;
    const auto type = header.value("type", Json());
    if (type == "object.error") {
      return ParseWireError(header);
    }
    if (type == "object.chunk" && message.kind == cluster::Message::Kind::kBinary) {
      if (!header.contains("offset") || !Number(header["offset"]) ||
          header["offset"].get<uint64_t>() != offset || message.bytes.empty() ||
          message.bytes.size() > kSegmentSize || offset > UINT64_MAX - message.bytes.size())
        return invalid_transfer();
      output.write(reinterpret_cast<const char*>(message.bytes.data()), message.bytes.size());
      if (!output)
        return Error{ErrorCode::kUnavailable, "object partial write failed"};
      offset += message.bytes.size();
    } else if (type == "object.end" && message.kind == cluster::Message::Kind::kJson) {
      if (!header.contains("size") || !Number(header["size"]) ||
          header["size"].get<uint64_t>() != offset || !header.contains("sha256") ||
          !header["sha256"].is_string())
        return invalid_transfer();
      output.close();
      if (!output)
        return Error{ErrorCode::kUnavailable, "object partial write failed"};
      return store_.Import(id, offset, header["sha256"].get<std::string>());
    } else
      return invalid_transfer();
  }
}
}  // namespace remotekit::objects
