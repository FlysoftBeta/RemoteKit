#pragma once

#include "documents/tool_process.hpp"

#include <array>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <mutex>
#include <thread>

namespace remotekit::documents {
struct RenditionResult {
  std::filesystem::path archive;
  uint64_t size;
};

// Own one queue for the node. Source IDs identify immutable plaintext. Input
// files must remain available until the returned future completes. The caller
// owns completed archives; the queue cleans up only intermediate files.
class RenderQueue {
 public:
  using Future = std::shared_future<Result<RenditionResult>>;
  using Worker = std::function<Result<RenditionResult>(size_t slot,
                                                       const std::string& source_id,
                                                       const std::filesystem::path& plaintext,
                                                       const std::string& name)>;
  explicit RenderQueue(const std::filesystem::path& data_directory,
                       const std::filesystem::path& tools_directory = DefaultToolsDirectory());
  explicit RenderQueue(Worker worker);
  ~RenderQueue();
  RenderQueue(const RenderQueue&) = delete;
  RenderQueue& operator=(const RenderQueue&) = delete;

  Future Submit(const std::string& source_id,
                const std::filesystem::path& plaintext,
                std::string_view name);
  Result<RenditionResult> Render(const std::string& source_id,
                                 const std::filesystem::path& plaintext,
                                 std::string_view name);

 private:
  struct Job {
    std::string source_id;
    std::filesystem::path plaintext;
    std::string name;
    std::promise<Result<RenditionResult>> promise;
  };
  void Work(size_t slot);
  Worker worker_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::shared_ptr<Job>> pending_;
  std::map<std::string, Future> active_;
  bool stopping_ = false;
  std::array<std::thread, 2> threads_;
};
}  // namespace remotekit::documents
