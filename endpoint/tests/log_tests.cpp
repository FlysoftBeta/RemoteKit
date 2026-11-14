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
#include <io.h>
#include <share.h>
#include <fstream>
#include <future>
#include <regex>
#include <set>
#include <thread>
#include <iostream>
using namespace remotekit;
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
void Writer(const fs::path& root) {
  const auto path = root / "concurrent.jsonl";
  {
    Capture capture(path);
    std::vector<std::thread> threads;
    for (int thread = 0; thread < 8; ++thread)
      threads.emplace_back([thread] {
        for (int item = 0; item < 50; ++item)
          LogEvent(LogLevel::kInfo, "test.concurrent",
                   {{"thread", thread}, {"item", item}, {"text", "a\nb\"c"}});
      });
    for (auto& thread : threads)
      thread.join();
  }
  const auto records = Records(path);
  Check(records.size() == 400, "one record per concurrent call");
  const std::regex timestamp(R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$)");
  std::set<std::pair<int, int>> identities;
  for (const auto& row : records) {
    Check(row.at("lvl") == "info" && row.at("ev") == "test.concurrent", "record envelope");
    Check(std::regex_match(row.at("ts").get<std::string>(), timestamp),
          "UTC timestamp with milliseconds");
    Check(row.at("text") == "a\nb\"c", "JSON escaping");
    identities.emplace(row.at("thread").get<int>(), row.at("item").get<int>());
  }
  Check(identities.size() == 400, "records never interleave");
}
void Search(const fs::path& root) {
  const auto logs = root / "logs";
  fs::create_directories(logs);
  const std::string id = "e-0123456789";
  const auto line = [&](int index, bool nested = false) {
    return Json{{"index", index},
                {nested ? "err" : "errorId", nested ? Json{{"errorId", id}} : Json(id)}}
        .dump();
  };
  std::ofstream(logs / "endpoint.log.4") << line(0) << '\n';
  std::ofstream(logs / "endpoint.log.2") << line(1, true) << '\n';
  std::ofstream(logs / "endpoint.log.1") << "malformed " << id << '\n'
                                         << Json{{"msg", id}, {"errorId", "other"}}.dump() << '\n';
  std::ofstream(logs / "endpoint.log") << line(2) << '\n';
  const auto found = Take(SearchErrorLogs(root, id)).at("lines");
  Check(found == Json::array({line(0), line(1, true), line(2)}), "rotated matches oldest first");
  for (const auto& entry : fs::directory_iterator(logs))
    fs::remove(entry.path());
  {
    std::ofstream file(logs / "endpoint.log");
    for (size_t index = 0; index < limits::logSearchLines; ++index)
      file << line(static_cast<int>(index)) << '\n';
  }
  auto boundary = Take(SearchErrorLogs(root, id));
  Check(boundary.at("lines").size() == limits::logSearchLines && !boundary.contains("truncated"),
        "search line count at limit accepted");
  std::ofstream(logs / "endpoint.log", std::ios::app) << line(50) << '\n';
  boundary = Take(SearchErrorLogs(root, id));
  Check(boundary.at("lines").size() == limits::logSearchLines && boundary.at("truncated") == true,
        "search line one over omitted");
  {
    std::ofstream file(logs / "endpoint.log");
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
  fs::create_directories(root / "logs");
  const std::string id = "e-0123456789";
  const auto path = root / "logs/endpoint.log";
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
  std::ofstream(path, std::ios::binary) << std::string(kLogWindowBytes, '\xff');
  result = Take(ReadLogWindow(path, {}, kLogWindowBytes));
  Check(result.at("end") == kLogWindowBytes &&
            result.at("data").get<std::string>().size() == ((kLogWindowBytes + 2) / 3) * 4,
        "maximum log window uses expected base64 expansion");
  Check(ManagementReply(request, result).dump().size() <= limits::managementBytes,
        "maximum base64 log window fits with reply envelope");
  Check(!ReadLogWindow(path, {}, kLogWindowBytes + 1), "log window one byte past bound rejected");
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
  bool SendEvent(const Json&, uint64_t, DeliveryFlag = {}) override { return true; }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override {
    return Json{{"ok", true}};
  }
};
void Boundaries(const fs::path& root) {
  fs::create_directories(root / "logs");
  std::ofstream(root / "logs/endpoint.log") << "locked";
  const auto held = CreateFileW((root / "logs/endpoint.log").c_str(), GENERIC_READ, 0, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(held != INVALID_HANDLE_VALUE, "lock log");
  const auto read = ReadFileIfExists(root / "logs/endpoint.log");
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
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  const auto root = fs::path(argv[1]) / (L"logs-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directories(root);
    Writer(root);
    Search(root / "search");
    SearchSizeBoundary(root / "search-boundary");
    Boundaries(root / "boundaries");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
