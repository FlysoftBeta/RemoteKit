#include "remotekit/file_upload.hpp"

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
bool Throws(F f) {
  try {
    f();
  } catch (const std::exception&) {
    return true;
  }
  return false;
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
  const auto live = [] {};
  {
    FileUploadStore store(root / "staging", {8, 8, 8, 2, 2});
    CHECK(Throws([&] { store.Stage({}, sources, live); }));
    CHECK(Throws([&] { store.Stage(binding, {{{"../bad", "", 3}, source}}, live); }));
    CHECK(Throws([&] { store.Stage(binding, {{{"too-big", "", 9}, source}}, live); }));
    CHECK(Throws([&] { store.Stage(binding, {{{"missing", "", 3}, root / "missing"}}, live); }));
    CHECK(store.reserved_bytes() == 0 && store.reserved_files() == 0);
    unsigned checks = 0;
    CHECK(Throws([&] {
      store.Stage(binding, sources, [&] {
        if (++checks == 3)
          throw std::runtime_error("retired");
      });
    }));
    CHECK(store.reserved_bytes() == 0);
    const auto batch = store.Stage(binding, sources, live);
    CHECK(batch.state == FileUploadStore::State::sealed);
    CHECK(batch.files.front().path.extension() == ".file");
    CHECK(store.reserved_bytes() == 3 && store.reserved_files() == 1);
    CHECK(Throws([&] { store.Stage(binding, sources, live); }));
    CHECK(store.Cancel(batch.id));
    CHECK(!fs::exists(batch.files.front().path));
    const auto submitted = store.Stage(binding, sources, live);
    store.MarkSubmitted(submitted.id);
    CHECK(!store.Cancel(submitted.id));
    store.ConfirmBrowserStopped("other-browser");
    CHECK(fs::exists(submitted.files.front().path));
    FileUploadStore restarted(root / "staging", {8, 8, 8, 2, 2});
    CHECK(restarted.reserved_bytes() == 3 && restarted.reserved_files() == 1);
    restarted.ConfirmBrowserStopped("browser");
    CHECK(fs::exists(submitted.files.front().path));
    CHECK(Throws([&] { restarted.Stage(binding, {sources[0], sources[0]}, live); }));
    store.ConfirmBrowserStopped("browser");
    CHECK(!fs::exists(submitted.files.front().path));
    CHECK(store.reserved_bytes() == 0 && store.reserved_files() == 0);
  }
  {
    const auto session = root / "retained";
    FileUploadStore original(session);
    const auto batch = original.Stage(binding, sources, live);
    original.MarkSubmitted(batch.id);
    {
      std::ofstream record(batch.files.front().path.parent_path() / ".reservation");
      record << "corrupt";
    }
    FileUploadStore damaged(session);
    CHECK(Throws([&] { damaged.Stage(binding, sources, live); }));
    CHECK(fs::exists(batch.files.front().path));
    original.ConfirmBrowserStopped("browser");
  }
  CHECK(root.is_absolute() && fs::equivalent(root.parent_path(), temporary) &&
        root.filename().string().starts_with("remotekit-file-staging-test-"));
  fs::remove_all(root);
}
