#include "input/input.hpp"
#include "media/sdk_loader.hpp"
#include "media/render_slots.hpp"
#include <barrier>
#include <iostream>
#include <thread>
#include <vector>

using namespace remotekit;
namespace remotekit::media {
class NativeLifetimeProbe {
 public:
  static void Publish(RenderSlots& owner, const SharedAtlasFrame& frame) {
    owner.PublishSnapshot({}, frame);
  }
};
}  // namespace remotekit::media
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
void InputLifecycle() {
  InputController input("session", {});
  std::barrier start(8);
  std::vector<std::jthread> callers;
  for (unsigned caller = 0; caller < 8; ++caller) {
    callers.emplace_back([&, caller] {
      start.arrive_and_wait();
      for (unsigned iteration = 0; iteration < 50; ++iteration) {
        if ((iteration + caller) % 2)
          input.Start(caller + 1);
        else
          input.Stop();
      }
    });
  }
  callers.clear();
  input.Stop();
  Check(input.Snapshot().at("inputQueue") == 0, "stopped input releases queued work");
  input.Start(1);
  input.Stop();
}
void MetadataSnapshot() {
  media::FrameAdmission admission;
  media::RenderSlots slots(admission);
  std::atomic<bool> done = false, coherent = true;
  std::barrier start(5);
  std::vector<std::jthread> readers;
  for (unsigned reader = 0; reader < 4; ++reader) {
    readers.emplace_back([&] {
      start.arrive_and_wait();
      do {
        const auto frame = slots.LatestMetadata();
        if (frame.generation &&
            (frame.view_count != 1 || frame.views[0].webview_id != frame.generation ||
             frame.views[0].session_id != frame.generation))
          coherent = false;
      } while (!done);
    });
  }
  start.arrive_and_wait();
  for (uint64_t generation = 1; generation <= 30000; ++generation) {
    SharedAtlasFrame frame{};
    frame.generation = generation;
    frame.view_count = 1;
    frame.views[0].webview_id = frame.views[0].session_id = generation;
    media::NativeLifetimeProbe::Publish(slots, frame);
  }
  done = true;
  readers.clear();
  Check(coherent, "metadata snapshots never mix publications");
  std::string error;
  Check(slots.Close(error), "close metadata owner");
  Check(slots.LatestMetadata().generation == 0, "close clears the published generation");
}
void SdkLifetime(const fs::path& fixture) {
  const auto name = fixture.filename().wstring();
  for (const int status : {int(REMOTEKIT_SDK_BUSY), int(REMOTEKIT_SDK_TIMEOUT),
                           int(REMOTEKIT_SDK_INVALID_STATE), -1, 0}) {
    Check(GetModuleHandleW(name.c_str()) == nullptr, "fixture initially unloaded");
    HMODULE retained = nullptr;
    {
      media::Sdk sdk;
      sdk.module = LoadLibraryW(fixture.c_str());
      Check(sdk.module != nullptr, "load fixture");
      retained = sdk.module;
      if (status == REMOTEKIT_SDK_BUSY)
        sdk.remotekit_sdk_shutdown = []() -> int { return REMOTEKIT_SDK_BUSY; };
      else if (status == REMOTEKIT_SDK_TIMEOUT)
        sdk.remotekit_sdk_shutdown = []() -> int { return REMOTEKIT_SDK_TIMEOUT; };
      else if (status == REMOTEKIT_SDK_INVALID_STATE)
        sdk.remotekit_sdk_shutdown = []() -> int { return REMOTEKIT_SDK_INVALID_STATE; };
      else if (status == 0)
        sdk.remotekit_sdk_shutdown = reinterpret_cast<decltype(sdk.remotekit_sdk_shutdown)>(
            GetProcAddress(sdk.module, "FixtureShutdown"));
    }
    Check((GetModuleHandleW(name.c_str()) != nullptr) == (status != 0),
          "SDK module retained until completed shutdown");
    if (status) {
      const auto completed =
          reinterpret_cast<int (*)()>(GetProcAddress(retained, "FixtureShutdown"));
      Check(completed && completed() == 0, "retained code remains callable");
      Check(FreeLibrary(retained) != FALSE, "release fixture after completion evidence");
    }
  }
}
}  // namespace
int wmain(int argc, wchar_t** argv) try {
  Check(argc == 2, "fixture DLL required");
  InputLifecycle();
  MetadataSnapshot();
  SdkLifetime(fs::absolute(argv[1]));
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
