#include "remotekit/file_library.hpp"
#include "persistence/session_store.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>
#include <limits>
#include <span>
#include "remotekit/result_macros.hpp"
#include "remotekit/file_io.hpp"

namespace remotekit {
namespace {
namespace fs = std::filesystem;
using Json = ServiceJson;
using State = FileLibrary::Selection::State;
constexpr std::uint64_t kMiB = 1024 * 1024;
constexpr std::uint64_t kFileBytes = 256 * kMiB;
constexpr std::uint64_t kLibraryBytes = 1024 * kMiB;
constexpr std::uint64_t kDraftBytes = 512 * kMiB;
constexpr std::uint64_t kJpegDerivativeBytes = 24 * kMiB;
constexpr std::uint64_t kPngDerivativeBytes = 64 * kMiB;
constexpr std::size_t kAssets = 8192;
constexpr std::size_t kDrafts = 1024;
constexpr std::size_t kActiveDrafts = 32;
constexpr std::size_t kSelections = 65536;
constexpr std::int64_t kDraftLifetime = 30 * 60;
constexpr std::int64_t kAssetLifetime = 2 * 60 * 60;
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
struct Sha256 {
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_HASH_HANDLE hash{};
  Result<void> Open() {
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
      return Error{ErrorCode::kUnavailable, "file_hash_failed"};
    if (BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) < 0) {
      return Error{ErrorCode::kUnavailable, "file_hash_failed"};
    }
    return {};
  }
  ~Sha256() {
    if (hash)
      BCryptDestroyHash(hash);
    if (algorithm)
      BCryptCloseAlgorithmProvider(algorithm, 0);
  }
};
Result<std::string> Digest(const fs::path& file, const FileLibrary::Check& check) {
  Sha256 digest;
  RK_RETURN_IF_ERROR(digest.Open());
  std::ifstream input(file, std::ios::binary);
  std::array<unsigned char, 64 * 1024> buffer{};
  for (;;) {
    RK_RETURN_IF_ERROR(check());
    input.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
    const auto count = input.gcount();
    if (count && BCryptHashData(digest.hash, buffer.data(), static_cast<ULONG>(count), 0) < 0)
      return Error{ErrorCode::kUnavailable, "file_hash_failed"};
    if (input.eof())
      break;
    if (!input)
      return Error{ErrorCode::kUnavailable, "file_read_failed"};
  }
  std::array<unsigned char, 32> bytes{};
  if (BCryptFinishHash(digest.hash, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0)
    return Error{ErrorCode::kUnavailable, "file_hash_failed"};
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
Result<void> FlushPayload(const fs::path& path) {
  auto flushed = FlushFile(path);
  if (!flushed)
    return flushed.error();

  return {};
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
  ServiceJson result = {{"assetId", id}, {"hash", id}, {"size", size}, {"type", type}};
  if (width && height) {
    result["width"] = width;
    result["height"] = height;
  }
  return result;
}

FileLibrary::FileLibrary(fs::path root) : root_(std::move(root)) {}
Result<void> FileLibrary::Initialize() {
  std::error_code absolute_error;
  root_ = fs::absolute(root_, absolute_error).make_preferred();
  if (absolute_error)
    return Error{ErrorCode::kUnavailable, "library path unavailable"};
  const auto native = root_.native();
  if (!native.starts_with(LR"(\\?\)"))
    root_ = native.starts_with(LR"(\\)") ? fs::path(LR"(\\?\UNC\)" + native.substr(2))
                                         : fs::path(LR"(\\?\)" + native);
  for (const auto& directory : {root_, root_ / "assets", root_ / "payload", root_ / "drafts",
                                root_ / "incoming", root_ / "selections"}) {
    RK_RETURN_IF_ERROR(CreateDirectories(directory));
    if (!Plain(directory, true))
      return Error{ErrorCode::kUnavailable, "unsafe_library_root"};
  }
  const auto reference_file = root_ / "references.json";
  std::error_code reference_error;
  const bool has_references = fs::exists(reference_file, reference_error);
  if (reference_error)
    return Error{ErrorCode::kUnavailable, "cannot inspect library references"};
  if (has_references) {
    RK_ASSIGN_OR_RETURN(size, FileSize(reference_file));
    if (!Plain(reference_file) || size > 1024 * 1024)
      return Error{ErrorCode::kInvalidRequest, "invalid_library_references"};
    std::ifstream input(reference_file, std::ios::binary);
    const auto record = Json::parse(input);
    reference_revision_ = record.at("revision").get<std::uint64_t>();
    const auto& ids = record.at("assetIds");
    if (!ids.is_array() || ids.size() > kAssets)
      return Error{ErrorCode::kInvalidRequest, "invalid_library_references"};
    for (const auto& id : ids) {
      auto asset_id = id.get<std::string>();
      if (!HexId(asset_id, 64) || !references_.insert(std::move(asset_id)).second)
        return Error{ErrorCode::kInvalidRequest, "invalid_library_references"};
    }
  }
  RK_RETURN_IF_ERROR(
      Records(root_ / "assets", kAssets, [&](const auto& id, const Json& value) -> Result<void> {
        Asset asset{id, value.at("type").get<std::string>(), value.at("size").get<std::uint64_t>(),
                    value.value("width", 0u), value.value("height", 0u)};
        if (!HexId(id, 64) || !ValidSpec({"asset", asset.type, asset.size}) ||
            asset.size > kLibraryBytes - asset_bytes_ || entries_.size() >= kAssets)
          return Error{ErrorCode::kInvalidRequest, "invalid_asset_record"};
        RK_RETURN_IF_ERROR(Verify(Payload(id), asset.size));
        asset_bytes_ += asset.size;
        entries_.emplace(id, Entry{std::move(asset), value.at("expires").get<std::int64_t>()});
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
          return Error{ErrorCode::kInvalidRequest, "invalid_asset_draft"};
        if (draft.sealed.empty()) {
          const auto path = DraftData(id);
          RK_ASSIGN_OR_RETURN(size, FileSize(path));
          if (!Plain(path) || size > draft.spec.size ||
              draft.spec.size > kDraftBytes - draft_bytes_)
            return Error{ErrorCode::kInvalidRequest, "invalid_asset_draft"};
          draft_bytes_ += draft.spec.size;
        } else if (!HexId(draft.sealed, 64)) {
          return Error{ErrorCode::kInvalidRequest, "invalid_asset_draft"};
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
        const auto& files = value.at("files");
        if (!HexId(id, 32) || selections_.size() >= kSelections || !files.is_array() ||
            files.empty() || files.size() > 64)
          return Error{ErrorCode::kInvalidRequest, "invalid_selection_record"};
        for (const auto& file : files) {
          selection.files.push_back({file.at("assetId").get<std::string>(),
                                     file.at("name").get<std::string>(),
                                     file.at("type").get<std::string>()});
        }
        selections_.emplace(id, std::move(selection));
        return {};
      }));
  // Payloads without a committed record belong to interrupted publishes.
  // Likewise, a committed sealed draft has no need for its original link.
  const auto clean = [&](const fs::path& directory, std::size_t maximum,
                         auto keep) -> Result<void> {
    std::size_t count = 0;
    RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(directory));
    for (const auto& entry : entries) {
      if (++count > maximum || !Plain(entry.path()))
        return Error{ErrorCode::kInvalidRequest, "invalid_library_payload"};
      if (!keep(entry.path().filename().string()) && !Remove(entry.path()))
        return Error{ErrorCode::kUnavailable, "cannot_clean_library_payload"};
    }
    return {};
  };
  RK_RETURN_IF_ERROR(
      clean(root_ / "payload", kAssets + 1, [&](const auto& id) { return entries_.contains(id); }));
  clean(root_ / "incoming", kDrafts + 1, [&](const auto& id) {
    const auto found = drafts_.find(id);
    return found != drafts_.end() && found->second.sealed.empty();
  });
  RK_RETURN_IF_ERROR(Sweep());

  return {};
}
fs::path FileLibrary::Payload(const std::string& id) const {
  return root_ / "payload" / id;
}
fs::path FileLibrary::DraftData(const std::string& id) const {
  return root_ / "incoming" / id;
}
Result<const FileLibrary::Entry*> FileLibrary::RequireAsset(const std::string& id) const {
  const auto found = entries_.find(id);
  if (found == entries_.end())
    return Error{ErrorCode::kNotFound, "unknown_asset"};
  RK_RETURN_IF_ERROR(Verify(Payload(id), found->second.asset.size));
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
  value["expires"] = entry.expires;
  RK_RETURN_IF_ERROR(Save(root_ / "assets" / (entry.asset.id + ".json"), value, check));

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
      spec.size > kDraftBytes - draft_bytes_ ||
      asset_bytes_ + draft_bytes_ + spec.size > kLibraryBytes)
    return Error{ErrorCode::kLimitExceeded, "asset_draft_quota"};
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
                                                const Check& check) {
  RK_RETURN_IF_ERROR(Verify(source, asset.size));
  RK_ASSIGN_OR_RETURN(digest, Digest(source, check));
  asset.id = digest;
  RK_RETURN_IF_ERROR(FlushPayload(source));
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(check());
  const auto existing = entries_.find(asset.id);
  if (existing != entries_.end()) {
    RK_ASSIGN_OR_RETURN(entry, RequireAsset(asset.id));
    auto refreshed = *entry;
    if (refreshed.expires)
      refreshed.expires = Now() + kAssetLifetime;
    if (asset.width && !refreshed.asset.width) {
      refreshed.asset.width = asset.width;
      refreshed.asset.height = asset.height;
      refreshed.asset.type = asset.type;
    }
    RK_RETURN_IF_ERROR(SaveEntry(refreshed, check));
    existing->second = std::move(refreshed);
    return existing->second.asset;
  }
  if (entries_.size() >= kAssets || asset.size > kLibraryBytes - asset_bytes_)
    return Error{ErrorCode::kLimitExceeded, "asset_library_quota"};
  const auto destination = Payload(asset.id);
  // Keep the input until its upload receipt commits. A crash between the two
  // records can then finish the same draft against the existing hash.
  std::error_code link_error;
  fs::create_hard_link(source, destination, link_error);
  if (link_error)
    return Error{ErrorCode::kUnavailable, "cannot link library payload: " + link_error.message()};
  struct Rollback {
    fs::path path;
    bool committed = false;
    ~Rollback() {
      if (!committed)
        Remove(path);
    }
  } rollback{destination};
  Entry entry{asset, Now() + kAssetLifetime};
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(SaveEntry(entry, check));
  rollback.committed = true;
  asset_bytes_ += asset.size;
  entries_.emplace(asset.id, std::move(entry));
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
Result<fs::path> FileLibrary::Path(const std::string& id) const {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(RequireAsset(id));
  return Payload(id);
}
Result<std::pair<FileLibrary::Asset, std::vector<std::uint8_t>>> FileLibrary::Read(
    const std::string& id,
    std::uint64_t offset) const {
  RK_ASSIGN_OR_RETURN(asset, Describe(id));
  if (offset > asset.size)
    return Error{ErrorCode::kInvalidRequest, "invalid_asset_offset"};
  std::vector<std::uint8_t> bytes(
      static_cast<std::size_t>(std::min<std::uint64_t>(kChunk, asset.size - offset)));
  if (!bytes.empty()) {
    std::ifstream input(Payload(id), std::ios::binary);
    input.seekg(static_cast<std::streamoff>(offset));
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!input)
      return Error{ErrorCode::kUnavailable, "file_read_failed"};
  }
  return std::pair{asset, std::move(bytes)};
}
Result<void> FileLibrary::Retain(const std::vector<std::string>& assets) {
  std::lock_guard lock(mutex_);
  for (const auto& id : assets)
    RK_RETURN_IF_ERROR(RequireAsset(id));
  for (const auto& id : assets) {
    auto& entry = entries_.at(id);
    if (!entry.expires)
      continue;
    const Entry retained{entry.asset, 0};
    RK_RETURN_IF_ERROR(SaveEntry(retained));
    entry.expires = 0;
  }

  return {};
}
Result<void> FileLibrary::References(std::uint64_t revision,
                                     const std::vector<std::string>& assets) {
  if (assets.size() > kAssets)
    return Error{ErrorCode::kInvalidRequest, "invalid_library_references"};
  std::lock_guard lock(mutex_);
  if (reference_revision_ && revision < *reference_revision_)
    return {};
  const std::set<std::string> next(assets.begin(), assets.end());
  if (next.size() != assets.size() || (reference_revision_ == revision && next != references_))
    return Error{ErrorCode::kConflict, "library_reference_conflict"};
  for (const auto& id : next)
    RK_RETURN_IF_ERROR(RequireAsset(id));
  const auto expires = Now() + kAssetLifetime;
  for (auto& [id, entry] : entries_) {
    if (next.contains(id) || (entry.expires && !references_.contains(id)))
      continue;
    const Entry released{entry.asset, expires};
    RK_RETURN_IF_ERROR(SaveEntry(released));
    entry.expires = expires;
  }
  if (reference_revision_ != revision) {
    RK_RETURN_IF_ERROR(
        Save(root_ / "references.json", {{"revision", revision}, {"assetIds", next}}));
    references_ = next;
    reference_revision_ = revision;
  }

  return {};
}
Result<FileLibrary::Asset> FileLibrary::CreateDerivative(const Render& render,
                                                         const Check& check,
                                                         DerivativeFormat format) {
  const bool png = format == DerivativeFormat::png;
  const auto budget = png ? kPngDerivativeBytes : kJpegDerivativeBytes;
  {
    std::lock_guard lock(mutex_);
    RK_RETURN_IF_ERROR(check());
    if (entries_.size() >= kAssets || asset_bytes_ + draft_bytes_ + budget > kLibraryBytes)
      return Error{ErrorCode::kLimitExceeded, "asset_library_quota"};
  }
  RK_ASSIGN_OR_RETURN(random, RandomId());
  const auto path = DraftData(random + (png ? ".png" : ".jpg"));
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
      return Error{ErrorCode::kLimitExceeded, "photo_output_too_large"};
    auto result = Publish(
        path, {{}, png ? "image/png" : "image/jpeg", size, dimensions.width, dimensions.height},
        check);
    Remove(path);
    return result;
  }
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
  for (auto it = entries_.begin(); it != entries_.end();) {
    const auto current = it++;
    const auto& [id, entry] = *current;
    if (!entry.expires || entry.expires > now || references_.contains(id))
      continue;
    if (!Remove(root_ / "assets" / (id + ".json")) || !Remove(Payload(id)))
      continue;
    asset_bytes_ -= entry.asset.size;
    entries_.erase(current);
  }

  return {};
}
Result<void> FileLibrary::Prepare(const Selection& selection) {
  if (!HexId(selection.id, 32) || !BoundedServiceId(selection.request_id) ||
      selection.request_id == "library" || selection.files.empty() || selection.files.size() > 64)
    return Error{ErrorCode::kInvalidRequest, "invalid_selection_manifest"};
  std::lock_guard lock(mutex_);
  const auto found = selections_.find(selection.id);
  if (found != selections_.end()) {
    if (found->second.binding != selection.binding || found->second.files != selection.files ||
        found->second.request_id != selection.request_id)
      return Error{ErrorCode::kConflict, "selection_manifest_conflict"};
    return {};
  }
  if (selections_.size() >= kSelections)
    return Error{ErrorCode::kLimitExceeded, "selection_receipt_quota"};
  std::uint64_t bytes = 0;
  for (const auto& file : selection.files) {
    RK_ASSIGN_OR_RETURN(asset_entry, RequireAsset(file.asset_id));
    const auto& entry = *asset_entry;
    if ((entry.expires && !references_.contains(file.asset_id)) ||
        !ValidSpec({file.name, file.type, entry.asset.size}) ||
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
