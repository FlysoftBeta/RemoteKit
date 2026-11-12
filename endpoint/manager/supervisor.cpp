#include "supervisor.hpp"
#include "release/executor.hpp"
#include "release/payload.hpp"
#include "updater/archive.hpp"
#include "updater/process.hpp"
#include "updater/snapshot.hpp"
#include "updater/replacement.hpp"
#include "util/error_policy.hpp"
#include <atomic>
#include <thread>

namespace remotekit::manager {
using namespace release;
namespace {
struct Config {
  std::string manifest, proxy;
  DWORD interval = 60 * 60000;
};
Config LoadConfig(const fs::path& root) {
  auto bytes = Read(root / L"config/manager.json", 1024 * 1024);
  auto json = ParseJson({reinterpret_cast<const char*>(bytes.data()), bytes.size()});
  Keys(json, {"manifest"}, {"checkIntervalMinutes", "proxy"});
  Require(json["manifest"].is_string(), "invalid manager manifest URL");
  Config config;
  config.manifest = json["manifest"].get<std::string>();
  Require(ValidUrl(config.manifest), "invalid manager manifest URL");
  if (json.contains("checkIntervalMinutes")) {
    auto minutes = Unsigned(json["checkIntervalMinutes"]);
    Require(minutes >= 5 && minutes <= 1440, "checkIntervalMinutes must be 5..1440");
    config.interval = static_cast<DWORD>(minutes * 60000);
  }
  if (json.contains("proxy")) {
    Require(json["proxy"].is_string(), "invalid manager proxy");
    config.proxy = json["proxy"].get<std::string>();
    Require(ValidUrl(config.proxy), "invalid manager proxy");
  }
  return config;
}
bool BaseUsable(const fs::path& version) {
  try {
    auto bytes = Read(version / L"payload.json", 4096);
    auto json = ParseJson({reinterpret_cast<const char*>(bytes.data()), bytes.size()});
    Keys(json, {"size", "sha256"});
    HexString(json["sha256"]);
    return fs::is_regular_file(version / L"payload.tar") &&
           fs::file_size(version / L"payload.tar") == Unsigned(json["size"]);
  } catch (...) {
    return false;
  }
}
std::unique_ptr<updater::ChildProcess> StartControl(const fs::path& root,
                                                    const std::string& id,
                                                    updater::Log& manager_log,
                                                    updater::Log& control_log) {
  auto version = root / L"versions" / id;
  auto child = std::make_unique<updater::ChildProcess>(
      version / L"bin/node.exe", updater::Quote((version / L"control/dist/server.mjs").wstring()),
      root, control_log, true,
      L"REMOTEKIT_CONTROL_CONFIG=" + (root / L"config/control.json").wstring());
  manager_log.Event(LogLevel::kInfo, "control.started", {{"buildId", id}});
  return child;
}
}  // namespace
updater::Handle Lock(const fs::path& root, HANDLE stop, DWORD timeout) {
  fs::create_directories(root);
  auto started = GetTickCount64();
  while (true) {
    updater::Handle lock(CreateFileW((root / L"manager.lock").c_str(), GENERIC_READ | GENERIC_WRITE,
                                     0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (lock.value != INVALID_HANDLE_VALUE)
      return lock;
    DWORD error = GetLastError();
    if (error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION)
      Fail(ErrorCode::kUnavailable, "cannot open manager.lock");
    if (GetTickCount64() - started >= timeout)
      Fail(ErrorCode::kBusy, "manager holds the lock");
    if (stop ? updater::Delay(stop, 100) : (Sleep(100), false))
      Fail(ErrorCode::kCanceled, "manager stopped while waiting for lock");
  }
}
std::string Current(const fs::path& root) {
  try {
    auto bytes = Read(root / L"current", 66);
    std::string id(bytes.begin(), bytes.end());
    while (!id.empty() && (id.back() == '\r' || id.back() == '\n'))
      id.pop_back();
    if (!cluster::ValidBuildId(id))
      return {};
    auto version = root / L"versions" / id;
    if (Take(cluster::ReadBuildId(version)) != id)
      return {};
    for (auto required : {L"bin/node.exe", L"bin/remotekit_control.exe", L"bin/remotekit_node.exe",
                          L"control/dist/server.mjs"})
      if (!fs::is_regular_file(version / required))
        return {};
    return id;
  } catch (...) {
    return {};
  }
}
void Cleanup(const fs::path& root, const std::string& current) {
  std::error_code ec;
  fs::remove(root / L"remotekit_control.exe.old", ec);
  fs::remove(root / L"remotekit_control.exe.new", ec);
  if (fs::exists(root / L"versions"))
    for (auto& entry : fs::directory_iterator(root / L"versions"))
      if (entry.path().filename().string() != current)
        fs::remove_all(updater::ExtendedPath(entry.path()));
  if (fs::exists(root / L"work"))
    for (auto& entry : fs::directory_iterator(root / L"work")) {
      auto name = entry.path().filename().string();
      if (name.starts_with("stage-") || name.starts_with("payload-"))
        fs::remove_all(updater::ExtendedPath(entry.path()));
    }
}
int SuperviseLoop(const fs::path& root, HANDLE stop, bool service) {
  auto lock = Lock(root, stop, 30000);
  updater::Log log(root / L"logs/manager.log"), control_log(root / L"logs/control.stdout.log");
  auto config = LoadConfig(root);
  auto key = LoadKey(root / L"config/release.key");
  auto id = Current(root);
  Cleanup(root, id);
  State state{id, !id.empty() && BaseUsable(root / L"versions" / id), {}};
  Http http(config.proxy, stop, &log);
  std::unique_ptr<updater::ChildProcess> child;
  std::vector<std::unique_ptr<updater::SnapshotSupervisor>> snapshots;
  ULONGLONG started = 0, restart_at = 0, check_at = 0;
  unsigned backoff = 1, attempt = 0;
  std::atomic<bool> done = false;
  std::optional<std::string> installed;
  std::optional<Error> error;
  std::thread worker;
  auto stop_child = [&] {
    if (child) {
      child->Stop(60000);
      child.reset();
      snapshots.clear();
      log.Event(LogLevel::kInfo, "control.stopped");
    }
  };
  try {
    while (!updater::Stopping(stop)) {
      auto now = GetTickCount64();
      if (worker.joinable() && done.load()) {
        worker.join();
        if (error) {
          log.Event(LogLevel::kWarn, "manager.update_failed", LogErrorFields(*error));
          auto delay = RetryDelay(*error, attempt++);
          check_at = now + (delay ? delay->count() : config.interval);
        } else {
          attempt = 0;
          check_at = now + config.interval;
          if (installed && *installed != id) {
            stop_child();
            id = *installed;
            AtomicText(root / L"current", id);
            state.current = id;
            state.base_usable = true;
            Cleanup(root, id);
            auto replaced = updater::ReplaceExecutable(
                root / L"remotekit_control.exe",
                root / L"versions" / id / L"bin/remotekit_control.exe", root,
                L"run --root=" + updater::Quote(root.wstring()), service, log);
            if (!replaced)
              log.Event(LogLevel::kError, "manager.replacement_failed",
                        LogErrorFields(replaced.error()));
            else if (replaced.value()) {
              SecureZeroMemory(key.data(), key.size());
              return service ? 1 : 0;
            }
            restart_at = 0;
            backoff = 1;
          }
        }
      }
      if (child && WaitForSingleObject(child->handle(), 0) == WAIT_OBJECT_0) {
        log.Event(LogLevel::kWarn, "control.exited", {{"exitCode", child->ExitCode()}});
        child.reset();
        if (now - started >= 60000)
          backoff = 1;
        restart_at = now + backoff * 1000;
        backoff = std::min(30u, backoff * 2);
      }
      if (!child && !id.empty() && now >= restart_at) {
        try {
          child = StartControl(root, id, log, control_log);
          snapshots.clear();
          auto bytes = Read(root / L"config/control.json", 1024 * 1024);
          auto control = ParseJson({reinterpret_cast<const char*>(bytes.data()), bytes.size()});
          for (const auto& [node_id, node] : control.at("nodes").items()) {
            if (!node.contains("local"))
              continue;
            const auto local_text = node.at("local").at("root").get<std::string>();
            auto local = fs::path(std::u8string(local_text.begin(), local_text.end()));
            if (local.is_relative())
              local = root / L"config" / local;
            snapshots.push_back(std::make_unique<updater::SnapshotSupervisor>(
                root / L"versions" / id / L"node/bin/remotekit_snapshot.exe",
                fs::absolute(local).lexically_normal(), node_id));
          }
          started = GetTickCount64();
        } catch (const std::exception&) {
          log.Event(LogLevel::kError, "control.start_failed");
          restart_at = now + backoff * 1000;
          backoff = std::min(30u, backoff * 2);
        }
      }
      if (!worker.joinable() && now >= check_at) {
        installed.reset();
        error.reset();
        done.store(false);
        worker = std::thread([&] {
          try {
            auto base = id.empty() ? fs::path() : root / L"versions" / id / L"payload.tar";
            auto result = Fetch(config.manifest, state, base, root / L"work", key, http);
            if (result.build_id != id) {
              InstallPayload(root, result.path, result.build_id, PayloadSource::kMove);
              installed = result.build_id;
            }
          } catch (const Failure& failure) {
            error = failure.error;
          } catch (const fs::filesystem_error&) {
            error = Error{ErrorCode::kUnavailable, "release filesystem operation failed"};
          } catch (...) {
            error = Error{ErrorCode::kInternal, "release check failed"};
          }
          done.store(true);
        });
      }
      if (updater::Delay(stop, 100))
        break;
    }
    stop_child();
  } catch (...) {
    SetEvent(stop);
    stop_child();
    if (worker.joinable())
      worker.join();
    SecureZeroMemory(key.data(), key.size());
    throw;
  }
  if (worker.joinable())
    worker.join();
  SecureZeroMemory(key.data(), key.size());
  log.Event(LogLevel::kInfo, "manager.stopped");
  return 0;
}
int Supervise(const fs::path& root, HANDLE stop, bool service) {
  updater::Log log(root / L"logs/manager.log");
  try {
    return SuperviseLoop(root, stop, service);
  } catch (const Failure& failure) {
    log.Event(LogLevel::kError, "manager.failed", LogErrorFields(failure.error));
  } catch (const fs::filesystem_error&) {
    log.Event(LogLevel::kError, "manager.filesystem_failed");
  } catch (...) {
    log.Event(LogLevel::kError, "manager.failed");
  }
  return 1;
}
}  // namespace remotekit::manager
