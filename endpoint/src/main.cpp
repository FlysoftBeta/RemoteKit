#include "service.hpp"
#include "media/sdk_loader.hpp"
#include "management/remote_link.hpp"
#include "remotekit/thread.hpp"
#include "remotekit/file_io.hpp"
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
        auto parsed = RuntimeOptions::Parse(argc, argv);
        if (!parsed) {
          fprintf(stderr, "endpoint startup: %s\n", parsed.error().message.c_str());
          return;
        }
        const auto options = std::move(parsed).value();
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
        std::unique_ptr<ManagementLink> link;
        if (options.control_url.empty())
          link = MakeStdioLink();
        else {
          auto remote = RemoteLink::Create(options.control_url, options.node_id,
                                           Env("REMOTEKIT_ENDPOINT_TOKEN"));
          if (!remote) {
            fprintf(stderr, "endpoint startup: %s\n", remote.error().message.c_str());
            return;
          }
          link = std::move(remote).value();
        }
        Service service(sdk, options, *link);
        RunThread(
            "management dispatcher", [&] { exit_code = service.Run(); }, [&] { service.Fail(); });
      },
      [&] { exit_code = 1; });
  return exit_code;
}
