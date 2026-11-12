#include "peer_fixture.hpp"
#include "session_db_fixture.hpp"
#include "runtime_config_fixture.hpp"
#include "diagnostics/node_metrics.hpp"
#include "persistence/checkpoint.hpp"
#include "session/session.hpp"
#include "service.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <functional>
#include <iomanip>

namespace remotekit {
class CheckpointCacheProbe {
 public:
  static void Age(CheckpointCache& cache) {
    std::lock_guard lock(cache.watcher_.mutex_);
    for (auto& [name, changed] : cache.watcher_.changes_.paths)
      changed = PhaseClock::now() - std::chrono::seconds(11);
  }
  static void RefreshNow(CheckpointCache& cache) { cache.next_refresh_ = PhaseClock::now(); }
  static void Overflow(DirectoryWatcher& watcher) {
    std::lock_guard lock(watcher.mutex_);
    for (int i = 0; i < 2048; ++i) {
      const auto name = std::to_string(i) + std::string(100, 'x');
      std::ofstream(watcher.directory_ / name, std::ios::binary) << 'x';
    }
  }
  static void Wait(CheckpointCache& cache) {
    if (cache.staging_.valid())
      cache.staging_.get();
  }
};
}  // namespace remotekit
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
  std::mutex mutex;
  size_t commit_requests = 0, locate_requests = 0;
  std::vector<Json> batches, refreshes;
  std::function<void()> on_commit;
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
    std::lock_guard lock(mutex);
    if (name == "object.committed.batch") {
      ++commit_requests;
      Check(fields.contains("tenantId") && fields["tenantId"].is_string(),
            "reverse request includes its tenant scope");
      Check(fields["objects"].size() <= 1024 && fields.dump().size() <= 256 * 1024,
            "bounded object commit batch");
      batches.push_back(fields);
      for (const auto& object : fields["objects"])
        committed.insert(object["objectId"].get<std::string>());
      if (on_commit)
        on_commit();
      return Json{{"ok", true}};
    }
    if (name == "object.committed") {
      committed.insert(fields["objectId"].get<std::string>());
      return Json{{"accepted", true}};
    }
    if (name == "object.claims.refresh") {
      Check(fields["ids"].size() <= 1024, "bounded claim refresh");
      refreshes.push_back(fields);
      return Json{{"ok", true}};
    }
    Check(name == "object.locate", "unexpected request");
    ++locate_requests;
    Check(fields["ids"].size() <= 1024, "bounded locate batch");
    Json result = Json::object();
    for (const auto& id : fields["ids"])
      result[id.get<std::string>()] = sources.value(id.get<std::string>(), Json::array());
    return Json{{"sources", result}};
  }
};
std::string Read(const fs::path& path) {
  std::ifstream file(LongPath(path), std::ios::binary);
  return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
void Write(const fs::path& path, const std::string& bytes) {
  fs::create_directories(LongPath(path).parent_path());
  std::ofstream file(LongPath(path), std::ios::binary);
  file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}
Result<Json> Commit(Session& session) {
  auto result = session.StopAndCommit("test-commit");
  if (!result)
    return result.error();
  result.value()["manifestId"] = result.value()["base"];
  return result;
}
void RoundTrip(const fs::path& root) {
  const std::string session(32, 'a');
  const auto directory = LongPath(root / "one/data/sessions" / session);
  auto config = TestConfig();
  const auto options = Take(RuntimeOptions::FromConfig(config, root / "one", "dev", "test"));
  Link source_link, target_link;
  const auto source_key = TestPrivateKey(7), target_key = TestPrivateKey(8);
  objects::ObjectService source(root / "one/data", source_link, source_key, "source", "dev");
  objects::ObjectService target(root / "two/data", target_link, target_key, "target", "dev");
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
  Write(directory / std::string(110, 'a') / std::string(110, 'b') / std::string(110, 'c'),
        "long path");
  Write(directory / "profile/Session Storage/CURRENT", "db");
  Write(directory / "profile/Session Storage/LOCK", "omit");
  Write(directory / "profile/Session Storage/LOG", "omit");
  Write(directory / "profile/Cookies-wal", "keep wal");
  Write(directory / "profile/Cookies-journal", "keep journal");
  Write(directory / "profile/Cache/value", "omit");
  fs::create_directories(directory / "empty-directory");
  const auto checkpoint = Take(Commit(first));
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
  Check(!fs::exists(directory / "profile/Cache") && fs::is_directory(directory / "empty-directory"),
        "exclusions and empty directories");
  objects::PeerSet members;
  Take(members.Update(Json::array({TestPeer("target", "127.0.0.1:1", target_key)})));
  objects::PeerServer peer(source.Store(), source_key, "source", "dev", members);
  Take(peer.Start("127.0.0.1:0"));
  Take(target.SetPeers(Json::array({TestPeer("source", peer.Address(), source_key),
                                    TestPeer("failed", "127.0.0.1:1", TestPrivateKey(1))})));
  for (const auto& id : checkpoint["objects"])
    target_link.sources[id.get<std::string>()] =
        Json::array({{{"nodeId", "source"}, {"address", peer.Address()}}});
  const auto remote_directory = LongPath(root / "two/data/sessions" / session);
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  for (const auto& [path, bytes] : expected)
    Check(Read(remote_directory / path) == bytes, "peer restored bytes");
  Check(target_link.committed == source_link.committed, "peer copies committed");
  const auto upgraded = Take(Checkpoints(source).Create(directory, "tenant", "previous-build"));
  fs::remove_all(directory);
  Take(Checkpoints(source).Restore(directory, "tenant", upgraded["manifestId"]));
  for (const auto& [path, bytes] : expected)
    Check(Read(directory / path) == bytes,
          "a checkpoint from an earlier build restores after upgrade");
  const auto shared = Take(Checkpoints(target).Create(remote_directory, "other", "dev"));
  Check(shared["manifestId"] == manifest && shared["objects"] == checkpoint["objects"],
        "identical checkpoint content shares blocks and manifests across sessions and tenants");
  Write(remote_directory / "warm-only", "warm");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  Check(!fs::exists(remote_directory / "warm-only"), "warm repair removes uncommitted extras");
  fs::remove(remote_directory / "small");
  Write(remote_directory / "profile/Cookies-wal", "corrupt");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  Check(Read(remote_directory / "small") == "persistent" &&
            Read(remote_directory / "profile/Cookies-wal") == "keep wal",
        "warm validation repairs missing and changed files");
  Take(Checkpoints(target).Create(remote_directory, "tenant", "dev"));
  const auto unchanged_time = fs::last_write_time(remote_directory / "small");
  Write(remote_directory / "replacement", "XXXXXXXXXX");
  fs::last_write_time(remote_directory / "replacement", unchanged_time);
  fs::remove(remote_directory / "small");
  fs::rename(remote_directory / "replacement", remote_directory / "small");
  Take(Checkpoints(target).Restore(remote_directory, "tenant", manifest));
  Check(Read(remote_directory / "small") == "persistent",
        "warm validation checks file ID at equal size and mtime");
  fs::remove(remote_directory / "small");
  Write(remote_directory / "profile/Cookies-wal", "leave this changed file");
  const auto local_index =
      Json::parse(Read(remote_directory.wstring() + L".checkpoint-index.json"));
  const auto missing_id = local_index["small"]["chunks"][0].get<std::string>();
  target_link.sources[missing_id] = Json::array();
  Take(target.Store().Delete(missing_id));
  const auto unavailable = Checkpoints(target).Restore(remote_directory, "tenant", manifest);
  Check(!unavailable && unavailable.error().code == ErrorCode::kUnavailable &&
            !fs::exists(remote_directory / "small") &&
            Read(remote_directory / "profile/Cookies-wal") == "leave this changed file",
        "unavailable warm repair preserves directory");
  Take(Checkpoints(target).Restore(root / "new-session", "tenant", nullptr));
  Check(fs::is_empty(root / "new-session"), "null restore creates new Profile");
}
void DraftCheckpoint(const fs::path& root) {
  const auto data = root / "draft-node/data";
  const std::string session_id(32, 'd');
  const auto directory = data / "sessions" / session_id;
  Link link;
  objects::ObjectService objects(data, link, {}, "draft-node", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  {
    SessionDb seed(directory);
    Take(seed.Open());
    for (const auto& upload : {std::string(32, 'a'), std::string(32, 'b')}) {
      Take(seed.Library().Save(LibraryTable::kDrafts, upload,
                               {{"operation", upload},
                                {"name", "a"},
                                {"type", "text/plain"},
                                {"size", 3},
                                {"expires", 2000000000},
                                {"sealed", upload.front() == 'a' ? "" : std::string(64, 'c')}}));
      Write(directory / "file-library/incoming" / upload, "abc");
    }
  }
  auto config = TestConfig();
  const auto options = Take(RuntimeOptions::FromConfig(config, data.parent_path(), "dev", "test"));
  media::Sdk sdk;
  Json checkpoint;
  {
    Session session(sdk, options, "tenant", session_id, 1, {}, link, objects);
    Take(session.Initialize());
    checkpoint = Take(Commit(session));
  }
  Check(!fs::exists(directory / "file-library/incoming"), "draft payloads discarded at stop");
  const auto restored_data = root / "draft-restored-node/data";
  const auto restored_directory = restored_data / "sessions" / session_id;
  Take(Checkpoints(objects).Restore(restored_directory, "tenant", checkpoint["manifestId"]));
  const auto restored_options =
      Take(RuntimeOptions::FromConfig(config, restored_data.parent_path(), "dev", "test"));
  {
    Session restored(sdk, restored_options, "tenant", session_id, 2, {}, link, objects);
    Take(restored.Initialize());
  }
  SessionDb verify(restored_directory);
  Take(verify.Open());
  Check(Take(verify.Library().Load(LibraryTable::kDrafts)).empty(),
        "draft rows absent after restore");
  Check(fs::is_empty(restored_directory / "file-library/incoming"),
        "restored incoming directory is empty");
}
void IncrementalEquality(const fs::path& root) {
  const auto directory = root / "incremental";
  Write(directory / "rename/sub/file", "old");
  Write(directory / "remove", "deleted");
  Write(directory / "case", "case");
  Write(directory / "replace/old", "removed child");
  auto previous = Take(Checkpoints::Scan(directory, Json(), {}));
  DirectoryWatcher watcher;
  watcher.Start(directory);
  fs::rename(directory / "rename", directory / "renamed");
  fs::rename(directory / "case", directory / "CASE");
  fs::remove(directory / "remove");
  fs::remove_all(directory / "replace");
  Write(directory / "replace/new", "new child");
  Write(directory / "new/sub/file", "created");
  Write(directory / "renamed/sub/file", "changed");
  Write(directory / "profile/Cache/ignored", "cache");
  watcher.Stop();
  const auto changes = watcher.Snapshot();
  Check(changes.continuous, "watcher drained through shutdown boundary");
  _putenv_s("REMOTEKIT_CHECKPOINT_VERIFY", "1");
  const auto incremental = Take(Checkpoints::Scan(directory, previous, changes));
  _putenv_s("REMOTEKIT_CHECKPOINT_VERIFY", "");
  Check(incremental == Take(Checkpoints::Scan(directory, Json(), {})),
        "incremental scan equals full walk for renames, deletes, replacements and new directories");
  watcher.Start(directory);
  CheckpointCacheProbe::Overflow(watcher);
  for (int i = 0; i < 500 && watcher.Snapshot().continuous; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  Check(!watcher.Snapshot().continuous, "kernel notification overflow invalidates coverage");
  Write(directory / "overflow/new", "overflow");
  watcher.Stop();
  Json phases = CheckpointPhases();
  Check(Take(Checkpoints::Scan(directory, previous, watcher.Snapshot(), &phases)) ==
                Take(Checkpoints::Scan(directory, Json(), {})) &&
            phases["scan"]["filesFromWatcher"] == 0,
        "overflow invalidates the baseline and forces a full walk");
}
void BatchesAndPipeline(const fs::path& root) {
  Link source_link, target_link;
  const auto source_key = TestPrivateKey(2), target_key = TestPrivateKey(3);
  objects::ObjectService source(root / "pipeline-source", source_link, source_key, "source", "dev");
  objects::ObjectService target(root / "pipeline-target", target_link, target_key, "target", "dev");
  const Json keys = {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                     {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}};
  Take(source.Configure(keys));
  Take(target.Configure(keys));
  std::vector<objects::ObjectInfo> infos;
  std::vector<std::string> ids;
  for (int i = 0; i < 2050; ++i) {
    std::ostringstream text;
    text << std::hex << std::setfill('0') << std::setw(64) << i;
    ids.push_back(text.str());
    infos.push_back({text.str(), 1, 41, std::string(64, 'a')});
  }
  Take(source.CommittedBatch(infos, "tenant"));
  Check(source_link.commit_requests == 3, "commit list streams in bounded batches");
  objects::SessionObjects access(source, "tenant");
  Take(access.Prepare(ids));
  Check(source_link.locate_requests == 3, "locate grants a complete list in bounded batches");
  const auto directory = root / "pipeline-profile";
  for (int i = 0; i < 64; ++i)
    Write(directory / (std::to_string(i) + "/file"), std::string(2048, char(i)));
  Write(directory / "large", std::string(3 * 1024 * 1024 + 13, 'p'));
  const auto first = Take(Checkpoints(source).Create(directory, "tenant", "dev"));
  const auto second = Take(Checkpoints(source).Create(directory, "tenant", "dev"));
  Check(first == second, "parallel checkpoint manifest is deterministic");
  objects::PeerSet members;
  Take(members.Update(Json::array({TestPeer("target", "127.0.0.1:1", target_key)})));
  objects::PeerServer peer(source.Store(), source_key, "source", "dev", members);
  Take(peer.Start("127.0.0.1:0"));
  Take(target.SetPeers(Json::array({TestPeer("source", peer.Address(), source_key),
                                    TestPeer("failed", "127.0.0.1:1", TestPrivateKey(1))})));
  for (const auto& id : first["objects"])
    target_link.sources[id.get<std::string>()] =
        Json::array({{{"nodeId", "failed"}, {"address", "127.0.0.1:1"}},
                     {{"nodeId", "source"}, {"address", peer.Address()}}});
  auto phases = RestorePhases();
  const auto restored = root / "pipeline-restored";
  Take(Checkpoints(target, {}, &phases).Restore(restored, "tenant", first["manifestId"]));
  Check(Read(restored / "large") == Read(directory / "large"),
        "parallel chunk offsets preserve bytes");
  for (int i = 0; i < 64; ++i)
    Check(Read(restored / (std::to_string(i) + "/file")) == std::string(2048, char(i)),
          "parallel restore materializes every file through a failing source");
  Check(phases["fetch"]["concurrency"] == 8 && target_link.locate_requests == 2 &&
            target_link.commit_requests == 2,
        "parallel restore batches grants and new replicas");
  CheckpointCache cache;
  cache.Start(directory);
  {
    std::fstream changed(directory / "large", std::ios::binary | std::ios::in | std::ios::out);
    changed.put('q');
  }
  cache.Stop();
  const auto previous = Json::parse(Read(directory.wstring() + L".checkpoint-index.json"));
  const auto chunk = previous["large"]["chunks"][1].get<std::string>();
  const auto object_path = Take(source.Store().StoredPath(chunk));
  HANDLE held = CreateFileW(object_path.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(held != INVALID_HANDLE_VALUE, "hold unchanged checkpoint object against inspection");
  auto incremental_phases = CheckpointPhases();
  const auto changed =
      Checkpoints(source, {}, &incremental_phases, &cache).Create(directory, "tenant", "dev");
  CloseHandle(held);
  Check(bool(changed) && incremental_phases["store"]["filesRead"] == 1 &&
            incremental_phases["store"]["chunksNew"] == 1,
        "changed files hash and reuse indexed chunks without inspecting their stored replicas");
}
void PreStageIdentity(const fs::path& root) {
  Link link;
  objects::ObjectService objects(root / "stage-objects", link, {}, "stage", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  const auto directory = root / "stage-profile";
  CheckpointCache cache;
  cache.Start(directory);
  const auto file = directory / "quiet-file";
  Write(file, "first identity");
  for (int i = 0; i < 500 && !cache.Changes().paths.contains("quiet-file"); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  Check(cache.Changes().paths.contains("quiet-file"), "pre-stage observes file change");
  const auto before = Take(CheckpointIdentity(file));
  link.on_commit = [&] { Write(file, "changed during pre-stage"); };
  CheckpointCacheProbe::Age(cache);
  cache.MaybeStage(objects, "tenant");
  CheckpointCacheProbe::Wait(cache);
  Check(!cache.Find("quiet-file", before), "identity change discards pre-staged cache entry");
  link.on_commit = {};
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  const auto stable = Take(CheckpointIdentity(file));
  CheckpointCacheProbe::Age(cache);
  cache.MaybeStage(objects, "tenant");
  CheckpointCacheProbe::Wait(cache);
  Check(cache.Find("quiet-file", stable).has_value(), "quiet stable file reuses pre-staged chunks");
  for (const auto& batch : link.batches)
    Check(batch.value("tenantId", std::string()) == "tenant", "pre-stage owns tenant claims");

  Write(directory / "peer-active", "pre-stage with peer");
  for (int i = 0; i < 500 && !cache.Changes().paths.contains("peer-active"); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  CheckpointCacheProbe::Age(cache);
  cache.MaybeStage(objects, "tenant");
  CheckpointCacheProbe::Wait(cache);
  Check(cache.Find("peer-active", Take(CheckpointIdentity(directory / "peer-active"))).has_value(),
        "pre-staging remains enabled for every running Session");
  CheckpointCacheProbe::RefreshNow(cache);
  cache.MaybeStage(objects, "tenant");
  CheckpointCacheProbe::Wait(cache);
  Check(!link.refreshes.empty() && link.refreshes[0]["tenantId"] == "tenant" &&
            !link.refreshes[0]["ids"].empty(),
        "staged chunks refresh tenant claims");
  cache.Stop();
}
void Blockers(const fs::path& root) {
  Link link;
  const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
  objects::ObjectService objects(options.data, link, cluster::Key{}, "test", "dev");
  media::Sdk sdk;
  Session session(sdk, options, "tenant", std::string(32, 'b'), 1, cluster::Key{}, link, objects);
  Take(session.Initialize());
  Take(session.Views().RecordClosed("1", "closed"));
  const auto snapshot = Take(session.Snapshot());
  Check(snapshot["stopBlockers"]["unacknowledgedClosedEvents"] == 1, "durable close blocker");
  const auto stopped = Commit(session);
  Check(!stopped && stopped.error().code == ErrorCode::kConflict, "close event blocks");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  test::LibraryFixture library(root / "library", objects, "tenant");
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
  const auto blockers = library.StopBlockers([](uint64_t grant) { return grant == 7; });
  Check(blockers["pendingNativeSelections"] == 1 && blockers["inFlightUploads"] == 1,
        "library owns selection and upload counts");
  Check(library.StopBlockers([](uint64_t) { return false; })["inFlightUploads"] == 0,
        "revoked upload is not in flight");
}
void Metrics(const fs::path& root) {
  NodeMetrics sampler(root / "one/data");
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
class CopyLink : public Link {
 public:
  const std::string session = std::string(32, 'd');
  bool replay = false, graceful = false;
  size_t step = 0;
  std::vector<Json> replies, events;
  std::optional<ReadyState> ReadySessions() override {
    return ReadyState{1,
                      Json::array({{{"tenantId", "tenant"},
                                    {"sessionId", session},
                                    {"placementEpoch", 1},
                                    {"dataState", "dirty"}}}),
                      {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                       {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}};
  }
  bool SendEvent(const Json& event, uint64_t, DeliveryFlag = {}) override {
    events.push_back(event);
    return true;
  }
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    eof = false;
    generation = 1;
    Json request{{"tenantId", "tenant"}, {"placementEpoch", 1}};
    if (!replay && step == 0) {
      request.update({{"method", "session.open"},
                      {"sessionId", session},
                      {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                      {"checkpoint", nullptr}});
    } else if (!graceful && ((!replay && step <= 3) || (replay && step <= 1))) {
      request.update({{"method", "session.stop"},
                      {"commit", step == 3 || (replay && step == 1) ? "different" : "commit-one"}});
    } else {
      request["method"] = "shutdown";
    }
    request["id"] = step++;
    bytes = request.dump();
    return true;
  }
  bool SendReply(uint64_t, const Json& reply) override {
    replies.push_back(reply);
    return true;
  }
};
void CommitReplay(const fs::path& root) {
  const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root / "copy", "dev", "test"));
  media::Sdk sdk;
  CopyLink first;
  {
    Service service(sdk, options, first, {});
    Check(service.Run() == 0, "copy service");
  }
  Check(first.replies[1]["ok"] && first.replies[2]["ok"] &&
            first.replies[1]["result"] == first.replies[2]["result"],
        "commit repeats after unload");
  Check(first.replies[3]["result"]["committed"].is_null(),
        "different ID reuses stopped clean copy");
  CopyLink restarted;
  restarted.replay = true;
  {
    Service service(sdk, options, restarted, {});
    Check(service.Run() == 0, "copy restart");
  }
  Check(restarted.replies[0]["result"] == first.replies[1]["result"],
        "commit repeats after restart");
  Check(restarted.events[0]["sessions"][0]["copy"]["lastCommit"]["requestId"] == "commit-one",
        "ready reports durable commit");
}
void GracefulCommit(const fs::path& root) {
  const auto options =
      Take(RuntimeOptions::FromConfig(TestConfig(), root / "graceful", "dev", "test"));
  media::Sdk sdk;
  CopyLink link;
  link.graceful = true;
  {
    Service service(sdk, options, link, {});
    Check(service.Run() == 0, "graceful shutdown");
  }
  const auto directory = options.data / "sessions" / link.session;
  const auto copy = Take(Checkpoints::Copy(directory));
  Check(copy["state"] == "clean" && copy["stoppedCleanly"] == true &&
            copy["lastCommit"]["requestId"].get<std::string>().starts_with("node-"),
        "graceful shutdown commits with node request ID");
  CopyLink restarted;
  restarted.graceful = restarted.replay = true;
  {
    Service service(sdk, options, restarted, {});
    Check(service.Run() == 0, "graceful restart");
  }
  Check(restarted.events[0]["sessions"][0]["copy"]["lastCommit"] == copy["lastCommit"],
        "node ready reports shutdown commit");
}
void DeferredCommit(const fs::path& root) {
  const auto options =
      Take(RuntimeOptions::FromConfig(TestConfig(), root / "deferred", "dev", "test"));
  CopyLink offline;
  media::Sdk sdk;
  objects::ObjectService objects(options.data, offline, {}, "test", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  Json committed;
  {
    Session session(sdk, options, "tenant", offline.session, 1, {}, offline, objects);
    Take(session.Initialize());
    Write(options.data / "sessions" / offline.session / "payload", "offline state");
    committed =
        Take(session.StopAndCommit("node-offline", false, PhaseClock::time_point::max(), true));
    Check(offline.committed.empty() && committed["state"] == "clean",
          "offline shutdown publishes locally");
  }
  CopyLink restarted;
  restarted.graceful = restarted.replay = true;
  {
    Service service(sdk, options, restarted, {});
    Check(service.Run() == 0, "deferred reconnect");
  }
  Check(restarted.committed.contains(committed["base"].get<std::string>()),
        "reconnect registers deferred manifest");
  const auto limited =
      Take(RuntimeOptions::FromConfig(TestConfig(), root / "budget", "dev", "test"));
  Session session(sdk, limited, "tenant", offline.session, 1, {}, offline, objects);
  Take(session.Initialize());
  const auto stopped = Take(session.StopAndCommit("budget", false, PhaseClock::now()));
  const auto copy = Take(Checkpoints::Copy(limited.data / "sessions" / offline.session));
  Check(stopped["state"] == "dirty" && stopped["committed"].is_null() &&
            copy["stoppedCleanly"] == true,
        "exhausted commit budget leaves a cleanly stopped dirty copy");
}
void CopyRecovery(const fs::path& root) {
  const auto directory = LongPath(root / std::string(32, 'e'));
  Write(directory / "unchanged", "stable");
  Write(directory / "journal", "old");
  Write(directory / "gap", "old");
  Write(directory / "removed", "old");
  auto previous = Take(Checkpoints::Scan(directory, Json(), {}));
  Take(WriteDurableJson(directory.wstring() + L".checkpoint-index.json", previous));
  Json copy{{"sessionId", directory.filename().string()},
            {"placementEpoch", uint64_t(3)},
            {"base", std::string(64, 'a')},
            {"state", "dirty"},
            {"stoppedCleanly", false},
            {"changesAt", 0},
            {"lastCommit", nullptr}};
  Take(Checkpoints::WriteCopy(directory, copy));
  Check(Checkpoints::ReuseCopy(copy, 3, nullptr), "dirty copy beats checkpoint pointer");
  Check(!Checkpoints::ReuseCopy(copy, 2, nullptr), "newer epoch fences copy");
  copy["state"] = "clean";
  Check(Checkpoints::ReuseCopy(copy, 4, copy["base"]), "matching clean base reuses directory");
  Check(!Checkpoints::ReuseCopy(copy, 4, std::string(64, 'b')), "different clean base restores");
  DirectoryChanges journal;
  journal.continuous = true;
  journal.paths["journal"] = PhaseClock::now();
  Write(directory / "journal", "journal content");
  Take(Checkpoints::FlushChanges(directory, journal));
  const auto saved = Take(Checkpoints::Copy(directory));
  Write(directory / "gap", "unflushed content");
  fs::remove(directory / "removed");
  Write(directory / std::string(105, 'a') / std::string(105, 'b') / std::string(105, 'c'),
        "long journal path");
  const auto long_file =
      directory / std::string(105, 'a') / std::string(105, 'b') / std::string(105, 'c');
  HANDLE held = CreateFileW(long_file.c_str(), GENERIC_READ, FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(held != INVALID_HANDLE_VALUE, "metadata walk can read long paths");
  const auto recovered =
      Take(Checkpoints::RecoverChanges(directory, saved["changesAt"].get<int64_t>()));
  CloseHandle(held);
  Check(recovered.paths.contains("journal") && recovered.paths.contains("gap") &&
            recovered.removed.contains("removed"),
        "journal union metadata gap and removed files");
  Check(Take(Checkpoints::Scan(directory, previous, recovered)) ==
            Take(Checkpoints::Scan(directory, Json(), {})),
        "recovered change list equals full scan");
  Take(Checkpoints::TruncateChanges(directory));
  Check(Read(directory.wstring() + L".changes").empty(), "commit truncates journal");
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
    DraftCheckpoint(root);
    IncrementalEquality(root);
    BatchesAndPipeline(root);
    PreStageIdentity(root);
    Blockers(root);
    Metrics(root);
    Fencing(root);
    CommitReplay(root);
    CopyRecovery(root);
    GracefulCommit(root);
    DeferredCommit(root);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
