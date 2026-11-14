#include "supervisor.hpp"
#include "snapshots.hpp"
#include "persistence/config_formats.hpp"
#include "release/executor.hpp"
#include "release/payload.hpp"
#include "updater/archive.hpp"
#include "updater/process.hpp"
#include "updater/snapshot.hpp"
#include "updater/replacement.hpp"
#include "util/retry_unit.hpp"
#include <atomic>
#include <thread>

namespace remotekit::manager {
using namespace release;
namespace {
struct Config {
  std::string manifest, proxy;
  DWORD interval;
};
Config LoadConfig(const fs::path& root) {
  auto bytes = Read(root / L"config/manager.json", 1024 * 1024);
  auto decoded = config_formats::Decode({reinterpret_cast<const char*>(bytes.data()), bytes.size()},
                                        config_formats::Manager, persisted::Store::kManager);
  auto json = Take(std::move(decoded));
  Config config;
  config.manifest = json.at("manifest").get<std::string>();
  Require(ValidUrl(config.manifest), "invalid manager manifest URL");
  config.interval = static_cast<DWORD>(json.at("checkIntervalMinutes").get<uint64_t>() * 60000);
  if (json.contains("proxy")) {
    config.proxy = json.at("proxy").get<std::string>();
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
Result<release::CurrentState> Current(const fs::path& root) {
  return release::ReadCurrent(root, L"versions", release::kControlFiles);
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
  std::string id;
  State state{};
  Http http(config.proxy, stop, &log);
  std::unique_ptr<updater::ChildProcess> child;
  std::map<std::string, std::unique_ptr<updater::SnapshotSupervisor>> snapshots;
  std::map<std::string, RetryUnit> snapshot_retries;
  ULONGLONG started = 0, check_at = 0, snapshot_check_at = 0, current_check_at = 0,
            replacement_check_at = 0;
  enum class Startup { kPending, kReady };
  auto startup = Startup::kPending;
  std::optional<std::string> reported_invalid;
  RetryUnit update_retry("manager.update"), process_retry("control"),
      replacement_retry("manager.replacement");
  std::atomic<bool> done = false;
  std::optional<std::string> installed;
  std::optional<Error> error;
  std::thread worker;
  auto stop_child = [&] {
    if (child) {
      child->Stop(60000);
      child.reset();
      log.Event(LogLevel::kInfo, "control.stopped");
    }
    snapshots.clear();
  };
  try {
    while (!updater::Stopping(stop)) {
      auto now = GetTickCount64();
      if (!worker.joinable() && (startup == Startup::kPending || now >= current_check_at)) {
        current_check_at = now + config.interval;
        auto current = Current(root);
        if (!current) {
          log.Event(LogLevel::kError, "manager.current_failed", LogErrorFields(current.error()));
          // A running Control keeps running: only a successful read may replace or stop it.
          if (startup == Startup::kPending) {
            if (updater::Delay(stop, 1000))
              break;
            continue;
          }
        }
        if (current) {
          const auto* missing = std::get_if<NotInstalled>(&current.value());
          const auto invalid = missing ? missing->invalid : std::nullopt;
          if (invalid && invalid != reported_invalid)
            log.Event(LogLevel::kWarn, "current.invalid", {{"message", *invalid}});
          reported_invalid = invalid;
          auto current_id = InstalledId(current.value());
          if (startup == Startup::kPending || current_id != id) {
            stop_child();
            id = current_id;
            Cleanup(root, id);
            state.current = id;
            state.base_usable = !id.empty() && BaseUsable(root / L"versions" / id);
            startup = Startup::kReady;
            replacement_check_at = 0;
          }
        }
      }
      if (worker.joinable() && done.load()) {
        worker.join();
        if (error) {
          check_at = update_retry.Status() == RetryUnit::State::kWaiting
                         ? now + static_cast<ULONGLONG>(std::max<int64_t>(
                                     0, std::chrono::duration_cast<std::chrono::milliseconds>(
                                            update_retry.Until() - RetryUnit::Clock::now())
                                            .count()))
                         : now + config.interval;
        } else {
          check_at = now + config.interval;
          if (installed && *installed != id) {
            stop_child();
            AtomicText(root / L"current", *installed);
            id = *installed;
            state.current = id;
            state.base_usable = true;
            try {
              Cleanup(root, id);
            } catch (const std::exception& failure) {
              log.Event(LogLevel::kWarn, "runtime.cleanup_failed", {{"message", failure.what()}});
            }
            replacement_check_at = 0;
            process_retry.Input(id);
          }
        }
      }
      replacement_retry.Input(id);
      if (!id.empty() && now >= replacement_check_at && replacement_retry.Ready()) {
        auto replaced = updater::ReplaceExecutable(
            root / L"remotekit_control.exe", root / L"versions" / id / L"bin/remotekit_control.exe",
            root, L"run --root=" + updater::Quote(root.wstring()), service, log);
        if (!replaced)
          replacement_retry.Fail(replaced.error());
        else {
          replacement_retry.Success();
          replacement_check_at = now + config.interval;
          if (replaced.value()) {
            stop_child();
            if (worker.joinable())
              worker.join();
            SecureZeroMemory(key.data(), key.size());
            return service ? 1 : 0;
          }
        }
      }
      process_retry.Input(id);
      if (child && WaitForSingleObject(child->handle(), 0) == WAIT_OBJECT_0) {
        log.Event(LogLevel::kWarn, "control.exited", {{"exitCode", child->ExitCode()}});
        child.reset();
        if (now - started >= 60000)
          process_retry.Success();
        process_retry.Fail({ErrorCode::kUnavailable, "control process exited"});
      }
      if (!child && !id.empty() && process_retry.Ready()) {
        try {
          child = StartControl(root, id, log, control_log);
          started = GetTickCount64();
        } catch (const std::exception& failure) {
          process_retry.Fail({ErrorCode::kUnavailable, failure.what()});
        }
      }
      if (child && now >= snapshot_check_at) {
        snapshot_check_at = now + 1000;
        try {
          auto bytes = Read(root / L"config/control.json", 1024 * 1024);
          auto control = Take(
              config_formats::Decode({reinterpret_cast<const char*>(bytes.data()), bytes.size()},
                                     config_formats::Control, persisted::Store::kControl));
          ReconcileSnapshots(
              control.at("nodes"), snapshots,
              [&](const std::string& node_id,
                  const Json& local_config) -> std::unique_ptr<updater::SnapshotSupervisor> {
                auto& retry =
                    snapshot_retries.try_emplace(node_id, "manager.snapshot").first->second;
                retry.Input(node_id);
                if (!retry.Ready())
                  return {};
                const auto local_text = local_config.at("root").get<std::string>();
                auto local = fs::path(std::u8string(local_text.begin(), local_text.end()));
                if (local.is_relative())
                  local = root / L"config" / local;
                auto executable = local / L"runtime" / id / L"bin/remotekit_snapshot.exe";
                if (local_config.contains("executable")) {
                  const auto text = local_config.at("executable").get<std::string>();
                  auto endpoint = fs::path(std::u8string(text.begin(), text.end()));
                  if (endpoint.is_relative())
                    endpoint = root / L"config" / endpoint;
                  executable = endpoint.parent_path() / L"remotekit_snapshot.exe";
                }
                auto supervisor = std::make_unique<updater::SnapshotSupervisor>(
                    fs::absolute(executable).lexically_normal(),
                    fs::absolute(local).lexically_normal(), node_id);
                retry.Success();
                return supervisor;
              },
              [&](const std::string& node_id, const std::exception& failure) {
                auto& retry = snapshot_retries.at(node_id);
                Error error{ErrorCode::kUnavailable, failure.what()};
                if (!retry.Failure())
                  log.Event(LogLevel::kWarn, "manager.snapshot_failed",
                            LogErrorFields(error, {{"nodeId", node_id}}));
                retry.Fail(error);
              });
        } catch (const std::exception& failure) {
          log.Event(LogLevel::kWarn, "manager.snapshot_config_failed",
                    {{"message", failure.what()}});
        }
      }
      if (!worker.joinable() && now >= check_at) {
        installed.reset();
        error.reset();
        done.store(false);
        worker = std::thread([&] {
          try {
            auto base = id.empty() ? fs::path() : root / L"versions" / id / L"payload.tar";
            auto result =
                Fetch(config.manifest, state, base, root / L"work", key, http, update_retry);
            if (result.build_id != id) {
              InstallPayload(root, result.path, result.build_id, PayloadSource::kMove);
              installed = result.build_id;
            }
            update_retry.Success();
          } catch (const Failure& failure) {
            error = failure.error;
          } catch (const fs::filesystem_error&) {
            error = Error{ErrorCode::kUnavailable, "release filesystem operation failed"};
          } catch (...) {
            error = Error{ErrorCode::kInternal, "release check failed"};
          }
          if (error) {
            const auto previous_status = update_retry.Status();
            update_retry.Fail(*error);
            if (previous_status == RetryUnit::State::kIdle)
              log.Event(LogLevel::kWarn, "manager.update_failed", LogErrorFields(*error));
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
