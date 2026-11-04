#pragma once
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace remotekit {
// Endpoint-private Session storage. This C++ API never crosses the SDK DLL.
class FileUploadStore {
 public:
  struct Limits {
    std::uint64_t file_bytes = 256ULL * 1024 * 1024;
    std::uint64_t batch_bytes = 512ULL * 1024 * 1024;
    std::uint64_t session_bytes = 1024ULL * 1024 * 1024;
    std::size_t files = 64;
    std::size_t session_files = 4096;
  };
  struct Binding {
    std::string browser_incarnation, view, instance, document, request;
    bool operator==(const Binding&) const = default;
  };
  struct Spec { std::string name, type; std::uint64_t size{}; };
  struct Source { Spec spec; std::filesystem::path path; };
  struct File { std::string ticket, name, type; std::uint64_t size{}; std::filesystem::path path; };
  enum class State { uploading, sealed, submitted, selected };
  struct Batch {
    std::string id;
    Binding binding;
    std::vector<File> files;
    State state = State::uploading;
    bool library_stage = false;
  };
  explicit FileUploadStore(std::filesystem::path root);
  FileUploadStore(std::filesystem::path root, Limits limits);
  // root is Session-owned. Call ConfirmBrowserStopped only on confirmed exit,
  // never merely a lost control channel. Destructor does not delete selections.
  const Batch& Begin(const Binding&, const std::vector<Spec>&);
  const Batch& BeginOrResume(const Binding&, const std::vector<Spec>&);
  const Batch& Stage(const Binding&, const std::vector<Source>&, const std::function<void()>& check);
  const Batch* FindBinding(const Binding&) const;
  std::uint64_t Write(const std::string& id, const Binding&, std::size_t file,
                      std::uint64_t offset, const std::vector<std::uint8_t>& bytes);
  std::vector<std::uint64_t> Offsets(const std::string& id, const Binding&) const;
  bool CancelBinding(const Binding&);
  const Batch& Seal(const std::string& id, const Binding&);
  void MarkSubmitted(const std::string& id);
  void MarkSelected(const std::string& id);
  const Batch* Find(const std::string& id) const;
  bool Cancel(const std::string& id);  // false: already submitted/selected.
  // Only after Browser explicitly confirms cancelled/validation failed.
  bool DiscardUnselected(const std::string& id);
  void RevokeUncommitted();
  void ConfirmBrowserStopped(const std::string& incarnation);
  std::uint64_t reserved_bytes() const { return reserved_bytes_; }
  std::uint64_t reserved_files() const { return reserved_files_; }
 private:
  void Erase(std::map<std::string, Batch>::iterator);
  std::filesystem::path root_;
  Limits limits_;
  std::map<std::string, Batch> batches_;
  std::uint64_t reserved_bytes_{};
  std::uint64_t reserved_files_{};
};
}  // namespace remotekit
