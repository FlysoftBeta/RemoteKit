#include "objects/peer.hpp"
#include <windows.h>
#include <fstream>
#include <future>
#include <iostream>
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
  std::istringstream duplicate(plain);
  Check(Take(store.Write(keys, duplicate)).stored_sha256 == info.stored_sha256,
        "deterministic stored bytes");
  const auto path = Take(store.StoredPath(info.id));
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
    Check(!corrupt && corrupt.error().message == "corrupt object",
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
  for (int index = 0; index < 258; ++index) {
    std::istringstream value("inventory-" + std::to_string(index));
    Take(store.Write(keys, value));
  }
  const auto first = Take(store.Inventory(nullptr));
  Check(first["objects"].size() == 256 && first["next"].is_string(), "bounded inventory page");
  const auto next = Take(store.Inventory(first["next"]));
  Check(next["objects"].size() == 3 && next["next"].is_null(), "inventory continuation");
  std::set<std::string> identities;
  for (const auto& page : {first, next})
    for (const auto& object : page["objects"])
      Check(identities.insert(object["id"].get<std::string>()).second,
            "inventory pages do not repeat");
  Check(identities.size() == 259, "complete inventory");
}
void Peer(ObjectStore& source,
          ObjectStore& target,
          const Keys& keys,
          const ObjectInfo& info,
          const std::string& plain) {
  const cluster::Key cluster_key{7};
  PeerServer server(source, cluster_key, "source", "dev");
  Take(server.Start("127.0.0.1:0"));
  PeerClient client(target, cluster_key, "target", "dev");
  // Interrupt a real TCP/Noise transfer, then resume against the regular peer server.
  auto listener = Take(cluster::TcpListener::Listen("127.0.0.1:0"));
  auto interrupted = std::async(std::launch::async, [&] {
    auto carrier = Take(listener->Accept(5s));
    auto connection = Take(cluster::AcceptCarrier(
        std::move(carrier), cluster_key, [](const cluster::Json& hello) -> Result<cluster::Json> {
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
  Check(!client.Fetch(info.id, listener->Address()), "interrupted transfer fails");
  interrupted.get();
  auto partial = Take(target.StoredPath(info.id));
  partial += ".partial";
  Check(fs::file_size(partial) == 12345, "partial retained for resume");
  const auto fetched = Take(client.Fetch(info.id, server.Address()));
  Check(fetched.stored_sha256 == info.stored_sha256 && fetched.stored_size == info.stored_size &&
            !fs::exists(partial),
        "resumed stored file verified");
  Check(Read(target, keys, info.id) == plain, "resumed plaintext round trip");
  PeerClient mismatch(target, cluster_key, "target", std::string(64, 'a'));
  auto rejected = mismatch.Fetch(info.id, server.Address());
  Check(!rejected && rejected.error().message == "build_mismatch", "peer build lock");
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
    Peer(source, target, keys, info, plain);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
