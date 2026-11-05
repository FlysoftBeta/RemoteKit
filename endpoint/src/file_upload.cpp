#include "remotekit/file_upload.hpp"
#include <algorithm>
#include <array>
#include <fstream>
#include <limits>
#include <random>
#include <set>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#endif

namespace remotekit {
namespace {
std::string RandomId() {
  std::random_device random;
  constexpr char hex[] = "0123456789abcdef";
  std::string value;
  for (unsigned i = 0; i < 4; ++i) {
    const auto part = random();
    for (unsigned shift = 0; shift < 32; shift += 4)
      value += hex[(part >> shift) & 15];
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
  const auto status = std::filesystem::symlink_status(path);
  if (!std::filesystem::is_regular_file(status) || std::filesystem::is_symlink(status))
    return false;
#ifdef _WIN32
  const auto attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return false;
#endif
  return true;
}
bool PlainDirectory(const std::filesystem::path& path) {
  const auto status = std::filesystem::symlink_status(path);
  if (!std::filesystem::is_directory(status) || std::filesystem::is_symlink(status))
    return false;
#ifdef _WIN32
  const auto attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return false;
#endif
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
std::pair<std::uint64_t, std::uint64_t> RetainedUsage(const std::filesystem::path& root) {
  std::uint64_t bytes = 0, files = 0, visited = 0;
  try {
    if (!PlainDirectory(root))
      throw std::runtime_error("unsafe_upload_root");
    for (const auto& owner : std::filesystem::directory_iterator(root)) {
      if (++visited > 65536)
        throw std::runtime_error("upload_scan_limit");
      if (!OwnedId(owner.path()))
        continue;
      if (!PlainDirectory(owner.path()))
        throw std::runtime_error("unsafe_upload_owner");
      for (const auto& batch : std::filesystem::directory_iterator(owner.path())) {
        if (++visited > 65536 || !OwnedId(batch.path()) || !PlainDirectory(batch.path()))
          throw std::runtime_error("invalid_upload_batch");
        const auto record = batch.path() / ".reservation";
        if (!RegularFile(record) || std::filesystem::file_size(record) > 128)
          throw std::runtime_error("invalid_upload_reservation");
        std::string version;
        std::uint64_t declared_bytes{}, declared_files{};
        std::ifstream input(record);
        if (!(input >> version >> declared_bytes >> declared_files) || version != "v1" ||
            !declared_files)
          throw std::runtime_error("invalid_upload_reservation");
        input >> std::ws;
        if (!input.eof())
          throw std::runtime_error("invalid_upload_reservation");
        std::uint64_t actual_bytes = 0, actual_files = 0;
        for (const auto& file : std::filesystem::directory_iterator(batch.path())) {
          if (++visited > 65536)
            throw std::runtime_error("upload_scan_limit");
          if (file.path().filename() == ".reservation")
            continue;
          const auto extension = file.path().extension();
          if ((extension != ".part" && extension != ".file") || !OwnedId(file.path().stem()) ||
              !RegularFile(file.path()))
            throw std::runtime_error("unsafe_upload_payload");
          AddSaturating(actual_bytes, std::filesystem::file_size(file.path()));
          ++actual_files;
        }
        AddSaturating(bytes, std::max(declared_bytes, actual_bytes));
        AddSaturating(files, std::max(declared_files, actual_files));
      }
    }
  } catch (const std::exception&) {
    // Corrupt or inaccessible metadata must never turn retained data into free
    // quota. Keep existing files intact and reject new allocations.
    return {std::numeric_limits<std::uint64_t>::max(), std::numeric_limits<std::uint64_t>::max()};
  }
  return {bytes, files};
}
}  // namespace
FileUploadStore::FileUploadStore(std::filesystem::path root)
    : FileUploadStore(std::move(root), Limits{}) {}
FileUploadStore::FileUploadStore(std::filesystem::path root, Limits limits)
    : root_(std::filesystem::absolute(std::move(root))), limits_(limits) {
#ifdef _WIN32
  root_.make_preferred();
  const auto native = root_.native();
  if (!native.starts_with(L"\\\\?\\"))
    root_ = native.starts_with(L"\\\\") ? std::filesystem::path(L"\\\\?\\UNC\\" + native.substr(2))
                                        : std::filesystem::path(L"\\\\?\\" + native);
#endif
  std::filesystem::create_directories(root_);
  const auto retained = RetainedUsage(root_);
  reserved_bytes_ = retained.first;
  reserved_files_ = retained.second;
  // Do not create empty owner directories on every restart. Begin creates the
  // private subtree only when a real upload reserves space.
  root_ /= RandomId();
}
const FileUploadStore::Batch& FileUploadStore::Begin(const Binding& binding,
                                                     const std::vector<Spec>& specs) {
  if (binding.browser_incarnation.empty() || binding.view.empty() || binding.instance.empty() ||
      binding.document.empty() || binding.request.empty())
    throw std::runtime_error("invalid_file_request_binding");
  if (specs.empty() || specs.size() > limits_.files)
    throw std::runtime_error("invalid_file_count");
  std::uint64_t bytes = 0;
  for (const auto& spec : specs) {
    if (!ValidName(spec.name) || spec.type.size() > 255)
      throw std::runtime_error("invalid_file_name_or_type");
    if (spec.size > limits_.file_bytes || spec.size > limits_.batch_bytes - bytes)
      throw std::runtime_error("file_upload_quota");
    bytes += spec.size;
  }
  if (bytes > limits_.session_bytes || reserved_bytes_ > limits_.session_bytes - bytes)
    throw std::runtime_error("session_file_quota");
  if (specs.size() > limits_.session_files ||
      reserved_files_ > limits_.session_files - specs.size())
    throw std::runtime_error("session_file_count_quota");
  for (const auto& [key, batch] : batches_)
    if (batch.binding == binding)
      throw std::runtime_error("file_request_upload_already_exists");
  Batch batch{RandomId(), binding, {}, State::uploading};
  const auto directory = root_ / batch.id;
  std::filesystem::create_directories(directory);
  try {
    {
      std::ofstream reservation(directory / ".reservation", std::ios::binary | std::ios::trunc);
      reservation << "v1 " << bytes << ' ' << specs.size() << '\n';
      reservation.close();
      if (!reservation)
        throw std::runtime_error("cannot_reserve_upload");
    }
    for (const auto& spec : specs) {
      const auto ticket = RandomId();
      const auto path = directory / (ticket + ".part");
      std::ofstream stream(path, std::ios::binary | std::ios::trunc);
      if (!stream)
        throw std::runtime_error("cannot_create_upload_file");
      batch.files.push_back({ticket, spec.name, spec.type, spec.size, path});
    }
    auto [entry, inserted] = batches_.emplace(batch.id, std::move(batch));
    if (!inserted)
      throw std::runtime_error("file_upload_id_collision");
    reserved_bytes_ += bytes;
    reserved_files_ += specs.size();
    return entry->second;
  } catch (...) {
    std::filesystem::remove_all(directory);
    throw;
  }
}
const FileUploadStore::Batch& FileUploadStore::Seal(const std::string& id, const Binding& binding) {
  auto found = batches_.find(id);
  if (found == batches_.end() || !(found->second.binding == binding))
    throw std::runtime_error("unknown_file_upload");
  auto& batch = found->second;
  if (batch.state != State::uploading)
    return batch;
  for (const auto& file : batch.files)
    if (!RegularFile(file.path) || std::filesystem::file_size(file.path) != file.size)
      throw std::runtime_error("incomplete_or_invalid_upload");
  // Same-directory rename is the sealing boundary; Control must have closed
  // all writers before asking to commit. Paths never use supplied filenames.
  for (auto& file : batch.files) {
    if (file.path.extension() != ".file") {
      const auto sealed = file.path.parent_path() / (file.ticket + ".file");
      std::filesystem::rename(file.path, sealed);
      file.path = sealed;
    }
  }
  batch.state = State::sealed;
  return batch;
}
const FileUploadStore::Batch* FileUploadStore::FindBinding(const Binding& binding) const {
  for (const auto& [id, batch] : batches_)
    if (batch.binding == binding)
      return &batch;
  return nullptr;
}
const FileUploadStore::Batch& FileUploadStore::BeginOrResume(const Binding& binding,
                                                             const std::vector<Spec>& specs) {
  if (const auto* batch = FindBinding(binding)) {
    if (batch->library_stage)
      throw std::runtime_error("file_request_upload_already_exists");
    if (batch->files.size() != specs.size())
      throw std::runtime_error("file_upload_specs_conflict");
    for (std::size_t i = 0; i < specs.size(); ++i)
      if (batch->files[i].name != specs[i].name || batch->files[i].type != specs[i].type ||
          batch->files[i].size != specs[i].size)
        throw std::runtime_error("file_upload_specs_conflict");
    return *batch;
  }
  return Begin(binding, specs);
}
const FileUploadStore::Batch& FileUploadStore::Stage(const Binding& binding,
                                                     const std::vector<Source>& sources,
                                                     const std::function<void()>& check) {
  std::vector<Spec> specs;
  for (const auto& source : sources)
    specs.push_back(source.spec);
  check();
  const auto& batch = Begin(binding, specs);
  const auto id = batch.id;
  batches_.at(id).library_stage = true;
  try {
    for (std::size_t i = 0; i < sources.size(); ++i) {
      check();
      const auto& source = sources[i];
      if (!RegularFile(source.path) || std::filesystem::file_size(source.path) != source.spec.size)
        throw std::runtime_error("asset_unavailable");
      const auto& path = batch.files[i].path;
      std::filesystem::remove(path);
      std::error_code error;
      std::filesystem::create_hard_link(source.path, path, error);
      if (error)
        std::filesystem::copy_file(source.path, path);
    }
    check();
    return Seal(id, binding);
  } catch (...) {
    Cancel(id);
    throw;
  }
}
std::vector<std::uint64_t> FileUploadStore::Offsets(const std::string& id,
                                                    const Binding& binding) const {
  const auto* batch = Find(id);
  if (!batch || !(batch->binding == binding))
    throw std::runtime_error("unknown_file_upload");
  std::vector<std::uint64_t> offsets;
  for (const auto& file : batch->files) {
    if (!RegularFile(file.path))
      throw std::runtime_error("invalid_upload_file");
    const auto size = std::filesystem::file_size(file.path);
    if (size > file.size)
      throw std::runtime_error("invalid_upload_size");
    offsets.push_back(size);
  }
  return offsets;
}
std::uint64_t FileUploadStore::Write(const std::string& id,
                                     const Binding& binding,
                                     std::size_t index,
                                     std::uint64_t offset,
                                     const std::vector<std::uint8_t>& bytes) {
  const auto* batch = Find(id);
  if (!batch || !(batch->binding == binding))
    throw std::runtime_error("unknown_file_upload");
  if (batch->state != State::uploading)
    throw std::runtime_error("file_upload_not_writable");
  if (index >= batch->files.size() || bytes.empty() || bytes.size() > 16384)
    throw std::runtime_error("invalid_file_chunk");
  const auto& file = batch->files[index];
  if (offset > file.size || bytes.size() > file.size - offset || !RegularFile(file.path))
    throw std::runtime_error("invalid_file_chunk_range");
  const auto received = std::filesystem::file_size(file.path);
  if (offset > received || (offset < received && bytes.size() > received - offset))
    throw std::runtime_error("file_chunk_out_of_order");
  std::fstream stream(file.path, std::ios::binary | std::ios::in | std::ios::out);
  if (!stream)
    throw std::runtime_error("cannot_open_upload_file");
  if (offset < received) {
    std::vector<std::uint8_t> previous(bytes.size());
    stream.seekg(static_cast<std::streamoff>(offset));
    stream.read(reinterpret_cast<char*>(previous.data()),
                static_cast<std::streamsize>(previous.size()));
    if (!stream || previous != bytes)
      throw std::runtime_error("file_chunk_conflict");
    return received;
  }
  stream.seekp(static_cast<std::streamoff>(offset));
  stream.write(reinterpret_cast<const char*>(bytes.data()),
               static_cast<std::streamsize>(bytes.size()));
  stream.flush();
  if (!stream)
    throw std::runtime_error("cannot_write_upload_file");
  return offset + bytes.size();
}
bool FileUploadStore::CancelBinding(const Binding& binding) {
  const auto* batch = FindBinding(binding);
  return !batch || Cancel(batch->id);
}
void FileUploadStore::MarkSubmitted(const std::string& id) {
  auto& batch = batches_.at(id);
  if (batch.state == State::sealed)
    batch.state = State::submitted;
}
void FileUploadStore::MarkSelected(const std::string& id) {
  auto& batch = batches_.at(id);
  if (batch.state != State::submitted && batch.state != State::selected)
    throw std::runtime_error("file_upload_not_submitted");
  batch.state = State::selected;
}
const FileUploadStore::Batch* FileUploadStore::Find(const std::string& id) const {
  const auto found = batches_.find(id);
  return found == batches_.end() ? nullptr : &found->second;
}
void FileUploadStore::Erase(std::map<std::string, Batch>::iterator entry) {
  std::uint64_t bytes = 0;
  for (const auto& file : entry->second.files)
    bytes += file.size;
  std::filesystem::remove_all(root_ / entry->first);
  reserved_bytes_ -= bytes;
  reserved_files_ -= entry->second.files.size();
  batches_.erase(entry);
  std::error_code ignored;
  std::filesystem::remove(root_, ignored);  // Only succeeds when this owner's directory is empty.
}
bool FileUploadStore::Cancel(const std::string& id) {
  auto found = batches_.find(id);
  if (found == batches_.end())
    return true;
  if (found->second.state == State::submitted || found->second.state == State::selected)
    return false;
  Erase(found);
  return true;
}
bool FileUploadStore::DiscardUnselected(const std::string& id) {
  auto found = batches_.find(id);
  if (found == batches_.end())
    return true;
  if (found->second.state == State::selected)
    return false;
  Erase(found);
  return true;
}
void FileUploadStore::RevokeUncommitted() {
  for (auto it = batches_.begin(); it != batches_.end();) {
    auto current = it++;
    if (current->second.state == State::uploading || current->second.state == State::sealed)
      Erase(current);
  }
}
void FileUploadStore::ConfirmBrowserStopped(const std::string& incarnation) {
  for (auto it = batches_.begin(); it != batches_.end();) {
    auto current = it++;
    if (current->second.binding.browser_incarnation == incarnation)
      Erase(current);
  }
}
}  // namespace remotekit
