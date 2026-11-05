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

int main() {
  const auto root = fs::temp_directory_path() /
                    ("remotekit-file-library-" +
                     std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  const auto live = []() -> remotekit::Result<void> { return {}; };
  const auto retired = []() -> remotekit::Result<void> {
    return remotekit::Error{remotekit::ErrorCode::kForbidden, "file_transfer_interrupted"};
  };
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
    FileLibrary library(session);
    CHECK(library.Initialize());
    CHECK(Fails([&] { return library.Chunk(1, upload, 1, {'b'}, live); }));
    CHECK(Take(library.Begin(1, "operation", spec, live))["offset"] == 1);
    CHECK(Take(library.Chunk(1, upload, 0, {'a', 'b', 'c'}, live)) == 3);
    CHECK(Take(library.Chunk(1, upload, 0, {'a', 'b', 'c'}, live)) == 3);
    CHECK(Fails([&] { return library.Chunk(1, upload, 0, {'x'}, live); }));
    CHECK(Fails([&] { return library.Seal(1, upload, retired); }));
    CHECK(Take(library.Seal(1, upload, live)).id == hash);
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
        live, FileLibrary::DerivativeFormat::png));
    CHECK(derivative.type == "image/png" && derivative.width == 800 && derivative.height == 600);
    derivative_id = derivative.id;
    CHECK(Take(library.Read(derivative_id, 0)).second == png_signature);
    CHECK(Fails([&] { return library.Read(hash, 4); }));
    FileLibrary other(root / "other-session");
    CHECK(other.Initialize());
    CHECK(Fails([&] { return other.Describe(hash); }));
    const auto duplicate =
        Take(library.Begin(1, "different-operation", spec, live))["uploadId"].get<std::string>();
    Take(library.Chunk(1, duplicate, 0, {'a', 'b', 'c'}, live));
    CHECK(Take(library.Seal(1, duplicate, live)).id == hash);
    CHECK(Fails([&] { return library.Prepare(selection); }));
    Take(library.Retain({hash}));
    Take(library.References(7, {hash}));
    Take(library.References(7, {hash}));
    CHECK(Fails([&] { return library.References(7, {}); }));
    Take(library.References(6, {}));
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
    FileLibrary library(session);
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
    Take(library.References(8, {}));
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
    const auto& metadata = session / "assets" / (hash + ".json");
    fs::remove(metadata);
    FileLibrary library(session);
    CHECK(library.Initialize());
    CHECK(library.FindSelection(selection.id)->state == FileLibrary::Selection::State::selected);
  }
  fs::remove_all(root);
  return 0;
}
