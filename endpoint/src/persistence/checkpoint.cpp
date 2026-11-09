#include "persistence/checkpoint.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <fstream>
#include <set>
#include <sstream>

namespace remotekit {
namespace {
constexpr size_t kChunk = 1024 * 1024;
bool SafePath(const std::string& text) {
  if (text.empty() || text.find('\\') != std::string::npos || text.find(':') != std::string::npos ||
      text.find('\0') != std::string::npos)
    return false;
  const auto path = Utf8Path(text);
  if (path.is_absolute() || path.has_root_path())
    return false;
  for (const auto& part : path)
    if (part == "." || part == ".." || part.empty() || part.native().back() == L'.' ||
        part.native().back() == L' ')
      return false;
  return true;
}
Json Load(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  return input ? Json::parse(input, nullptr, false) : Json();
}
Result<Json> Identity(const fs::path& path) {
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "checkpoint file attributes unavailable"};
  BY_HANDLE_FILE_INFORMATION info{};
  const bool ok = GetFileInformationByHandle(file, &info) != FALSE;
  CloseHandle(file);
  if (!ok)
    return Error{ErrorCode::kUnavailable, "checkpoint file identity unavailable"};
  return Json{
      {"size", (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow},
      {"mtime",
       (uint64_t(info.ftLastWriteTime.dwHighDateTime) << 32) | info.ftLastWriteTime.dwLowDateTime},
      {"fileId", std::to_string(info.dwVolumeSerialNumber) + ":" +
                     std::to_string((uint64_t(info.nFileIndexHigh) << 32) | info.nFileIndexLow)}};
}
}  // namespace
Result<Json> Checkpoints::Hibernation(const fs::path& directory) {
  const fs::path path = directory.wstring() + L".hibernation.json";
  if (!fs::exists(path))
    return Json();
  auto journal = Load(path);
  if (!journal.is_object() || !journal.contains("placementEpoch") ||
      !journal["placementEpoch"].is_number_unsigned() || journal["placementEpoch"] == 0 ||
      !journal.contains("manifestId") || !journal["manifestId"].is_string() ||
      !objects::ValidId(journal["manifestId"].get<std::string>()) || !journal.contains("objects") ||
      !journal["objects"].is_array() || !journal.contains("buildId") ||
      !journal["buildId"].is_string())
    return Error{ErrorCode::kUnavailable, "invalid hibernation journal"};
  return journal;
}
Result<void> Checkpoints::Journal(const fs::path& directory,
                                  uint64_t epoch,
                                  const Json& checkpoint,
                                  const std::string& build) {
  Json journal = checkpoint;
  journal["placementEpoch"] = epoch;
  journal["buildId"] = build;
  return WriteDurableJson(directory.wstring() + L".hibernation.json", journal);
}
bool Checkpoints::Excluded(const fs::path& relative, bool directory) {
  const auto name = relative.filename().wstring();
  if (directory) {
    static const std::set<std::wstring> excluded{
        L"Cache",           L"Code Cache",        L"GPUCache",
        L"DawnWebGPUCache", L"DawnGraphiteCache", L"Shared Dictionary",
        L"VideoDecodeStats"};
    if (excluded.contains(name))
      return true;
    return relative == "uploads" || relative == "file-library/drafts" ||
           relative == "file-library/incoming" || relative == "file-library/staging";
  }
  return name == L"browser.log" || name == L"LOCK" || name == L"LOG" || name == L"LOG.old";
}
Result<std::string> Checkpoints::Put(const std::string& tenant, const std::string& bytes) {
  std::istringstream input(bytes);
  RK_ASSIGN_OR_RETURN(info, objects_.Store().Write(objects_.ObjectKeys(), input));
  // Repeated notification also repairs a prior interrupted checkpoint transaction.
  RK_RETURN_IF_ERROR(objects_.Committed(info, {{"tenantId", tenant}}));
  if (access_)
    access_->Grant(info.id);
  return info.id;
}
Result<std::string> Checkpoints::Get(const std::string& tenant, const std::string& id) {
  if (!access_)
    access_ = std::make_shared<objects::SessionObjects>(objects_, tenant);
  RK_RETURN_IF_ERROR(access_->Ensure(id));
  std::ostringstream output;
  RK_RETURN_IF_ERROR(objects_.Store().Read(objects_.ObjectKeys(), id, output));
  return output.str();
}
Result<Json> Checkpoints::Create(const fs::path& directory,
                                 const std::string& tenant,
                                 const std::string& build) {
  const fs::path index_path = directory.wstring() + L".checkpoint-index.json";
  auto previous = Load(index_path);
  if (!previous.is_object())
    previous = Json::object();
  Json index = Json::object(), files = Json::array(), directories = Json::array();
  std::set<std::string> ids;
  fs::create_directories(directory);
  for (auto entry = fs::recursive_directory_iterator(directory);
       entry != fs::recursive_directory_iterator(); ++entry) {
    const auto relative = entry->path().lexically_relative(directory);
    if (entry->is_symlink() ||
        (GetFileAttributesW(entry->path().c_str()) & FILE_ATTRIBUTE_REPARSE_POINT))
      return Error{ErrorCode::kRejected, "checkpoint contains a reparse point"};
    const bool is_directory = entry->is_directory();
    if (Excluded(relative, is_directory)) {
      if (is_directory)
        entry.disable_recursion_pending();
      continue;
    }
    const auto path = relative.generic_u8string();
    const std::string name(path.begin(), path.end());
    if (!SafePath(name))
      return Error{ErrorCode::kRejected, "invalid checkpoint path"};
    if (is_directory) {
      directories.push_back(name);
      continue;
    }
    RK_ASSIGN_OR_RETURN(identity, Identity(entry->path()));
    Json chunks = Json::array();
    bool reuse = previous.contains(name) && previous[name].is_object() &&
                 previous[name].value("size", Json()) == identity["size"] &&
                 previous[name].value("mtime", Json()) == identity["mtime"] &&
                 previous[name].value("fileId", Json()) == identity["fileId"] &&
                 previous[name].contains("chunks");
    if (reuse) {
      chunks = previous[name]["chunks"];
      for (const auto& id : chunks) {
        auto local = objects_.Store().Inspect(id.get<std::string>());
        if (!local) {
          reuse = false;
          break;
        }
        RK_RETURN_IF_ERROR(objects_.Committed(local.value(), {{"tenantId", tenant}}));
      }
    }
    if (!reuse) {
      chunks = Json::array();
      std::ifstream input(entry->path(), std::ios::binary);
      if (!input)
        return Error{ErrorCode::kUnavailable, "checkpoint file open failed"};
      uint64_t remaining = identity["size"].get<uint64_t>();
      do {
        std::string bytes(static_cast<size_t>(std::min<uint64_t>(remaining, kChunk)), '\0');
        if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
          return Error{ErrorCode::kUnavailable, "checkpoint file read failed"};
        RK_ASSIGN_OR_RETURN(id, Put(tenant, bytes));
        chunks.push_back(id);
        remaining -= bytes.size();
      } while (remaining);
    }
    identity["chunks"] = chunks;
    index[name] = identity;
    files.push_back({{"path", name}, {"size", identity["size"]}, {"chunks", chunks}});
    for (const auto& id : chunks)
      ids.insert(id.get<std::string>());
  }
  std::sort(files.begin(), files.end(), [](const Json& a, const Json& b) {
    return a["path"].get<std::string>() < b["path"].get<std::string>();
  });
  std::sort(directories.begin(), directories.end());
  Json manifest{{"version", 2}, {"buildId", build}, {"files", files}, {"directories", directories}};
  RK_ASSIGN_OR_RETURN(manifest_id, Put(tenant, manifest.dump()));
  ids.insert(manifest_id);
  RK_RETURN_IF_ERROR(WriteDurableJson(index_path, index));
  RK_RETURN_IF_ERROR(WriteDurableJson(directory.wstring() + L".checkpoint", manifest_id));
  return Json{{"manifestId", manifest_id}, {"objects", ids}};
}
Result<void> Checkpoints::Restore(const fs::path& directory,
                                  const std::string& tenant,
                                  const Json& checkpoint) {
  const fs::path marker = directory.wstring() + L".checkpoint";
  RK_ASSIGN_OR_RETURN(journal, Hibernation(directory));
  if (!journal.is_null() && checkpoint != journal["manifestId"])
    return Error{ErrorCode::kConflict,
                 "uncommitted hibernation: checkpoint does not match journal"};
  if (checkpoint.is_null() && fs::exists(directory) && !fs::is_empty(directory)) {
    fprintf(stderr, "null checkpoint over non-empty Session directory: %s\n",
            Utf8(directory).c_str());
    return Error{ErrorCode::kConflict, "null checkpoint over non-empty Session directory"};
  }
  const bool warm =
      !checkpoint.is_null() && fs::is_directory(directory) && Load(marker) == checkpoint;
  auto index = warm ? Load(directory.wstring() + L".checkpoint-index.json") : Json();
  if (!index.is_object())
    index = Json::object();
  const fs::path restore = directory.wstring() + L".restore";
  const fs::path discard = directory.wstring() + L".discard";
  fs::remove_all(restore);
  fs::create_directories(restore);
  if (!checkpoint.is_null()) {
    RK_ASSIGN_OR_RETURN(bytes, Get(tenant, checkpoint.get<std::string>()));
    const auto manifest = Json::parse(bytes, nullptr, false);
    // The manifest's buildId only records its producer: a Profile written by an earlier build of
    // the same pinned Chromium opens as is, so upgrades keep hibernated Sessions.
    if (!manifest.is_object() || manifest.value("version", Json()) != 2 ||
        !manifest.contains("files") || !manifest["files"].is_array() ||
        !manifest.contains("directories") || !manifest["directories"].is_array())
      return Error{ErrorCode::kRejected, "invalid checkpoint manifest"};
    std::set<std::string> paths;
    for (const auto& item : manifest["directories"]) {
      if (!item.is_string() || !SafePath(item.get<std::string>()) ||
          !paths.insert(item.get<std::string>()).second)
        return Error{ErrorCode::kRejected, "invalid checkpoint directory"};
      fs::create_directories(restore / Utf8Path(item.get<std::string>()));
    }
    for (const auto& file : manifest["files"]) {
      if (!file.is_object() || !file.contains("path") || !file["path"].is_string() ||
          !SafePath(file["path"].get<std::string>()) || !file.contains("size") ||
          !file["size"].is_number_unsigned() || !file.contains("chunks") ||
          !file["chunks"].is_array() || !paths.insert(file["path"].get<std::string>()).second)
        return Error{ErrorCode::kRejected, "invalid checkpoint file"};
      const auto path = restore / Utf8Path(file["path"].get<std::string>());
      const auto name = file["path"].get<std::string>();
      if (warm && index.contains(name) && index[name].is_object()) {
        const auto identity = Identity(directory / Utf8Path(name));
        if (identity && index[name].value("size", Json()) == identity.value()["size"] &&
            index[name].value("mtime", Json()) == identity.value()["mtime"] &&
            index[name].value("fileId", Json()) == identity.value()["fileId"] &&
            index[name].value("chunks", Json()) == file["chunks"] &&
            identity.value()["size"] == file["size"])
          continue;
      }
      fs::create_directories(path.parent_path());
      std::ofstream output(path, std::ios::binary | std::ios::trunc);
      uint64_t remaining = file["size"].get<uint64_t>();
      if (file["chunks"].size() != std::max<uint64_t>(1, (remaining + kChunk - 1) / kChunk))
        return Error{ErrorCode::kRejected, "invalid checkpoint chunk count"};
      for (const auto& chunk : file["chunks"]) {
        if (!chunk.is_string() || !objects::ValidId(chunk.get<std::string>()))
          return Error{ErrorCode::kRejected, "invalid checkpoint chunk"};
        auto fetched = Get(tenant, chunk.get<std::string>());
        if (!fetched)
          return Error{ErrorCode::kUnavailable,
                       "checkpoint object unavailable: " + fetched.error().message};
        const auto& content = fetched.value();
        if (content.size() != std::min<uint64_t>(remaining, kChunk))
          return Error{ErrorCode::kRejected, "checkpoint chunk size mismatch"};
        output.write(content.data(), static_cast<std::streamsize>(content.size()));
        remaining -= content.size();
      }
      output.close();
      if (!output)
        return Error{ErrorCode::kUnavailable, "checkpoint materialization failed"};
      RK_RETURN_IF_ERROR(FlushFile(path));
    }
  }
  if (warm) {
    for (const auto& entry : fs::recursive_directory_iterator(restore)) {
      const auto target = directory / entry.path().lexically_relative(restore);
      if (entry.is_directory()) {
        fs::create_directories(target);
      } else if (!MoveFileExW(entry.path().c_str(), target.c_str(),
                              MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        return Error{ErrorCode::kUnavailable, "warm checkpoint repair failed"};
      }
    }
    fs::remove_all(restore);
    fs::remove(marker);
    return {};
  }
  fs::remove_all(discard);
  const bool had_directory = fs::exists(directory);
  if (had_directory)
    fs::rename(directory, discard);
  std::error_code error;
  fs::rename(restore, directory, error);
  if (error) {
    if (had_directory)
      fs::rename(discard, directory);
    return Error{ErrorCode::kUnavailable, "checkpoint directory swap failed"};
  }
  fs::remove(marker);
  fs::remove(directory.wstring() + L".checkpoint-index.json");
  fs::remove_all(discard);
  return {};
}
}  // namespace remotekit
