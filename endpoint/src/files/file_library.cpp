#include "files/file_library.hpp"
#include "documents/object_documents.hpp"
#include "files/dc_file_services.hpp"
#include "persistence/session_store.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <fstream>
#include <limits>
#include <span>
#include "util/result_macros.hpp"
#include "util/file_io.hpp"

namespace remotekit {
ServiceJson FileLibrary::Hibernation(const std::function<bool(uint64_t)>& current) const {
  std::lock_guard lock(mutex_);
  const auto selections =
      std::count_if(selections_.begin(), selections_.end(), [](const auto& item) {
        return item.second.state == Selection::State::pending ||
               item.second.state == Selection::State::submitted;
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
constexpr std::uint64_t kMiB = 1024 * 1024;
constexpr std::uint64_t kFileBytes = 256 * kMiB;
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
bool HexId(const std::string& id, std::size_t size) {
  return id.size() == size && std::all_of(id.begin(), id.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
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
Result<void> Save(const fs::path& path, const Json& value, const FileLibrary::Check& check = {}) {
  auto saved = WriteDurableJson(path, value, check);
  if (!saved)
    return saved.error();

  return {};
}

template <class Visit>
Result<void> Records(const fs::path& directory, std::size_t maximum, Visit visit) {
  std::size_t count = 0;
  RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(directory));
  for (const auto& entry : entries) {
    if (++count > maximum * 2 + 1)
      return Error{ErrorCode::kLimitExceeded, "file_metadata_limit"};
    if (!Plain(entry.path()))
      return Error{ErrorCode::kInvalidRequest, "invalid_file_metadata"};
    if (entry.path().extension() == L".new") {
      Remove(entry.path());
      continue;
    }
    RK_ASSIGN_OR_RETURN(size, FileSize(entry.path()));
    if (entry.path().extension() != L".json" || size > 256 * 1024)
      return Error{ErrorCode::kInvalidRequest, "invalid_file_metadata"};
    std::ifstream input(entry.path(), std::ios::binary);
    RK_RETURN_IF_ERROR(visit(entry.path().stem().string(), Json::parse(input)));
  }

  return {};
}
const char* StateName(State state) {
  switch (state) {
    case State::pending:
      return "pending";
    case State::submitted:
      return "submitted";
    case State::selected:
      return "selected";
    case State::cancelled:
      return "cancelled";
  }
  throw std::logic_error("invalid selection enum");
}
Result<State> ParseState(const std::string& state) {
  for (const auto value : {State::pending, State::submitted, State::selected, State::cancelled})
    if (state == StateName(value))
      return value;
  return Error{ErrorCode::kInvalidRequest, "invalid_selection_state"};
}
bool ValidSpec(const FileUploadStore::Spec& spec) {
  if (spec.name.empty() || spec.name == "." || spec.name == ".." || spec.name.size() > 1024 ||
      spec.type.size() > 255 || spec.size > kFileBytes)
    return false;
  for (const unsigned char c : spec.name)
    if (c < 32 || c == '/' || c == '\\' || c == ':')
      return false;
  for (const unsigned char c : spec.type)
    if (c < 32 || c >= 127)
      return false;
  return true;
}
}  // namespace

ServiceJson FileLibrary::Asset::Json() const {
  ServiceJson result = {{"assetId", id}, {"size", size}, {"type", type}};
  if (width && height) {
    result["width"] = width;
    result["height"] = height;
  }
  return result;
}

FileLibrary::FileLibrary(fs::path root,
                         objects::ObjectService& objects,
                         std::string tenant,
                         std::shared_ptr<objects::SessionObjects> access)
    : root_(std::move(root)),
      objects_(objects),
      tenant_(std::move(tenant)),
      access_(access ? std::move(access)
                     : std::make_shared<objects::SessionObjects>(objects, tenant_)) {}
Result<void> FileLibrary::Initialize() {
  std::error_code absolute_error;
  root_ = fs::absolute(root_, absolute_error).make_preferred();
  if (absolute_error)
    return Error{ErrorCode::kUnavailable, "library path unavailable"};
  const auto native = root_.native();
  if (!native.starts_with(LR"(\\?\)"))
    root_ = native.starts_with(LR"(\\)") ? fs::path(LR"(\\?\UNC\)" + native.substr(2))
                                         : fs::path(LR"(\\?\)" + native);
  for (const auto& directory : {root_, root_ / "metadata", root_ / "staging", root_ / "drafts",
                                root_ / "incoming", root_ / "selections", root_ / "derivatives"}) {
    RK_RETURN_IF_ERROR(CreateDirectories(directory));
    if (!Plain(directory, true))
      return Error{ErrorCode::kUnavailable, "unsafe_library_root"};
  }
  RK_RETURN_IF_ERROR(
      Records(root_ / "metadata", kAssets, [&](const auto& id, const Json& value) -> Result<void> {
        Asset asset{id, value.at("type").get<std::string>(), value.at("size").get<std::uint64_t>(),
                    value.value("width", 0u), value.value("height", 0u)};
        if (!HexId(id, 64) || !ValidSpec({"asset", asset.type, asset.size}) ||
            entries_.size() >= kAssets)
          return Error{ErrorCode::kInternal, "invalid_asset_record"};
        entries_.emplace(id, Entry{std::move(asset)});
        return {};
      }));
  RK_RETURN_IF_ERROR(
      Records(root_ / "drafts", kDrafts, [&](const auto& id, const Json& value) -> Result<void> {
        Draft draft{id,
                    value.at("operation").get<std::string>(),
                    value.at("sealed").get<std::string>(),
                    {value.at("name").get<std::string>(), value.at("type").get<std::string>(),
                     value.at("size").get<std::uint64_t>()},
                    value.at("expires").get<std::int64_t>()};
        if (!HexId(id, 32) || !BoundedServiceId(draft.operation) || !ValidSpec(draft.spec) ||
            drafts_.size() >= kDrafts)
          return Error{ErrorCode::kInternal, "invalid_asset_draft"};
        if (draft.sealed.empty()) {
          const auto path = DraftData(id);
          RK_ASSIGN_OR_RETURN(size, FileSize(path));
          if (!Plain(path) || size > draft.spec.size ||
              draft.spec.size > kDraftBytes - draft_bytes_)
            return Error{ErrorCode::kInternal, "invalid_asset_draft"};
          draft_bytes_ += draft.spec.size;
        } else if (!HexId(draft.sealed, 64)) {
          return Error{ErrorCode::kInternal, "invalid_asset_draft"};
        }
        drafts_.emplace(id, std::move(draft));
        return {};
      }));
  RK_RETURN_IF_ERROR(Records(
      root_ / "selections", kSelections, [&](const auto& id, const Json& value) -> Result<void> {
        const auto& binding = value.at("binding");
        RK_ASSIGN_OR_RETURN(state, ParseState(value.at("state").get<std::string>()));
        Selection selection{
            id,
            value.at("requestId").get<std::string>(),
            {binding.at("browserIncarnation").get<std::string>(),
             binding.at("view").get<std::string>(), binding.at("instance").get<std::string>(),
             binding.at("document").get<std::string>(), binding.at("request").get<std::string>()},
            {},
            state};
        selection.accept = value.at("accept").get<std::vector<std::string>>();
        const auto& limits = value.at("limits");
        selection.limits.file_bytes = limits.at("maxFileBytes").get<std::uint64_t>();
        selection.limits.batch_bytes = limits.at("maxBatchBytes").get<std::uint64_t>();
        selection.limits.files = limits.at("maxFiles").get<std::size_t>();
        const auto& files = value.at("files");
        if (!HexId(id, 32) || selections_.size() >= kSelections || !files.is_array() ||
            files.empty() || files.size() > 64)
          return Error{ErrorCode::kInternal, "invalid_selection_record"};
        for (const auto& file : files) {
          selection.files.push_back({file.at("assetId").get<std::string>(),
                                     file.at("name").get<std::string>(),
                                     file.at("type").get<std::string>()});
        }
        selections_.emplace(id, std::move(selection));
        return {};
      }));
  const auto clean = [&](const fs::path& directory, std::size_t maximum,
                         auto keep) -> Result<void> {
    std::size_t count = 0;
    RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(directory));
    for (const auto& entry : entries) {
      if (++count > maximum || !Plain(entry.path()))
        return Error{ErrorCode::kInternal, "invalid_library_payload"};
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
fs::path FileLibrary::DraftData(const std::string& id) const {
  return root_ / "incoming" / id;
}
Result<const FileLibrary::Entry*> FileLibrary::RequireAsset(const std::string& id) const {
  auto found = entries_.find(id);
  RK_ASSIGN_OR_RETURN(info, access_->Ensure(id));
  if (found == entries_.end()) {
    if (info.size > kFileBytes)
      return Error{ErrorCode::kLimitExceeded, "asset_too_large", ErrorReason::kFileTooLarge};
    Entry entry{Asset{id, "application/octet-stream", info.size}};
    RK_RETURN_IF_ERROR(SaveEntry(entry));
    found = entries_.emplace(id, std::move(entry)).first;
  }
  if (found->second.asset.size != info.size)
    return Error{ErrorCode::kInternal, "invalid_asset_size"};
  return &found->second;
}
Result<FileLibrary::Draft*> FileLibrary::RequireDraft(std::uint64_t grant, const std::string& id) {
  const auto found = drafts_.find(id);
  if (!grant || found == drafts_.end() || found->second.grant != grant)
    return Error{ErrorCode::kNotFound, "unknown_asset_upload"};
  return &found->second;
}
Result<void> FileLibrary::SaveDraft(const Draft& draft, const Check& check) const {
  RK_RETURN_IF_ERROR(Save(root_ / "drafts" / (draft.id + ".json"),
                          {{"operation", draft.operation},
                           {"name", draft.spec.name},
                           {"type", draft.spec.type},
                           {"size", draft.spec.size},
                           {"expires", draft.expires},
                           {"sealed", draft.sealed}},
                          check));

  return {};
}
Result<void> FileLibrary::SaveEntry(const Entry& entry, const Check& check) const {
  auto value = entry.asset.Json();
  RK_RETURN_IF_ERROR(Save(root_ / "metadata" / (entry.asset.id + ".json"), value, check));

  return {};
}
Result<void> FileLibrary::SaveSelection(const Selection& selection, const Check& check) const {
  const auto& binding = selection.binding;
  Json files = Json::array();
  for (const auto& file : selection.files)
    files.push_back({{"assetId", file.asset_id}, {"name", file.name}, {"type", file.type}});
  RK_RETURN_IF_ERROR(Save(root_ / "selections" / (selection.id + ".json"),
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
                           {"state", StateName(selection.state)}},
                          check));

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
  if (drafts_.size() >= kDrafts || static_cast<std::size_t>(active) >= kActiveDrafts ||
      spec.size > kDraftBytes - draft_bytes_)
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
                                                const std::string& derived_from) {
  RK_RETURN_IF_ERROR(Verify(source, asset.size));
  RK_ASSIGN_OR_RETURN(info, access_->Write(source, check, derived_from));
  asset.id = info.id;
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  Entry entry{asset};
  RK_RETURN_IF_ERROR(SaveEntry(entry, check));
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
  RK_ASSIGN_OR_RETURN(asset, Publish(DraftData(id), {{}, draft.spec.type, draft.spec.size}, check));
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  draft.sealed = asset.id;
  draft.expires = Now() + kDraftLifetime;
  RK_RETURN_IF_ERROR(SaveDraft(draft, check));
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
                   "download_open_failed"};
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
bool FileLibrary::EraseDraft(std::map<std::string, Draft>::iterator draft) {
  if (!Remove(root_ / "drafts" / (draft->first + ".json")) || !Remove(DraftData(draft->first)))
    return false;
  if (draft->second.sealed.empty())
    draft_bytes_ -= draft->second.spec.size;
  drafts_.erase(draft);
  return true;
}
Result<void> FileLibrary::Cancel(std::uint64_t grant, const std::string& id, const Check& check) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  const auto found = drafts_.find(id);
  if (found != drafts_.end())
    RK_RETURN_IF_ERROR(RequireDraft(grant, id));
  if (found != drafts_.end() && found->second.sealed.empty() && !EraseDraft(found))
    return Error{ErrorCode::kUnavailable, "asset_cleanup_failed"};

  return {};
}
Result<FileLibrary::Asset> FileLibrary::Describe(const std::string& id) const {
  std::lock_guard lock(mutex_);
  RK_ASSIGN_OR_RETURN(entry, RequireAsset(id));
  return entry->asset;
}
Result<ServiceJson> FileLibrary::OpenDocument(const std::string& asset, const Check& check) {
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(objects_.Documents().Available());
  std::string media_type;
  {
    std::lock_guard lock(mutex_);
    RK_ASSIGN_OR_RETURN(entry, RequireAsset(asset));
    media_type = entry->asset.type;
  }
  RK_ASSIGN_OR_RETURN(result,
                      objects_.Documents().Open(asset, tenant_, root_ / "documents", media_type));
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
                                                         const std::string& derived_from) {
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
    auto result =
        Publish(path, {{}, type, size, dimensions.width, dimensions.height}, check, derived_from);
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
  const auto path = root_ / "derivatives" /
                    (original.id + (format == DerivativeFormat::jpeg  ? "-jpeg.json"
                                    : format == DerivativeFormat::png ? "-png.json"
                                                                      : "-webp.json"));
  RK_ASSIGN_OR_RETURN(exists, FileExists(path));
  if (exists) {
    std::ifstream input(path, std::ios::binary);
    const auto record = Json::parse(input, nullptr, false);
    if (record.is_discarded() || !record.contains("assetId") || !record["assetId"].is_string())
      return Error{ErrorCode::kInternal, "invalid_derivative_record"};
    return Describe(record["assetId"].get<std::string>());
  }
  RK_ASSIGN_OR_RETURN(asset, CreateDerivative(render, check, format, source));
  RK_RETURN_IF_ERROR(Save(path, {{"assetId", asset.id}}, check));
  return asset;
}
Result<void> FileLibrary::Sweep() {
  std::lock_guard lock(mutex_);
  const auto now = Now();
  if (now < sweep_after_)
    return {};
  sweep_after_ = now + 10;
  for (auto it = drafts_.begin(); it != drafts_.end();) {
    const auto current = it++;
    if (current->second.expires <= now)
      EraseDraft(current);
  }
  for (const auto& entry : fs::directory_iterator(root_ / "staging")) {
    if (fs::file_time_type::clock::now() - entry.last_write_time() > std::chrono::minutes(10))
      Remove(entry.path());
  }

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
  submitted.state = State::submitted;
  RK_RETURN_IF_ERROR(SaveSelection(submitted, check));
  selection.state = State::submitted;
  return true;
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
    if (selection.state == State::submitted || selection.state == State::selected)
      return std::optional<State>{selection.state};
  }
  for (auto& [id, selection] : selections_) {
    if (selection.binding != binding)
      continue;
    if (selection.state == State::pending) {
      auto cancelled = selection;
      cancelled.state = State::cancelled;
      RK_RETURN_IF_ERROR(SaveSelection(cancelled, check));
      selection.state = State::cancelled;
    }
    result = selection.state;
  }
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
      !(state == State::selected && selection.state == State::submitted))
    return Error{ErrorCode::kInvalidRequest, "invalid_selection_state"};
  auto terminal = selection;
  terminal.state = state;
  RK_RETURN_IF_ERROR(SaveSelection(terminal));
  selection.state = state;
  return state;
}
}  // namespace remotekit
