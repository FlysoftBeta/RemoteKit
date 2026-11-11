#include "session_db_fixture.hpp"
#include "files/file_library.hpp"
#include "documents/object_documents.hpp"
#include "files/dc_file_services.hpp"
#include "files/file_selection.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
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
    if (fields["tenantId"] == "other-tenant")
      return remotekit::Error{remotekit::ErrorCode::kForbidden, "no tenant claim"};
    remotekit::Json sources = remotekit::Json::object();
    for (const auto& id : fields["ids"])
      sources[id.get<std::string>()] =
          address.empty() ? remotekit::Json::array()
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
    CHECK(first.OpenDocument(source.id, live).error().code == remotekit::ErrorCode::kUnavailable);
    return;
  }
  const auto fixture = fs::path(__FILE__).parent_path() / "fixtures/document.zip";
  const auto document = Take(objects.Write(
      fixture, {}, {{"tenantId", "tenant"}, {"derivedFrom", source.id}, {"kind", "document"}}));
  auto unopened = first.DocumentResource(document.id, std::string(64, 'a'), 0, live);
  CHECK(!unopened && unopened.error().code == remotekit::ErrorCode::kForbidden);
  const auto info = Take(first.OpenDocument(source.id, live));
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
  CHECK(Take(second.OpenDocument(source.id, live))["documentId"] == document.id);
  LibraryFixture forbidden(root / "forbidden", objects, "other-tenant");
  Take(forbidden.Initialize());
  CHECK(forbidden.OpenDocument(source.id, live).error().code == remotekit::ErrorCode::kForbidden);
  CHECK(Take(objects.Dispatch({{"method", "object.render"},
                               {"params", {{"id", source.id}}}}))["documentId"] == document.id);
  std::ofstream(source_path, std::ios::binary | std::ios::trunc) << "MZother unsupported";
  const auto unsupported = Take(objects.Write(source_path, {}, {{"tenantId", "tenant"}}));
  auto failed = first.OpenDocument(unsupported.id, live);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (failed && failed.value()["state"] == "converting") {
    CHECK(std::chrono::steady_clock::now() < deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    failed = first.OpenDocument(unsupported.id, live);
  }
  CHECK(!failed && failed.error().code == remotekit::ErrorCode::kRejected);
  const auto located = control.located;
  for (int attempt = 0; attempt < 3; ++attempt)
    CHECK(first.OpenDocument(unsupported.id, live).error().reason ==
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
    auto result = reopened.OpenDocument(asset.id, live);
    const auto expires = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (result && result.value()["state"] == "converting") {
      CHECK(std::chrono::steady_clock::now() < expires);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      result = reopened.OpenDocument(asset.id, live);
    }
    CHECK(!result && result.error().code == remotekit::ErrorCode::kRejected &&
          result.error().reason == expected);
    truncated.push_back(0);
  }
}

void Puts(const fs::path& root) {
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
  CHECK(!objects.Dispatch({{"method", "object.put.begin"},
                           {"tenantId", "first"},
                           {"putId", first},
                           {"sizeHint", 268435457}}));
  for (int n = 1; n <= 4; ++n)
    Take(begin("00000000-0000-4000-8000-00000000000" + std::to_string(n), "first"));
  CHECK(!begin("00000000-0000-4000-8000-000000000005", "first"));
  CHECK(!objects.PutChunk({{"putId", first}, {"offset", 1}}, std::vector<uint8_t>{'x'}));
  CHECK(!objects.Dispatch({{"method", "object.put.end"}, {"putId", first}}));
  const auto second = "00000000-0000-4000-8000-000000000002";
  Take(objects.Dispatch({{"method", "object.put.cancel"}, {"putId", second}}));
  CHECK(!fs::exists(root / "object-puts" / second));
  objects.CancelPuts();
  CHECK(fs::is_empty(root / "object-puts"));
  remotekit::objects::SessionObjects forbidden(objects, "other-tenant");
  CHECK(!forbidden.Ensure(id));
  CHECK(objects.Store().Inspect(id));
}

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
  Documents(root / "documents");
  Control control;
  remotekit::objects::ObjectService objects(root / "node", control, remotekit::cluster::Key{},
                                            "source", "dev");
  Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
  remotekit::objects::PeerServer peer(objects.Store(), remotekit::cluster::Key{}, "source", "dev");
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
    const auto cached =
        Take(library.CachedDerivative(hash, FileLibrary::DerivativeFormat::webp, render, live));
    cached_id = cached.id;
    CHECK(cached.type == "image/webp" && cached.width == 320 && cached.height == 240);
    CHECK(Take(library.CachedDerivative(hash, FileLibrary::DerivativeFormat::webp, render, live))
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
    auto competing = selection;
    competing.id = "11111111111111111111111111111111";
    competing.request_id = "other-chooser-token";
    Take(library.Prepare(competing));
    CHECK(Take(library.Claim(selection.id, live)));
    CHECK(!Take(library.Claim(selection.id, live)));
    using State = FileLibrary::Selection::State;
    CHECK(Take(library.CancelPendingSelections(selection.binding, live)) == State::submitted);
    CHECK(library.FindSelection("11111111111111111111111111111111")->state == State::pending);
    CHECK(Take(library.Finish(selection.id, State::cancelled, State::pending)) == State::submitted);
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
                   live))
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
    CHECK(library.FindSelection(selection.id)->state == State::submitted);
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
    remotekit::objects::ObjectService target(root / "target", target_control,
                                             remotekit::cluster::Key{}, "target", "dev");
    Take(target.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                           {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
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
