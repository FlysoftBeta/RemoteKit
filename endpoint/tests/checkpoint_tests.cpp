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
  bool SendEvent(const Json&, uint64_t, remotekit::DeliveryFlag delivery = {}) override {
    if (delivery)
      delivery->MarkWritten();
    return true;
  }
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
  objects::ObjectService source(root / "one", source_link, cluster_key, "source", "dev");
  objects::ObjectService target(root / "two", target_link, cluster_key, "target", "dev");
  Take(source.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                         {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  Take(target.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                         {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  media::Sdk sdk;
  Session first(sdk, options, "tenant", session, 1, cluster::Key{}, source_link, source);
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
  const auto second = Checkpoints(source).Create(directory, "tenant", "dev");
  CloseHandle(held);
  Check(bool(second) && second.value()["manifestId"] == checkpoint["manifestId"] &&
            second.value()["objects"] == checkpoint["objects"],
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
  Take(Checkpoints(source).Restore(directory, "tenant", manifest));
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
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  for (const auto& [path, bytes] : expected)
    Check(Read(remote_directory / path) == bytes, "peer restored bytes");
  Check(target_link.committed == source_link.committed, "peer copies committed");
  // Control committed the earlier hibernation; its journal is gone before the next checkpoint.
  fs::remove(directory.wstring() + L".hibernation.json");
  const auto upgraded = Take(Checkpoints(source).Create(directory, "tenant", "previous-build"));
  fs::remove_all(directory);
  Take(Checkpoints(source).Restore(directory, "tenant", upgraded["manifestId"]));
  for (const auto& [path, bytes] : expected)
    Check(Read(directory / path) == bytes,
          "a checkpoint from an earlier build restores after upgrade");
  const auto shared = Take(Checkpoints(target).Create(remote_directory, "other", "dev"));
  Check(shared["manifestId"] == manifest && shared["objects"] == checkpoint["objects"],
        "identical checkpoint content shares blocks and manifests across sessions and tenants");
  Take(WriteDurableJson(remote_directory.wstring() + L".checkpoint", manifest));
  Write(remote_directory / "warm-only", "warm");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  Check(fs::exists(remote_directory / "warm-only"), "warm copy used");
  Take(WriteDurableJson(remote_directory.wstring() + L".checkpoint", manifest));
  fs::remove(remote_directory / "small");
  Write(remote_directory / "profile/Cookies-wal", "corrupt");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  Check(Read(remote_directory / "small") == "persistent" &&
            Read(remote_directory / "profile/Cookies-wal") == "keep wal",
        "warm validation repairs missing and changed files");
  Take(Checkpoints(target).Create(remote_directory, "tenant", "dev"));
  Take(WriteDurableJson(remote_directory.wstring() + L".checkpoint", manifest));
  const auto unchanged_time = fs::last_write_time(remote_directory / "small");
  Write(remote_directory / "replacement", "XXXXXXXXXX");
  fs::last_write_time(remote_directory / "replacement", unchanged_time);
  fs::remove(remote_directory / "small");
  fs::rename(remote_directory / "replacement", remote_directory / "small");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  Check(Read(remote_directory / "small") == "persistent",
        "warm validation checks file ID at equal size and mtime");
  const auto empty_restore = Checkpoints(target).Restore(remote_directory, "tenant", nullptr);
  Check(!empty_restore && empty_restore.error().code == ErrorCode::kConflict &&
            Read(remote_directory / "small") == "persistent",
        "null restore refuses populated Profile");
  Take(Checkpoints::Journal(remote_directory, 7, checkpoint, "dev"));
  Check(Take(Checkpoints::Hibernation(remote_directory))["placementEpoch"] == 7,
        "durable journal identity");
  const auto stale = Checkpoints(target).Restore(remote_directory, "tenant", std::string(64, '0'));
  Check(!stale && stale.error().code == ErrorCode::kConflict &&
            Read(remote_directory / "small") == "persistent",
        "uncommitted hibernation rejects stale checkpoint without mutation");
  const auto null_journal = Checkpoints(target).Restore(remote_directory, "tenant", nullptr);
  Check(!null_journal && null_journal.error().code == ErrorCode::kConflict,
        "uncommitted hibernation rejects null checkpoint");
  Take(WriteDurableJson(remote_directory.wstring() + L".checkpoint", manifest));
  fs::remove(remote_directory / "small");
  Write(remote_directory / "profile/Cookies-wal", "leave this changed file");
  const auto local_index =
      Json::parse(Read(remote_directory.wstring() + L".checkpoint-index.json"));
  const auto missing_id = local_index["small"]["chunks"][0].get<std::string>();
  target_link.sources[missing_id] = Json::array();
  Take(target.Store().Delete(missing_id));
  const auto unavailable = Checkpoints(target).Restore(remote_directory, "tenant", manifest);
  Check(!unavailable && unavailable.error().code == ErrorCode::kUnavailable &&
            fs::exists(remote_directory / "warm-only") && !fs::exists(remote_directory / "small") &&
            Read(remote_directory / "profile/Cookies-wal") == "leave this changed file",
        "unavailable warm repair preserves directory");
  Take(Checkpoints(target).Restore(root / "new-session", "tenant", nullptr));
  Check(fs::is_empty(root / "new-session"), "null restore creates new Profile");
}
void Blockers(const fs::path& root) {
  Link link;
  const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
  objects::ObjectService objects(options.data, link, cluster::Key{}, "test", "dev");
  media::Sdk sdk;
  Session session(sdk, options, "tenant", std::string(32, 'b'), 1, cluster::Key{}, link, objects,
                  nullptr);
  Take(session.Initialize());
  Take(session.Views().RecordClosed("1", "closed"));
  const auto snapshot = Take(session.Snapshot());
  Check(snapshot["hibernation"]["unacknowledgedClosedEvents"] == 1, "durable close blocker");
  const auto hibernated = session.Hibernate(objects);
  Check(!hibernated && hibernated.error().code == ErrorCode::kConflict, "close event blocks");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  FileLibrary library(root / "library", objects, "tenant");
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
    return ReadyState{generation,
                      Json::array(),
                      {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                       {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}};
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
                 {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}};
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
class JournalLink : public Link {
 public:
  const std::string session = std::string(32, 'd');
  fs::path directory;
  bool replay = false;
  size_t step = 0;
  std::vector<Json> replies;
  std::optional<ReadyState> ReadySessions() override {
    return ReadyState{
        1,
        Json::array({{{"tenantId", "tenant"}, {"sessionId", session}, {"placementEpoch", 1}}}),
        {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
         {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}};
  }
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    eof = false;
    generation = 1;
    Json request{{"tenantId", "tenant"}, {"placementEpoch", 1}};
    if (!replay && step == 0) {
      request["method"] = "session.open";
      request["sessionId"] = session;
      request["profileKey"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      request["checkpoint"] = nullptr;
    } else if ((!replay && step <= 3) || (replay && step == 0)) {
      request["method"] = "session.hibernate";
      if (!replay && step == 3)
        request["placementEpoch"] = 2;
    } else if ((!replay && step == 4) || (replay && step == 1)) {
      request["method"] = "session.open";
      request["sessionId"] = session;
      request["profileKey"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      request["checkpoint"] = replay ? replies[0]["result"]["manifestId"] : Json(nullptr);
      request["placementEpoch"] = 2;
    } else {
      request["method"] = "shutdown";
    }
    request["id"] = step++;
    bytes = request.dump();
    return true;
  }
  bool SendReply(uint64_t, const Json& reply) override {
    if (reply.value("ok", false) && reply.value("result", Json::object()).contains("manifestId"))
      Check(fs::exists(directory.wstring() + L".hibernation.json"), "journal durable before reply");
    replies.push_back(reply);
    return true;
  }
};
void JournalReplay(const fs::path& root) {
  const auto options =
      Take(RuntimeOptions::FromConfig(TestConfig(), root / "journal", "dev", "test"));
  media::Sdk sdk;
  JournalLink first;
  first.directory = options.data / "sessions" / first.session;
  {
    Service service(sdk, options, first, cluster::Key{});
    Check(service.Run() == 0, "journal service");
  }
  Check(first.replies[1]["ok"] && first.replies[2]["ok"] &&
            first.replies[1]["result"] == first.replies[2]["result"],
        "duplicate hibernation returns committed manifest");
  Check(first.replies[3]["error"]["code"] == "conflict" &&
            first.replies[4]["error"]["code"] == "conflict",
        "journal fences different epoch and null open");
  JournalLink restarted;
  restarted.replay = true;
  restarted.directory = first.directory;
  {
    Service service(sdk, options, restarted, cluster::Key{});
    Check(service.Run() == 0, "journal restart service");
  }
  Check(restarted.replies[0]["result"]["manifestId"] == first.replies[1]["result"]["manifestId"] &&
            restarted.replies[1]["ok"],
        "restart replays journal and matching open succeeds");
  Check(!fs::exists(first.directory.wstring() + L".hibernation.json"),
        "matching open consumes journal");
}
class CapacityLink : public Link {
 public:
  size_t step = 0;
  std::vector<Json> replies;
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    eof = false;
    generation = 1;
    Json request{{"id", step}};
    if (step < 4) {
      request["method"] = "session.open";
      request["tenantId"] = "tenant-" + std::to_string(step);
      request["sessionId"] = std::string(31, 'e') + std::to_string(step);
      request["placementEpoch"] = 1;
      request["checkpoint"] = nullptr;
      request["profileKey"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    } else {
      request["method"] = "shutdown";
    }
    ++step;
    bytes = request.dump();
    return true;
  }
  bool SendReply(uint64_t, const Json& reply) override {
    replies.push_back(reply);
    return true;
  }
};
void SessionCapacity(const fs::path& root) {
  for (const bool limited : {false, true}) {
    auto config = TestConfig();
    config["maxSessions"] = limited ? Json(1) : Json(nullptr);
    config["diskReserveBytes"] = nullptr;
    config["sessionMemoryBytes"] = nullptr;
    const auto options = Take(
        RuntimeOptions::FromConfig(config, root / (limited ? "cap" : "uncapped"), "dev", "test"));
    CapacityLink link;
    media::Sdk sdk;
    Service service(sdk, options, link, cluster::Key{});
    Check(service.Run() == 0, "capacity service");
    Check(link.replies[0]["ok"], "first Session admitted");
    for (size_t i = 1; i < 4; ++i) {
      if (limited)
        Check(link.replies[i]["error"]["code"] == "unavailable", "session cap is unavailable");
      else
        Check(link.replies[i]["ok"], "null session cap admits every Session");
    }
  }
}
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
    JournalReplay(root);
    SessionCapacity(root);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
