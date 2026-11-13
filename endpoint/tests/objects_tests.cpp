#include "peer_fixture.hpp"
#include "objects/peer.hpp"
#include <windows.h>
#include <fstream>
#include <future>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <set>
#include <stdexcept>
using namespace remotekit;
using namespace remotekit::objects;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
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
std::string Read(ObjectStore& store, const Keys& keys, const std::string& id) {
  std::ostringstream output;
  Take(store.Read(keys, id, output));
  return output.str();
}
void Flip(const fs::path& path, uint64_t offset) {
  std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
  file.seekg(offset);
  char byte;
  file.get(byte);
  file.seekp(offset);
  file.put(byte ^ 1);
}
void Store(ObjectStore& store, const Keys& keys, const std::string& plain, ObjectInfo& info) {
  std::istringstream input(plain);
  info = Take(store.Write(keys, input));
  Check(info.id.size() == 64 &&
            info.id != cluster::Hex(cluster::Sha256(
                           {reinterpret_cast<const uint8_t*>(plain.data()), plain.size()})),
        "keyed object identity");
  Check(Read(store, keys, info.id) == plain, "segmented round trip");
  Check(Take(store.ReadRange(keys, info.id, 0, limits::objectChunkBytes)).size() ==
            limits::objectChunkBytes,
        "object range at chunk limit accepted");
  Check(!store.ReadRange(keys, info.id, 0, limits::objectChunkBytes + 1),
        "object range one byte over chunk limit rejected");
  std::istringstream duplicate(plain);
  Check(Take(store.Write(keys, duplicate)).stored_sha256 == info.stored_sha256,
        "deterministic stored bytes");
  const auto path = Take(store.StoredPath(info.id));
  const auto held = CreateFileW(path.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                                FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(held != INVALID_HANDLE_VALUE, "hold object without sharing");
  const auto inspect = store.Inspect(info.id);
  std::ostringstream blocked_output;
  const auto blocked_read = store.Read(keys, info.id, blocked_output);
  const auto blocked_range = store.ReadRange(keys, info.id, 0, 3);
  CloseHandle(held);
  Check(!inspect && inspect.error().code == ErrorCode::kUnavailable &&
            inspect.error().message.find("Windows 32") != std::string::npos,
        "object inspect sharing violation");
  Check(!blocked_read && blocked_read.error().code == ErrorCode::kUnavailable,
        "object read sharing violation");
  Check(!blocked_range && blocked_range.error().code == ErrorCode::kUnavailable,
        "object range sharing violation");

  std::ifstream file(path, std::ios::binary);
  file.seekg(24);
  for (uint32_t index = 0; index < 3; ++index) {
    const auto start = static_cast<uint64_t>(file.tellg());
    std::array<uint8_t, 5> prefix;
    file.read(reinterpret_cast<char*>(prefix.data()), prefix.size());
    Check(prefix[0] == (index != 1), "compression selected only when smaller");
    const auto length = cluster::DecodeLength(std::span<const uint8_t, 4>(prefix.data() + 1, 4));
    file.seekg(length, std::ios::cur);
    file.close();
    Flip(path, start + 5 + length - 1);
    std::ostringstream output;
    auto corrupt = store.Read(keys, info.id, output);
    Check(!corrupt && corrupt.error().code == remotekit::ErrorCode::kInternal,
          "each segment authenticates its tag");
    Flip(path, start + 5 + length - 1);
    file.open(path, std::ios::binary);
    file.seekg(start + 5 + length);
  }
  file.close();
  auto wrong = keys;
  wrong.object[0] ^= 1;
  std::ostringstream rejected;
  Check(!store.Read(wrong, info.id, rejected), "wrong encryption key rejected");
  auto bytes = Take(store.ReadRange(keys, info.id, kSegmentSize - 3, 9));
  Check(std::string(bytes.begin(), bytes.end()) == plain.substr(kSegmentSize - 3, 9),
        "range across segments");
  std::istringstream empty("");
  const auto zero = Take(store.Write(keys, empty));
  Check(zero.size == 0 && zero.stored_size == 24 && Read(store, keys, zero.id).empty(),
        "empty object");
  Check(Take(store.Inventory(nullptr))["objects"].size() == 2, "inventory");
  Take(store.Delete(zero.id));
  Take(store.Delete(zero.id));
  Check(!store.Inspect(zero.id), "delete");
  Check(!store.StoredPath(std::string(64, 'G')), "object id validated");
  for (size_t index = 0; index < limits::objectInventoryPage - 1; ++index) {
    std::istringstream value("inventory-" + std::to_string(index));
    Take(store.Write(keys, value));
  }
  const auto full = Take(store.Inventory(nullptr));
  Check(full["objects"].size() == limits::objectInventoryPage && full["next"].is_null(),
        "inventory at page limit needs no continuation");
  std::istringstream extra("inventory-overflow");
  Take(store.Write(keys, extra));
  const auto first = Take(store.Inventory(nullptr));
  Check(first["objects"].size() == limits::objectInventoryPage && first["next"].is_string(),
        "bounded inventory page");
  const auto next = Take(store.Inventory(first["next"]));
  Check(next["objects"].size() == 1 && next["next"].is_null(), "inventory one over is continued");
  std::set<std::string> identities;
  for (const auto& page : {first, next})
    for (const auto& object : page["objects"])
      Check(identities.insert(object["id"].get<std::string>()).second,
            "inventory pages do not repeat");
  Check(identities.size() == limits::objectInventoryPage + 1, "complete inventory");
}
void LocateReplyBudget() {
  Json sources = Json::object();
  const Json source{{"nodeId", std::string(limits::objectSourceNodeIdBytes, '\x01')},
                    {"address", std::string(limits::objectSourceAddressBytes, '\x01')}};
  for (size_t i = 0; i < limits::objectLocateIds; ++i) {
    std::ostringstream id;
    id << std::hex << std::setw(64) << std::setfill('0') << i;
    sources[id.str()] = Json::array();
    for (size_t j = 0; j < limits::objectLocateSources; ++j)
      sources[id.str()].push_back(source);
  }
  const Json reply{{"id", std::string(limits::identityBytes, '\x01')},
                   {"opId", std::string(limits::identityBytes, '\x01')},
                   {"ok", true},
                   {"result", {{"sources", sources}}}};
  Check(reply.dump().size() < limits::managementBytes / 2,
        "worst escaped locate reply retains half the management budget");
}
void Peer(ObjectStore& source,
          ObjectStore& target,
          const Keys& keys,
          const ObjectInfo& info,
          const std::string& plain) {
  const auto source_key = TestPrivateKey(7), target_key = TestPrivateKey(8);
  PeerSet server_peers, client_peers;
  Take(server_peers.Update(Json::array({TestPeer("target", "127.0.0.1:1", target_key)})));
  PeerServer server(source, source_key, "source", "dev", server_peers);
  Take(server.Start("127.0.0.1:0"));
  PeerClient client(target, target_key, "target", "dev", client_peers);
  // Interrupt a real TCP/Noise transfer, then resume against the regular peer server.
  auto listener = Take(cluster::TcpListener::Listen("127.0.0.1:0"));
  auto interrupted = std::async(std::launch::async, [&] {
    auto carrier = Take(listener->Accept(5s));
    auto connection = Take(cluster::AcceptCarrier(
        std::move(carrier), source_key,
        [](const cluster::Json& hello, const cluster::Key& public_key) -> Result<cluster::Json> {
          Check(hello["role"] == "peer", "peer hello");
          return cluster::Json{{"type", "node.ready"}, {"buildId", "dev"}};
        }));
    const auto request = Take(connection.channel->Receive(5s)).json;
    Check(request["offset"] == 0, "initial transfer offset");
    std::ifstream input(Take(source.StoredPath(info.id)), std::ios::binary);
    cluster::Bytes chunk(12345);
    input.read(reinterpret_cast<char*>(chunk.data()), chunk.size());
    Take(connection.channel->SendBinary({{"type", "object.chunk"}, {"offset", 0}}, chunk));
    connection.channel->Close();
  });
  Take(client_peers.Update(Json::array({TestPeer("source", listener->Address(), source_key)})));
  Check(!client.Fetch(info.id, "source"), "interrupted transfer fails");
  interrupted.get();
  auto partial = Take(target.StoredPath(info.id));
  partial += ".partial";
  Check(fs::file_size(partial) == 12345, "partial retained for resume");
  Take(client_peers.Update(Json::array({TestPeer("source", server.Address(), source_key)})));
  const auto fetched = Take(client.Fetch(info.id, "source"));
  Check(fetched.stored_sha256 == info.stored_sha256 && fetched.stored_size == info.stored_size &&
            !fs::exists(partial),
        "resumed stored file verified");
  Check(Read(target, keys, info.id) == plain, "resumed plaintext round trip");
  PeerClient mismatch(target, target_key, "target", std::string(64, 'a'), client_peers);
  auto rejected = mismatch.Fetch(info.id, "source");
  Check(!rejected && rejected.error().code == remotekit::ErrorCode::kUnavailable,
        "peer build lock");
  PeerSet intruder_peers;
  Take(intruder_peers.Update(Json::array({TestPeer("source", server.Address(), source_key)})));
  PeerClient intruder(target, TestPrivateKey(9), "target", "dev", intruder_peers);
  Check(!intruder.Fetch(info.id, "source"),
        "non-member static key is rejected even with member claim");
  Take(server_peers.Update(Json::array()));
  server.Revoke();
  Check(!client.Fetch(info.id, "source"), "removed member is rejected");
  Take(server_peers.Update(Json::array({TestPeer("actual-member", "127.0.0.1:1", target_key)})));
  Check(bool(client.Fetch(info.id, "source")),
        "peer identity comes from key membership rather than claimed id");
  Take(client_peers.Update(Json::array({TestPeer("source", server.Address(), TestPrivateKey(9))})));
  Check(!client.Fetch(info.id, "source"), "wrong responder static key is rejected");
  fs::copy_file(Take(source.StoredPath(info.id)), partial);
  Flip(partial, 25);
  Check(!target.Import(info.id, info.stored_size, info.stored_sha256) && !fs::exists(partial),
        "transfer hash mismatch removes partial");
}
}  // namespace
int main(int argc, char** argv) {
  try {
    Check(argc == 2, "evidence root required");
    const auto root =
        fs::absolute(fs::path(argv[1])) / ("objects-test-" + std::to_string(GetCurrentProcessId()));
    fs::create_directories(root);
    struct Cleanup {
      fs::path path;
      ~Cleanup() {
        std::error_code error;
        fs::remove_all(path, error);
      }
    } cleanup{root};
    ObjectStore source(root / "source"), target(root / "target");
    Keys keys;
    keys.object.fill(9);
    keys.id.fill(11);
    std::string plain(kSegmentSize, 'a');
    uint32_t random = 1234;
    for (size_t i = 0; i < kSegmentSize; ++i) {
      random ^= random << 13;
      random ^= random >> 17;
      random ^= random << 5;
      plain.push_back(static_cast<char>(random));
    }
    plain += std::string(1000, 'z');
    ObjectInfo info;
    Store(source, keys, plain, info);
    LocateReplyBudget();
    Peer(source, target, keys, info, plain);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
