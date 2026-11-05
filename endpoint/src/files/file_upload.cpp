#include "files/file_upload.hpp"
#include <algorithm>
#include <array>
#include <fstream>
#include <limits>
#include "util/result_macros.hpp"
#include "util/file_io.hpp"
#include <windows.h>
#include <bcrypt.h>

namespace remotekit {
namespace {
Result<std::string> RandomId() {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return Error{ErrorCode::kUnavailable, "upload random ID unavailable"};
  constexpr char hex[] = "0123456789abcdef";
  std::string value;
  for (const auto byte : bytes) {
    value += hex[byte >> 4];
    value += hex[byte & 15];
  }
  return value;
}
bool ValidName(const std::string& name) {
  if (name.empty() || name == "." || name == ".." || name.size() > 1024)
    return false;
  for (const auto c : name)
    if (static_cast<unsigned char>(c) < 32 || c == '/' || c == '\\' || c == ':')
      return false;
  return true;
}
bool RegularFile(const std::filesystem::path& path) {
  std::error_code error;
  const auto status = std::filesystem::symlink_status(path, error);
  if (error)
    return false;
  if (!std::filesystem::is_regular_file(status) || std::filesystem::is_symlink(status))
    return false;
  const auto attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return false;
  return true;
}
bool PlainDirectory(const std::filesystem::path& path) {
  std::error_code error;
  const auto status = std::filesystem::symlink_status(path, error);
  if (error)
    return false;
  if (!std::filesystem::is_directory(status) || std::filesystem::is_symlink(status))
    return false;
  const auto attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return false;
  return true;
}
bool OwnedId(const std::filesystem::path& path) {
  const auto name = path.filename().native();
  return (name.size() == 32 || name.size() == 64) &&
         std::all_of(name.begin(), name.end(),
                     [](auto c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
void AddSaturating(std::uint64_t& total, std::uint64_t value) {
  total = value > std::numeric_limits<std::uint64_t>::max() - total
              ? std::numeric_limits<std::uint64_t>::max()
              : total + value;
}
// A previous Endpoint may have disappeared before confirming its Browser's
// exit. Account its files without following links or releasing their lifetime.
Result<std::pair<std::uint64_t, std::uint64_t>> RetainedUsage(const std::filesystem::path& root) {
  std::uint64_t bytes = 0, files = 0, visited = 0;
  {
    if (!PlainDirectory(root))
      return Error{ErrorCode::kUnavailable, "unsafe_upload_root"};
    RK_ASSIGN_OR_RETURN(owners, DirectoryEntries(root));
    for (const auto& owner : owners) {
      if (++visited > 65536)
        return Error{ErrorCode::kLimitExceeded, "upload_scan_limit"};
      if (!OwnedId(owner.path()))
        continue;
      if (!PlainDirectory(owner.path()))
        return Error{ErrorCode::kUnavailable, "unsafe_upload_owner"};
      RK_ASSIGN_OR_RETURN(batches, DirectoryEntries(owner.path()));
      for (const auto& batch : batches) {
        if (++visited > 65536 || !OwnedId(batch.path()) || !PlainDirectory(batch.path()))
          return Error{ErrorCode::kInvalidRequest, "invalid_upload_batch"};
        const auto record = batch.path() / ".reservation";
        RK_ASSIGN_OR_RETURN(size, FileSize(record));
        if (!RegularFile(record) || size > 128)
          return Error{ErrorCode::kInvalidRequest, "invalid_upload_reservation"};
        std::string version;
        std::uint64_t declared_bytes{}, declared_files{};
        std::ifstream input(record);
        if (!(input >> version >> declared_bytes >> declared_files) || version != "v1" ||
            !declared_files)
          return Error{ErrorCode::kInvalidRequest, "invalid_upload_reservation"};
        input >> std::ws;
        if (!input.eof())
          return Error{ErrorCode::kInvalidRequest, "invalid_upload_reservation"};
        std::uint64_t actual_bytes = 0, actual_files = 0;
        RK_ASSIGN_OR_RETURN(payloads, DirectoryEntries(batch.path()));
        for (const auto& file : payloads) {
          if (++visited > 65536)
            return Error{ErrorCode::kLimitExceeded, "upload_scan_limit"};
          if (file.path().filename() == ".reservation")
            continue;
          const auto extension = file.path().extension();
          if ((extension != ".part" && extension != ".file") || !OwnedId(file.path().stem()) ||
              !RegularFile(file.path()))
            return Error{ErrorCode::kUnavailable, "unsafe_upload_payload"};
          RK_ASSIGN_OR_RETURN(size, FileSize(file.path()));
          AddSaturating(actual_bytes, size);
          ++actual_files;
        }
        AddSaturating(bytes, std::max(declared_bytes, actual_bytes));
        AddSaturating(files, std::max(declared_files, actual_files));
      }
    }
  }
  return std::pair{bytes, files};
}
}  // namespace
FileUploadStore::FileUploadStore(std::filesystem::path root)
    : FileUploadStore(std::move(root), Limits{}) {}
FileUploadStore::FileUploadStore(std::filesystem::path root, Limits limits)
    : root_(std::move(root)), limits_(limits) {}
Result<void> FileUploadStore::Initialize() {
  std::error_code absolute_error;
  root_ = std::filesystem::absolute(root_, absolute_error);
  if (absolute_error)
    return Error{ErrorCode::kUnavailable, "upload root unavailable"};
  root_.make_preferred();
  const auto native = root_.native();
  if (!native.starts_with(L"\\\\?\\"))
    root_ = native.starts_with(L"\\\\") ? std::filesystem::path(L"\\\\?\\UNC\\" + native.substr(2))
                                        : std::filesystem::path(L"\\\\?\\" + native);
  RK_RETURN_IF_ERROR(CreateDirectories(root_));
  RK_ASSIGN_OR_RETURN(retained, RetainedUsage(root_));
  reserved_bytes_ = retained.first;
  reserved_files_ = retained.second;
  // Do not create empty owner directories on every restart. Begin creates the
  // private subtree only when a selection reserves space.
  RK_ASSIGN_OR_RETURN(owner, RandomId());
  root_ /= owner;

  return {};
}
Result<FileUploadStore::Batch> FileUploadStore::Begin(const Binding& binding,
                                                      const std::vector<Spec>& specs) {
  if (binding.browser_incarnation.empty() || binding.view.empty() || binding.instance.empty() ||
      binding.document.empty() || binding.request.empty())
    return Error{ErrorCode::kInvalidRequest, "invalid_file_request_binding"};
  if (specs.empty() || specs.size() > limits_.files)
    return Error{ErrorCode::kInvalidRequest, "invalid_file_count"};
  std::uint64_t bytes = 0;
  for (const auto& spec : specs) {
    if (!ValidName(spec.name) || spec.type.size() > 255)
      return Error{ErrorCode::kInvalidRequest, "invalid_file_name_or_type"};
    if (spec.size > limits_.file_bytes || spec.size > limits_.batch_bytes - bytes)
      return Error{ErrorCode::kLimitExceeded, "file_upload_quota"};
    bytes += spec.size;
  }
  if (bytes > limits_.session_bytes || reserved_bytes_ > limits_.session_bytes - bytes)
    return Error{ErrorCode::kLimitExceeded, "session_file_quota"};
  if (specs.size() > limits_.session_files ||
      reserved_files_ > limits_.session_files - specs.size())
    return Error{ErrorCode::kLimitExceeded, "session_file_count_quota"};
  for (const auto& [key, batch] : batches_)
    if (batch.binding == binding)
      return Error{ErrorCode::kConflict, "file_request_upload_already_exists"};
  RK_ASSIGN_OR_RETURN(random, RandomId());
  Batch batch{random, binding, {}, State::uploading};
  const auto directory = root_ / batch.id;
  RK_RETURN_IF_ERROR(CreateDirectories(directory));
  struct Cleanup {
    std::filesystem::path path;
    bool committed = false;
    ~Cleanup() {
      if (!committed) {
        auto removed = RemoveTree(path);
        if (!removed)
          fprintf(stderr, "upload rollback: %s\n", removed.error().message.c_str());
      }
    }
  } cleanup{directory};
  {
    {
      std::ofstream reservation(directory / ".reservation", std::ios::binary | std::ios::trunc);
      reservation << "v1 " << bytes << ' ' << specs.size() << '\n';
      reservation.close();
      if (!reservation)
        return Error{ErrorCode::kUnavailable, "cannot_reserve_upload"};
    }
    for (const auto& spec : specs) {
      RK_ASSIGN_OR_RETURN(ticket, RandomId());
      const auto path = directory / (ticket + ".part");
      std::ofstream stream(path, std::ios::binary | std::ios::trunc);
      if (!stream)
        return Error{ErrorCode::kUnavailable, "cannot_create_upload_file"};
      batch.files.push_back({ticket, spec.name, spec.type, spec.size, path});
    }
    auto [entry, inserted] = batches_.emplace(batch.id, std::move(batch));
    if (!inserted)
      return Error{ErrorCode::kInvalidRequest, "file_upload_id_collision"};
    reserved_bytes_ += bytes;
    reserved_files_ += specs.size();
    cleanup.committed = true;
    return entry->second;
  }
}
Result<FileUploadStore::Batch> FileUploadStore::Seal(const std::string& id,
                                                     const Binding& binding) {
  auto found = batches_.find(id);
  if (found == batches_.end() || !(found->second.binding == binding))
    return Error{ErrorCode::kNotFound, "unknown_file_upload"};
  auto& batch = found->second;
  if (batch.state != State::uploading)
    return batch;
  for (const auto& file : batch.files) {
    RK_ASSIGN_OR_RETURN(size, FileSize(file.path));
    if (!RegularFile(file.path) || size != file.size)
      return Error{ErrorCode::kInvalidRequest, "incomplete_or_invalid_upload"};
  }
  // Same-directory rename is the sealing boundary. Paths never use supplied filenames.
  for (auto& file : batch.files) {
    if (file.path.extension() != ".file") {
      const auto sealed = file.path.parent_path() / (file.ticket + ".file");
      std::error_code rename_error;
      std::filesystem::rename(file.path, sealed, rename_error);
      if (rename_error)
        return Error{ErrorCode::kUnavailable, "cannot seal upload: " + rename_error.message()};
      file.path = sealed;
    }
  }
  batch.state = State::sealed;
  return batch;
}
Result<FileUploadStore::Batch> FileUploadStore::Stage(const Binding& binding,
                                                      const std::vector<Source>& sources,
                                                      const std::function<Result<void>()>& check) {
  std::vector<Spec> specs;
  for (const auto& source : sources)
    specs.push_back(source.spec);
  RK_RETURN_IF_ERROR(check());
  RK_ASSIGN_OR_RETURN(batch, Begin(binding, specs));
  const auto id = batch.id;
  struct Cleanup {
    FileUploadStore& store;
    std::string id;
    bool committed = false;
    ~Cleanup() {
      if (!committed) {
        auto cancelled = store.Cancel(id);
        if (!cancelled)
          fprintf(stderr, "upload cancellation: %s\n", cancelled.error().message.c_str());
      }
    }
  } cleanup{*this, id};
  {
    for (std::size_t i = 0; i < sources.size(); ++i) {
      RK_RETURN_IF_ERROR(check());
      const auto& source = sources[i];
      RK_ASSIGN_OR_RETURN(size, FileSize(source.path));
      if (!RegularFile(source.path) || size != source.spec.size)
        return Error{ErrorCode::kUnavailable, "asset_unavailable"};
      const auto& path = batch.files[i].path;
      RK_RETURN_IF_ERROR(RemoveFile(path));
      std::error_code error;
      std::filesystem::create_hard_link(source.path, path, error);
      if (error)
        return Error{ErrorCode::kUnavailable, "cannot link selection payload: " + error.message()};
    }
    RK_RETURN_IF_ERROR(check());
    RK_ASSIGN_OR_RETURN(sealed, Seal(id, binding));
    cleanup.committed = true;
    return sealed;
  }
}
Result<void> FileUploadStore::MarkSubmitted(const std::string& id) {
  auto& batch = batches_.at(id);
  if (batch.state == State::sealed)
    batch.state = State::submitted;

  return {};
}
Result<void> FileUploadStore::Erase(std::map<std::string, Batch>::iterator entry) {
  std::uint64_t bytes = 0;
  for (const auto& file : entry->second.files)
    bytes += file.size;
  RK_RETURN_IF_ERROR(RemoveTree(root_ / entry->first));
  reserved_bytes_ -= bytes;
  reserved_files_ -= entry->second.files.size();
  batches_.erase(entry);
  std::error_code ignored;
  std::filesystem::remove(root_, ignored);  // Only succeeds when this owner's directory is empty.

  return {};
}
Result<bool> FileUploadStore::Cancel(const std::string& id) {
  auto found = batches_.find(id);
  if (found == batches_.end())
    return true;
  if (found->second.state == State::submitted)
    return false;
  RK_RETURN_IF_ERROR(Erase(found));
  return true;
}
Result<void> FileUploadStore::ConfirmBrowserStopped(const std::string& incarnation) {
  for (auto it = batches_.begin(); it != batches_.end();) {
    auto current = it++;
    if (current->second.binding.browser_incarnation == incarnation)
      RK_RETURN_IF_ERROR(Erase(current));
  }

  return {};
}
}  // namespace remotekit
