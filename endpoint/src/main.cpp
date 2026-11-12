#include "util/log.hpp"
#include "service.hpp"
#include "media/sdk_loader.hpp"
#include "management/cluster_link.hpp"
#include "cluster/node_files.hpp"
#include <bcrypt.h>
#include "util/thread.hpp"
#include "util/file_io.hpp"
#include <windows.h>
#include <mmsystem.h>
#include <fcntl.h>
#include <io.h>
#include <cstdio>
int main(int argc, char** argv) {
  using namespace remotekit;
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  struct TimerResolution {
    TimerResolution() { timeBeginPeriod(1); }
    ~TimerResolution() { timeEndPeriod(1); }
  } timer_resolution;
  int exit_code = 1;
  RunThread(
      "endpoint",
      [&] {
        auto parsed = ProcessOptions::Parse(argc, argv);
        if (!parsed) {
          LogError(LogLevel::kError, "endpoint.start_failed", parsed.error());
          return;
        }
        auto process = std::move(parsed).value();
        auto files = cluster::LoadNodeFiles(process.node_root);
        if (!files ||
            (process.stdio ? !files.value().control.empty() : files.value().control.empty())) {
          LogError(LogLevel::kError, "endpoint.start_failed",
                   files ? Error{ErrorCode::kInvalidRequest, "node.json carrier mismatch"}
                         : files.error());
          return;
        }
        const auto& key = files.value().private_key;
        const auto& control_public_key = files.value().control_public_key;
        const auto& control = files.value().control;
        const auto& node_id = files.value().node_id;
        wchar_t executable[32768]{};
        GetModuleFileNameW(nullptr, executable, 32768);
        auto build = cluster::ReadBuildId(fs::path(executable).parent_path().parent_path());
        if (!build) {
          LogError(LogLevel::kError, "endpoint.start_failed", build.error());
          return;
        }
        std::array<uint8_t, 16> incarnation{};
        if (BCryptGenRandom(nullptr, incarnation.data(), static_cast<ULONG>(incarnation.size()),
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
          return;
        cluster::Hello hello{"endpoint", node_id, build.value(), cluster::Hex(incarnation)};
        ClusterLink link(
            [&] {
              return process.stdio
                         ? cluster::ConnectStdio(key, control_public_key, hello)
                         : cluster::ConnectWebSocket(control, key, control_public_key, hello);
            },
            process.stdio, build.value(), hello.incarnation,
            [&](const Json& config) -> Result<void> {
              auto options =
                  RuntimeOptions::FromConfig(config, process.node_root, build.value(), node_id);
              if (!options) {
                LogError(LogLevel::kError, "endpoint.start_failed", options.error());
                return options.error();
              }
              return {};
            },
            !process.stdio);
        auto config = link.WaitReady();
        if (!config) {
          exit_code = link.ExitCode();
          return;
        }
        auto runtime =
            RuntimeOptions::FromConfig(config.value(), process.node_root, build.value(), node_id);
        auto options = std::move(runtime).value();
        options.SetConfigSource([&link, initial = config.value()] {
          auto current = link.WaitReady();
          return current ? current.value() : initial;
        });
        auto directory = CreateDirectories(options.data);
        if (!directory) {
          LogError(LogLevel::kError, "endpoint.start_failed", directory.error());
          return;
        }
        media::Sdk sdk;
        auto loaded = sdk.Open(options.browser.parent_path() / "remotekit_sdk.dll");
        if (!loaded) {
          LogError(LogLevel::kError, "endpoint.start_failed", loaded.error());
          return;
        }
        Service service(sdk, options, link, key, hello.incarnation);
        RunThread(
            "management dispatcher", [&] { exit_code = service.Run(); }, [&] { service.Fail(); });
        if (const auto link_exit = link.ExitCode())
          exit_code = link_exit;
        link.Flush();
      },
      [&] { exit_code = 1; });
  return exit_code;
}
