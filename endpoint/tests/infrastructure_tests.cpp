#include "management/link.hpp"
#include "options.hpp"
#include "persistence/session_store.hpp"
#include "platform/process.hpp"
#include "service.hpp"
#include "media/sdk_loader.hpp"
#include "util/thread.hpp"
#include <windows.h>
#include <array>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
using namespace remotekit;
void Check(bool value, const char* message) {
  if (!value)
    throw std::logic_error(message);
}
Result<RuntimeOptions> Options(std::string argument) {
  std::string executable = "endpoint";
  char* arguments[] = {executable.data(), argument.data()};
  return RuntimeOptions::Parse(2, arguments);
}
void NumericOptions() {
  const std::array names{
      "fps",          "bitrate",   "max-bitrate", "async-depth",      "gop",
      "target-usage", "buffer-ms", "idle-idr-ms", "max-encode-width", "max-encode-height"};
  for (const auto* name : names) {
    const std::string option = std::string("--") + name;
    for (const auto* invalid :
         {"", "1tail", "-1", "+1", " 1", "4294967296", "999999999999999999999"}) {
      auto parsed = Options(option + "=" + invalid);
      Check(!parsed && parsed.error().code == ErrorCode::kInvalidRequest &&
                parsed.error().message.find(option) != std::string::npos,
            "numeric option must reject the entire invalid value and name the option");
    }
  }
  Check(bool(Options("--fps=120")), "valid option boundary");
  Check(!Options("--fps=121"), "fps range");
  Check(!Options("--target-usage=0"), "target usage range");
  Check(!Options("--max-encode-width=4097"), "dimension range");
}
struct TemporaryDirectory {
  fs::path path = fs::temp_directory_path() /
                  (L"remotekit-infrastructure-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
                   std::to_wstring(GetTickCount64()));
  TemporaryDirectory() { fs::create_directories(path); }
  ~TemporaryDirectory() {
    std::error_code ignored;
    fs::remove_all(path, ignored);
  }
};
void Durability() {
  TemporaryDirectory directory;
  SessionStore store(directory.path);
  Check(bool(store.Save("state.json", {{"value", 1}})), "initial durable write");
  fs::create_directory(directory.path / "state.json.new");
  Check(!store.Save("state.json", {{"value", 2}}), "failed temp write must fail the transaction");
  Check(store.Load("state.json").at("value") == 1,
        "failed transaction must preserve committed state");
  Check(bool(store.Save("state.json", {{"value", 3}})), "replacement durable write");
  Check(store.Load("state.json").at("value") == 3, "committed replacement");
  Check(!fs::exists(directory.path / "state.json.new"), "temporary file is removed");
}
void ThreadFailure() {
  bool failed = false;
  std::thread worker([&] {
    RunThread(
        "injected failure", [] { throw std::logic_error("injected"); }, [&] { failed = true; });
  });
  worker.join();
  Check(failed, "thread exception must mark its owner failed");
  RunThread("failure callback", [] { throw 1; }, [] { throw 2; });
}
void ProcessOwnership() {
  Check(BrowserProcess::Quote(L"") == L"\"\"", "empty argument quoting");
  Check(BrowserProcess::Quote(L"a b\\") == L"\"a b\\\\\"", "trailing slash quoting");
  Check(BrowserProcess::Quote(L"a\"b") == L"\"a\\\"b\"", "embedded quote");
  wchar_t system[MAX_PATH]{};
  GetSystemDirectoryW(system, MAX_PATH);
  const fs::path executable = fs::path(system) / "cmd.exe";
  BrowserProcess process;
  auto started =
      process.Launch(executable, BrowserProcess::Quote(executable.wstring()) + L" /c exit 0");
  Check(bool(started), "suspended process launch and job assignment");
  Check(process.Present(), "retain exact process identity");
  Check(bool(process.Terminate()) && process.state() == BrowserProcess::State::kExited,
        "stop confirms process exit");
  process.ReleaseExited();
  Check(!process.Present() && process.state() == BrowserProcess::State::kStopped,
        "release confirmed process");
}
class FixtureLink final : public ManagementLink {
 public:
  SessionStore& store;
  fs::path directory;
  std::vector<Json> replies;
  size_t index = 0;
  explicit FixtureLink(SessionStore& value, fs::path path)
      : store(value), directory(std::move(path)) {}
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    static const std::vector<Json> requests{
        {{"id", 0}, {"method", "unknown"}, {"tenantId", "new-tenant"}},
        {{"id", 1}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 2}, {"method", "session.events.ack"}, {"tenantId", "tenant"}, {"eventIds", {"1"}}},
        {{"id", 3}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 4}, {"method", "session.events.ack"}, {"tenantId", "tenant"}, {"eventIds", {"1"}}},
        {{"id", 5}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 6}, {"method", "shutdown"}}};
    eof = index == requests.size();
    if (eof)
      return false;
    if (index == 2)
      fs::create_directory(directory / "sessions/1/events.json.new");
    generation = 7;
    bytes = requests[index++].dump();
    return true;
  }
  bool Current(uint64_t generation) override { return generation == 7; }
  bool SendReply(uint64_t generation, const Json& reply) override {
    Check(generation == 7, "request link generation");
    replies.push_back(reply);
    if (reply["id"] == 0)
      Check(store.Load("sessions.json")["tenants"].size() == 1,
            "unknown method must not register a tenant");
    return true;
  }
  bool SendEvent(const Json&, uint64_t) override { return true; }
  void OnDisconnect(Disconnect) override {}
};
void ManagementDispatch() {
  TemporaryDirectory directory;
  SessionStore store(directory.path);
  Check(bool(store.Save("sessions.json", {{"next", 2}, {"tenants", {{"tenant", "1"}}}})),
        "registry fixture");
  Check(bool(store.Save(
            "sessions/1/events.json",
            {{"next", 2},
             {"events",
              Json::array({{{"eventId", "1"}, {"type", "view.closed"}, {"viewId", "1"}}})}})),
        "event fixture");
  auto parsed = Options("--data-path=" + Utf8(directory.path));
  Check(bool(parsed), "fixture options");
  FixtureLink link(store, directory.path);
  media::Sdk sdk;
  Service service(sdk, parsed.value(), link);
  Check(service.Run() == 0, "management dispatch");
  Check(link.replies[0]["error"]["code"] == "invalid_request", "unknown method error code");
  Check(link.replies[1]["result"]["events"].size() == 1, "event loaded");
  Check(link.replies[2]["error"]["code"] == "unavailable",
        "failed acknowledgement reports persistence failure");
  Check(link.replies[3]["result"]["events"].size() == 1, "failed acknowledgement preserves memory");
  Check(link.replies[5]["result"]["events"].empty(), "acknowledged events removed");
  Check(store.Load("sessions/1/events.json")["events"].empty(), "acknowledgement committed");
}
}  // namespace
int main() {
  try {
    NumericOptions();
    Durability();
    ThreadFailure();
    ProcessOwnership();
    ManagementDispatch();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
