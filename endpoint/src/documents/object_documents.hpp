#pragma once

#include "documents/render_archive.hpp"
#include "documents/render_queue.hpp"
#include "objects/work_queue.hpp"
#include "util/common.hpp"

#include <list>

namespace remotekit::objects {
class ObjectService;
}

namespace remotekit::documents {
class ObjectDocuments {
 public:
  struct ResourceChunk {
    std::string mime;
    Bytes bytes;
    uint64_t total;
  };
  ObjectDocuments(objects::ObjectService& objects, std::filesystem::path data);
  ~ObjectDocuments();
  Result<void> Available() const;
  Result<Json> Open(const std::string& source,
                    const std::string& tenant,
                    const std::filesystem::path& temporary);
  Result<std::string> Render(const std::string& source);
  Result<ResourceChunk> Resource(const std::string& document,
                                 const std::string& content,
                                 uint64_t offset);

 private:
  using Clock = std::chrono::steady_clock;
  using Future = std::shared_future<Result<std::string>>;
  struct Job {
    Future future;
    Clock::time_point expires = Clock::time_point::max();
  };
  Future Submit(const std::string& source,
                const std::string& tenant,
                const std::filesystem::path& temporary);
  Result<std::string> Convert(const std::string& source,
                              const std::string& tenant,
                              const std::filesystem::path& temporary);
  Result<Json> Ready(const std::string& document,
                     const std::string& tenant,
                     const std::string& source);
  Result<RenderArchive> Archive(const std::string& document);
  objects::ObjectService& objects_;
  std::filesystem::path data_, tools_;
  RenderQueue renders_;
  objects::WorkQueue workers_{2};
  std::mutex mutex_;
  std::map<std::string, Job> jobs_;
  std::list<std::pair<std::string, RenderArchive>> archives_;
};
}  // namespace remotekit::documents
