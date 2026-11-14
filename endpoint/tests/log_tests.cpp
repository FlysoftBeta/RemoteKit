#include "coordination_fixture.hpp"
#include "util/log.hpp"
#include "util/wire_error.hpp"
#include "util/file_io.hpp"
#include "diagnostics/log_files.hpp"
#include "management/reply.hpp"
#include "protocol/limits.hpp"
#include "rtc/data_router.hpp"
#include "input/input.hpp"
#include "service.hpp"
#include "media/sdk_loader.hpp"
#include "runtime_config_fixture.hpp"
#include <windows.h>
#include <winioctl.h>
#include <io.h>
#include <share.h>
#include <fstream>
#include <future>
#include <regex>
#include <set>
#include <thread>
#include <iostream>
using namespace remotekit;
namespace remotekit {
class NativeErrorStateProbe {
 public:
  static Result<Json> Dispatch(Service& service, const Json& request) {
    return service.Dispatch(request, 1);
  }
};
}  // namespace remotekit
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}
void Take(Result<void> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
}
class Capture {
 public:
  explicit Capture(const fs::path& path) {
    fflush(stderr);
    saved_ = _dup(_fileno(stderr));
    file_ = _wfsopen(path.c_str(), L"wb", _SH_DENYNO);
    Check(file_ && saved_ >= 0, "open log capture");
    Check(_dup2(_fileno(file_), _fileno(stderr)) == 0, "redirect stderr");
  }
  ~Capture() {
    fflush(stderr);
    _dup2(saved_, _fileno(stderr));
    _close(saved_);
    fclose(file_);
  }

 private:
  int saved_;
  FILE* file_;
};
std::vector<Json> Records(const fs::path& path) {
  std::ifstream input(path);
  std::string line;
  std::vector<Json> result;
  while (std::getline(input, line))
    result.push_back(Json::parse(line));
  return result;
}
LogClock::time_point LocalTime(int year, int month, int day, int hour = 12) {
  std::tm value{};
  value.tm_year = year - 1900;
  value.tm_mon = month - 1;
  value.tm_mday = day;
  value.tm_hour = hour;
  value.tm_isdst = -1;
  return LogClock::from_time_t(mktime(&value));
}
void Writer(const fs::path& root) {
  auto now = LocalTime(2026, 11, 14);
  DailyLog writer(root, "endpoint", 1234, [&] { return now; });
  std::vector<std::thread> threads;
  for (int thread = 0; thread < 8; ++thread)
    threads.emplace_back([&, thread] {
      for (int item = 0; item < 50; ++item)
        writer.Write(LogLevel::kInfo, "test.concurrent",
                     {{"thread", thread}, {"item", item}, {"text", "a\nb\"c"}});
    });
  for (auto& thread : threads)
    thread.join();
  const auto records = Records(root / "2026-11-14/endpoint.jsonl");
  Check(records.size() == 400, "one record per concurrent call");
  const std::regex timestamp(R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$)");
  std::set<std::pair<int, int>> identities;
  for (const auto& row : records) {
    Check(row.at("lvl") == "info" && row.at("ev") == "test.concurrent" &&
              row.at("proc") == "endpoint" && row.at("pid") == 1234,
          "record envelope");
    Check(std::regex_match(row.at("ts").get<std::string>(), timestamp), "UTC timestamp");
    Check(row.at("text") == "a\nb\"c", "JSON escaping");
    identities.emplace(row.at("thread").get<int>(), row.at("item").get<int>());
  }
  Check(identities.size() == 400, "records never interleave");
  now = LocalTime(2026, 11, 15);
  writer.Write(LogLevel::kInfo, "test.rollover");
  Check(Records(root / "2026-11-15/endpoint.jsonl").size() == 1, "day rollover");
  DailyLog parts(root, "node", 1234, [&] { return now; }, 260, 100000);
  for (int i = 0; i < 10; ++i)
    parts.Write(LogLevel::kInfo, "test.part");
  Check(fs::exists(root / "2026-11-15/node.1.jsonl"), "part rollover");
  size_t lines = 0;
  for (const auto& entry : fs::directory_iterator(root / "2026-11-15")) {
    if (!entry.path().filename().string().starts_with("node"))
      continue;
    Check(entry.file_size() <= 260, "part size bound");
    lines += Records(entry.path()).size();
  }
  Check(lines == 10, "part rollover retains complete lines");
  {
    DailyLog budget(root, "snapshot", 1234, [&] { return now; }, 2000, 700);
    for (int i = 0; i < 20; ++i)
      budget.Write(LogLevel::kInfo, "test.budget");
  }
  DailyLog restarted(root, "snapshot", 1234, [&] { return now; }, 2000, 700);
  restarted.Write(LogLevel::kInfo, "test.after_restart");
  const auto budget = Records(root / "2026-11-15/snapshot.jsonl");
  Check(budget.back().at("ev") == "log.budget_exhausted", "budget marker retained on restart");
  Check(std::count_if(budget.begin(), budget.end(),
                      [](const auto& row) { return row.at("ev") == "log.budget_exhausted"; }) == 1,
        "budget marker once");
  Check(fs::file_size(root / "2026-11-15/snapshot.jsonl") <= 700, "daily budget bound");
  now = LocalTime(2026, 11, 16);
  restarted.Write(LogLevel::kInfo, "test.new_budget");
  Check(Records(root / "2026-11-16/snapshot.jsonl").front().at("ev") == "test.new_budget",
        "budget resets on day change");
}
void Prune(const fs::path& root) {
  for (const auto* day : {"2026-10-13", "2026-10-14", "2026-11-14"}) {
    fs::create_directories(root / day);
    std::ofstream(root / day / "endpoint.jsonl") << "test\n";
  }
  fs::create_directories(root / "crashes/browser/reports");
  for (const auto* name : {"old.dmp", "boundary.dmp", "new.dmp"})
    std::ofstream(root / "crashes/browser/reports" / name) << "dump";
  const auto bound = LocalTime(2026, 10, 14, 0);
  const auto set_time = [&](const char* name, LogClock::time_point time) {
    fs::last_write_time(root / "crashes/browser/reports" / name,
                        std::chrono::clock_cast<std::chrono::file_clock>(time));
  };
  set_time("old.dmp", bound - std::chrono::seconds(1));
  set_time("boundary.dmp", bound);
  set_time("new.dmp", bound + std::chrono::seconds(1));
  std::ofstream(root / "crashes/browser/metadata") << "live database";
  fs::last_write_time(
      root / "crashes/browser/metadata",
      std::chrono::clock_cast<std::chrono::file_clock>(bound - std::chrono::hours(24)));
  const auto locked = CreateFileW((root / "2026-10-13/endpoint.jsonl").c_str(), GENERIC_READ,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(locked != INVALID_HANDLE_VALUE, "locked prune file");
  PruneLogs(root, 31, "2026-11-14", {"browser"});
  Check(fs::exists(root / "2026-10-13/endpoint.jsonl"), "locked file retained");
  Check(fs::exists(root / "2026-10-14") && fs::exists(root / "2026-11-14"),
        "today and retention boundary retained");
  Check(!fs::exists(root / "crashes/browser/reports/old.dmp") &&
            fs::exists(root / "crashes/browser/reports/boundary.dmp") &&
            fs::exists(root / "crashes/browser/reports/new.dmp"),
        "crash mtime pruning");
  Check(fs::exists(root / "crashes/browser/metadata"), "Crashpad database metadata retained");
  CloseHandle(locked);
  PruneLogs(root, 31, "2026-11-14", {"browser"});
  Check(!fs::exists(root / "2026-10-13"), "unlocked expired directory removed");
  PruneLogs(root, 31, "2026-11-14");
  Check(!fs::exists(root / "crashes/browser/metadata"), "inactive Crashpad metadata pruned");
}
void Junction(const fs::path& link, const fs::path& target) {
  fs::create_directories(link);
  const auto substitute = L"\\??\\" + fs::absolute(target).wstring();
  struct Reparse {
    ULONG tag = IO_REPARSE_TAG_MOUNT_POINT;
    USHORT length = 0, reserved = 0;
    USHORT substitute_offset = 0, substitute_length = 0, print_offset = 0, print_length = 0;
    wchar_t text[32768]{};
  } data;
  data.substitute_length = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  data.print_offset = data.substitute_length + sizeof(wchar_t);
  memcpy(data.text, substitute.c_str(), data.substitute_length);
  data.length = 8 + data.print_offset + sizeof(wchar_t);
  const auto handle =
      CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                  FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Check(handle != INVALID_HANDLE_VALUE, "open junction");
  DWORD bytes = 0;
  const bool set = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &data, data.length + 8, nullptr,
                                   0, &bytes, nullptr) != FALSE;
  CloseHandle(handle);
  Check(set, "create junction");
}
void LogApi(const fs::path& root) {
  fs::create_directories(root / "2026-11-13");
  fs::create_directories(root / "2026-11-14");
  fs::create_directories(root / "crashes/browser/reports");
  fs::create_directories(root / "not-a-date");
  std::ofstream(root / "2026-11-13/browser-test.jsonl") << "late child output";
  std::ofstream(root / "2026-11-14/endpoint.jsonl", std::ios::binary) << "0123456789";
  std::ofstream(root / "crashes/browser/reports/test.dmp") << "dump";
  const auto modified = std::chrono::clock_cast<std::chrono::file_clock>(LocalTime(2026, 11, 14));
  fs::last_write_time(root / "2026-11-13/browser-test.jsonl", modified);
  fs::last_write_time(root / "crashes/browser/reports/test.dmp", modified);
  Check(Take(NodeLogDays(root))["days"] == Json::array({"2026-11-14", "2026-11-13"}),
        "date directories newest first");
  const auto files = Take(NodeLogList(root, "2026-11-14"))["files"];
  Check(files.size() == 3, "list includes older directory's late output and crash files");
  for (const auto& file : files)
    Check(file["mtime"].is_number_integer() && file["size"].is_number_integer(), "list metadata");
  for (const auto* path :
       {"../endpoint.jsonl", "C:/endpoint.jsonl", "/endpoint.jsonl", "2026-11-14/../endpoint.jsonl",
        "2026-11-14/a/b.jsonl", "2026-11-14/endpoint.3.jsonl", "2026-02-30/endpoint.jsonl",
        "2026-11-14/endpoint.jsonl:ads", "crashes/a/../secret"})
    Check(!ValidateLogPath(root, path), "invalid log path rejected");
  const auto outside = root.parent_path() / "outside";
  fs::create_directories(outside);
  std::ofstream(outside / "endpoint.jsonl") << "secret";
  Junction(root / "2026-11-12", outside);
  Junction(root / "crashes/link", outside);
  Check(!ValidateLogPath(root, "2026-11-12/endpoint.jsonl") &&
            !ValidateLogPath(root, "crashes/link/endpoint.jsonl"),
        "reparse directories rejected");
  Check(Take(NodeLogDays(root))["days"].size() == 2, "reparse date directories omitted");
  Junction(root.parent_path() / "linked-root", root);
  Check(ValidateLogPath(root.parent_path() / "linked-root", "2026-11-14/endpoint.jsonl") &&
            Take(NodeLogDays(root.parent_path() / "linked-root"))["days"].size() == 2,
        "configured root behind a junction accepted");
  Check(!ValidateLogPath(root.parent_path() / "linked-root", "2026-11-12/endpoint.jsonl"),
        "reparse below a junctioned root rejected");
  const Json params{{"path", "2026-11-14/endpoint.jsonl"}, {"offset", 3}, {"length", 4}};
  const auto read = Take(ReadNodeLog(root, params));
  Check(read["path"] == params["path"] && read["offset"] == 3 && read["size"] == 10 &&
            read["data"] == Json::binary(std::vector<uint8_t>{'3', '4', '5', '6'}),
        "read range");
  auto invalid = params;
  invalid["length"] = kLogWindowBytes + 1;
  Check(!ReadNodeLog(root, invalid), "length above limit rejected");
  invalid["length"] = 1.0;
  Check(!ReadNodeLog(root, invalid), "fractional number representation rejected");
  invalid = params;
  invalid["extra"] = true;
  Check(!ReadNodeLog(root, invalid), "unknown read field rejected");
  auto tail = params;
  tail["offset"] = 8;
  tail["length"] = kLogWindowBytes;
  Check(Take(ReadNodeLog(root, tail))["data"].get_binary().size() == 2, "EOF caps read");
  tail["offset"] = 12;
  Check(Take(ReadNodeLog(root, tail))["data"].get_binary().empty(), "offset past EOF");
  std::ofstream(root / "2026-11-14/endpoint.1.jsonl", std::ios::binary)
      << std::string(kLogWindowBytes, 'x');
  Check(Take(ReadNodeLog(root, {{"path", "2026-11-14/endpoint.1.jsonl"},
                                {"offset", 0},
                                {"length", kLogWindowBytes}}))["data"]
                .get_binary()
                .size() == kLogWindowBytes,
        "maximum read size");
  std::ofstream(root / "2026-11-14/browser-test.jsonl")
      << Json{{"ev", "chromium.log"}, {"severity", "FATAL"}, {"message", "fatal message"}}.dump()
      << '\n'
      << "not JSON FATAL\n";
  Check(LastBrowserFatal(root, "test") == "fatal message", "structured fatal selection");
  std::ofstream(root / "2026-11-14/browser-test.1.jsonl") << "latest has no fatal\n";
  Check(LastBrowserFatal(root, "test").empty(), "only newest browser log tail scanned");
}
void Search(const fs::path& root) {
  const auto logs = root / "logs/2026-11-14";
  fs::create_directories(logs);
  const std::string id = "e-0123456789";
  const auto line = [&](int index, bool nested = false) {
    return Json{{"index", index},
                {nested ? "err" : "errorId", nested ? Json{{"errorId", id}} : Json(id)}}
        .dump();
  };
  std::ofstream(logs / "endpoint.jsonl") << line(0) << '\n';
  std::ofstream(logs / "endpoint.1.jsonl") << line(1, true) << '\n';
  std::ofstream(logs / "endpoint.2.jsonl")
      << "malformed " << id << '\n'
      << Json{{"msg", id}, {"errorId", "other"}}.dump() << '\n';
  std::ofstream(logs / "endpoint.3.jsonl") << line(2) << '\n';
  const auto found = Take(SearchErrorLogs(root, id)).at("lines");
  Check(found == Json::array({line(0), line(1, true), line(2)}), "daily part matches oldest first");
  for (const auto& entry : fs::directory_iterator(logs))
    fs::remove(entry.path());
  {
    std::ofstream file(logs / "endpoint.3.jsonl");
    for (size_t index = 0; index < limits::logSearchLines; ++index)
      file << line(static_cast<int>(index)) << '\n';
  }
  auto boundary = Take(SearchErrorLogs(root, id));
  Check(boundary.at("lines").size() == limits::logSearchLines && !boundary.contains("truncated"),
        "search line count at limit accepted");
  std::ofstream(logs / "endpoint.3.jsonl", std::ios::app) << line(50) << '\n';
  boundary = Take(SearchErrorLogs(root, id));
  Check(boundary.at("lines").size() == limits::logSearchLines && boundary.at("truncated") == true,
        "search line one over omitted");
  {
    std::ofstream file(logs / "endpoint.3.jsonl");
    for (int index = 0; index < 70; ++index)
      file << line(index) << '\n';
  }
  const auto capped = Take(SearchErrorLogs(root, id)).at("lines");
  Check(capped.size() == limits::logSearchLines &&
            Json::parse(capped.front().get<std::string>()).at("index") == 20 &&
            Json::parse(capped.back().get<std::string>()).at("index") == 69,
        "newest fifty returned in chronological order");
  Check(!SearchErrorLogs(root, "e-BAD"), "malformed id rejected");
}
void SearchSizeBoundary(const fs::path& root) {
  fs::create_directories(root / "logs/2026-11-14");
  const std::string id = "e-0123456789";
  const auto path = root / "logs/2026-11-14/endpoint.jsonl";
  Json line{{"errorId", id}, {"padding", std::string(100, '\x01')}};
  const auto encoded = [&] {
    return Json{{"lines", Json::array({line.dump()})}, {"truncated", true}}.dump().size();
  };
  constexpr auto budget = limits::managementBytes - kReplyEnvelopeReserve;
  line["padding"] = line["padding"].get<std::string>() + std::string(budget - encoded(), 'x');
  Check(encoded() == budget, "encoded search fixture reaches exact budget");
  const Json too_large{{"errorId", id}, {"padding", std::string(limits::managementBytes, 'y')}};
  {
    std::ofstream file(path);
    file << too_large.dump() << '\n' << line.dump() << '\n';
  }
  auto result = Take(SearchErrorLogs(root, id));
  Check(result.at("lines").size() == 1 && result.at("truncated") == true &&
            result.dump().size() == budget,
        "exact encoded log search budget accepted with truncation marker");
  const Json request{{"id", std::string(limits::identityBytes, 'i')},
                     {"opId", std::string(limits::identityBytes, 'o')}};
  Check(ManagementReply(request, result).dump().size() <= limits::managementBytes,
        "log search plus envelope stays within management limit");
  line["padding"] = line["padding"].get<std::string>() + "x";
  std::ofstream(path) << line.dump() << '\n';
  result = Take(SearchErrorLogs(root, id));
  Check(result.at("lines").empty() && result.at("truncated") == true,
        "one byte beyond encoded search budget dropped");
}
class Link final : public ManagementLink {
 public:
  std::vector<Json> requests, replies;
  std::mutex mutex;
  std::optional<ReadyState> ReadyConfiguration() override {
    return ReadyState{1,
                      {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                       {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
                      "connection"};
  }
  size_t next = 0;
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    generation = 1;
    eof = next == requests.size();
    if (eof)
      return false;
    bytes = requests[next++].dump();
    return true;
  }
  bool Current(uint64_t generation) override { return generation == 1; }
  bool SendReply(uint64_t, const Json& reply) override {
    std::lock_guard lock(mutex);
    replies.push_back(reply);
    return true;
  }
  bool SendBinaryReply(uint64_t, const Json& header, std::span<const uint8_t> bytes) override {
    auto reply = header;
    reply["result"]["data"] = Json::binary(std::vector<uint8_t>(bytes.begin(), bytes.end()));
    return SendReply(1, reply);
  }
  bool SendEvent(const Json&, uint64_t, DeliveryFlag = {}) override { return true; }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override {
    return Json{{"ok", true}};
  }
};
void ServiceLogs(const fs::path& root) {
  const auto logs = root / "logs";
  const auto day = LocalLogDate();
  fs::create_directories(logs / day);
  fs::create_directories(logs / "2000-01-01");
  std::ofstream(logs / day / "endpoint.jsonl", std::ios::binary) << "0123456789";
  std::ofstream(logs / "2000-01-01/endpoint.jsonl") << "expired";
  const auto rpc = [](const char* method, Json params, const char* id) {
    auto request = test::Rpc(method, std::move(params), id);
    request.update(
        {{"id", id}, {"tenantId", ""}, {"sessionId", nullptr}, {"placementEpoch", nullptr}});
    return request;
  };
  Link link;
  link.requests = {test::NodeDesired(Json::array()), rpc("node.logs.days", Json::object(), "days"),
                   rpc("node.logs.list", {{"date", day}}, "list"),
                   rpc("node.logs.read",
                       {{"path", day + "/endpoint.jsonl"}, {"offset", 3}, {"length", 4}}, "read")};
  const auto options = Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"));
  media::Sdk sdk;
  Service service(sdk, options, link, {}, "endpoint");
  Check(service.Run() == 0, "log RPC service run");
  Check(fs::exists(logs / "2000-01-01"), "no pruning before settings");
  const auto reply = [&](const char* id) -> Json {
    for (const auto& row : link.replies)
      if (row["id"] == id)
        return row;
    throw std::runtime_error("missing log RPC reply");
  };
  Check(reply("days")["result"]["days"] == Json::array({day, "2000-01-01"}), "days node dispatch");
  Check(!reply("list")["result"]["files"].empty(), "list node dispatch");
  Check(reply("read")["result"] ==
            Json{{"path", day + "/endpoint.jsonl"},
                 {"offset", 3},
                 {"size", 10},
                 {"data", Json::binary(std::vector<uint8_t>{'3', '4', '5', '6'})}},
        "binary read dispatch header and bytes");
  Take(NativeErrorStateProbe::Dispatch(service,
                                       {{"type", "node.settings"}, {"logRetentionDays", 1}}));
  Check(!fs::exists(logs / "2000-01-01"), "first settings prunes node root");
  Check(!NativeErrorStateProbe::Dispatch(
            service, {{"type", "node.settings"}, {"logRetentionDays", 30}, {"extra", true}}),
        "settings unknown fields rejected");
}
void Boundaries(const fs::path& root) {
  fs::create_directories(root / "logs/2026-11-14");
  std::ofstream(root / "logs/2026-11-14/endpoint.jsonl") << "locked";
  const auto held = CreateFileW((root / "logs/2026-11-14/endpoint.jsonl").c_str(), GENERIC_READ, 0,
                                nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(held != INVALID_HANDLE_VALUE, "lock log");
  const auto read = ReadFileIfExists(root / "logs/2026-11-14/endpoint.jsonl");
  Check(!read && read.error().os && read.error().os->kind == OsError::Kind::kWin32 &&
            read.error().os->value == ERROR_SHARING_VIOLATION,
        "sharing violation captured structurally");
  Link link;
  auto desired = test::Desired();
  auto conflict = desired;
  conflict["profileKey"] = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
  auto search = test::Rpc("node.logs.search", {{"errorId", "e-0123456789"}}, "search");
  search.update({{"tenantId", ""}, {"sessionId", nullptr}, {"placementEpoch", nullptr}});
  auto shutdown = test::Rpc("shutdown", Json::object(), "shutdown");
  shutdown.update({{"tenantId", ""}, {"sessionId", nullptr}, {"placementEpoch", nullptr}});
  link.requests = {test::NodeDesired(Json::array({test::Placement()})), search, desired, conflict,
                   shutdown};
  for (size_t index = 0; index < link.requests.size(); ++index)
    link.requests[index]["id"] = index;
  auto config = TestConfig();
  const auto options = Take(RuntimeOptions::FromConfig(config, root, "dev", "test"));
  media::Sdk sdk;
  const auto capture_path = root / "boundaries.jsonl";
  std::string once;
  Json dc_reply;
  Json input_reply;
  {
    Capture capture(capture_path);
    {
      Service service(sdk, options, link, {}, "endpoint");
      Check(service.Run() == 0, "management fixture");
    }
    Error error = WithOsError(ErrorCode::kUnavailable, "shared file", OsError::Kind::kWin32,
                              ERROR_SHARING_VIOLATION);
    auto first = WireError(error, "dc.request_failed", {{"method", "test.once"}});
    auto second = WireError(error, "dc.request_failed", {{"method", "test.once"}});
    once = first.at("errorId");
    Check(first == second && ValidErrorId(once), "error id assigned once");
    const auto expected = WireError(Error{ErrorCode::kConflict, "conflict"}, "dc.request_failed");
    Check(!expected.contains("errorId"), "conflict has no error id");
    DataRouter router(
        {.peer = [] { return uint64_t(1); },
         .stamp = [] { return uint64_t(1); },
         .epoch = [] { return uint64_t(1); },
         .current = [](const RtcEvent&) { return true; },
         .input = [](const RtcEvent&) { throw std::runtime_error("injected input failure"); },
         .received = [](const RtcEvent&) {},
         .send = [&](const Json& reply, uint64_t) { dc_reply = reply; }});
    RtcEvent event{};
    event.peer = 1;
    event.bytes = Json{{"type", "input"}, {"authEpoch", uint64_t(1)}}.dump();
    Take(router.Receive(event));
    router.Drain();
    std::promise<Json> input_result;
    auto input_future = input_result.get_future();
    InputController input(
        "1", {.control = [] { return uint64_t(1); },
              .admitted = [](const RtcEvent&) { return true; },
              .admission = [] { return AuthorizationController::AdmissionToken{1, 1, 1}; },
              .revalidate = [](const auto&) { return true; },
              .rpc = [](auto&&...) -> Result<Json> {
                return Json{{"ok", false},
                            {"error",
                             {{"code", "unavailable"},
                              {"message", "Browser unavailable"},
                              {"reason", "browser_restarting"}}}};
              },
              .send = [&](const Json& reply, uint64_t) { input_result.set_value(reply); },
              .failed = [] {},
              .log_fields = {{"tenantId", "input-tenant"}, {"sessionId", "input-session"}}});
    input.Start(1);
    RtcEvent layout{};
    layout.peer = 1;
    layout.authorization = 1;
    layout.message = {{"type", "keyboard.layout"}};
    input.QueueInput(layout);
    Check(input_future.wait_for(std::chrono::seconds(5)) == std::future_status::ready,
          "Browser error reply delivered");
    input_reply = input_future.get();
    input.Stop();
  }
  CloseHandle(held);
  const auto reply = [&](int id) {
    for (const auto& value : link.replies)
      if (value["id"] == id)
        return value;
    throw std::runtime_error("missing log reply");
  };
  Check(reply(1).at("error").at("code") == "unavailable" &&
            ValidErrorId(reply(1).at("error").at("errorId").get<std::string>()),
        "management error id");
  Check(reply(3).at("error").at("code") == "conflict" && !reply(3).at("error").contains("errorId"),
        "management conflict has no id");
  Check(ValidErrorId(dc_reply.at("error").at("errorId").get<std::string>()),
        "DataChannel boundary id");
  Check(ValidErrorId(input_reply.at("error").at("errorId").get<std::string>()) &&
            input_reply.at("error").at("reason") == "browser_restarting",
        "raw Browser reply gets an id and preserves its reason");
  std::map<std::string, int> counts;
  for (const auto& row : Records(capture_path))
    if (row.contains("err") && row["err"].contains("errorId")) {
      ++counts[row["err"]["errorId"].get<std::string>()];
      if (row["err"]["errorId"] == once)
        Check(row["err"]["os"] == Json{{"kind", "win32"}, {"value", 32}}, "OS code logged");
      if (row["err"]["errorId"] == input_reply.at("error").at("errorId"))
        Check(row.at("tenantId") == "input-tenant" && row.at("sessionId") == "input-session" &&
                  row.at("method") == "keyboard.layout",
              "boundary log retains its Session identity");
    }
  Check(counts.size() == 4, "only operational errors get ids");
  for (const auto& [id, count] : counts)
    Check(count == 1, "each error id logged once");
}
void ParentOutputAndSdk(const fs::path& root) {
  InitLog(root, "node");
  {
    ProcessOutput output("endpoint", 5678, "stderr");
    output.Append("first\r\nsec");
    output.Append("ond\npartial");
  }
  media::SdkLogSink(nullptr, REMOTEKIT_SDK_LOG_WARN, "test.event", "{\"value\":42}");
  media::SdkLogSink(nullptr, REMOTEKIT_SDK_LOG_ERROR, "test.event", std::string(5000, 'x').c_str());
  const auto records = Records(root / LocalLogDate() / "node.jsonl");
  Check(records.size() == 5, "child lines and SDK records");
  Check(records[0]["text"] == "first" && records[1]["text"] == "second" &&
            records[2]["text"] == "partial" && records[0]["child"] == "endpoint" &&
            records[0]["childPid"] == 5678 && records[0]["stream"] == "stderr" &&
            records[0]["proc"] == "node",
        "child output framing and partial flush");
  Check(records[3]["ev"] == "sdk.test.event" && records[3]["value"] == 42 &&
            records[3]["lvl"] == "warn",
        "SDK sink event and fields");
  Check(
      records[4]["ev"] == "sdk.log_invalid" && records[4]["text"].get<std::string>().size() == 4096,
      "SDK invalid fields bounded");
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  const auto root = fs::path(argv[1]) / (L"logs-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directories(root);
    Writer(root);
    Prune(root / "prune");
    LogApi(root / "api");
    Search(root / "search");
    SearchSizeBoundary(root / "search-boundary");
    ServiceLogs(root / "service-api");
    Boundaries(root / "boundaries");
    ParentOutputAndSdk(root / "parent");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
