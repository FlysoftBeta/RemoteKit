#include "peer_fixture.hpp"
#include "session_db_fixture.hpp"
#include "files/file_library.hpp"
#include "documents/object_documents.hpp"
#include "files/dc_file_services.hpp"
#include "files/file_selection.hpp"
#include "protocol/file_requests.h"
#ifdef RK_FILE_PHOTO
#include <webp/encode.h>
#include <webp/decode.h>
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <future>
#include <iostream>
#include <mutex>
#include <sstream>

using remotekit::FileLibrary;
using remotekit::FileUploadStore;
using remotekit::test::LibraryFixture;
namespace fs = std::filesystem;
#define CHECK(value)                             \
  do {                                           \
    if (!(value)) {                              \
      std::cerr << __LINE__ << ": " #value "\n"; \
      std::exit(1);                              \
    }                                            \
  } while (false)
template <class F>
bool Fails(F operation) {
  return !operation();
}

template <class T>
T Take(remotekit::Result<T> result) {
  if (!result) {
    std::cerr << result.error().message << '\n';
    std::exit(1);
  }
  return std::move(result).value();
}
inline void Take(remotekit::Result<void> result) {
  if (!result) {
    std::cerr << result.error().message << '\n';
    std::exit(1);
  }
}

class Control final : public remotekit::ManagementLink {
 public:
  bool reject_commit = false;
  remotekit::ErrorCode reject_code = remotekit::ErrorCode::kUnavailable;
  remotekit::Json last_commit;
  std::string address;
  std::vector<remotekit::Json> committed;
  unsigned located = 0;
  std::map<std::string, remotekit::Error> locate_failures;
  remotekit::Json locate_sources;
  std::vector<size_t> locate_batches;
  std::mutex mutex;
  std::map<std::string, std::string> documents;
  bool Next(std::string&, uint64_t&, bool&) override { return false; }
  bool Current(uint64_t) override { return true; }
  bool SendReply(uint64_t, const remotekit::Json&) override { return true; }
  bool SendEvent(const remotekit::Json&, uint64_t, remotekit::DeliveryFlag delivery = {}) override {
    if (delivery)
      delivery->MarkWritten();
    return true;
  }
  void OnDisconnect(Disconnect) override {}
  remotekit::Result<remotekit::Json> Request(const std::string& name,
                                             remotekit::Json fields) override {
    std::lock_guard lock(mutex);
    if (name == "object.derivation") {
      const auto found = documents.find(fields.at("params").at("id").get<std::string>());
      return found == documents.end() ? remotekit::Json(nullptr)
                                      : remotekit::Json{{"id", found->second}};
    }
    if (name == "object.committed") {
      last_commit = fields;
      if (reject_commit)
        return remotekit::Error{reject_code, "Control rejected commit"};
      committed.push_back(fields);
      if (fields.value("kind", std::string()) == "document")
        documents[fields.at("derivedFrom").get<std::string>()] =
            fields.at("objectId").get<std::string>();
      return remotekit::Json{{"accepted", true}};
    }
    if (name == "object.committed.batch") {
      if (!fields["objects"].empty())
        last_commit = fields["objects"][0];
      if (reject_commit)
        return remotekit::Error{reject_code, "Control rejected commit"};
      for (auto item : fields["objects"]) {
        item["tenantId"] = fields.value("tenantId", std::string());
        last_commit = item;
        committed.push_back(std::move(item));
      }
      return remotekit::Json{{"ok", true}};
    }
    CHECK(name == "object.locate");
    ++located;
    locate_batches.push_back(fields["ids"].size());
    if (fields["tenantId"] == "other-tenant")
      return remotekit::Error{remotekit::ErrorCode::kForbidden, "no tenant claim"};
    remotekit::Json sources = remotekit::Json::object();
    for (const auto& id : fields["ids"])
      if (const auto failure = locate_failures.find(id.get<std::string>());
          failure != locate_failures.end())
        return failure->second;
    for (const auto& id : fields["ids"])
      sources[id.get<std::string>()] =
          !locate_sources.is_null() ? locate_sources
          : address.empty()
              ? remotekit::Json::array()
              : remotekit::Json::array({{{"nodeId", "source"}, {"address", address}}});
    return remotekit::Json{{"sources", sources}};
  }
};
#include "download_imports_tests.hpp"

void PersistedRecords(const fs::path& root, remotekit::objects::ObjectService& objects) {
  const auto directory = root / "selections";
  fs::create_directories(directory);
  const std::string valid_id(32, 'a');
  const remotekit::Json complete{
      {"requestId", "chooser"},
      {"binding",
       {{"browserIncarnation", "browser"},
        {"view", "1"},
        {"instance", "2"},
        {"document", "3"},
        {"request", "4"}}},
      {"state", "selected"},
      {"accept", {"text/plain"}},
      {"limits", {{"maxFileBytes", 1024}, {"maxBatchBytes", 2048}, {"maxFiles", 2}}},
      {"files", remotekit::Json::array({{{"assetId", std::string(64, 'b')},
                                         {"name", "private-receipt-content.txt"},
                                         {"type", "text/plain"}}})}};
  LibraryFixture library(root, objects, "tenant");
  Take(library.Database().Library().Save(remotekit::LibraryTable::kSelections, valid_id, complete));
  Take(library.Initialize());
  const auto loaded = library.FindSelection(valid_id);
  CHECK(loaded && loaded->request_id == "chooser");
  CHECK(loaded->state == FileLibrary::Selection::State::selected);
  CHECK(loaded->binding == (FileUploadStore::Binding{"browser", "1", "2", "3", "4"}));
  CHECK(loaded->accept == std::vector<std::string>{"text/plain"});
  CHECK(loaded->limits.file_bytes == 1024 && loaded->limits.batch_bytes == 2048 &&
        loaded->limits.files == 2);
  CHECK(loaded->files == (std::vector<FileLibrary::SelectionFile>{
                             {std::string(64, 'b'), "private-receipt-content.txt", "text/plain"}}));
}

void Documents(const fs::path& root) {
  Control control;
  remotekit::objects::ObjectService objects(root / "node", control, {}, "documents", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  const auto live = []() -> remotekit::Result<void> { return {}; };
  LibraryFixture first(root / "first", objects, "tenant");
  LibraryFixture second(root / "second", objects, "second");
  Take(first.Initialize());
  Take(second.Initialize());
  const auto source_path = root / "source";
  std::ofstream(source_path, std::ios::binary) << "MZunsupported";
  const auto source = Take(objects.Write(source_path, {}, {{"tenantId", "tenant"}}));
  {
    const remotekit::Json metadata{
        {"assetId", source.id}, {"type", "application/octet-stream"}, {"size", source.size}};
    Take(first.Database().Library().Save(remotekit::LibraryTable::kAssets, source.id, metadata));
  }
  LibraryFixture existing(root / "first", objects, "tenant");
  Take(existing.Initialize());
  CHECK(Take(existing.Describe(source.id)).size == source.size);

  if (!objects.Documents().Available()) {
    CHECK(first.OpenDocument(source.id, "application/octet-stream", live).error().code ==
          remotekit::ErrorCode::kUnavailable);
    return;
  }
  const auto fixture = fs::path(__FILE__).parent_path() / "fixtures/document.zip";
  const auto document = Take(objects.Write(
      fixture, {}, {{"tenantId", "tenant"}, {"derivedFrom", source.id}, {"kind", "document"}}));
  auto unopened = first.DocumentResource(document.id, std::string(64, 'a'), 0, live);
  CHECK(!unopened && unopened.error().code == remotekit::ErrorCode::kForbidden);
  const auto info = Take(first.OpenDocument(source.id, "application/octet-stream", live));
  CHECK(info["state"] == "ready" && info["documentId"] == document.id);
  const auto archive = Take(remotekit::documents::RenderArchive::OpenFile(fixture));
  const auto manifest = Take(archive.Info());
  CHECK(info["pages"].size() == manifest.pages.size() && info["shared"] == manifest.shared);
  std::set<std::string> resources(manifest.shared.begin(), manifest.shared.end());
  for (const auto& page : manifest.pages) {
    resources.insert(page.document);
    resources.insert(page.dependencies.begin(), page.dependencies.end());
  }
  for (const auto& content : resources) {
    const auto expected = Take(archive.Resource(content));
    std::vector<uint8_t> actual;
    uint64_t offset = 0;
    do {
      const auto part = Take(first.DocumentResource(document.id, content, offset, live));
      const auto bytes = part["data"] == "" ? std::vector<uint8_t>{}
                                            : Take(remotekit::DecodeFileChunk(part["data"]));
      actual.insert(actual.end(), bytes.begin(), bytes.end());
      CHECK(part["offset"] == offset + bytes.size() && part["total"] == expected.second.size());
      CHECK(part["mime"] == expected.first);
      offset = part["offset"];
    } while (offset < expected.second.size());
    CHECK(actual == expected.second && remotekit::documents::Sha256Hex(actual) == content);
  }
  CHECK(!first.DocumentResource(document.id, *resources.begin(), UINT64_MAX, live));
  CHECK(!first.DocumentResource(document.id, std::string(64, 'a'), 0, live));
  CHECK(Take(second.OpenDocument(source.id, "application/octet-stream", live))["documentId"] ==
        document.id);
  LibraryFixture forbidden(root / "forbidden", objects, "other-tenant");
  Take(forbidden.Initialize());
  CHECK(forbidden.OpenDocument(source.id, "application/octet-stream", live).error().code ==
        remotekit::ErrorCode::kForbidden);
  CHECK(Take(objects.Dispatch({{"method", "object.render"},
                               {"params", {{"id", source.id}}}}))["documentId"] == document.id);
  std::ofstream(source_path, std::ios::binary | std::ios::trunc) << "MZother unsupported";
  const auto unsupported = Take(objects.Write(source_path, {}, {{"tenantId", "tenant"}}));
  auto failed = first.OpenDocument(unsupported.id, "application/octet-stream", live);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (failed && failed.value()["state"] == "converting") {
    CHECK(std::chrono::steady_clock::now() < deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    failed = first.OpenDocument(unsupported.id, "application/octet-stream", live);
  }
  CHECK(!failed && failed.error().code == remotekit::ErrorCode::kRejected);
  const auto located = control.located;
  for (int attempt = 0; attempt < 3; ++attempt)
    CHECK(first.OpenDocument(unsupported.id, "application/octet-stream", live).error().reason ==
          remotekit::ErrorReason::kDocumentUnsupported);
  CHECK(control.located == located && fs::is_empty(root / "first/documents"));
  const auto docx_path = fs::path(__FILE__).parent_path() / "fixtures/document.docx";
  std::ifstream docx_stream(docx_path, std::ios::binary);
  std::vector<uint8_t> truncated(100);
  docx_stream.read(reinterpret_cast<char*>(truncated.data()), truncated.size());
  CHECK(docx_stream.good());
  unsigned sequence = 0;
  for (const auto& [mime, expected] : std::vector<std::pair<std::string, remotekit::ErrorReason>>{
           {"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            remotekit::ErrorReason::kDocumentCorrupt},
           {"application/octet-stream", remotekit::ErrorReason::kDocumentUnsupported}}) {
    auto draft = Take(first.Begin(1, "document-" + std::to_string(++sequence),
                                  {"truncated.docx", mime, truncated.size()}, live));
    const auto upload = draft["uploadId"].get<std::string>();
    Take(first.Chunk(1, upload, 0, truncated, live));
    const auto asset = Take(first.Seal(1, upload, live));
    {
      const auto metadata =
          Take(first.Database().Library().Load(remotekit::LibraryTable::kAssets)).at(asset.id);
      CHECK(!metadata.contains("name") && metadata["type"] == mime);
    }
    LibraryFixture reopened(root / "first", objects, "tenant");
    Take(reopened.Initialize());
    auto result = reopened.OpenDocument(asset.id, mime, live);
    const auto expires = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (result && result.value()["state"] == "converting") {
      CHECK(std::chrono::steady_clock::now() < expires);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      result = reopened.OpenDocument(asset.id, mime, live);
    }
    CHECK(!result && result.error().code == remotekit::ErrorCode::kRejected &&
          result.error().reason == expected);
    truncated.push_back(0);
  }
}

void AssetLimitOpen(const fs::path& root) {
  Control control;
  remotekit::objects::ObjectService objects(root / "node", control, {}, "limit", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  LibraryFixture first(root / "session", objects, "tenant");
  Take(first.Initialize());
  const auto count = remotekit::kLibraryAssetLimit + 1;
  {
    remotekit::sqlite::Database raw;
    Take(raw.Open(root / "session" / "session.db"));
    const auto sql =
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<" +
        std::to_string(count) +
        ") INSERT INTO library_assets SELECT printf('%064x',i),7,NULL,NULL,NULL FROM n";
    Take(raw.Execute(sql.c_str()));
    Take(raw.Close());
  }
  LibraryFixture over(root / "session", objects, "tenant");
  Take(over.Initialize());
  CHECK(Take(over.Describe(std::string(63, '0') + "1")).size == 7);
  const remotekit::Json extra{{"assetId", std::string(64, 'f')}, {"size", 1}};
  const auto rejected =
      over.Database().Library().Save(remotekit::LibraryTable::kAssets, std::string(64, 'f'), extra);
  CHECK(!rejected && rejected.error().code == remotekit::ErrorCode::kLimitExceeded);
}
void Puts(const fs::path& root) {
  using namespace remotekit;
  Control control;
  remotekit::objects::ObjectService objects(root, control, remotekit::cluster::Key{}, "put", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  const std::string first = "00000000-0000-4000-8000-000000000001";
  const auto begin = [&](const std::string& id, const std::string& tenant) {
    return objects.Dispatch({{"method", "object.put.begin"}, {"putId", id}, {"tenantId", tenant}});
  };
  Take(begin(first, "first"));
  CHECK(!begin(first, "first"));
  Take(objects.PutChunk({{"putId", first}, {"offset", 0}}, std::vector<uint8_t>{'a', 'b', 'c'}));
  const auto stored = Take(objects.Dispatch({{"method", "object.put.end"}, {"putId", first}}));
  const auto id = stored["objectId"].get<std::string>();
  CHECK(control.last_commit["tenantId"] == "first" && control.last_commit["putId"] == first);
  CHECK(stored["size"] == 3 && !fs::exists(root / "object-puts" / first));
  Take(begin(first, "second"));
  Take(objects.PutChunk({{"putId", first}, {"offset", 0}}, std::vector<uint8_t>{'a', 'b', 'c'}));
  CHECK(Take(objects.Dispatch({{"method", "object.put.end"}, {"putId", first}}))["objectId"] == id);
  CHECK(control.last_commit["tenantId"] == "second");
  CHECK(Take(objects.Store().Inventory(nullptr))["objects"].size() == 1);
  Take(objects.Dispatch({{"method", "object.put.begin"},
                         {"tenantId", "first"},
                         {"putId", first},
                         {"sizeHint", limits::objectPutBytes}}));
  Take(objects.Dispatch({{"method", "object.put.cancel"}, {"putId", first}}));
  CHECK(!objects.Dispatch({{"method", "object.put.begin"},
                           {"tenantId", "first"},
                           {"putId", first},
                           {"sizeHint", limits::objectPutBytes + 1}}));
  for (size_t n = 1; n <= limits::objectPutsPerNode; ++n)
    Take(begin("00000000-0000-4000-8000-00000000000" + std::to_string(n), "first"));
  CHECK(!begin("00000000-0000-4000-8000-000000000005", "first"));
  CHECK(!objects.PutChunk({{"putId", first}, {"offset", 1}}, std::vector<uint8_t>{'x'}));
  CHECK(!objects.Dispatch({{"method", "object.put.end"}, {"putId", first}}));
  const auto second = "00000000-0000-4000-8000-000000000002";
  Take(objects.Dispatch({{"method", "object.put.cancel"}, {"putId", second}}));
  CHECK(!fs::exists(root / "object-puts" / second));
  objects.CancelPuts();
  CHECK(fs::is_empty(root / "object-puts"));
  Take(begin(first, "first"));
  std::vector<uint8_t> chunk(limits::objectChunkBytes, 'x');
  for (size_t offset = 0; offset < limits::objectPutBytes; offset += chunk.size())
    Take(objects.PutChunk({{"putId", first}, {"offset", offset}}, chunk));
  CHECK(!objects.PutChunk({{"putId", first}, {"offset", limits::objectPutBytes}},
                          std::vector<uint8_t>{'x'}));
  objects.CancelPuts();
  Take(begin(first, "first"));
  chunk.push_back('x');
  CHECK(!objects.PutChunk({{"putId", first}, {"offset", 0}}, chunk));
  objects.CancelPuts();
  std::vector<std::string> ids;
  for (size_t i = 0; i < limits::objectLocateIds; ++i) {
    const auto suffix = std::to_string(i);
    ids.push_back(std::string(64 - suffix.size(), '0') + suffix);
  }
  Take(objects.LocateBatch(ids, {}));
  CHECK(control.locate_batches.back() == limits::objectLocateIds);
  auto overflow_ids = ids;
  overflow_ids.push_back(std::string(64, 'e'));
  const auto before = control.locate_batches.size();
  Take(objects.LocateBatch(overflow_ids, {}));
  CHECK(control.locate_batches.size() == before + 2 &&
        control.locate_batches[before] == limits::objectLocateIds &&
        control.locate_batches.back() == 1);
  const Json source{{"nodeId", std::string(limits::objectSourceNodeIdBytes, 'n')},
                    {"address", std::string(limits::objectSourceAddressBytes, 'a')}};
  control.locate_sources = Json::array();
  for (size_t i = 0; i < limits::objectLocateSources; ++i)
    control.locate_sources.push_back(source);
  Take(objects.LocateBatch({ids.front()}, {}));
  control.locate_sources.push_back(source);
  CHECK(!objects.LocateBatch({ids.front()}, {}));
  control.locate_sources = Json::array({source});
  control.locate_sources[0]["nodeId"] = std::string(limits::objectSourceNodeIdBytes + 1, 'n');
  CHECK(!objects.LocateBatch({ids.front()}, {}));
  control.locate_sources = Json::array({source});
  control.locate_sources[0]["address"] = std::string(limits::objectSourceAddressBytes + 1, 'a');
  CHECK(!objects.LocateBatch({ids.front()}, {}));
  remotekit::objects::SessionObjects forbidden(objects, "other-tenant");
  CHECK(!forbidden.Ensure(id));
  CHECK(objects.Store().Inspect(id));
}

void DocumentOpenContract() {
  const remotekit::Json params{
      {"requestId", "library"}, {"assetId", std::string(64, 'a')}, {"type", "application/pdf"}};
  CHECK(remotekit::protocol::ValidDocumentOpenParams(params));
  auto missing = params;
  missing.erase("type");
  auto unknown = params;
  unknown["unknown"] = true;
  auto wrong = params;
  wrong["type"] = 7;
  for (const auto& invalid : {missing, unknown, wrong})
    CHECK(!remotekit::protocol::ValidDocumentOpenParams(invalid));
}

#ifdef RK_FILE_PHOTO
void HashOnlySelection(const fs::path& root) {
  Control control;
  remotekit::objects::ObjectService objects(root / "node", control, {}, "selection", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  fs::create_directories(root);
  const std::vector<uint8_t> pixels(32 * 32 * 4, 255);
  uint8_t* encoded = nullptr;
  const auto size = WebPEncodeLosslessRGBA(pixels.data(), 32, 32, 32 * 4, &encoded);
  CHECK(size > 0);
  const auto path = root / "source.webp";
  {
    std::ofstream stream(path, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(encoded), size);
  }
  WebPFree(encoded);
  const auto object = Take(objects.Write(path, {}, {{"tenantId", "tenant"}}));
  const auto live = []() -> remotekit::Result<void> { return {}; };
  LibraryFixture library(root / "session", objects, "tenant");
  Take(library.Initialize());
  FileLibrary::Selection selection{std::string(32, 'a'),
                                   "chooser",
                                   {"browser", "1", "1", "1", "1"},
                                   {{object.id, "selected.webp", "image/webp"}}};
  selection.accept = {"image/png"};
  Take(library.Prepare(selection));
  CHECK(!Take(library.Describe(object.id)).type.has_value());
  CHECK(!Take(library.Database().Library().Load(remotekit::LibraryTable::kAssets))
             .at(object.id)
             .contains("type"));
  const auto sources = Take(library.SelectionSources(selection, live));
  CHECK(sources.size() == 1 && sources[0].spec.type == "image/png" &&
        sources[0].spec.name == "selected.png");
  std::ifstream stream(sources[0].path, std::ios::binary);
  std::array<uint8_t, 8> signature{};
  stream.read(reinterpret_cast<char*>(signature.data()), signature.size());
  CHECK((signature == std::array<uint8_t, 8>{137, 80, 78, 71, 13, 10, 26, 10}));
  stream.close();
  LibraryFixture reopened(root / "session", objects, "tenant");
  Take(reopened.Initialize());
  CHECK(!Take(reopened.Describe(object.id)).Json().contains("type"));
}
#endif

void CacheHealing(const fs::path& root) {
  Control control;
  remotekit::objects::ObjectService objects(root / "node", control, {}, "cache", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  fs::create_directories(root);
  const auto source_path = root / "source";
  std::ofstream(source_path, std::ios::binary) << "original-source";
  const auto source = Take(objects.Write(source_path, {}, {{"tenantId", "tenant"}}));
  LibraryFixture library(root / "session", objects, "tenant");
  Take(library.Initialize());
  const auto live = []() -> remotekit::Result<void> { return {}; };
  unsigned renders = 0;
  const auto render = [&](const fs::path& path) -> remotekit::Result<FileLibrary::Derivative> {
    ++renders;
    std::ofstream(path, std::ios::binary) << "cached-derivative";
    return FileLibrary::Derivative{320, 240};
  };
  const auto cached =
      Take(library.CachedDerivative(source.id, FileLibrary::DerivativeFormat::jpeg, render, live));
  Take(objects.Store().Delete(cached.id));
  control.locate_failures.emplace(
      cached.id, remotekit::Error{remotekit::ErrorCode::kNotFound, "missing derivative"});
  CHECK(Take(library.CachedDerivative(source.id, FileLibrary::DerivativeFormat::jpeg, render, live))
            .id == cached.id);
  CHECK(renders == 2);
  Take(objects.Store().Delete(cached.id));
  control.locate_failures.at(cached.id) =
      remotekit::Error{remotekit::ErrorCode::kForbidden, "revoked derivative"};
  CHECK(library.CachedDerivative(source.id, FileLibrary::DerivativeFormat::jpeg, render, live)
            .error()
            .code == remotekit::ErrorCode::kForbidden);
  CHECK(renders == 2);
  control.locate_failures.at(cached.id) =
      remotekit::Error{remotekit::ErrorCode::kNotFound, "missing derivative"};
  const auto failed_render = [&](const fs::path&) -> remotekit::Result<FileLibrary::Derivative> {
    return remotekit::Error{remotekit::ErrorCode::kCanceled, "cancelled render"};
  };
  CHECK(!library.CachedDerivative(source.id, FileLibrary::DerivativeFormat::jpeg, failed_render,
                                  live));
  CHECK(Take(library.CachedDerivative(source.id, FileLibrary::DerivativeFormat::jpeg, render, live))
            .id == cached.id);
  CHECK(renders == 3);
  {
    const auto stored = Take(objects.Store().StoredPath(cached.id));
    std::ofstream(stored, std::ios::binary | std::ios::trunc) << "corrupt";
  }
  const auto corrupt =
      library.CachedDerivative(source.id, FileLibrary::DerivativeFormat::jpeg, render, live);
  CHECK(!corrupt && corrupt.error().reason == remotekit::ErrorReason::kCorruptRecord);
  CHECK(renders == 3);
}
#ifdef RK_FILE_PHOTO
void PhotoDerivatives(const fs::path& root) {
  Control control;
  remotekit::objects::ObjectService objects(root / "node", control, {}, "photos", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  fs::create_directories(root);
  const auto write_webp = [&](const char* name, int width, int height) {
    std::vector<uint8_t> pixels(size_t(width) * height * 4, 255);
    for (int y = 0; y < height; ++y)
      for (int x = 0; x < width; ++x)
        pixels[(size_t(y) * width + x) * 4] = static_cast<uint8_t>(x * 255 / width);
    uint8_t* encoded = nullptr;
    const auto size = WebPEncodeLosslessRGBA(pixels.data(), width, height, width * 4, &encoded);
    CHECK(size);
    const auto path = root / name;
    std::ofstream stream(path, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(encoded), size);
    stream.close();
    WebPFree(encoded);
    return Take(objects.Write(path, {}, {{"tenantId", "tenant"}}));
  };
  const auto large = write_webp("large.webp", 3200, 1600);
  const auto small = write_webp("small.webp", 128, 64);
  const auto live = []() -> remotekit::Result<void> { return {}; };
  remotekit::Json processed, preview;
  {
    LibraryFixture library(root / "session", objects, "tenant");
    Take(library.Initialize());
    CHECK(library.Preview(large.id, 1279, live).error().code == remotekit::ErrorCode::kRejected);
    preview = Take(library.Preview(large.id, 1280, live));
    CHECK(preview.size() == 4 && preview["type"] == "image/webp" && preview["width"] == 1280 &&
          preview["height"] == 640);
    CHECK(control.committed.back()["kind"] == "preview" &&
          control.committed.back()["derivedFrom"] == large.id);
    const auto count = control.committed.size();
    CHECK(Take(library.Preview(large.id, 1280, live)) == preview);
    CHECK(control.committed.size() == count);
    const auto higher = Take(library.Preview(large.id, 2560, live));
    CHECK(higher["width"] == 2560 && higher["height"] == 1280 &&
          higher["assetId"] != preview["assetId"]);
    const auto bytes = Take(library.Read(preview["assetId"], 0)).second;
    WebPBitstreamFeatures features{};
    CHECK(WebPGetFeatures(bytes.data(), bytes.size(), &features) == VP8_STATUS_OK);
    CHECK(features.width == 1280 && features.height == 640 && features.format == 1);
    CHECK(Take(library.Preview(small.id, 1280, live))["assetId"] == small.id);
    const auto jpeg = root / "small.jpg";
    Take(remotekit::TranscodePhoto(root / "small.webp", jpeg, remotekit::PhotoTranscode::kJpeg));
    const auto jpeg_object = Take(objects.Write(jpeg, {}, {{"tenantId", "tenant"}}));
    const auto original = Take(library.Preview(jpeg_object.id, 1280, live));
    CHECK(original["assetId"] == jpeg_object.id && original["width"] == 128 &&
          original["height"] == 64 && original["type"] == "image/jpeg");
    for (const auto format : {remotekit::PhotoTranscode::kJpeg, remotekit::PhotoTranscode::kPng}) {
      const auto path =
          root / (format == remotekit::PhotoTranscode::kJpeg ? "large.jpg" : "large.png");
      Take(remotekit::TranscodePhoto(root / "large.webp", path, format));
      const auto object = Take(objects.Write(path, {}, {{"tenantId", "tenant"}}));
      const auto resized = Take(library.Preview(object.id, 1280, live));
      CHECK(resized["width"] == 1280 && resized["height"] == 640 &&
            resized["type"] == "image/webp");
    }
    const auto before_process = control.committed.size();
    std::array<std::future<remotekit::Json>, 4> requests;
    for (auto& request : requests)
      request = std::async(std::launch::async,
                           [&] { return Take(library.Process(small.id, "photo", 0, live)); });
    processed = requests.front().get();
    for (size_t i = 1; i < requests.size(); ++i)
      CHECK(requests[i].get() == processed);
    CHECK(control.committed.size() == before_process + 1);
    CHECK(control.committed.back()["kind"] == "photo");
    const auto rotated = Take(library.Process(small.id, "photo", 1, live));
    CHECK(rotated["width"] == 64 && rotated["height"] == 128 && rotated["quarterTurns"] == 1);
    const auto before_scan = control.committed.size();
    Take(library.Process(small.id, "scan", 0, live));
    CHECK(control.committed.size() == before_scan + 1);
    const auto cancelled = []() -> remotekit::Result<void> {
      return remotekit::Error{remotekit::ErrorCode::kCanceled, "retired grant"};
    };
    CHECK(!library.Process(small.id, "photo", 0, cancelled));
    CHECK(!library.Preview(large.id, 1280, cancelled));
  }
  {
    LibraryFixture library(root / "session", objects, "tenant");
    Take(library.Initialize());
    const auto count = control.committed.size();
    CHECK(Take(library.Process(small.id, "photo", 0, live)) == processed);
    CHECK(Take(library.Preview(large.id, 1280, live)) == preview);
    CHECK(control.committed.size() == count);
    std::array<std::future<std::pair<FileLibrary::Asset, std::vector<uint8_t>>>, 4> reads;
    for (size_t i = 0; i < reads.size(); ++i)
      reads[i] = std::async(std::launch::async, [&, i] { return Take(library.Read(large.id, i)); });
    std::ifstream source_bytes(root / "large.webp", std::ios::binary);
    const std::vector<uint8_t> all{std::istreambuf_iterator<char>(source_bytes), {}};
    for (size_t i = 0; i < reads.size(); ++i) {
      const auto range = reads[i].get();
      CHECK(std::equal(range.second.begin(), range.second.end(), all.begin() + i));
    }
  }
}
#endif

int main(int argc, char** argv) {
  using remotekit::PhotoTranscode;
  using remotekit::SelectionWebpTranscode;
  CHECK(SelectionWebpTranscode({"image/png"}) == PhotoTranscode::kPng);
  CHECK(SelectionWebpTranscode({" .JpG "}) == PhotoTranscode::kJpeg);
  CHECK(SelectionWebpTranscode({"image/png", "image/jpeg"}) == PhotoTranscode::kJpeg);
  CHECK(SelectionWebpTranscode({"IMAGE/PJPEG"}) == PhotoTranscode::kJpeg);
  CHECK(SelectionWebpTranscode({".jfif"}) == PhotoTranscode::kJpeg);
  CHECK(!SelectionWebpTranscode({"image/*", "image/png"}));
  CHECK(!SelectionWebpTranscode({" .WEBP ", ".jpg"}));
  CHECK(!SelectionWebpTranscode({"image/webp", ".png"}));
  CHECK(!SelectionWebpTranscode({}));
  CHECK(!SelectionWebpTranscode({"application/pdf"}));
  FileUploadStore::Limits request_limits;
  request_limits.file_bytes = 10;
  request_limits.batch_bytes = 15;
  CHECK(remotekit::CheckSelectionSources({{{"photo.jpg", "image/jpeg", 8}, {}}}, request_limits));
  CHECK(!remotekit::CheckSelectionSources({{{"photo.png", "image/png", 11}, {}}}, request_limits));
  CHECK(!remotekit::CheckSelectionSources(
      {{{"a.jpg", "image/jpeg", 8}, {}}, {{"b.jpg", "image/jpeg", 8}, {}}}, request_limits));
  CHECK(argc == 2);
  const auto root = fs::path(argv[1]) /
                    ("remotekit-file-library-" +
                     std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  const auto live = []() -> remotekit::Result<void> { return {}; };
  const auto retired = []() -> remotekit::Result<void> {
    return remotekit::Error{remotekit::ErrorCode::kForbidden, "file_transfer_interrupted"};
  };
  const auto session = root / "session";
  DocumentOpenContract();
#ifdef RK_FILE_PHOTO
  HashOnlySelection(root / "hash-only");
  PhotoDerivatives(root / "photo-derivatives");
#endif
  CacheHealing(root / "cache-healing");
  Documents(root / "documents");
  Control control;
  const auto source_key = TestPrivateKey(7), target_key = TestPrivateKey(8);
  remotekit::objects::ObjectService objects(root / "node", control, source_key, "source", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  remotekit::objects::PeerSet members;
  Take(members.Update(remotekit::Json::array({TestPeer("target", "127.0.0.1:1", target_key)})));
  remotekit::objects::PeerServer peer(objects.Store(), source_key, "source", "dev", members);
  PersistedRecords(root / "persisted-records", objects);
  Take(peer.Start("127.0.0.1:0"));
  const std::string hash = "fd7adb152c05ef80dccf50a1fa4c05d5a3ec6da95575fc312ae7c5d091836351";
  const FileUploadStore::Spec spec{"photo.jpeg", "image/jpeg", 3};
  const std::vector<std::uint8_t> png_signature{137, 80, 78, 71, 13, 10, 26, 10};
  std::string upload;
  std::string derivative_id;
  std::string cached_id;
  std::map<FileLibrary::DerivativeFormat, std::string> transcode_cache;
  FileLibrary::Selection selection{"aabbccddaabbccddaabbccddaabbccdd",
                                   "chooser",
                                   {"browser", "1", "2", "3", "4"},
                                   {{hash, "photo.jpeg", "image/jpeg"}}};
  auto unsubmitted = selection;
  unsubmitted.id = "aabbccddaabbccddaabbccddaabbccee";
  unsubmitted.binding.request = "5";
  {
    LibraryFixture library(session, objects, "tenant");
    CHECK(library.Initialize());
    const auto draft = Take(library.Begin(1, "operation", spec, live));
    upload = draft["uploadId"];
    CHECK(draft["offset"] == 0);
    CHECK(Fails([&] { return library.Begin(1, "operation", {"different", "", 3}, live); }));
    CHECK(Fails([&] { return library.Chunk(1, upload, 1, {'a'}, live); }));
    CHECK(Take(library.Chunk(1, upload, 0, {'a'}, live)) == 1);
    CHECK(Fails([&] { return library.Seal(1, upload, live); }));
    CHECK(Fails([&] { return library.Chunk(1, upload, 1, {'b'}, retired); }));
    CHECK(Fails([&] { return library.Chunk(2, upload, 1, {'b'}, live); }));
  }
  {
    LibraryFixture library(session, objects, "tenant");
    CHECK(library.Initialize());
    CHECK(Fails([&] { return library.Chunk(1, upload, 1, {'b'}, live); }));
    CHECK(Take(library.Begin(1, "operation", spec, live))["offset"] == 1);
    CHECK(Take(library.Chunk(1, upload, 0, {'a', 'b', 'c'}, live)) == 3);
    CHECK(Take(library.Chunk(1, upload, 0, {'a', 'b', 'c'}, live)) == 3);
    CHECK(Fails([&] { return library.Chunk(1, upload, 0, {'x'}, live); }));
    CHECK(Fails([&] { return library.Seal(1, upload, retired); }));
    control.reject_commit = true;
    CHECK(Fails([&] { return library.Seal(1, upload, live); }));
    control.reject_commit = false;
    CHECK(Take(library.Seal(1, upload, live)).id == hash);
    CHECK(control.committed.back()["objectId"] == hash &&
          control.committed.back()["tenantId"] == "tenant" &&
          control.committed.back()["size"] == 3 &&
          control.committed.back()["storedSha256"] ==
              Take(objects.Store().Inspect(hash)).stored_sha256);
    CHECK(Take(library.Seal(1, upload, live)).id == hash);
    CHECK(Take(library.Read(hash, 1)).second == std::vector<std::uint8_t>({'b', 'c'}));
    CHECK(Take(library.Read(hash, 3)).second.empty());
    const auto derivative = Take(library.CreateDerivative(
        [&](const fs::path& path) -> remotekit::Result<FileLibrary::Derivative> {
          CHECK(path.extension() == ".png");
          std::ofstream output(path, std::ios::binary);
          output.write(reinterpret_cast<const char*>(png_signature.data()), png_signature.size());
          return FileLibrary::Derivative{800, 600};
        },
        live, FileLibrary::DerivativeFormat::png, hash));
    CHECK(derivative.type == "image/png" && derivative.width == 800 && derivative.height == 600);
    derivative_id = derivative.id;
    CHECK(control.committed.back()["derivedFrom"] == hash);
    CHECK(!derivative.Json().contains("hash"));
    CHECK(Take(library.Read(derivative_id, 0)).second == png_signature);
    unsigned renders = 0;
    const auto render = [&](const fs::path& path) -> remotekit::Result<FileLibrary::Derivative> {
      ++renders;
      CHECK(path.extension() == ".webp");
      std::ofstream(path, std::ios::binary) << "webp-derivative-cache";
      return FileLibrary::Derivative{320, 240};
    };
    const auto cached = Take(library.CachedDerivative(hash, FileLibrary::DerivativeFormat::webp,
                                                      render, live, "preview", "1280-q80-v1"));
    cached_id = cached.id;
    CHECK(cached.type == "image/webp" && cached.width == 320 && cached.height == 240);
    CHECK(Take(library.CachedDerivative(hash, FileLibrary::DerivativeFormat::webp, render, live,
                                        "preview", "1280-q80-v1"))
              .id == cached.id);
    CHECK(renders == 1);
    for (const auto format :
         {FileLibrary::DerivativeFormat::jpeg, FileLibrary::DerivativeFormat::png}) {
      unsigned transcodes = 0;
      const auto render_transcode =
          [&](const fs::path& path) -> remotekit::Result<FileLibrary::Derivative> {
        ++transcodes;
        CHECK(path.extension() ==
              (format == FileLibrary::DerivativeFormat::jpeg ? ".jpg" : ".png"));
        std::ofstream(path, std::ios::binary) << "selection-transcode-" << static_cast<int>(format);
        return FileLibrary::Derivative{320, 240};
      };
      const auto first = Take(library.CachedDerivative(hash, format, render_transcode, live));
      CHECK(first.type ==
            (format == FileLibrary::DerivativeFormat::jpeg ? "image/jpeg" : "image/png"));
      CHECK(Take(library.CachedDerivative(hash, format, render_transcode, live)).id == first.id);
      CHECK(transcodes == 1);
      transcode_cache[format] = first.id;
    }
    CHECK(Fails([&] { return library.Read(hash, 4); }));
    LibraryFixture other(root / "other-session", objects, "other-tenant");
    CHECK(other.Initialize());
    CHECK(Fails([&] { return other.Describe(hash); }));
    const auto duplicate =
        Take(library.Begin(1, "different-operation", spec, live))["uploadId"].get<std::string>();
    Take(library.Chunk(1, duplicate, 0, {'a', 'b', 'c'}, live));
    CHECK(Take(library.Seal(1, duplicate, live)).id == hash);
    const auto conflicted =
        Take(library.Begin(1, "conflicting-object", spec, live))["uploadId"].get<std::string>();
    Take(library.Chunk(1, conflicted, 0, {'x', 'y', 'z'}, live));
    control.reject_commit = true;
    control.reject_code = remotekit::ErrorCode::kConflict;
    CHECK(!library.Seal(1, conflicted, live));
    CHECK(objects.Store().Inspect(control.last_commit["objectId"].get<std::string>()));
    control.reject_commit = false;
    control.reject_code = remotekit::ErrorCode::kUnavailable;
    CHECK(library.Seal(1, conflicted, live));
    Take(library.Prepare(selection));
    Take(library.Prepare(selection));
    auto conflict = selection;
    conflict.files[0].name = "different";
    CHECK(Fails([&] { return library.Prepare(conflict); }));
    CHECK(Fails([&] { return library.Claim(selection.id, retired); }));
    {
      FileUploadStore staged(root / "claim-staging");
      Take(staged.Initialize());
      const auto sources = Take(library.SelectionSources(selection, live));
      for (unsigned failure_step = 1; failure_step <= 3; ++failure_step) {
        unsigned step = 0;
        const auto check = [&]() -> remotekit::Result<void> {
          if (++step == failure_step)
            return remotekit::Error{remotekit::ErrorCode::kConflict,
                                    "injected staging admission failure"};
          return {};
        };
        CHECK(!staged.Stage(selection.binding, sources, check));
        CHECK(staged.reserved_bytes() == 0 && staged.reserved_files() == 0);
      }
      const auto batch = Take(staged.Stage(selection.binding, sources, live));
      CHECK(!library.Claim(selection.id, retired));
      Take(staged.AbortSubmission(batch.id));
      CHECK(staged.reserved_bytes() == 0 && staged.reserved_files() == 0);
    }
    auto competing = selection;
    competing.id = "11111111111111111111111111111111";
    competing.request_id = "other-chooser-token";
    Take(library.Prepare(competing));
    CHECK(Take(library.Claim(selection.id, live)));
    Take(library.ReleaseClaim(selection.id));
    CHECK(library.FindSelection(selection.id)->state == FileLibrary::Selection::State::pending);
    CHECK(Take(library.Database().Library().Load(remotekit::LibraryTable::kSelections))
              .at(selection.id)
              .at("state") == "pending");
    CHECK(Take(library.Claim(selection.id, live)));
    Take(library.Unknown(selection.id));
    CHECK(!library.ReleaseClaim(selection.id));
    CHECK(!Take(library.Claim(selection.id, live)));
    using State = FileLibrary::Selection::State;
    CHECK(Take(library.CancelPendingSelections(selection.binding, live)) == State::unknown);
    CHECK(library.FindSelection("11111111111111111111111111111111")->state == State::pending);
    CHECK(Take(library.Finish(selection.id, State::cancelled, State::pending)) == State::unknown);
    Take(library.Prepare(unsubmitted));
    auto wrong_binding = unsubmitted.binding;
    wrong_binding.document = "other";
    CHECK(!Take(library.CancelPendingSelections(wrong_binding, live)));
    CHECK(Fails([&] { return library.CancelPendingSelections(unsubmitted.binding, retired); }));
    CHECK(library.FindSelection(unsubmitted.id)->state == State::pending);
    CHECK(Take(library.CancelPendingSelections(unsubmitted.binding, live)) == State::cancelled);
    CHECK(Take(library.CancelPendingSelections(unsubmitted.binding, live)) == State::cancelled);
    CHECK(!Take(library.Claim(unsubmitted.id, live)));
  }
  {
    LibraryFixture library(session, objects, "tenant");
    CHECK(library.Initialize());
    using State = FileLibrary::Selection::State;
    CHECK(Take(library.Describe(hash)).size == 3);
    CHECK(Take(library.Describe(derivative_id)).type == "image/png");
    CHECK(Take(library.CachedDerivative(
                   hash, FileLibrary::DerivativeFormat::webp,
                   [&](const fs::path&) -> remotekit::Result<FileLibrary::Derivative> {
                     CHECK(false);
                     return FileLibrary::Derivative{};
                   },
                   live, "preview", "1280-q80-v1"))
              .id == cached_id);
    for (const auto& [format, id] : transcode_cache) {
      CHECK(Take(library.CachedDerivative(
                     hash, format,
                     [&](const fs::path&) -> remotekit::Result<FileLibrary::Derivative> {
                       CHECK(false);
                       return FileLibrary::Derivative{};
                     },
                     live))
                .id == id);
    }
    CHECK(Take(library.Begin(1, "operation", spec, live))["offset"] == 3);
    CHECK(Take(library.Seal(1, upload, live)).id == hash);
    CHECK(library.FindSelection(selection.id)->state == State::unknown);
    CHECK(library.FindSelection(unsubmitted.id)->state == State::cancelled);
    CHECK(!Take(library.Claim(selection.id, live)));
    Take(library.Finish(selection.id, State::selected));
    Take(library.Finish(selection.id, State::cancelled));
    CHECK(library.FindSelection(selection.id)->state == State::selected);
    FileUploadStore staging(root / "staging");
    CHECK(staging.Initialize());
    const auto source = Take(library.Path(hash));
    const auto batch = Take(staging.Stage(selection.binding, {{spec, source}}, live));
    const auto staged = batch.files.front().path;
    CHECK(Fails([&] { return staging.Stage(selection.binding, {{spec, source}}, live); }));
    Take(staging.MarkSubmitted(batch.id));
    CHECK(fs::exists(staged));
    fs::remove(source);
    std::ifstream input(staged, std::ios::binary);
    CHECK(std::string(std::istreambuf_iterator<char>(input), {}) == "abc");
    input.close();
    Take(staging.ConfirmBrowserStopped("browser"));
    CHECK(!fs::exists(staged));
  }
  {
    // Receipt recovery must not depend on the original source or live Browser.
    LibraryFixture library(session, objects, "tenant");
    Take(library.Database().Library().Erase(remotekit::LibraryTable::kAssets, hash));
    CHECK(library.Initialize());
    CHECK(library.FindSelection(selection.id)->state == FileLibrary::Selection::State::selected);
  }
  {
    Control target_control;
    target_control.address = peer.Address();
    remotekit::objects::ObjectService target(root / "target", target_control, target_key, "target",
                                             "dev");
    Take(target.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                           {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
    Take(target.SetPeers(remotekit::Json::array({TestPeer("source", peer.Address(), source_key)})));
    LibraryFixture library(root / "remote-session", target, "tenant");
    Take(library.Initialize());
    CHECK(!target.Store().Inspect(hash));
    target_control.reject_commit = true;
    CHECK(!library.Path(hash));
    CHECK(target.Store().Inspect(hash));
    target_control.reject_commit = false;
    const auto path = Take(library.Path(hash));
    std::ifstream input(path, std::ios::binary);
    CHECK(std::string(std::istreambuf_iterator<char>(input), {}) == "abc");
    CHECK(target_control.located == 1 && target_control.last_commit["objectId"] == hash);
    CHECK(target.Store().Inspect(hash));
    CHECK(Take(library.Read(hash, 1)).second == std::vector<uint8_t>({'b', 'c'}));
    input.close();
    Take(target.Dispatch(
        {{"method", "object.fetch"},
         {"tenantId", "tenant"},
         {"ids", {derivative_id}},
         {"sources",
          {{derivative_id,
            remotekit::Json::array({{{"nodeId", "source"}, {"address", peer.Address()}}})}}}}));
    CHECK(target_control.committed.back()["objectId"] == derivative_id);
    const auto inventory = Take(
        target.Dispatch({{"method", "object.inventory"}, {"tenantId", ""}, {"cursor", nullptr}}));
    CHECK(inventory["objects"].size() == 2);
    Take(target.Dispatch(
        {{"method", "object.delete"}, {"tenantId", "tenant"}, {"ids", {derivative_id}}}));
    CHECK(!target.Store().Inspect(derivative_id));
    CHECK(!target.Dispatch({{"method", "object.delete"}, {"ids", {"invalid-id"}}}));
  }
  CHECK(!fs::exists(session / "references.json") && !fs::exists(session / "payload") &&
        !fs::exists(session / "assets"));
  Puts(root / "puts");
  DownloadImportTests(root, objects, control);
  fs::remove_all(root);
  return 0;
}
