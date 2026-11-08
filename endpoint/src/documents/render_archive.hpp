#pragma once

#include "documents/tool_process.hpp"

#include <functional>
#include <memory>

namespace remotekit::documents {
using ArchiveRead = std::function<Result<Bytes>(uint64_t offset, size_t length)>;

struct ArchivePage {
  std::string id;
  uint32_t ordinal;
  double width, height;
  std::string document;
  std::vector<std::string> dependencies;
};

struct ArchiveInfo {
  std::vector<ArchivePage> pages;
  std::vector<std::string> shared;
};

class RenderArchive {
 public:
  // The source must return exactly length bytes and support concurrent reads.
  static Result<RenderArchive> Open(ArchiveRead read, uint64_t size);
  static Result<RenderArchive> OpenFile(const std::filesystem::path& path);
  Result<ArchiveInfo> Info() const;
  Result<std::pair<std::string, Bytes>> Resource(const std::string& content_id) const;

 private:
  struct Impl;
  explicit RenderArchive(std::shared_ptr<const Impl> impl) : impl_(std::move(impl)) {}
  std::shared_ptr<const Impl> impl_;
};
}  // namespace remotekit::documents
