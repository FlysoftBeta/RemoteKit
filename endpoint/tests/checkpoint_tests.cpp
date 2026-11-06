#include "runtime_config_fixture.hpp"
#include "diagnostics/node_metrics.hpp"
#include "persistence/checkpoint.hpp"
#include "session/session.hpp"
#include "service.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>

using namespace remotekit;
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
class Link : public ManagementLink {
 public:
  Json sources = Json::object();
  std::set<std::string> committed;
  bool Next(std::string&, uint64_t&, bool& eof) override {
    eof = true;
    return false;
  }
  bool Current(uint64_t) override { return true; }
  bool SendReply(uint64_t, const Json&) override { return true; }
  bool SendEvent(const Json&, uint64_t) override { return true; }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string& name, Json fields) override {
    if (name == "object.committed") {
      committed.insert(fields["objectId"].get<std::string>());
      return Json{{"accepted", true}};
    }
    Check(name == "object.locate", "unexpected request");
    Json result = Json::object();
    for (const auto& id : fields["ids"])
      result[id.get<std::string>()] = sources.value(id.get<std::string>(), Json::array());
    return Json{{"sources", result}};
  }
};
std::string Read(const fs::path& path) {
  std::ifstream file(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
void Write(const fs::path& path, const std::string& bytes) {
  fs::create_directories(path.parent_path());
  std::ofstream file(path, std::ios::binary);
  file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}
void RoundTrip(const fs::path& root) {
  const std::string session(32, 'a');
  const auto directory = root / "one/sessions" / session;
  auto config = TestConfig();
  config["dataPath"] = Utf8(root / "one");
  const auto options = Take(RuntimeOptions::FromConfig(config, root, "dev", "test"));
  Link source_link, target_link;
  cluster::Key cluster_key{7};
  objects::Keys keys;
  keys.object.fill(8);
  keys.id.fill(9);
  objects::ObjectService source(root / "one", source_link, cluster_key, "source", "dev");
  objects::ObjectService target(root / "two", target_link, cluster_key, "target", "dev");
  media::Sdk sdk;
  Session first(sdk, options, "tenant", session, 1, cluster::Key{}, source_link, source, keys);
  Take(first.Initialize());
  Write(directory / "small", "persistent");
  Write(directory / "large", std::string(2 * 1024 * 1024 + 13, 'x'));
  Write(directory / "empty", "");
  Write(directory / "profile/Session Storage/CURRENT", "db");
  Write(directory / "profile/Session Storage/LOCK", "omit");
  Write(directory / "profile/Session Storage/LOG", "omit");
  Write(directory / "profile/Cookies-wal", "keep wal");
  Write(directory / "profile/Cookies-journal", "keep journal");
  Write(directory / "profile/Cache/value", "omit");
  Write(directory / "browser.log", "omit");
  fs::create_directories(directory / "empty-directory");
  const auto checkpoint = Take(first.Hibernate(source));
  Check(source_link.committed.size() == checkpoint["objects"].size(), "all objects committed");
  const auto manifest = checkpoint["manifestId"].get<std::string>();
  Check(fs::exists(directory.wstring() + L".checkpoint-index.json"), "external chunk index");
  HANDLE held = CreateFileW((directory / "large").c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(held != INVALID_HANDLE_VALUE, "lock unchanged file against content reads");
  const auto second = Checkpoints(source).Create(directory, "tenant", keys, session, 1, "dev");
  CloseHandle(held);
  Check(bool(second) && second.value() == checkpoint,
        "unchanged files reuse chunks without reading");
  std::map<fs::path, std::string> expected;
  for (const auto& entry : fs::recursive_directory_iterator(directory)) {
    if (!entry.is_regular_file())
      continue;
    const auto relative = entry.path().lexically_relative(directory);
    if (relative.generic_string().find("Cache/") == std::string::npos &&
        !Checkpoints::Excluded(relative, false))
      expected[relative] = Read(entry.path());
  }
  fs::remove_all(directory);
  Take(Checkpoints(source).Restore(directory, "tenant", keys, session, 2, "dev", manifest));
  for (const auto& [path, bytes] : expected)
    Check(Read(directory / path) == bytes, "local restored bytes");
  Check(!fs::exists(directory / "profile/Cache") && !fs::exists(directory / "browser.log") &&
            fs::is_directory(directory / "empty-directory"),
        "exclusions and empty directories");
  objects::PeerServer peer(source.Store(), cluster_key, "source", "dev");
  Take(peer.Start("127.0.0.1:0"));
  for (const auto& id : checkpoint["objects"])
    target_link.sources[id.get<std::string>()] =
        Json::array({{{"nodeId", "source"}, {"address", peer.Address()}}});
  const auto remote_directory = root / "two/sessions" / session;
  Take(Checkpoints(target).Restore(remote_directory, "tenant", keys, session, 2, "dev", manifest));
  for (const auto& [path, bytes] : expected)
    Check(Read(remote_directory / path) == bytes, "peer restored bytes");
  Check(target_link.committed == source_link.committed, "peer copies committed");
  Take(WriteDurableJson(remote_directory.wstring() + L".checkpoint", manifest));
  Write(remote_directory / "warm-only", "warm");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", keys, session, 3, "dev", manifest));
  Check(fs::exists(remote_directory / "warm-only"), "warm copy used");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", keys, session, 4, "dev", nullptr));
  Check(fs::is_empty(remote_directory), "null checkpoint starts empty");
}
void Blockers(const fs::path& root) {
  Link link;
  const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
  objects::ObjectService objects(options.data, link, cluster::Key{}, "test", "dev");
  media::Sdk sdk;
  Session session(sdk, options, "tenant", std::string(32, 'b'), 1, cluster::Key{}, link, objects,
                  objects::Keys{});
  Take(session.Initialize());
  Take(session.Views().RecordClosed("1", "closed"));
  const auto snapshot = Take(session.Snapshot());
  Check(snapshot["hibernation"]["unacknowledgedClosedEvents"] == 1, "durable close blocker");
  const auto hibernated = session.Hibernate(objects);
  Check(!hibernated && hibernated.error().code == ErrorCode::kConflict, "close event blocks");
  objects::Keys keys;
  FileLibrary library(root / "library", objects, "tenant", keys);
  Take(library.Initialize());
  const auto upload = Take(
      library.Begin(7, "sealed-upload", {"asset", "text/plain", 3}, [] { return Result<void>(); }));
  Take(library.Chunk(7, upload["uploadId"], 0, {'a', 'b', 'c'}, [] { return Result<void>(); }));
  const auto asset = Take(library.Seal(7, upload["uploadId"], [] { return Result<void>(); }));
  FileLibrary::Selection selection{std::string(32, 'd'),
                                   "request",
                                   {"inc", "1", "1", "1", "1"},
                                   {{asset.id, "asset", "text/plain"}}};
  Take(library.Prepare(selection));
  Take(library.Begin(7, "upload", {"name", "text/plain", 3}, [] { return Result<void>(); }));
  const auto blockers = library.Hibernation([](uint64_t grant) { return grant == 7; });
  Check(blockers["pendingNativeSelections"] == 1 && blockers["inFlightUploads"] == 1,
        "library owns selection and upload counts");
  Check(library.Hibernation([](uint64_t) { return false; })["inFlightUploads"] == 0,
        "revoked upload is not in flight");
}
void Metrics(const fs::path& root) {
  NodeMetrics sampler(root / "one");
  Sleep(150);
  const auto sample = sampler.Sample(2);
  Check(sample["cpu"] >= 0 && sample["cpu"] <= 1, "system CPU fraction");
  Check(sample["memory"]["total"] > 0 && sample["memory"]["available"] > 0 &&
            sample["memory"]["available"] <= sample["memory"]["total"],
        "physical memory");
  Check(sample["disk"]["free"] > 0 && sample["disk"]["free"] <= sample["disk"]["total"],
        "data volume");
  Check(sample["sessions"] == 2 && sample["objectBytes"] > 0, "session and object totals");
  Check(!sample["gpus"].empty(), "DXGI adapters on this machine");
  for (const auto& gpu : sample["gpus"])
    Check(gpu["engine3d"] >= 0 && gpu["engine3d"] <= 1 && gpu["engineVideoEncode"] >= 0 &&
              gpu["engineVideoEncode"] <= 1 && gpu["dedicatedTotal"] >= 0 &&
              gpu["dedicatedUsed"] >= 0,
          "GPU counters");
  std::cout << sample.dump() << '\n';
}
class FenceLink : public Link {
 public:
  size_t step = 0;
  uint64_t generation = 1;
  std::vector<Json> replies;
  std::optional<ReadyState> ReadySessions() override {
    return ReadyState{generation, Json::array()};
  }
  bool Next(std::string& bytes, uint64_t& stamp, bool& eof) override {
    eof = false;
    Json request;
    if (step == 0)
      request = {{"method", "session.open"},
                 {"tenantId", "tenant"},
                 {"sessionId", std::string(32, 'c')},
                 {"placementEpoch", 2},
                 {"checkpoint", nullptr},
                 {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                 {"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                 {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}};
    else if (step == 1) {
      generation = 2;
      request = {{"method", "session.snapshot"}, {"tenantId", "tenant"}};
    } else if (step == 2)
      request = {{"method", "session.cold.delete"}, {"tenantId", ""}};
    else
      request = {{"method", "shutdown"}};
    request["id"] = step++;
    stamp = generation;
    bytes = request.dump();
    return true;
  }
  bool SendReply(uint64_t, const Json& reply) override {
    replies.push_back(reply);
    return true;
  }
};
void Fencing(const fs::path& root) {
  const auto options =
      Take(RuntimeOptions::FromConfig(TestConfig(), root / "fence", "dev", "test"));
  FenceLink link;
  media::Sdk sdk;
  Service service(sdk, options, link, cluster::Key{});
  Check(service.Run() == 0, "fencing service");
  Check(link.replies[0]["ok"] && link.replies[1]["error"]["code"] == "not_found",
        "reconnect fencing forgets stale session");
  Check(link.replies[2]["result"]["deleted"] == 1, "node-wide cold delete");
}
}  // namespace
int main(int argc, char** argv) {
  try {
    Check(argc == 2, "evidence root argument");
    const auto root = fs::absolute(Utf8Path(argv[1])) /
                      ("checkpoint-native-" + std::to_string(GetCurrentProcessId()));
    fs::create_directories(root);
    RoundTrip(root);
    Blockers(root);
    Metrics(root);
    Fencing(root);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
