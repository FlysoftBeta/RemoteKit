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
  struct Spec {
    std::string name, type;
    std::uint64_t size{};
  };
  struct Source {
    Spec spec;
    std::filesystem::path path;
  };
  struct File {
    std::string ticket, name, type;
    std::uint64_t size{};
    std::filesystem::path path;
  };
  enum class State { uploading, sealed, submitted };
  struct Batch {
    std::string id;
    Binding binding;
    std::vector<File> files;
    State state = State::uploading;
  };
  explicit FileUploadStore(std::filesystem::path root);
  FileUploadStore(std::filesystem::path root, Limits limits);
  // root is Session-owned. Call ConfirmBrowserStopped only on confirmed exit,
  // never merely a lost control channel. Destructor does not delete selections.
  const Batch& Stage(const Binding&,
                     const std::vector<Source>&,
                     const std::function<void()>& check);
  void MarkSubmitted(const std::string& id);
  bool Cancel(const std::string& id);
  void ConfirmBrowserStopped(const std::string& incarnation);
  std::uint64_t reserved_bytes() const { return reserved_bytes_; }
  std::uint64_t reserved_files() const { return reserved_files_; }

 private:
  const Batch& Begin(const Binding&, const std::vector<Spec>&);
  const Batch& Seal(const std::string& id, const Binding&);
  void Erase(std::map<std::string, Batch>::iterator);
  std::filesystem::path root_;
  Limits limits_;
  std::map<std::string, Batch> batches_;
  std::uint64_t reserved_bytes_{};
  std::uint64_t reserved_files_{};
};
}  // namespace remotekit
