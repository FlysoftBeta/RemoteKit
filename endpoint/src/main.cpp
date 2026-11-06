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
          fprintf(stderr, "endpoint startup: %s\n", parsed.error().message.c_str());
          return;
        }
        auto process = std::move(parsed).value();
        cluster::Key key{};
        struct ClearKey {
          cluster::Key& key;
          ~ClearKey() { SecureZeroMemory(key.data(), key.size()); }
        } clear_key{key};
        std::string control;
        if (process.stdio) {
          auto encoded = Env("REMOTEKIT_CLUSTER_KEY");
          _putenv_s("REMOTEKIT_CLUSTER_KEY", "");
          auto decoded = cluster::DecodeKey(encoded);
          SecureZeroMemory(encoded.data(), encoded.size());
          if (!decoded) {
            fprintf(stderr, "endpoint startup: invalid cluster key\n");
            return;
          }
          key = decoded.value();
          SecureZeroMemory(decoded.value().data(), decoded.value().size());
        } else {
          auto files = cluster::LoadNodeFiles(process.node_root);
          if (!files) {
            fprintf(stderr, "endpoint startup: %s\n", files.error().message.c_str());
            return;
          }
          control = files.value().control;
          process.node_id = files.value().node_id;
          key = files.value().key;
        }
        wchar_t executable[32768]{};
        GetModuleFileNameW(nullptr, executable, 32768);
        auto build = cluster::ReadBuildId(fs::path(executable).parent_path().parent_path());
        if (!build) {
          fprintf(stderr, "endpoint startup: %s\n", build.error().message.c_str());
          return;
        }
        std::array<uint8_t, 16> incarnation{};
        if (BCryptGenRandom(nullptr, incarnation.data(), static_cast<ULONG>(incarnation.size()),
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
          return;
        cluster::Hello hello{"endpoint", process.node_id, build.value(), cluster::Hex(incarnation)};
        ClusterLink link(
            [&] {
              return process.stdio ? cluster::ConnectStdio(key, hello)
                                   : cluster::ConnectWebSocket(control, key, hello);
            },
            process.stdio, build.value(),
            [&](const Json& config) -> Result<void> {
              auto options = RuntimeOptions::FromConfig(config, process.node_root, build.value(),
                                                        process.node_id);
              if (!options) {
                fprintf(stderr, "endpoint startup: %s\n", options.error().message.c_str());
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
        auto runtime = RuntimeOptions::FromConfig(config.value(), process.node_root, build.value(),
                                                  process.node_id);
        const auto options = std::move(runtime).value();
        auto directory = CreateDirectories(options.data);
        if (!directory) {
          fprintf(stderr, "endpoint startup: %s\n", directory.error().message.c_str());
          return;
        }
        media::Sdk sdk;
        auto loaded = sdk.Open(options.browser.parent_path() / "remotekit_sdk.dll");
        if (!loaded) {
          fprintf(stderr, "endpoint startup: %s\n", loaded.error().message.c_str());
          return;
        }
        Service service(sdk, options, link, key);
        RunThread(
            "management dispatcher", [&] { exit_code = service.Run(); }, [&] { service.Fail(); });
        if (const auto link_exit = link.ExitCode())
          exit_code = link_exit;
        link.Flush();
      },
      [&] { exit_code = 1; });
  return exit_code;
}
