#include "replacement.hpp"
#include "archive.hpp"
namespace remotekit::updater {
Result<bool> ReplaceExecutable(const fs::path& installed,
                               const fs::path& replacement,
                               const fs::path& root,
                               const std::wstring& arguments,
                               bool service,
                               Log& log) {
  auto running = ExecutablePath();
  if (!fs::exists(installed) || !fs::equivalent(running, installed))
    return false;
  auto old_hash = cluster::Sha256File(installed), new_hash = cluster::Sha256File(replacement);
  if (!old_hash)
    return old_hash.error();
  if (!new_hash)
    return new_hash.error();
  if (old_hash.value() == new_hash.value())
    return false;
  const auto staged = fs::path(installed.wstring() + L".new");
  if (!CopyFileW(replacement.c_str(), staged.c_str(), FALSE))
    return Error{ErrorCode::kUnavailable, "cannot stage new supervisor"};
  const auto file = CreateFileW(staged.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "cannot open staged supervisor"};
  const bool flushed = FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  if (!flushed)
    return Error{ErrorCode::kUnavailable, "cannot flush staged supervisor"};
  const auto old = fs::path(installed.wstring() + L".old");
  if (!MoveFileExW(installed.c_str(), old.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Error{ErrorCode::kUnavailable, "cannot rename installed supervisor"};
  auto restore = [&] {
    DeleteFileW(installed.c_str());
    return MoveFileExW(old.c_str(), installed.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  };
  if (!MoveFileExW(staged.c_str(), installed.c_str(), MOVEFILE_WRITE_THROUGH)) {
    const bool restored = restore() != FALSE;
    return Error{ErrorCode::kUnavailable,
                 restored ? "cannot install new supervisor" : "cannot restore supervisor"};
  }
  if (!service) {
    auto command = Quote(installed.wstring()) + L" " + arguments;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(installed.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, root.c_str(), &startup, &process)) {
      bool restored = restore() != FALSE;
      return Error{ErrorCode::kUnavailable,
                   restored ? "cannot start updated supervisor" : "cannot restore supervisor"};
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
  }
  log.Event(LogLevel::kInfo, "supervisor.replaced");
  return true;
}
void CleanupRuntime(const fs::path& root, const std::string& current, bool downloads) {
  if (fs::exists(root / L"runtime"))
    for (auto& entry : fs::directory_iterator(root / L"runtime"))
      if (entry.path().filename().string() != current)
        fs::remove_all(ExtendedPath(entry.path()));
  if (downloads && fs::exists(root / L"downloads"))
    for (auto& entry : fs::directory_iterator(root / L"downloads"))
      fs::remove_all(ExtendedPath(entry.path()));
}
}  // namespace remotekit::updater
