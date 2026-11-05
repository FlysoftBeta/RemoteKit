#include "remotekit/file_upload.hpp"
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
using remotekit::FileUploadStore;
#define CHECK(value)                             \
  do {                                           \
    if (!(value)) {                              \
      std::cerr << __LINE__ << ": " #value "\n"; \
      std::exit(1);                              \
    }                                            \
  } while (false)
template <class Callback>
bool Throws(Callback callback) {
  try {
    callback();
  } catch (const std::exception&) {
    return true;
  }
  return false;
}
int main() {
  try {
    namespace fs = std::filesystem;
    const auto temporary = fs::temp_directory_path();
    const auto root =
        temporary / ("remotekit-file-upload-test-" +
                     std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(root);
    {
      FileUploadStore store(root, {4, 6, 6, 2});
      FileUploadStore::Binding first{"browser-A", "1", "1", "1", "7"};
      auto second = first;
      second.request = "8";
      CHECK(Throws([&] { store.Begin(first, {{"../escape", "", 1}}); }));
      CHECK(Throws([&] { store.Begin(first, {{"a", "", 5}}); }));
      CHECK(Throws([&] { store.Begin(first, {{"a", "", 3}, {"b", "", 4}}); }));
      const auto batch = store.Begin(first, {{"原始名称.txt", "text/plain", 3}});
      CHECK(batch.files.size() == 1 && batch.files[0].name == "原始名称.txt");
      CHECK(batch.files[0].path.filename().string().find("原始名称") == std::string::npos);
      CHECK(Throws([&] { store.Begin(first, {{"duplicate", "", 1}}); }));
      CHECK(Throws([&] { store.Seal(batch.id, first); }));
      CHECK(Throws([&] { store.MarkSelected(batch.id); }));
      {
        std::ofstream output(batch.files[0].path, std::ios::binary);
        output << "abc";
      }
      auto wrong = first;
      wrong.document = "2";
      CHECK(Throws([&] { store.Seal(batch.id, wrong); }));
      const auto sealed = store.Seal(batch.id, first);
      CHECK(sealed.files[0].path.extension() == ".file");
      CHECK(!fs::exists(batch.files[0].path));
      store.MarkSubmitted(batch.id);
      CHECK(!store.Cancel(batch.id));
      store.MarkSelected(batch.id);
      CHECK(!store.DiscardUnselected(batch.id));
      const auto draft = store.Begin(second, {{"draft.txt", "", 3}});
      CHECK(store.reserved_bytes() == 6);
      auto third = first;
      third.request = "9";
      CHECK(Throws([&] { store.Begin(third, {{"over-quota", "", 1}}); }));
      store.RevokeUncommitted();
      CHECK(!store.Find(draft.id));
      CHECK(fs::exists(sealed.files[0].path) && store.reserved_bytes() == 3);
      store.ConfirmBrowserStopped("browser-B");
      CHECK(fs::exists(sealed.files[0].path));
      store.ConfirmBrowserStopped("browser-A");
      CHECK(!fs::exists(sealed.files[0].path));
      CHECK(store.reserved_bytes() == 0);
      const auto cancelled = store.Begin(first, {{"zero.txt", "", 0}});
      store.Seal(cancelled.id, first);
      store.MarkSubmitted(cancelled.id);
      CHECK(store.DiscardUnselected(cancelled.id));
      CHECK(!store.Find(cancelled.id));
    }
    {
      FileUploadStore store(root / "direct-chunks", {32, 64, 64, 4, 8});
      const FileUploadStore::Binding binding{"chunk-browser", "1", "1", "1", "1"};
      const std::vector<FileUploadStore::Spec> specs{{"bytes.txt", "text/plain", 6}};
      const auto first = store.BeginOrResume(binding, specs);
      CHECK(store.BeginOrResume(binding, specs).id == first.id);  // Lost begin reply reserves once.
      CHECK(store.reserved_bytes() == 6 && store.reserved_files() == 1);
      CHECK(Throws([&] { store.BeginOrResume(binding, {{"different", "", 6}}); }));
      CHECK(store.Write(first.id, binding, 0, 0, {'a', 'b', 'c'}) == 3);
      CHECK(store.Write(first.id, binding, 0, 0, {'a', 'b', 'c'}) == 3);  // Lost chunk ACK.
      CHECK(Throws([&] { store.Write(first.id, binding, 0, 0, {'x', 'b', 'c'}); }));
      CHECK(Throws([&] { store.Write(first.id, binding, 0, 4, {'e'}); }));
      CHECK(Throws([&] { store.Write(first.id, binding, 0, 2, {'c', 'd'}); }));
      CHECK(Throws([&] { store.Write(first.id, binding, 0, 3, {'d', 'e', 'f', 'g'}); }));
      auto stale = binding;
      stale.document = "2";
      CHECK(Throws([&] { store.Write(first.id, stale, 0, 3, {'d', 'e', 'f'}); }));
      CHECK(store.Offsets(first.id, binding) == std::vector<std::uint64_t>{3});
      CHECK(Throws([&] { store.Seal(first.id, binding); }));
      CHECK(store.Write(first.id, binding, 0, 3, {'d', 'e', 'f'}) == 6);
      {
        std::ifstream input(first.files[0].path, std::ios::binary);
        std::string bytes((std::istreambuf_iterator<char>(input)), {});
        CHECK(bytes == "abcdef");
      }
      CHECK(store.CancelBinding(binding));  // No uploadId needed after lost begin.
      CHECK(store.CancelBinding(binding));
      CHECK(!fs::exists(first.files[0].path) && store.reserved_bytes() == 0);
      const auto again = store.BeginOrResume(binding, specs);
      CHECK(again.id != first.id);
      store.Seal(store.BeginOrResume(stale, {{"empty", "", 0}}).id, stale);
      CHECK(store.CancelBinding(binding));
      store.RevokeUncommitted();
      CHECK(store.reserved_bytes() == 0);
    }
    {
      FileUploadStore long_paths(root / std::string(120, 'a') / std::string(120, 'b'));
      const auto batch =
          long_paths.Begin({"long-browser", "1", "1", "1", "1"}, {{"long.txt", "", 1}});
      {
        std::ofstream output(batch.files[0].path, std::ios::binary);
        output << 'x';
      }
      long_paths.Seal(batch.id, batch.binding);
      long_paths.MarkSubmitted(batch.id);
      long_paths.MarkSelected(batch.id);
      long_paths.ConfirmBrowserStopped("long-browser");
      CHECK(long_paths.reserved_bytes() == 0);
    }
    {
      const auto session = root / "restart";
      FileUploadStore original(session, {8, 8, 8, 2, 2});
      const FileUploadStore::Binding binding{"retained-browser", "1", "1", "1", "1"};
      const auto retained = original.Begin(binding, {{"selected.txt", "", 3}});
      {
        std::ofstream output(retained.files[0].path, std::ios::binary);
        output << "abc";
      }
      const auto selected = original.Seal(retained.id, binding);
      original.MarkSubmitted(retained.id);
      original.MarkSelected(retained.id);
      FileUploadStore restarted(session, {8, 8, 8, 2, 2});
      CHECK(restarted.reserved_bytes() == 3 &&
            restarted.reserved_files() == 1);  // max, not declaration + actual.
      restarted.ConfirmBrowserStopped("retained-browser");
      CHECK(
          fs::exists(selected.files[0].path));  // New owner cannot claim an old Browser is stopped.
      auto next = binding;
      next.browser_incarnation = "new-browser";
      const auto zero = restarted.Begin(next, {{"zero", "", 0}});
      next.request = "2";
      CHECK(Throws([&] { restarted.Begin(next, {{"another-zero", "", 0}}); }));
      CHECK(restarted.Cancel(zero.id));
      // A retained partial larger than its declaration is charged at actual size.
      {
        std::ofstream output(selected.files[0].path, std::ios::binary | std::ios::trunc);
        output << "123456";
      }
      FileUploadStore larger(session, {8, 8, 8, 2, 4});
      CHECK(larger.reserved_bytes() == 6);
      CHECK(Throws([&] { larger.Begin(next, {{"too-big", "", 3}}); }));
      {
        std::ofstream record(selected.files[0].path.parent_path() / ".reservation",
                             std::ios::trunc);
        record << "corrupt";
      }
      FileUploadStore damaged(session, {8, 8, 8, 2, 4});
      CHECK(Throws([&] { damaged.Begin(next, {{"even-zero", "", 0}}); }));
      CHECK(fs::exists(selected.files[0].path));
      // A non-owned directory is never traversed or charged as an upload.
      const auto unrelated = root / "foreign";
      fs::create_directories(unrelated / "not-an-owner");
      {
        std::ofstream keep(unrelated / "not-an-owner" / "keep");
        keep << "foreign";
      }
      FileUploadStore clean(unrelated, {8, 8, 8, 2, 4});
      CHECK(clean.reserved_bytes() == 0 && fs::exists(unrelated / "not-an-owner" / "keep"));
    }
    {
      const auto session = root / "partial";
      FileUploadStore original(session, {8, 8, 8, 2, 4});
      const FileUploadStore::Binding binding{"partial-browser", "1", "1", "1", "1"};
      const auto draft = original.Begin(binding, {{"partial", "", 1}});
      {
        std::ofstream output(draft.files[0].path, std::ios::binary);
        output << "1234";
      }
      FileUploadStore restarted(session, {8, 8, 8, 2, 4});
      CHECK(restarted.reserved_bytes() == 4 && restarted.reserved_files() == 1);
      fs::remove(draft.files[0].path.parent_path() / ".reservation");
      FileUploadStore missing(session, {8, 8, 8, 2, 4});
      CHECK(Throws([&] { missing.Begin(binding, {{"zero", "", 0}}); }));
      CHECK(fs::exists(draft.files[0].path));
    }
    CHECK(root.is_absolute() && fs::equivalent(root.parent_path(), temporary) &&
          root.filename().string().starts_with("remotekit-file-upload-test-"));
    auto cleanup_root = root;
#ifdef _WIN32
    cleanup_root.make_preferred();
    const auto native = cleanup_root.native();
    if (!native.starts_with(L"\\\\?\\"))
      cleanup_root = native.starts_with(L"\\\\") ? fs::path(L"\\\\?\\UNC\\" + native.substr(2))
                                                 : fs::path(L"\\\\?\\" + native);
#endif
    fs::remove_all(cleanup_root);
    std::cout << "file upload storage passed\n";
  } catch (const std::exception& error) {
    std::cerr << "file upload test exception: " << error.what() << '\n';
    return 1;
  }
}
