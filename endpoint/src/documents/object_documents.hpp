#pragma once

#include "documents/render_archive.hpp"
#include "documents/render_queue.hpp"
#include "objects/work_queue.hpp"
#include "util/common.hpp"
#include "util/retry_unit.hpp"
#include "persistence/document_job_formats.hpp"

#include <list>

namespace remotekit::objects {
class ObjectService;
}

namespace remotekit {
class NativeErrorStateProbe;
class NativeRetryOwnerProbe;
}  // namespace remotekit

namespace remotekit::documents {
class ObjectDocuments {
 public:
  struct ResourceChunk {
    std::string mime;
    Bytes bytes;
    uint64_t total;
  };
  using WriteRecord = std::function<Result<void>(const std::filesystem::path&, const Json&)>;
  ObjectDocuments(objects::ObjectService& objects,
                  std::filesystem::path data,
                  std::string build,
                  WriteRecord write_record = document_job_formats::Write);
  ~ObjectDocuments();
  Result<void> Available() const;
  Result<Json> Open(const std::string& source,
                    const std::string& tenant,
                    const std::filesystem::path& temporary,
                    const std::string& media_type);
  Result<std::string> Render(const std::string& source);
  Result<ResourceChunk> Resource(const std::string& document,
                                 const std::string& content,
                                 uint64_t offset);

 private:
  friend class ::remotekit::NativeErrorStateProbe;
  friend class ::remotekit::NativeRetryOwnerProbe;
  using Clock = std::chrono::steady_clock;
  using Future = std::shared_future<Result<std::string>>;
  struct Job {
    Future future;
    RetryUnit retry{"document.convert"};
    RetryUnit persistence{"document.persistence"};
    std::optional<Result<std::string>> pending_result;
    std::optional<RetryUnit> pending_retry;
    std::optional<Json> pending_record;
    bool loaded = false;
    Clock::time_point expires = Clock::time_point::max();
  };
  Future Submit(const std::string& source,
                const std::string& tenant,
                const std::filesystem::path& temporary,
                const std::string& media_type);
  Result<std::string> Publish(Job& job, const std::filesystem::path& path);
  Result<std::string> Convert(const std::string& source,
                              const std::string& tenant,
                              const std::filesystem::path& temporary,
                              const std::string& media_type);
  Result<Json> Ready(const std::string& document,
                     const std::string& tenant,
                     const std::string& source);
  Result<RenderArchive> Archive(const std::string& document);
  objects::ObjectService& objects_;
  std::filesystem::path data_, tools_;
  std::string build_;
  WriteRecord write_record_;
  RenderQueue renders_;
  objects::WorkQueue workers_{2};
  std::mutex mutex_;
  std::map<std::string, Job> jobs_;
  std::list<std::pair<std::string, RenderArchive>> archives_;
};
}  // namespace remotekit::documents
