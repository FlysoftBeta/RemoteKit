#pragma once
#include "options.hpp"
#include "management/link.hpp"
#include "persistence/session_store.hpp"
#include <map>
#include <mutex>
#include <atomic>
namespace remotekit {
namespace media {
struct Sdk;
}
class Session;
class Service {
 public:
  Service(media::Sdk& sdk, const RuntimeOptions& options, ManagementLink& link);
  ~Service();
  int Run();
  void Fail() { failed_ = true; }

 private:
  Result<Json> Dispatch(const Json& request, uint64_t generation);
  void Clear();
  media::Sdk& sdk_;
  const RuntimeOptions& options_;
  ManagementLink& link_;
  SessionStore store_;
  Json registry_;
  std::mutex mutex_;
  std::map<std::string, std::unique_ptr<Session>> sessions_;
  std::atomic<bool> failed_{false};
};
}  // namespace remotekit
