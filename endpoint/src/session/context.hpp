#pragma once
#include "common.hpp"
#include "options.hpp"
#include "management/link.hpp"
#include "media/adapter.hpp"
#include "media/server_trace.hpp"
#include "persistence/session_store.hpp"
#include "session/browser.hpp"
#include "remotekit/thread.hpp"
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
};
}  // namespace remotekit
