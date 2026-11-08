#include "files/file_library.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>

using remotekit::FileLibrary;
using remotekit::FileUploadStore;
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
  bool Next(std::string&, uint64_t&, bool&) override { return false; }
  bool Current(uint64_t) override { return true; }
  bool SendReply(uint64_t, const remotekit::Json&) override { return true; }
  bool SendEvent(const remotekit::Json&, uint64_t) override { return true; }
  void OnDisconnect(Disconnect) override {}
  remotekit::Result<remotekit::Json> Request(const std::string& name,
                                             remotekit::Json fields) override {
    if (name == "object.committed") {
      last_commit = fields;
      if (reject_commit)
        return remotekit::Error{reject_code, "Control rejected commit"};
      committed.push_back(fields);
      return remotekit::Json{{"accepted", true}};
    }
    CHECK(name == "object.locate");
    ++located;
    remotekit::Json sources = remotekit::Json::object();
    for (const auto& id : fields["ids"])
      sources[id.get<std::string>()] =
          address.empty() ? remotekit::Json::array()
                          : remotekit::Json::array({{{"nodeId", "source"}, {"address", address}}});
    return remotekit::Json{{"sources", sources}};
  }
};
#include "download_imports_tests.hpp"

int main(int argc, char** argv) {
  CHECK(argc == 2);
  const auto root = fs::path(argv[1]) /
                    ("remotekit-file-library-" +
                     std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  const auto live = []() -> remotekit::Result<void> { return {}; };
  const auto retired = []() -> remotekit::Result<void> {
    return remotekit::Error{remotekit::ErrorCode::kForbidden, "file_transfer_interrupted"};
  };
  const auto session = root / "session";
  Control control;
  remotekit::objects::Keys keys;
  remotekit::objects::ObjectService objects(root / "node", control, remotekit::cluster::Key{},
                                            "source", "dev");
  remotekit::objects::PeerServer peer(objects.Store(), remotekit::cluster::Key{}, "source", "dev");
  Take(peer.Start("127.0.0.1:0"));
  const std::string hash = "fd7adb152c05ef80dccf50a1fa4c05d5a3ec6da95575fc312ae7c5d091836351";
  const FileUploadStore::Spec spec{"photo.jpeg", "image/jpeg", 3};
  const std::vector<std::uint8_t> png_signature{137, 80, 78, 71, 13, 10, 26, 10};
  std::string upload;
  std::string derivative_id;
  FileLibrary::Selection selection{"aabbccddaabbccddaabbccddaabbccdd",
                                   "chooser",
                                   {"browser", "1", "2", "3", "4"},
                                   {{hash, "photo.jpeg", "image/jpeg"}}};
  auto unsubmitted = selection;
  unsubmitted.id = "aabbccddaabbccddaabbccddaabbccee";
  unsubmitted.binding.request = "5";
  {
    FileLibrary library(session, objects, "tenant", keys);
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
    FileLibrary library(session, objects, "tenant", keys);
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
              "5282c0a80ba6b75435b918f0fe3cd79840428777d155d5d35b0c66560471a7fa");
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
    CHECK(Fails([&] { return library.Read(hash, 4); }));
    FileLibrary other(root / "other-session", objects, "other-tenant", keys);
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
    CHECK(!objects.Store().Inspect("tenant", control.last_commit["objectId"].get<std::string>()));
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
    FileLibrary library(session, objects, "tenant", keys);
    CHECK(library.Initialize());
    using State = FileLibrary::Selection::State;
    CHECK(Take(library.Describe(hash)).size == 3);
    CHECK(Take(library.Describe(derivative_id)).type == "image/png");
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
    const auto& metadata = session / "metadata" / (hash + ".json");
    fs::remove(metadata);
    FileLibrary library(session, objects, "tenant", keys);
    CHECK(library.Initialize());
    CHECK(library.FindSelection(selection.id)->state == FileLibrary::Selection::State::selected);
  }
  {
    Control target_control;
    target_control.address = peer.Address();
    remotekit::objects::ObjectService target(root / "target", target_control,
                                             remotekit::cluster::Key{}, "target", "dev");
    FileLibrary library(root / "remote-session", target, "tenant", keys);
    Take(library.Initialize());
    CHECK(!target.Store().Inspect("tenant", hash));
    target_control.reject_commit = true;
    CHECK(!library.Path(hash));
    CHECK(target.Store().Inspect("tenant", hash));
    target_control.reject_commit = false;
    const auto path = Take(library.Path(hash));
    std::ifstream input(path, std::ios::binary);
    CHECK(std::string(std::istreambuf_iterator<char>(input), {}) == "abc");
    CHECK(target_control.located == 1 && target_control.committed.back()["objectId"] == hash);
    CHECK(target.Store().Inspect("tenant", hash));
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
    CHECK(!target.Store().Inspect("tenant", derivative_id));
    CHECK(!target.Dispatch(
        {{"method", "object.delete"}, {"tenantId", "../tenant"}, {"ids", {hash}}}));
  }
  CHECK(!fs::exists(session / "references.json") && !fs::exists(session / "payload") &&
        !fs::exists(session / "assets"));
  DownloadImportTests(root, objects, control, keys);
  fs::remove_all(root);
  return 0;
}
