#include "files/file_upload.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace fs = std::filesystem;
using remotekit::FileUploadStore;
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
  const auto temporary = fs::temp_directory_path();
  const auto root =
      temporary / ("remotekit-file-staging-test-" +
                   std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  fs::create_directories(root);
  const auto source = root / "source.txt";
  {
    std::ofstream output(source, std::ios::binary);
    output << "abc";
  }
  const FileUploadStore::Binding binding{"browser", "1", "1", "1", "1"};
  const std::vector<FileUploadStore::Source> sources{{{"photo.txt", "text/plain", 3}, source}};
  const auto live = []() -> remotekit::Result<void> { return {}; };
  {
    FileUploadStore store(root / "staging", {8, 8, 8, 2, 2});
    CHECK(store.Initialize());
    CHECK(Fails([&] { return store.Stage({}, sources, live); }));
    CHECK(Fails([&] { return store.Stage(binding, {{{"../bad", "", 3}, source}}, live); }));
    CHECK(Fails([&] { return store.Stage(binding, {{{"too-big", "", 9}, source}}, live); }));
    CHECK(Fails(
        [&] { return store.Stage(binding, {{{"missing", "", 3}, root / "missing"}}, live); }));
    CHECK(store.reserved_bytes() == 0 && store.reserved_files() == 0);
    unsigned checks = 0;
    CHECK(Fails([&] {
      return store.Stage(binding, sources, [&]() -> remotekit::Result<void> {
        if (++checks == 3)
          return remotekit::Error{remotekit::ErrorCode::kForbidden, "retired"};
        return {};
      });
    }));
    CHECK(store.reserved_bytes() == 0);
    const auto batch = Take(store.Stage(binding, sources, live));
    CHECK(batch.state == FileUploadStore::State::sealed);
    CHECK(batch.files.front().path.extension() == ".file");
    CHECK(store.reserved_bytes() == 3 && store.reserved_files() == 1);
    CHECK(Fails([&] { return store.Stage(binding, sources, live); }));
    CHECK(Take(store.Cancel(batch.id)));
    CHECK(!fs::exists(batch.files.front().path));
    const auto submitted = Take(store.Stage(binding, sources, live));
    Take(store.MarkSubmitted(submitted.id));
    CHECK(!Take(store.Cancel(submitted.id)));
    Take(store.ConfirmBrowserStopped("other-browser"));
    CHECK(fs::exists(submitted.files.front().path));
    FileUploadStore restarted(root / "staging", {8, 8, 8, 2, 2});
    CHECK(restarted.Initialize());
    CHECK(restarted.reserved_bytes() == 3 && restarted.reserved_files() == 1);
    Take(restarted.ConfirmBrowserStopped("browser"));
    CHECK(fs::exists(submitted.files.front().path));
    CHECK(Fails([&] { return restarted.Stage(binding, {sources[0], sources[0]}, live); }));
    Take(store.ConfirmBrowserStopped("browser"));
    CHECK(!fs::exists(submitted.files.front().path));
    CHECK(store.reserved_bytes() == 0 && store.reserved_files() == 0);
  }
  {
    const auto session = root / "retained";
    FileUploadStore original(session);
    CHECK(original.Initialize());
    const auto batch = Take(original.Stage(binding, sources, live));
    Take(original.MarkSubmitted(batch.id));
    {
      std::ofstream record(batch.files.front().path.parent_path() / ".reservation");
      record << "corrupt";
    }
    FileUploadStore damaged(session);
    CHECK(!damaged.Initialize());

    CHECK(fs::exists(batch.files.front().path));
    Take(original.ConfirmBrowserStopped("browser"));
  }
  CHECK(root.is_absolute() && fs::equivalent(root.parent_path(), temporary) &&
        root.filename().string().starts_with("remotekit-file-staging-test-"));
  fs::remove_all(root);
}
