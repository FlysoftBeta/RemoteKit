#pragma once
#include "util/common.hpp"
#include "options.hpp"
#include "management/link.hpp"
#include "media/adapter.hpp"
#include "media/server_trace.hpp"
#include "persistence/session_store.hpp"
#include "session/browser.hpp"
#include "util/thread.hpp"
#include "objects/service.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <thread>
namespace remotekit {
struct SessionConfig {
  const RuntimeOptions options;
  const std::string tenant, id;
  const fs::path directory;
  const uint64_t placement_epoch;
  cluster::Key profile_key;
  std::shared_ptr<objects::SessionObjects> object_access;
  ~SessionConfig() { SecureZeroMemory(profile_key.data(), profile_key.size()); }
};
struct ControllerContext {
  media::Sdk& sdk;
  const RuntimeOptions& options;
  const std::string& tenant;
  const std::string& id;
  const fs::path& directory;
  BrowserRuntime& browser;
  SessionStore& store;
  ManagementLink& management;
  const std::shared_ptr<media::ServerTrace> trace;
  objects::ObjectService& objects;
  std::shared_ptr<objects::SessionObjects> object_access;
};
}  // namespace remotekit
