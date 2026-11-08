#include "objects/peer.hpp"
#include "cluster/node_files.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <fstream>
#include <algorithm>
namespace remotekit::objects {
namespace {
using namespace std::chrono_literals;
namespace fs = std::filesystem;
Error Invalid() {
  return {ErrorCode::kRejected, "invalid object transfer"};
}
bool Number(const Json& value) {
  return value.is_number_unsigned() || (value.is_number_integer() && value.get<int64_t>() >= 0);
}
}  // namespace
PeerServer::PeerServer(ObjectStore& store, const Key& key, std::string node, std::string build)
    : store_(store), key_(key), node_(std::move(node)), build_(std::move(build)) {}
PeerServer::~PeerServer() {
  stopping_ = true;
  if (listener_)
    listener_->Close();
  {
    std::lock_guard lock(mutex_);
    for (const auto& channel : channels_)
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
void PeerServer::Loop() {
  while (!stopping_) {
    std::shared_ptr<cluster::Channel> channel;
    try {
      auto carrier = listener_->Accept(100ms);
      if (!carrier)
        continue;
      auto established = cluster::AcceptCarrier(
          std::move(carrier).value(), key_, [&](const Json& hello) -> Result<Json> {
            if (hello.value("type", Json()) != "node.hello" ||
                hello.value("role", Json()) != "peer" || !hello.contains("nodeId") ||
                !hello["nodeId"].is_string() ||
                !cluster::ValidNodeId(hello["nodeId"].get<std::string>()))
              return Invalid();
            if (hello.value("buildId", Json()) != build_)
              return Json{{"type", "node.reject"}, {"code", "build_mismatch"}, {"buildId", build_}};
            return Json{{"type", "node.ready"}, {"nodeId", node_}, {"buildId", build_}};
          });
      if (!established || established.value().reply["type"] == "node.reject")
        continue;
      channel = std::move(established.value().channel);
      {
        std::lock_guard lock(mutex_);
        if (stopping_) {
          channel->Close();
          continue;
        }
        channels_.push_back(channel);
      }
      auto served = Serve(*channel);
      if (!served)
        channel->Send({{"type", "object.error"}, {"code", ErrorCodeName(served.error().code)}});
    } catch (const std::exception&) {
      if (channel)
        channel->Send({{"type", "object.error"}, {"code", "invalid_request"}});
    }
    if (channel) {
      channel->Close();
      std::lock_guard lock(mutex_);
      std::erase(channels_, channel);
    }
  }
}
Result<void> PeerServer::Serve(cluster::Channel& channel) {
  RK_ASSIGN_OR_RETURN(message, channel.Receive(20s));
  const auto& request = message.json;
  if (message.kind != cluster::Message::Kind::kJson ||
      request.value("type", Json()) != "object.get" || !request.contains("id") ||
      !request["id"].is_string() || !request.contains("offset") || !Number(request["offset"]))
    return Invalid();
  const auto id = request["id"].get<std::string>();
  RK_ASSIGN_OR_RETURN(info, store_.Inspect(id));
  auto offset = request["offset"].get<uint64_t>();
  if (offset > info.stored_size)
    return Invalid();
  RK_ASSIGN_OR_RETURN(path, store_.StoredPath(id));
  std::ifstream input(path, std::ios::binary);
  input.seekg(static_cast<std::streamoff>(offset));
  cluster::Bytes buffer(kSegmentSize);
  while (offset < info.stored_size && !stopping_) {
    const auto count =
        static_cast<size_t>(std::min<uint64_t>(buffer.size(), info.stored_size - offset));
    input.read(reinterpret_cast<char*>(buffer.data()), count);
    if (!input)
      return Error{ErrorCode::kUnavailable, "object read failed"};
    RK_RETURN_IF_ERROR(
        channel.SendBinary({{"type", "object.chunk"}, {"offset", offset}}, {buffer.data(), count}));
    offset += count;
  }
  if (stopping_)
    return Error{ErrorCode::kUnavailable, "peer stopping"};
  return channel.Send(
      {{"type", "object.end"}, {"size", info.stored_size}, {"sha256", info.stored_sha256}});
}
PeerClient::PeerClient(ObjectStore& store, const Key& key, std::string node, std::string build)
    : store_(store), key_(key), node_(std::move(node)), build_(std::move(build)) {}
PeerClient::~PeerClient() {
  SecureZeroMemory(key_.data(), key_.size());
}
Result<ObjectInfo> PeerClient::Fetch(const std::string& id, const std::string& address) {
  RK_ASSIGN_OR_RETURN(path, store_.StoredPath(id));
  auto lock = store_.Lock(id);
  fs::create_directories(path.parent_path());
  auto partial = path;
  partial += ".partial";
  std::error_code error;
  uint64_t offset = fs::exists(partial, error) ? fs::file_size(partial, error) : 0;
  if (error)
    return Error{ErrorCode::kUnavailable, "object partial unavailable"};
  RK_ASSIGN_OR_RETURN(carrier, cluster::ConnectTcp(address));
  RK_ASSIGN_OR_RETURN(
      connection, cluster::ConnectCarrier(std::move(carrier), key_, {"peer", node_, build_, {}}));
  if (connection.reply.value("type", Json()) == "node.reject")
    return Error{ErrorCode::kRejected, connection.reply.value("code", "peer rejected")};
  if (connection.reply.value("buildId", Json()) != build_)
    return Invalid();
  auto& channel = *connection.channel;
  RK_RETURN_IF_ERROR(channel.Send({{"type", "object.get"}, {"id", id}, {"offset", offset}}));
  std::ofstream output(partial, std::ios::binary | std::ios::app);
  if (!output)
    return Error{ErrorCode::kUnavailable, "object partial unavailable"};
  while (true) {
    RK_ASSIGN_OR_RETURN(message, channel.Receive(20s));
    const auto& header = message.json;
    const auto type = header.value("type", Json());
    if (type == "object.error") {
      if (offset && header.value("code", Json()) == "rejected") {
        output.close();
        fs::remove(partial, error);
      }
      return Error{ErrorCode::kUnavailable, header.value("code", "object transfer failed")};
    }
    if (type == "object.chunk" && message.kind == cluster::Message::Kind::kBinary) {
      if (!header.contains("offset") || !Number(header["offset"]) ||
          header["offset"].get<uint64_t>() != offset || message.bytes.empty() ||
          message.bytes.size() > kSegmentSize || offset > UINT64_MAX - message.bytes.size())
        return Invalid();
      output.write(reinterpret_cast<const char*>(message.bytes.data()), message.bytes.size());
      if (!output)
        return Error{ErrorCode::kUnavailable, "object partial write failed"};
      offset += message.bytes.size();
    } else if (type == "object.end" && message.kind == cluster::Message::Kind::kJson) {
      if (!header.contains("size") || !Number(header["size"]) ||
          header["size"].get<uint64_t>() != offset || !header.contains("sha256") ||
          !header["sha256"].is_string())
        return Invalid();
      output.close();
      if (!output)
        return Error{ErrorCode::kUnavailable, "object partial write failed"};
      return store_.Import(id, offset, header["sha256"].get<std::string>());
    } else
      return Invalid();
  }
}
}  // namespace remotekit::objects
