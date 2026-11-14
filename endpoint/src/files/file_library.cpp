#include "util/log.hpp"
#include "files/file_library.hpp"
#include "files/library_records.hpp"
#include "files/file_selection.hpp"
#include "documents/object_documents.hpp"
#include "files/dc_file_services.hpp"
#include "persistence/durable_json.hpp"
#include "util/file_io.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <fstream>
#include <iostream>
#include <limits>
#include <span>
#include "util/result_macros.hpp"
#include "util/file_io.hpp"

namespace remotekit {
ServiceJson FileLibrary::StopBlockers(const std::function<bool(uint64_t)>& current) const {
  std::lock_guard lock(mutex_);
  const auto selections =
      std::count_if(selections_.begin(), selections_.end(), [](const auto& item) {
        return item.second.state == Selection::State::pending ||
               item.second.state == Selection::State::dispatching ||
               item.second.state == Selection::State::unknown;
      });
  const auto uploads = std::count_if(drafts_.begin(), drafts_.end(), [&](const auto& item) {
    return item.second.sealed.empty() && current(item.second.grant);
  });
  return {{"pendingNativeSelections", selections}, {"inFlightUploads", uploads}};
}
namespace {
namespace fs = std::filesystem;
using Json = ServiceJson;
using State = FileLibrary::Selection::State;
using namespace library_records;
constexpr std::uint64_t kMiB = 1024 * 1024;

constexpr std::uint64_t kStagingBytes = 512 * kMiB;
constexpr std::uint64_t kDraftBytes = 512 * kMiB;
constexpr std::uint64_t kJpegDerivativeBytes = 24 * kMiB;
constexpr std::uint64_t kPngDerivativeBytes = 64 * kMiB;
constexpr std::size_t kAssets = 8192;
constexpr std::size_t kDrafts = 1024;
constexpr std::size_t kActiveDrafts = 32;
constexpr std::size_t kSelections = 65536;
constexpr std::int64_t kDraftLifetime = 30 * 60;
constexpr std::size_t kChunk = 16384;

std::int64_t Now() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
std::string Hex(std::span<const unsigned char> bytes) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (auto byte : bytes) {
    result += digits[byte >> 4];
    result += digits[byte & 15];
  }
  return result;
}
Result<std::string> RandomId() {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return Error{ErrorCode::kUnavailable, "file_random_failed"};
  return Hex(bytes);
}
bool Plain(const fs::path& path, bool directory = false) {
  const auto attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
         bool(attributes & FILE_ATTRIBUTE_DIRECTORY) == directory;
}
Result<void> Verify(const fs::path& path, std::uint64_t size) {
  RK_ASSIGN_OR_RETURN(actual_size, FileSize(path));
  if (!Plain(path) || actual_size != size)
    return Error{ErrorCode::kUnavailable, "asset_unavailable"};

  return {};
}
bool Remove(const fs::path& path) {
  std::error_code error;
  fs::remove(path, error);
  return !error;
}
}  // namespace

ServiceJson FileLibrary::Asset::Json() const {
  ServiceJson result = {{"assetId", id}, {"size", size}};
  if (type)
    result["type"] = *type;
  if (width && height) {
    result["width"] = width;
    result["height"] = height;
  }
  return result;
}

FileLibrary::FileLibrary(fs::path root,
                         objects::ObjectService& objects,
                         std::string tenant,
                         LibraryStore store,
                         std::shared_ptr<objects::SessionObjects> access)
    : root_(std::move(root)),
      store_(store),
      objects_(objects),
      tenant_(std::move(tenant)),
      access_(access ? std::move(access)
                     : std::make_shared<objects::SessionObjects>(objects, tenant_)),
      remove_file_(RemoveFile) {}
Result<void> FileLibrary::Initialize() {
  std::error_code absolute_error;
  root_ = fs::absolute(root_, absolute_error).make_preferred();
  if (absolute_error)
    return Error{ErrorCode::kUnavailable, "library path unavailable"};
  const auto native = root_.native();
  if (!native.starts_with(LR"(\\?\)"))
    root_ = native.starts_with(LR"(\\)") ? fs::path(LR"(\\?\UNC\)" + native.substr(2))
                                         : fs::path(LR"(\\?\)" + native);
  for (const auto& directory : {root_, root_ / "staging", root_ / "incoming"}) {
    RK_RETURN_IF_ERROR(CreateDirectories(directory));
    if (!Plain(directory, true))
      return Error{ErrorCode::kUnavailable, "unsafe_library_root"};
  }
  RK_ASSIGN_OR_RETURN(assets, store_.Load(LibraryTable::kAssets));
  if (assets.size() > kAssets)
    return CorruptState("library asset limit");
  for (const auto& [id, value] : assets) {
    entries_.emplace(
        id, Entry{Asset{id,
                        value.contains("type") ? std::optional(value.at("type").get<std::string>())
                                               : std::nullopt,
                        value.at("size").get<uint64_t>(),
                        value.contains("width") ? value.at("width").get<unsigned>() : 0u,
                        value.contains("height") ? value.at("height").get<unsigned>() : 0u}});
  }
  RK_ASSIGN_OR_RETURN(drafts, store_.Load(LibraryTable::kDrafts));
  if (drafts.size() > kDrafts)
    return CorruptState("library draft limit");
  for (const auto& [id, value] : drafts) {
    Draft draft{id,
                value.at("operation").get<std::string>(),
                value.at("sealed").get<std::string>(),
                {value.at("name").get<std::string>(), value.at("type").get<std::string>(),
                 value.at("size").get<uint64_t>()},
                value.at("expires").get<int64_t>()};
    if (draft.sealed.empty()) {
      RK_ASSIGN_OR_RETURN(exists, FileExists(DraftData(id)));
      if (!exists)
        return CorruptState("missing asset draft payload");
      RK_ASSIGN_OR_RETURN(size, FileSize(DraftData(id)));
      if (!Plain(DraftData(id)) || size > draft.spec.size ||
          draft.spec.size > kDraftBytes - draft_bytes_)
        return CorruptState("invalid asset draft payload");
      draft_bytes_ += draft.spec.size;
    }
    drafts_.emplace(id, std::move(draft));
  }
  RK_ASSIGN_OR_RETURN(selections, store_.Load(LibraryTable::kSelections));
  if (selections.size() > kSelections)
    return CorruptState("library selection limit");
  for (const auto& [id, value] : selections) {
    RK_ASSIGN_OR_RETURN(selection, ParseSelection(id, value));
    selections_.emplace(id, std::move(selection));
  }
  const auto clean = [&](const fs::path& directory, std::size_t maximum,
                         auto keep) -> Result<void> {
    std::size_t count = 0;
    RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(directory));
    for (const auto& entry : entries) {
      if (++count > maximum)
        return CorruptState("invalid_library_payload");
      if (!Plain(entry.path()) && directory == root_ / "staging") {
        LogEvent(LogLevel::kWarn, "library.staging_discarded", {{"path", entry.path().string()}});
        RK_RETURN_IF_ERROR(RemoveTree(entry.path()));
        continue;
      }
      if (!Plain(entry.path()))
        return CorruptState("invalid_library_payload");
      if (!keep(entry.path().filename().string()) && !Remove(entry.path()))
        return Error{ErrorCode::kUnavailable, "cannot_clean_library_payload"};
    }
    return {};
  };
  RK_RETURN_IF_ERROR(clean(root_ / "staging", kAssets + 1, [](const auto&) { return false; }));
  RK_RETURN_IF_ERROR(clean(root_ / "incoming", kDrafts + 1, [&](const auto& id) {
    const auto found = drafts_.find(id);
    return found != drafts_.end() && found->second.sealed.empty();
  }));
  RK_RETURN_IF_ERROR(Sweep());

  return {};
}
Result<void> FileLibrary::PrepareCheckpoint() {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(store_.ClearDrafts());
  for (const auto& [id, draft] : drafts_)
    retiring_drafts_[id] = draft.sealed.empty() ? draft.spec.size : 0;
  drafts_.clear();
  RK_RETURN_IF_ERROR(RemoveTree(root_ / "incoming"));
  retiring_drafts_.clear();
  draft_bytes_ = 0;
  return {};
}
fs::path FileLibrary::DraftData(const std::string& id) const {
  return root_ / "incoming" / id;
}
Result<const FileLibrary::Entry*> FileLibrary::RequireAsset(const std::string& id) const {
  auto found = entries_.find(id);
  RK_ASSIGN_OR_RETURN(info, access_->Ensure(id));
  if (found != entries_.end() && found->second.asset.size != info.size) {
    return CorruptRecord("library asset size does not match its object");
  }
  if (found == entries_.end()) {
    if (info.size > kFileBytes)
      return Error{ErrorCode::kLimitExceeded, "asset_too_large", ErrorReason::kFileTooLarge};
    Entry entry{Asset{id, std::nullopt, info.size}};
    RK_RETURN_IF_ERROR(SaveEntry(entry));
    found = entries_.emplace(id, std::move(entry)).first;
  }
  return &found->second;
}
Result<FileLibrary::Draft*> FileLibrary::RequireDraft(std::uint64_t grant, const std::string& id) {
  const auto found = drafts_.find(id);
  if (!grant || found == drafts_.end() || found->second.grant != grant)
    return Error{ErrorCode::kNotFound, "unknown_asset_upload"};
  return &found->second;
}
Result<void> FileLibrary::SaveDraft(const Draft& draft, const Check& check) const {
  if (check) {
    RK_RETURN_IF_ERROR(check());
  }
  RK_RETURN_IF_ERROR(store_.Save(LibraryTable::kDrafts, draft.id,
                                 {{"operation", draft.operation},
                                  {"name", draft.spec.name},
                                  {"type", draft.spec.type},
                                  {"size", draft.spec.size},
                                  {"expires", draft.expires},
                                  {"sealed", draft.sealed}}));

  return {};
}
Result<void> FileLibrary::SaveEntry(const Entry& entry, const Check& check) const {
  if (check) {
    RK_RETURN_IF_ERROR(check());
  }
  auto value = entry.asset.Json();
  RK_RETURN_IF_ERROR(store_.Save(LibraryTable::kAssets, entry.asset.id, value));

  return {};
}
Result<void> FileLibrary::SaveSelection(const Selection& selection, const Check& check) const {
  if (check) {
    RK_RETURN_IF_ERROR(check());
  }
  const auto& binding = selection.binding;
  Json files = Json::array();
  for (const auto& file : selection.files)
    files.push_back({{"assetId", file.asset_id}, {"name", file.name}, {"type", file.type}});
  RK_RETURN_IF_ERROR(store_.Save(LibraryTable::kSelections, selection.id,
                                 {{"requestId", selection.request_id},
                                  {"files", files},
                                  {"accept", selection.accept},
                                  {"limits",
                                   {{"maxFileBytes", selection.limits.file_bytes},
                                    {"maxBatchBytes", selection.limits.batch_bytes},
                                    {"maxFiles", selection.limits.files}}},
                                  {"binding",
                                   {{"browserIncarnation", binding.browser_incarnation},
                                    {"view", binding.view},
                                    {"instance", binding.instance},
                                    {"document", binding.document},
                                    {"request", binding.request}}},
                                  {"state", StateName(selection.state)}}));

  return {};
}
Result<ServiceJson> FileLibrary::Begin(std::uint64_t grant,
                                       const std::string& operation,
                                       const FileUploadStore::Spec& spec,
                                       const Check& check) {
  if (!grant || !BoundedServiceId(operation) || !ValidSpec(spec))
    return Error{ErrorCode::kInvalidRequest, "invalid_asset_upload"};
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  for (auto& [id, draft] : drafts_) {
    if (draft.operation != operation)
      continue;
    if (draft.spec.name != spec.name || draft.spec.type != spec.type ||
        draft.spec.size != spec.size)
      return Error{ErrorCode::kConflict, "asset_operation_conflict"};
    uint64_t offset = spec.size;
    if (draft.sealed.empty()) {
      RK_ASSIGN_OR_RETURN(received, FileSize(DraftData(id)));
      offset = received;
    }
    draft.grant = grant;
    return Json{{"uploadId", id}, {"offset", offset}};
  }
  const auto active = std::count_if(drafts_.begin(), drafts_.end(),
                                    [](const auto& item) { return item.second.sealed.empty(); });
  if (drafts_.size() + retiring_drafts_.size() >= kDrafts ||
      static_cast<std::size_t>(active) >= kActiveDrafts || spec.size > kDraftBytes - draft_bytes_)
    return Error{ErrorCode::kLimitExceeded, "asset_draft_quota",
                 ErrorReason::kStorageQuotaExceeded};
  RK_ASSIGN_OR_RETURN(random, RandomId());
  Draft draft{random, operation, {}, spec, Now() + kDraftLifetime, grant};
  const auto path = DraftData(draft.id);
  const HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "cannot_create_asset_draft"};
  CloseHandle(handle);
  RK_RETURN_IF_ERROR(FlushFile(path));
  auto saved = SaveDraft(draft, check);
  if (!saved) {
    Remove(path);
    return saved.error();
  }
  draft_bytes_ += spec.size;
  const auto id = draft.id;
  drafts_.emplace(id, std::move(draft));
  return Json{{"uploadId", id}, {"offset", 0}};
}
Result<std::uint64_t> FileLibrary::Chunk(std::uint64_t grant,
                                         const std::string& id,
                                         std::uint64_t offset,
                                         const std::vector<std::uint8_t>& bytes,
                                         const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  RK_ASSIGN_OR_RETURN(draft_ptr, RequireDraft(grant, id));
  auto& draft = *draft_ptr;
  if (!draft.sealed.empty() || bytes.empty() || bytes.size() > kChunk || offset > draft.spec.size ||
      bytes.size() > draft.spec.size - offset)
    return Error{ErrorCode::kInvalidRequest, "invalid_asset_chunk"};
  const auto path = DraftData(id);
  if (!Plain(path))
    return Error{ErrorCode::kUnavailable, "asset_unavailable"};
  RK_ASSIGN_OR_RETURN(received, FileSize(path));
  if (offset > received || received > draft.spec.size)
    return Error{ErrorCode::kConflict, "file_chunk_out_of_order"};
  std::fstream stream(path, std::ios::binary | std::ios::in | std::ios::out);
  if (!stream)
    return Error{ErrorCode::kUnavailable, "file_read_failed"};
  const auto previous_size =
      static_cast<std::size_t>(std::min<std::uint64_t>(received - offset, bytes.size()));
  if (previous_size) {
    std::vector<std::uint8_t> previous(previous_size);
    stream.seekg(static_cast<std::streamoff>(offset));
    stream.read(reinterpret_cast<char*>(previous.data()),
                static_cast<std::streamsize>(previous.size()));
    if (!stream || !std::equal(previous.begin(), previous.end(), bytes.begin()))
      return Error{ErrorCode::kConflict, "file_chunk_conflict"};
  }
  if (previous_size < bytes.size()) {
    stream.seekp(static_cast<std::streamoff>(received));
    stream.write(reinterpret_cast<const char*>(bytes.data() + previous_size),
                 static_cast<std::streamsize>(bytes.size() - previous_size));
    stream.close();
    if (!stream)
      return Error{ErrorCode::kUnavailable, "file_write_failed"};
  }
  draft.expires = Now() + kDraftLifetime;
  return std::max(received, offset + bytes.size());
}
Result<FileLibrary::Asset> FileLibrary::Publish(const fs::path& source,
                                                Asset asset,
                                                const Check& check,
                                                const std::string& derived_from,
                                                const std::string& derivative) {
  RK_RETURN_IF_ERROR(Verify(source, asset.size));
  RK_ASSIGN_OR_RETURN(info, access_->Write(source, check, derived_from));
  asset.id = info.id;
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  Entry entry{asset};
  RK_RETURN_IF_ERROR(store_.Seal(asset.id, asset.Json(), {}, Json(), derivative));
  entries_.insert_or_assign(asset.id, std::move(entry));
  return asset;
}
Result<FileLibrary::Asset> FileLibrary::Seal(std::uint64_t grant,
                                             const std::string& id,
                                             const Check& check) {
  Draft draft;
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(check());
    RK_ASSIGN_OR_RETURN(current, RequireDraft(grant, id));
    draft = *current;
    if (!draft.sealed.empty()) {
      RK_ASSIGN_OR_RETURN(entry, RequireAsset(draft.sealed));
      return entry->asset;
    }
  }
  RK_RETURN_IF_ERROR(FlushFile(DraftData(id)));
  RK_RETURN_IF_ERROR(Verify(DraftData(id), draft.spec.size));
  RK_ASSIGN_OR_RETURN(info, access_->Write(DraftData(id), check));
  Asset asset{info.id, draft.spec.type, draft.spec.size};
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  draft.sealed = asset.id;
  draft.expires = Now() + kDraftLifetime;
  RK_RETURN_IF_ERROR(store_.Seal(asset.id, asset.Json(), id,
                                 {{"operation", draft.operation},
                                  {"name", draft.spec.name},
                                  {"type", draft.spec.type},
                                  {"size", draft.spec.size},
                                  {"expires", draft.expires},
                                  {"sealed", draft.sealed}}));
  entries_.insert_or_assign(asset.id, Entry{asset});
  drafts_.at(id) = std::move(draft);
  draft_bytes_ -= asset.size;
  Remove(DraftData(id));
  return asset;
}
Result<FileLibrary::Asset> FileLibrary::ImportDownload(const fs::path& profile,
                                                       const ServiceJson& download) {
  const auto reference = download.at("fileReference").get<std::string>();
  const auto size_text = download.at("size").get<std::string>();
  uint64_t size = 0;
  const auto parsed = std::from_chars(size_text.data(), size_text.data() + size_text.size(), size);
  if (parsed.ec != std::errc() || parsed.ptr != size_text.data() + size_text.size())
    return Error{ErrorCode::kInvalidRequest, "invalid_download_size"};
  if (size > kFileBytes)
    return Error{ErrorCode::kLimitExceeded, "file_too_large", ErrorReason::kFileTooLarge};
  const FileUploadStore::Spec spec{download.at("name").get<std::string>(),
                                   download.at("mimeType").get<std::string>(), size};
  if (!ValidSpec(spec) || reference.empty() || reference.find('\\') != std::string::npos ||
      reference.find(':') != std::string::npos || reference.find('\0') != std::string::npos)
    return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
  const auto relative = fs::u8path(reference);
  if (relative.is_absolute() || relative.has_root_path() || *relative.begin() != L"downloads")
    return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
  for (const auto& component : relative)
    if (component.empty() || component == L"." || component == L".." ||
        component.native().back() == L'.' || component.native().back() == L' ')
      return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
  if (std::distance(relative.begin(), relative.end()) < 2)
    return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};

  // Denying writes and renames keeps every checked component fixed while the
  // object store reads the file. OPEN_REPARSE_POINT checks the link itself.
  struct Handles {
    std::vector<HANDLE> values;
    ~Handles() {
      for (const auto handle : values)
        CloseHandle(handle);
    }
  } handles;
  auto path = profile;
  std::vector<fs::path> paths{profile.parent_path().parent_path(), profile.parent_path(), profile};
  for (const auto& component : relative) {
    path /= component;
    paths.push_back(path);
  }
  for (size_t index = 0; index < paths.size(); ++index) {
    const bool directory = index + 1 < paths.size();
    const auto handle = CreateFileW(
        paths[index].c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      const auto error = GetLastError();
      return Error{error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
                       ? ErrorCode::kNotFound
                       : ErrorCode::kUnavailable,
                   "download_open_failed",
                   {},
                   {},
                   OsError{OsError::Kind::kWin32, error}};
    }
    handles.values.push_back(handle);
    BY_HANDLE_FILE_INFORMATION info{};
    if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, &info))
      return Error{ErrorCode::kUnavailable, "download_stat_failed"};
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory)
      return Error{ErrorCode::kInvalidRequest, "invalid_download_path"};
    if (!directory) {
      const auto actual = (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
      if (actual > kFileBytes)
        return Error{ErrorCode::kLimitExceeded, "file_too_large", ErrorReason::kFileTooLarge};
      if (actual != size)
        return Error{ErrorCode::kInternal, "download_size_mismatch"};
    }
  }
  return Publish(path, {{}, spec.type, size}, []() -> Result<void> { return {}; });
}
Result<void> FileLibrary::EraseDraft(std::map<std::string, Draft>::iterator draft) {
  RK_RETURN_IF_ERROR(store_.Erase(LibraryTable::kDrafts, draft->first));
  const auto id = draft->first;
  cleanup_grants_[id] = draft->second.grant;
  retiring_drafts_[id] = draft->second.sealed.empty() ? draft->second.spec.size : 0;
  drafts_.erase(draft);
  return RetireDraft(id);
}
Result<void> FileLibrary::RetireDraft(const std::string& id) {
  const auto found = retiring_drafts_.find(id);
  if (found == retiring_drafts_.end())
    return {};
  auto& retry = cleanup_retries_.try_emplace(id, "files.draft_cleanup").first->second;
  retry.Input("retiring:" + id + ":" + std::to_string(cleanup_grants_[id]));
  if (!retry.Ready())
    return *retry.Failure();
  auto removed = remove_file_(DraftData(id));
  if (!removed) {
    retry.Fail(removed.error());
    return removed.error();
  }
  retry.Success();
  draft_bytes_ -= found->second;
  retiring_drafts_.erase(found);
  cleanup_grants_.erase(id);
  return {};
}
Result<void> FileLibrary::Cancel(std::uint64_t grant, const std::string& id, const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  const auto found = drafts_.find(id);
  if (found != drafts_.end())
    RK_RETURN_IF_ERROR(RequireDraft(grant, id));
  if (found != drafts_.end() && found->second.sealed.empty())
    return EraseDraft(found);
  if (retiring_drafts_.contains(id))
    cleanup_grants_[id] = grant;
  return RetireDraft(id);
}
Result<FileLibrary::Asset> FileLibrary::Describe(const std::string& id) const {
  std::lock_guard lock(mutex_);
  RK_ASSIGN_OR_RETURN(entry, RequireAsset(id));
  return entry->asset;
}
Result<std::vector<FileUploadStore::Source>> FileLibrary::SelectionSources(
    const Selection& selection,
    const Check& check) {
  RK_RETURN_IF_ERROR(check());
  std::vector<FileUploadStore::Source> sources;
  for (const auto& file : selection.files) {
    RK_ASSIGN_OR_RETURN(asset, Describe(file.asset_id));
    std::string name = file.name;
    std::string type = file.type;
    if (type == "image/webp") {
      const auto format = SelectionWebpTranscode(selection.accept);
      if (format) {
#ifdef RK_FILE_PHOTO
        RK_ASSIGN_OR_RETURN(original, Path(file.asset_id));
        const auto cancelled = [&] { return !check(); };
        RK_ASSIGN_OR_RETURN(
            transcoded, CachedDerivative(
                            file.asset_id,
                            *format == PhotoTranscode::kJpeg ? FileLibrary::DerivativeFormat::jpeg
                                                             : FileLibrary::DerivativeFormat::png,
                            [&](const fs::path& output) -> Result<FileLibrary::Derivative> {
                              RK_ASSIGN_OR_RETURN(
                                  dimensions, TranscodePhoto(original, output, *format, cancelled));
                              return FileLibrary::Derivative{dimensions.width, dimensions.height};
                            },
                            check));
        asset = std::move(transcoded);
        type = *format == PhotoTranscode::kJpeg ? "image/jpeg" : "image/png";
        auto filename = fs::u8path(name);
        filename.replace_extension(*format == PhotoTranscode::kJpeg ? ".jpg" : ".png");
        const auto encoded_name = filename.u8string();
        name.assign(encoded_name.begin(), encoded_name.end());
#else
        return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
#endif
      }
    }
    RK_ASSIGN_OR_RETURN(path, Path(asset.id));
    sources.push_back({{name, type, asset.size}, path});
  }
  RK_RETURN_IF_ERROR(CheckSelectionSources(sources, selection.limits));
  return sources;
}
Result<ServiceJson> FileLibrary::OpenDocument(const std::string& asset,
                                              const std::string& type,
                                              const Check& check) {
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(objects_.Documents().Available());
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(RequireAsset(asset));
  }
  RK_ASSIGN_OR_RETURN(result, objects_.Documents().Open(asset, tenant_, root_ / "documents", type));
  RK_RETURN_IF_ERROR(check());
  if (result["state"] == "ready") {
    std::lock_guard lock(mutex_);
    documents_.insert(result["documentId"].get<std::string>());
  }
  return result;
}
Result<ServiceJson> FileLibrary::DocumentResource(const std::string& document,
                                                  const std::string& content,
                                                  uint64_t offset,
                                                  const Check& check) {
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(objects_.Documents().Available());
  {
    std::lock_guard lock(mutex_);
    if (!documents_.contains(document))
      return Error{ErrorCode::kForbidden, "document not opened by session"};
  }
  RK_ASSIGN_OR_RETURN(resource, objects_.Documents().Resource(document, content, offset));
  RK_RETURN_IF_ERROR(check());
  return ServiceJson{{"data", EncodeFileChunk(resource.bytes)},
                     {"offset", offset + resource.bytes.size()},
                     {"total", resource.total},
                     {"mime", resource.mime}};
}
Result<fs::path> FileLibrary::Path(const std::string& id) const {
  std::lock_guard lock(mutex_);
  RK_ASSIGN_OR_RETURN(entry, RequireAsset(id));
  const auto path = root_ / "staging" / id;
  std::error_code error;
  if (fs::exists(path, error))
    return path;
  uint64_t used = 0;
  for (const auto& staged : fs::directory_iterator(root_ / "staging"))
    used += staged.file_size();
  if (entry->asset.size > kStagingBytes - std::min(used, kStagingBytes))
    return Error{ErrorCode::kLimitExceeded, "asset_staging_quota",
                 ErrorReason::kStorageQuotaExceeded};
  auto partial = path;
  partial += ".new";
  std::ofstream output(partial, std::ios::binary | std::ios::trunc);
  auto read = objects_.Store().Read(objects_.ObjectKeys(), id, output);
  output.close();
  if (!read || !output) {
    Remove(partial);
    return read ? Error{ErrorCode::kUnavailable, "asset_staging_failed"} : read.error();
  }
  if (!MoveFileExW(partial.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return Error{ErrorCode::kUnavailable, "asset_staging_failed"};
  return path;
}
Result<std::pair<FileLibrary::Asset, std::vector<std::uint8_t>>> FileLibrary::Read(
    const std::string& id,
    std::uint64_t offset) const {
  RK_ASSIGN_OR_RETURN(asset, Describe(id));
  RK_ASSIGN_OR_RETURN(bytes, objects_.Store().ReadRange(objects_.ObjectKeys(), id, offset, kChunk));
  return std::pair{asset, std::move(bytes)};
}
Result<FileLibrary::Asset> FileLibrary::CreateDerivative(const Render& render,
                                                         const Check& check,
                                                         DerivativeFormat format,
                                                         const std::string& derived_from,
                                                         const std::string& derivative) {
  const bool jpeg = format == DerivativeFormat::jpeg;
  const auto budget = jpeg ? kJpegDerivativeBytes : kPngDerivativeBytes;
  const char* extension = jpeg ? ".jpg" : format == DerivativeFormat::png ? ".png" : ".webp";
  const char* type = jpeg                              ? "image/jpeg"
                     : format == DerivativeFormat::png ? "image/png"
                                                       : "image/webp";
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(check());
  }
  RK_ASSIGN_OR_RETURN(random, RandomId());
  const auto path = DraftData(random + extension);
  struct Cleanup {
    fs::path path;
    ~Cleanup() { Remove(path); }
  } cleanup{path};
  {
    RK_ASSIGN_OR_RETURN(dimensions, render(path));
    if (!Plain(path))
      return Error{ErrorCode::kUnavailable, "photo_output_failed"};
    RK_ASSIGN_OR_RETURN(size, FileSize(path));
    if (size > budget)
      return Error{ErrorCode::kLimitExceeded, "photo_output_too_large", ErrorReason::kFileTooLarge};
    RK_RETURN_IF_ERROR(FlushFile(path));
    auto result = Publish(path, {{}, type, size, dimensions.width, dimensions.height}, check,
                          derived_from, derivative);
    Remove(path);
    return result;
  }
}
Result<FileLibrary::Asset> FileLibrary::CachedDerivative(const std::string& source,
                                                         DerivativeFormat format,
                                                         const Render& render,
                                                         const Check& check) {
  std::lock_guard lock(derivatives_mutex_);
  RK_RETURN_IF_ERROR(check());
  RK_ASSIGN_OR_RETURN(original, Describe(source));
  const auto key = original.id + (format == DerivativeFormat::jpeg  ? "-jpeg"
                                  : format == DerivativeFormat::png ? "-png"
                                                                    : "-webp");
  RK_ASSIGN_OR_RETURN(records, store_.Load(LibraryTable::kDerivatives));
  if (const auto found = records.find(key); found != records.end()) {
    RK_RETURN_IF_ERROR(library_records::Validate(LibraryTable::kDerivatives, key, found->second));
    return Describe(found->second.at("assetId").get<std::string>());
  }
  RK_ASSIGN_OR_RETURN(asset, CreateDerivative(render, check, format, source, key));
  return asset;
}
ServiceJson FileLibrary::CleanupFailures() const {
  std::lock_guard lock(mutex_);
  ServiceJson errors = ServiceJson::object();
  for (const auto& [id, retry] : cleanup_retries_)
    if (retry.Failure())
      errors[id] = WireError(*retry.Failure());
  return errors;
}
Result<void> FileLibrary::Sweep() {
  std::lock_guard lock(mutex_);
  const auto now = Now();
  if (now < sweep_after_)
    return {};
  sweep_after_ = now + 10;
  std::optional<Error> failure;
  for (auto it = drafts_.begin(); it != drafts_.end();) {
    const auto current = it++;
    if (current->second.expires <= now) {
      auto& retry =
          cleanup_retries_.try_emplace(current->first, "files.draft_cleanup").first->second;
      retry.Input("retiring:" + current->first + ":" + std::to_string(current->second.grant));
      if (!retry.Ready())
        continue;
      const auto before = retry.Attempt();
      auto erased = EraseDraft(current);
      if (!erased) {
        if (retry.Attempt() == before)
          retry.Fail(erased.error());
        failure = erased.error();
      }
    }
  }
  for (auto it = retiring_drafts_.begin(); it != retiring_drafts_.end();) {
    const auto id = (it++)->first;
    auto retired = RetireDraft(id);
    if (!retired)
      failure = retired.error();
  }
  for (const auto& entry : fs::directory_iterator(root_ / "staging")) {
    if (fs::file_time_type::clock::now() - entry.last_write_time() > std::chrono::minutes(10)) {
      auto retired = RetireStaging(entry);
      if (!retired)
        failure = retired.error();
    }
  }

  return failure ? Result<void>{*failure} : Result<void>{};
}
Result<void> FileLibrary::RetireStaging(const fs::directory_entry& entry) {
  const auto name = entry.path().string();
  auto& retry = cleanup_retries_.try_emplace(name, "files.staging_cleanup").first->second;
  retry.Input(name + ":" + std::to_string(entry.last_write_time().time_since_epoch().count()));
  if (!retry.Ready())
    return *retry.Failure();
  auto removed = remove_file_(entry.path());
  if (!removed) {
    retry.Fail(removed.error());
    return removed.error();
  }
  retry.Success();
  return {};
}
Result<void> FileLibrary::Prepare(const Selection& selection) {
  if (!HexId(selection.id, 32) || !BoundedServiceId(selection.request_id) ||
      selection.request_id == "library" || selection.files.empty() || selection.files.size() > 64 ||
      selection.files.size() > selection.limits.files || !selection.limits.file_bytes ||
      !selection.limits.batch_bytes)
    return Error{ErrorCode::kInvalidRequest, "invalid_selection_manifest"};
  std::lock_guard lock(mutex_);
  const auto found = selections_.find(selection.id);
  if (found != selections_.end()) {
    if (found->second.binding != selection.binding || found->second.files != selection.files ||
        found->second.request_id != selection.request_id ||
        found->second.accept != selection.accept ||
        found->second.limits.file_bytes != selection.limits.file_bytes ||
        found->second.limits.batch_bytes != selection.limits.batch_bytes ||
        found->second.limits.files != selection.limits.files)
      return Error{ErrorCode::kConflict, "selection_manifest_conflict"};
    return {};
  }
  if (selections_.size() >= kSelections)
    return Error{ErrorCode::kLimitExceeded, "selection_receipt_quota",
                 ErrorReason::kStorageQuotaExceeded};
  std::uint64_t bytes = 0;
  for (const auto& file : selection.files) {
    RK_ASSIGN_OR_RETURN(asset_entry, RequireAsset(file.asset_id));
    const auto& entry = *asset_entry;
    if (!ValidSpec({file.name, file.type, entry.asset.size}) ||
        entry.asset.size > 2 * kFileBytes - bytes)
      return Error{ErrorCode::kInvalidRequest, "invalid_selection_file"};
    bytes += entry.asset.size;
  }
  RK_RETURN_IF_ERROR(SaveSelection(selection));
  selections_.emplace(selection.id, selection);

  return {};
}
std::optional<FileLibrary::Selection> FileLibrary::FindSelection(const std::string& id) const {
  std::lock_guard lock(mutex_);
  const auto found = selections_.find(id);
  if (found == selections_.end())
    return std::nullopt;
  return found->second;
}
Result<bool> FileLibrary::Claim(const std::string& id, const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  auto& selection = selections_.at(id);
  if (selection.state != State::pending)
    return false;
  for (const auto& [other_id, other] : selections_) {
    if (id != other_id && other.binding == selection.binding && other.state != State::pending)
      return Error{ErrorCode::kConflict, "file_selection_already_submitted"};
  }
  auto submitted = selection;
  submitted.state = State::dispatching;
  RK_RETURN_IF_ERROR(SaveSelection(submitted, check));
  selection.state = State::dispatching;
  return true;
}
Result<void> FileLibrary::ReleaseClaim(const std::string& id) {
  std::lock_guard lock(mutex_);
  auto& selection = selections_.at(id);
  if (selection.state != State::dispatching)
    return Error{ErrorCode::kConflict, "selection dispatch state changed"};
  auto prepared = selection;
  prepared.state = State::pending;
  RK_RETURN_IF_ERROR(SaveSelection(prepared));
  selection = std::move(prepared);
  return {};
}
Result<void> FileLibrary::Unknown(const std::string& id) {
  std::lock_guard lock(mutex_);
  auto& selection = selections_.at(id);
  if (selection.state != State::dispatching && selection.state != State::unknown)
    return Error{ErrorCode::kConflict, "selection is not dispatching"};
  auto unknown = selection;
  unknown.state = State::unknown;
  RK_RETURN_IF_ERROR(SaveSelection(unknown));
  selection = std::move(unknown);
  return {};
}
Result<std::optional<State>> FileLibrary::CancelPendingSelections(
    const FileUploadStore::Binding& binding,
    const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  std::optional<State> result;
  for (const auto& [id, selection] : selections_) {
    if (selection.binding != binding)
      continue;
    if (selection.state == State::dispatching || selection.state == State::unknown ||
        selection.state == State::selected)
      return std::optional<State>{selection.state};
  }
  std::map<std::string, Json> cancelled;
  RK_ASSIGN_OR_RETURN(records, store_.Load(LibraryTable::kSelections));
  for (const auto& [id, selection] : selections_) {
    if (selection.binding != binding)
      continue;
    if (selection.state == State::pending) {
      auto document = records.at(id);
      document["state"] = "cancelled";
      cancelled.emplace(id, std::move(document));
      result = State::cancelled;
    } else
      result = selection.state;
  }
  RK_RETURN_IF_ERROR(store_.Selections(cancelled));
  for (const auto& [id, document] : cancelled)
    selections_.at(id).state = State::cancelled;
  return result;
}
Result<State> FileLibrary::Finish(const std::string& id,
                                  State state,
                                  std::optional<State> expected) {
  std::lock_guard lock(mutex_);
  auto& selection = selections_.at(id);
  if (selection.state == state || selection.state == State::selected ||
      selection.state == State::cancelled || (expected && selection.state != *expected))
    return selection.state;
  if (state != State::cancelled &&
      !(state == State::selected &&
        (selection.state == State::dispatching || selection.state == State::unknown)))
    return Error{ErrorCode::kInvalidRequest, "invalid_selection_state"};
  auto terminal = selection;
  terminal.state = state;
  RK_RETURN_IF_ERROR(SaveSelection(terminal));
  selection.state = state;
  return state;
}
}  // namespace remotekit
