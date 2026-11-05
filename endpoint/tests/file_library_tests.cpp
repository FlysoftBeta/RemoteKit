#include "remotekit/file_library.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>

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
template <class Action>
bool Throws(Action action) {
  try {
    action();
  } catch (const std::exception&) {
    return true;
  }
  return false;
}
int main() {
  const auto root = fs::temp_directory_path() /
                    ("remotekit-file-library-" +
                     std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  const auto live = [] {};
  const auto retired = [] { throw std::runtime_error("file_transfer_interrupted"); };
  const auto session = root / "session";
  const std::string hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
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
    FileLibrary library(session);
    const auto draft = library.Begin(1, "operation", spec, live);
    upload = draft["uploadId"];
    CHECK(draft["offset"] == 0);
    CHECK(Throws([&] { library.Begin(1, "operation", {"different", "", 3}, live); }));
    CHECK(Throws([&] { library.Chunk(1, upload, 1, {'a'}, live); }));
    CHECK(library.Chunk(1, upload, 0, {'a'}, live) == 1);
    CHECK(Throws([&] { library.Seal(1, upload, live); }));
    CHECK(Throws([&] { library.Chunk(1, upload, 1, {'b'}, retired); }));
    CHECK(Throws([&] { library.Chunk(2, upload, 1, {'b'}, live); }));
  }
  {
    FileLibrary library(session);
    CHECK(Throws([&] { library.Chunk(1, upload, 1, {'b'}, live); }));
    CHECK(library.Begin(1, "operation", spec, live)["offset"] == 1);
    CHECK(library.Chunk(1, upload, 0, {'a', 'b', 'c'}, live) == 3);
    CHECK(library.Chunk(1, upload, 0, {'a', 'b', 'c'}, live) == 3);
    CHECK(Throws([&] { library.Chunk(1, upload, 0, {'x'}, live); }));
    CHECK(Throws([&] { library.Seal(1, upload, retired); }));
    CHECK(library.Seal(1, upload, live).id == hash);
    CHECK(library.Seal(1, upload, live).id == hash);
    CHECK(library.Read(hash, 1).second == std::vector<std::uint8_t>({'b', 'c'}));
    CHECK(library.Read(hash, 3).second.empty());
    const auto derivative = library.CreateDerivative(
        [&](const fs::path& path) {
          CHECK(path.extension() == ".png");
          std::ofstream output(path, std::ios::binary);
          output.write(reinterpret_cast<const char*>(png_signature.data()), png_signature.size());
          return FileLibrary::Derivative{800, 600};
        },
        live, FileLibrary::DerivativeFormat::png);
    CHECK(derivative.type == "image/png" && derivative.width == 800 && derivative.height == 600);
    derivative_id = derivative.id;
    CHECK(library.Read(derivative_id, 0).second == png_signature);
    CHECK(Throws([&] { library.Read(hash, 4); }));
    FileLibrary other(root / "other-session");
    CHECK(Throws([&] { other.Describe(hash); }));
    const auto duplicate =
        library.Begin(1, "different-operation", spec, live)["uploadId"].get<std::string>();
    library.Chunk(1, duplicate, 0, {'a', 'b', 'c'}, live);
    CHECK(library.Seal(1, duplicate, live).id == hash);
    CHECK(Throws([&] { library.Prepare(selection); }));
    library.Retain({hash});
    library.References(7, {hash});
    library.References(7, {hash});
    CHECK(Throws([&] { library.References(7, {}); }));
    library.References(6, {});
    library.Prepare(selection);
    library.Prepare(selection);
    auto conflict = selection;
    conflict.files[0].name = "different";
    CHECK(Throws([&] { library.Prepare(conflict); }));
    CHECK(Throws([&] { library.Claim(selection.id, retired); }));
    CHECK(library.Claim(selection.id, live));
    CHECK(!library.Claim(selection.id, live));
    using State = FileLibrary::Selection::State;
    CHECK(library.Finish(selection.id, State::cancelled, State::pending) == State::submitted);
    library.Prepare(unsubmitted);
    CHECK(library.Finish(unsubmitted.id, State::cancelled, State::pending) == State::cancelled);
    CHECK(!library.Claim(unsubmitted.id, live));
  }
  {
    FileLibrary library(session);
    using State = FileLibrary::Selection::State;
    CHECK(library.Describe(hash).size == 3);
    CHECK(library.Describe(derivative_id).type == "image/png");
    CHECK(library.Begin(1, "operation", spec, live)["offset"] == 3);
    CHECK(library.Seal(1, upload, live).id == hash);
    CHECK(library.FindSelection(selection.id)->state == State::submitted);
    CHECK(library.FindSelection(unsubmitted.id)->state == State::cancelled);
    CHECK(!library.Claim(selection.id, live));
    library.Finish(selection.id, State::selected);
    library.Finish(selection.id, State::cancelled);
    CHECK(library.FindSelection(selection.id)->state == State::selected);
    library.References(8, {});
    FileUploadStore staging(root / "staging");
    const auto source = library.Path(hash);
    const auto& batch = staging.Stage(selection.binding, {{spec, source}}, live);
    const auto staged = batch.files.front().path;
    CHECK(Throws([&] { staging.BeginOrResume(selection.binding, {spec}); }));
    staging.MarkSubmitted(batch.id);
    staging.RevokeUncommitted();
    CHECK(fs::exists(staged));
    fs::remove(source);
    std::ifstream input(staged, std::ios::binary);
    CHECK(std::string(std::istreambuf_iterator<char>(input), {}) == "abc");
    input.close();
    staging.ConfirmBrowserStopped("browser");
    CHECK(!fs::exists(staged));
  }
  {
    // Receipt recovery must not depend on the original source or live Browser.
    const auto& metadata = session / "assets" / (hash + ".json");
    fs::remove(metadata);
    FileLibrary library(session);
    CHECK(library.FindSelection(selection.id)->state == FileLibrary::Selection::State::selected);
  }
  fs::remove_all(root);
  return 0;
}
