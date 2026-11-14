#include "session/control_reliability.hpp"
#include "rtc/outbox.hpp"
#include "session/browser_rpc.hpp"
#include "session/browser.hpp"
#include "session/navigation_export.hpp"
#include "media/presentation_barrier.hpp"
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <condition_variable>
#include <thread>
#include "util/thread.hpp"
#include "util/wire_error.hpp"
#include "util/error_policy.hpp"

#define CHECK(x)                                    \
  do {                                              \
    if (!(x)) {                                     \
      std::cerr << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                 \
    }                                               \
  } while (false)
using Json = nlohmann::json;

void RpcLockAndStatusMapping() {
  using remotekit::ErrorCode;
  CHECK(remotekit::SdkErrorCode(REMOTEKIT_SDK_CHANNEL_CLOSED) == ErrorCode::kUnavailable);
  CHECK(remotekit::SdkErrorCode(REMOTEKIT_SDK_LOST) == ErrorCode::kOutcomeUnknown);
  CHECK(remotekit::SdkErrorCode(REMOTEKIT_SDK_BUSY) == ErrorCode::kBusy);
  CHECK(remotekit::BrowserRpc::ReplyError(
            {{"error", {{"code", "internal"}, {"message", "Browser invariant"}}}})
            .code == ErrorCode::kInternal);
  struct BlockingRequest {
    std::mutex mutex;
    std::condition_variable wake;
    bool entered = false, released = false;
  } blocking;
  static BlockingRequest* current;
  current = &blocking;
  remotekit::media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char*, uint64_t* handle) {
    *handle = 1;
    return 0;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  sdk.remotekit_sdk_control_request = [](uint64_t, const void*, size_t, void* output, size_t,
                                         size_t* count, uint32_t) {
    std::unique_lock lock(current->mutex);
    current->entered = true;
    current->wake.notify_all();
    current->wake.wait(lock, [] { return current->released; });
    const std::string bytes = "{\"ok\":true}";
    std::memcpy(output, bytes.data(), bytes.size());
    *count = bytes.size();
    return 0;
  };
  remotekit::BrowserRpc browser(sdk);
  CHECK(browser.Connect("test"));
  bool completed = false, failed = false;
  std::thread worker([&] {
    remotekit::RunThread(
        "blocking RPC", [&] { completed = bool(browser.Request(Json::object())); },
        [&] { failed = true; });
  });
  {
    std::unique_lock lock(blocking.mutex);
    blocking.wake.wait(lock, [&] { return blocking.entered; });
  }
  const auto busy = browser.Request(Json::object(), 0, 10000, true);
  CHECK(!busy && busy.error().code == ErrorCode::kBusy && browser.Control() == 1);
  {
    std::lock_guard lock(blocking.mutex);
    blocking.released = true;
  }
  blocking.wake.notify_all();
  worker.join();
  CHECK(completed && !failed);
  sdk.remotekit_sdk_control_request = [](uint64_t, const void*, size_t, void*, size_t, size_t*,
                                         uint32_t) { return 6; };
  const auto too_small = browser.Request(Json::object());
  CHECK(!too_small && too_small.error().code == ErrorCode::kOutcomeUnknown && browser.Control());
}

void InputWireFailures() {
  int calls = 0, retries = 0, waits = 0, exhausted = 0;
  bool identity = true, expired = false;
  Json application;
  remotekit::media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char*, uint64_t* handle) {
    *handle = 1;
    return 0;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  // The callback needs state without capturing because it mirrors the C ABI.
  struct Fixture {
    int* calls;
    Json* application;
  } fixture{&calls, &application};
  static Fixture* current;
  current = &fixture;
  sdk.remotekit_sdk_control_request = [](uint64_t, const void* input, size_t size, void* output,
                                         size_t, size_t* count, uint32_t) {
    const auto wire =
        Json::parse(static_cast<const char*>(input), static_cast<const char*>(input) + size);
    CHECK(wire.at("sequence") == "41");
    CHECK(wire.at("version") == 1);
    CHECK(wire.at("id") == ++*current->calls);
    const auto response =
        current->application->is_null()
            ? (*current->calls < 3
                   ? Json{{"ok", false},
                          {"error", {{"code", "busy"}, {"message", "Input queue full"}}}}
                   : Json{{"ok", true}, {"accepted", true}})
            : *current->application;
    auto bytes = response.dump();
    *count = bytes.size();
    std::memcpy(output, bytes.data(), bytes.size());
    return 0;
  };
  remotekit::BrowserRpc browser(sdk);
  CHECK(browser.Connect("test"));
  auto rpc = [&](const Json& request) { return browser.Exchange(request); };
  auto dispatch = [&] {
    return remotekit::RetryBrowserInput(
        Json{{"method", "input"}, {"sequence", "41"}}, rpc, [&] { return identity; },
        [&] { return expired; }, [&](auto) { ++waits; }, [&] { ++retries; }, [&] { ++exhausted; });
  };
  CHECK(dispatch().value().at("ok") == true);
  CHECK(calls == 3 && retries == 2 && waits == 2 && exhausted == 0);
  // An accepted injection's later status is not a pre-admission BUSY.
  application = {{"ok", true}, {"accepted", true}, {"injectionStatus", "failed"}};
  CHECK(dispatch().value().at("accepted") == true);
  CHECK(calls == 4 && retries == 2);
  application = {{"ok", false}, {"error", {{"code", "conflict"}, {"message", "target mismatch"}}}};
  CHECK(remotekit::BrowserRpc::ReplyError(application).message == "target mismatch");
  CHECK(dispatch().value() == application);
  CHECK(calls == 5 && retries == 2);
  CHECK(dispatch().value() == application);
  application = {{"ok", false}, {"error", {{"code", "busy"}, {"message", "queue full"}}}};
  identity = false;
  CHECK(dispatch().error().code == remotekit::ErrorCode::kConflict);
  CHECK(calls == 7 && retries == 2);
  identity = true;
  expired = true;
  CHECK(dispatch().error().code == remotekit::ErrorCode::kBusy);
  CHECK(exhausted == 1 && calls == 8);
  expired = false;
  const auto before = calls;
  CHECK(dispatch().error().code == remotekit::ErrorCode::kBusy);
  CHECK(calls - before == remotekit::RetryUnit::kBusyAttempts && exhausted == 2);
  application = {{"ok", false},
                 {"error", {{"code", "outcome_unknown"}, {"message", "partial injection"}}},
                 {"inputAdmitted", true}};
  const auto admitted_calls = calls;
  CHECK(dispatch().value() == application && calls == admitted_calls + 1);
  sdk.remotekit_sdk_control_request = [](uint64_t, const void*, size_t, void*, size_t, size_t*,
                                         uint32_t) { return 5; };
  auto timeout = rpc(Json::object());
  CHECK(!timeout && timeout.error().code == remotekit::ErrorCode::kOutcomeUnknown);
  CHECK(browser.Control() == 1 && !browser.Disconnected());
  sdk.remotekit_sdk_control_request = [](uint64_t, const void*, size_t, void*, size_t, size_t*,
                                         uint32_t) -> int { return REMOTEKIT_SDK_CHANNEL_CLOSED; };
  auto disconnected = rpc(Json::object());
  CHECK(!disconnected && !browser.Control() && browser.Disconnected());
  auto unavailable = rpc(Json::object());
  CHECK(!unavailable && unavailable.error().code == remotekit::ErrorCode::kUnavailable);
}
void OpenRenderLifetimeAndStartupBackoff() {
  remotekit::BrowserStartPolicy starts;
  CHECK(starts.Admit(0) && !starts.Admit(.5));
  CHECK(starts.Admit(1) && !starts.Admit(2));
  CHECK(starts.Admit(3) && !starts.Admit(100));
  starts.Healthy(63);
  CHECK(starts.Admit(63));
  remotekit::media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char*, uint64_t* handle) {
    *handle = 1;
    return 0;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  remotekit::BrowserRpc browser(sdk);
  CHECK(browser.Connect("test"));
  sdk.remotekit_sdk_control_open_render = [](uint64_t, uint32_t, remotekit_sdk_render_setup*,
                                             uint32_t, remotekit_sdk_failure*) -> int {
    return REMOTEKIT_SDK_TIMEOUT;
  };
  remotekit_sdk_render_setup setup{};
  auto timeout = browser.OpenRender(setup);
  CHECK(!timeout && timeout.error().code == remotekit::ErrorCode::kOutcomeUnknown);
  CHECK(browser.Control() == 1 && browser.NeedsHealthCheck() && !browser.Disconnected());
  sdk.remotekit_sdk_control_request = [](uint64_t, const void*, size_t, void* output, size_t,
                                         size_t* count, uint32_t) {
    const std::string bytes = "{\"ok\":true}";
    *count = bytes.size();
    std::memcpy(output, bytes.data(), bytes.size());
    return 0;
  };
  CHECK(browser.Request({{"method", "snapshot"}}) && !browser.NeedsHealthCheck());
  sdk.remotekit_sdk_control_open_render = [](uint64_t, uint32_t, remotekit_sdk_render_setup*,
                                             uint32_t, remotekit_sdk_failure*) -> int {
    return REMOTEKIT_SDK_CHANNEL_CLOSED;
  };
  CHECK(!browser.OpenRender(setup) && !browser.Control() && browser.Disconnected());
  browser.Invalidate();
  CHECK(!browser.Disconnected());  // A new process cannot inherit old disconnect evidence.
}

void ControlBackpressure() {
  remotekit::ControlOutbox box;
  auto now = remotekit::RetryUnit::Clock::now();
  box.Bind({1, 1});
  std::vector<std::string> sent;
  std::string busy = "mode";
  auto send = [&](const std::string& bytes) -> int {
    if (bytes == busy)
      return REMOTEKIT_SDK_BUSY;
    sent.push_back(bytes);
    return 0;
  };
  box.Replace({1, 1}, "mode", "layout1", "prepare1");
  for (int i = 0; i < 100; ++i)
    box.Flush({1, 1}, send, now);
  CHECK(sent.empty());
  box.Transient({1, 1}, "frame", send);
  CHECK(sent.empty());
  now += std::chrono::seconds(6);
  busy = "layout1";
  box.Flush({1, 1}, send, now);
  CHECK(sent == std::vector<std::string>{"mode"});
  now += std::chrono::seconds(6);
  busy = "prepare1";
  box.Flush({1, 1}, send, now);
  CHECK((sent == std::vector<std::string>{"mode", "layout1"}));
  for (int i = 0; i < 100; ++i) {
    box.Replace({1, 1}, "", "layout1", "prepare1");
    box.Flush({1, 1}, send, now);
  }
  CHECK((sent == std::vector<std::string>{"mode", "layout1"}));  // BUSY head never rewinds.
  // Superseding layout revokes the old pending prepare, even under long BUSY.
  box.Replace({1, 1}, "", "layout2", "prepare2");
  busy = "prepare2";
  box.Flush({1, 1}, send, now);
  CHECK((sent == std::vector<std::string>{"mode", "layout1", "mode", "layout2"}));
  now += std::chrono::seconds(6);
  busy = "";
  box.Flush({1, 1}, send, now);
  CHECK(sent.back() == "prepare2");
  CHECK(std::find(sent.begin(), sent.end(), "prepare1") == sent.end());
  const auto admitted = sent.size();
  for (int i = 0; i < 100; ++i) {
    box.Replace({1, 1}, "", "layout2", "prepare2");
    box.Flush({1, 1}, send, now);
  }
  CHECK(sent.size() == admitted);  // Identical transactions are already reliable.
  box.Replace({1, 1}, "", "old-layout", "old-prepare");
  box.Bind({2, 1});
  box.Flush({1, 1}, send, now);
  box.Replace({1, 1}, "bad-mode", "bad-layout", "bad-prepare");
  const auto count = sent.size();
  box.Flush({2, 1}, send, now);
  CHECK(sent.size() == count);
  box.Replace({2, 1}, "mode2", "layout3", "prepare3");
  box.Flush({2, 1}, send, now);
  CHECK(sent.back() == "prepare3");
  // Outbox admission does not release the media gate; only matching ACK does.
  remotekit::PresentationBarrier gate;
  gate.Bind(2);
  gate.Video(2);
  auto key = gate.Layout(3, 4);
  CHECK(key);
  bool published = false;
  gate.Send(2, 4, true, [&] {
    published = true;
    return true;
  });
  CHECK(!published);
  CHECK(gate.Ready(2, *key));
  gate.Send(2, 4, true, [&] {
    published = true;
    return true;
  });
  CHECK(published);
}

struct ExportFixture {
  remotekit::NavigationExport exporter;
  Json current = {{"view", "1"},
                  {"instance", "3"},
                  {"document", "5"},
                  {"navigationRevision", "7"},
                  {"close_state", "open"}};
  Json saved = {{"previous", true}};
  std::string incarnation = "browser1";
  int begin = 0, chunks = 0, cancel = 0, reads = 0, writes = 0;
  bool disk_fail = false;
  bool failed = false;
  void Observe() { exporter.Observe(current, incarnation, true); }
  void Tick() {
    auto result = exporter.Tick(
        incarnation,
        [&](const auto& view) -> Json {
          ++reads;
          return current.is_object() && current.at("view") == view ? current : Json();
        },
        [&](const Json& request) -> Json {
          const auto method = request.at("method");
          if (method == "navigation.export.begin") {
            ++begin;
            return {{"transfer", "11"},
                    {"size", std::to_string(3 * 256 * 1024)},
                    {"navigationRevision", "7"}};
          }
          if (method == "navigation.export.chunk") {
            ++chunks;
            CHECK(request.at("length") == 256 * 1024);
            return {{"data", "fake-256KiB"}};
          }
          CHECK(method == "navigation.transfer.cancel");
          ++cancel;
          return {{"ok", true}};
        },
        [](const auto&) { return 256 * 1024; },
        [&](const auto& view, const Json& data) -> remotekit::Result<void> {
          CHECK(view == "1");
          if (disk_fail)
            return remotekit::Error{remotekit::ErrorCode::kUnavailable, "disk failure"};
          ++writes;
          saved = data;
          return {};
        });
    failed = !result;
  }
};

void IncrementalExport() {
  ExportFixture f;
  f.Observe();
  CHECK(f.begin == 0);
  f.Tick();
  CHECK(f.begin == 1 && f.chunks == 0);
  int other_session_commands = 0;
  for (int i = 0; i < 3; ++i) {
    f.Observe();  // Frequent snapshots cannot restart the active export.
    const auto before = f.chunks;
    f.Tick();
    CHECK(f.chunks == before + 1);
    ++other_session_commands;
    CHECK(f.saved.contains("previous"));
    CHECK(f.begin == 1 && f.writes == 0);
  }
  CHECK(other_session_commands == 3);
  f.Tick();
  CHECK(f.writes == 1 && f.cancel == 1);
  CHECK(f.saved.at("chunks").size() == 3 && !f.exporter.Pending());
  // Navigation, close, Browser incarnation, instance and lifecycle changes each cancel,
  // preserving the last atomically committed recovery state.
  for (int scenario = 0; scenario < 6; ++scenario) {
    ExportFixture cancelled;
    cancelled.Observe();
    cancelled.Tick();
    cancelled.Tick();
    if (scenario == 0)
      cancelled.current["navigationRevision"] = "8";
    if (scenario == 1)
      cancelled.current = nullptr;
    if (scenario == 2)
      cancelled.incarnation = "browser2";
    if (scenario == 3)
      cancelled.current["instance"] = "4";
    if (scenario == 4)
      cancelled.current["pending"] = true;
    if (scenario == 5)
      cancelled.current["lifecycle_uncertain"] = true;
    cancelled.Tick();
    CHECK(cancelled.cancel == 1 && cancelled.chunks == 1 && cancelled.writes == 0);
    CHECK(cancelled.saved.contains("previous"));
  }
  ExportFixture uncertain;
  uncertain.current["lifecycle_uncertain"] = true;
  uncertain.Observe();
  uncertain.Tick();
  CHECK(uncertain.begin == 0 && !uncertain.exporter.Pending());
  uncertain.current["lifecycle_uncertain"] = false;
  uncertain.Observe();
  for (int i = 0; i < 5; ++i)
    uncertain.Tick();
  CHECK(uncertain.begin == 1 && uncertain.writes == 1);
  ExportFixture forgotten;
  forgotten.Observe();
  forgotten.Tick();
  forgotten.exporter.Forget("1");
  forgotten.Tick();
  CHECK(forgotten.cancel == 1 && forgotten.writes == 0);
  ExportFixture failed;
  failed.Observe();
  for (int i = 0; i < 4; ++i)
    failed.Tick();
  failed.disk_fail = true;
  failed.Tick();
  CHECK(failed.failed && failed.saved.contains("previous") && failed.exporter.Pending());
  // Fairness between two views: bounded active transfer then next candidate.
  ExportFixture multiple;
  multiple.Observe();
  auto second = multiple.current;
  second["view"] = "2";
  multiple.exporter.Observe(second, multiple.incarnation, true);
  for (int i = 0; i < 5; ++i)
    multiple.Tick();
  CHECK(multiple.writes == 1);
  // The second candidate vanished before selection; no stale begin is issued.
  multiple.Tick();
  CHECK(multiple.begin == 1 && !multiple.exporter.Pending());
}
void OversizedBrowserReplyIsApplicationError() {
  remotekit::media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char*, uint64_t* handle) {
    *handle = 1;
    return 0;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  sdk.remotekit_sdk_control_request = [](uint64_t, const void* input, size_t size, void* output,
                                         size_t, size_t* count, uint32_t) {
    const auto request =
        Json::parse(static_cast<const char*>(input), static_cast<const char*>(input) + size);
    const auto serial = request.at("id").get<uint64_t>();
    const auto reply =
        serial == 1
            ? Json{{"ok", false},
                   {"error", {{"code", "outcome_unknown"}, {"message", "response_too_large"}}}}
            : Json{{"ok", true}, {"id", serial}};
    const auto bytes = reply.dump();
    *count = bytes.size();
    std::memcpy(output, bytes.data(), bytes.size());
    return 0;
  };
  remotekit::BrowserRpc browser(sdk);
  CHECK(browser.Connect("test"));
  auto rejected = browser.Request(Json{{"method", "snapshot"}});
  CHECK(!rejected && rejected.error().code == remotekit::ErrorCode::kOutcomeUnknown);
  CHECK(rejected.error().message.find("response_too_large") != std::string::npos);
  auto next = browser.Request(Json{{"method", "snapshot"}});
  CHECK(next && next.value().at("id") == 2);
}

void BrowserLocalSessionNumbers() {
  remotekit::media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char*, uint64_t* handle) {
    *handle = 1;
    return 0;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  sdk.remotekit_sdk_control_request = [](uint64_t, const void* input, size_t size, void* output,
                                         size_t, size_t* count, uint32_t) {
    const auto command =
        Json::parse(static_cast<const char*>(input), static_cast<const char*>(input) + size);
    CHECK(command.at("session") == "1");
    CHECK(command.at("viewConfigs").at(0).at("session") == "1");
    CHECK(command.at("viewConfigs").at(0).at("view") == "42");
    const std::string reply = "{\"ok\":true}";
    std::memcpy(output, reply.data(), reply.size());
    *count = reply.size();
    return 0;
  };
  remotekit::BrowserRpc browser(sdk);
  CHECK(browser.Connect("test"));
  CHECK(browser.Request(
      {{"method", "output.configure"},
       {"session", "0123456789abcdef0123456789abcdef"},
       {"viewConfigs",
        Json::array({{{"session", "0123456789abcdef0123456789abcdef"}, {"view", "42"}}})}}));
}

int main() {
  BrowserLocalSessionNumbers();
  RpcLockAndStatusMapping();
  OpenRenderLifetimeAndStartupBackoff();
  OversizedBrowserReplyIsApplicationError();
  InputWireFailures();
  ControlBackpressure();
  IncrementalExport();
  std::cout << "control reliability tests passed\n";
}
