#include "runtime_config_fixture.hpp"
#include "session/session.hpp"

#include <cstdlib>
#include <iostream>

namespace {
using namespace remotekit;

void Check(bool value, const char* message) {
  if (!value) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

class Link final : public ManagementLink {
 public:
  bool Next(std::string&, uint64_t&, bool&) override { return false; }
  bool Current(uint64_t generation) override { return generation == 7; }
  bool SendReply(uint64_t, const Json&) override { return true; }
  bool SendEvent(const Json&, uint64_t, remotekit::DeliveryFlag delivery = {}) override {
    if (delivery)
      delivery->MarkWritten();
    return true;
  }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override {
    return Error{ErrorCode::kUnavailable, "test Control has no object responder"};
  }
};
}  // namespace

int main() {
  using namespace remotekit;
  const auto directory = fs::temp_directory_path() /
                         ("remotekit-composition-" + std::to_string(GetCurrentProcessId()) + "-" +
                          std::to_string(GetTickCount64()));
  struct Cleanup {
    fs::path directory;
    ~Cleanup() {
      std::error_code ignored;
      fs::remove_all(directory, ignored);
    }
  } cleanup{directory};
  auto parsed = RuntimeOptions::FromConfig(TestConfig(), directory, "dev", "test");
  Check(bool(parsed), "composition options");
  const auto session_directory = directory / "data/sessions/0123456789abcdef0123456789abcdef";
  {
    SessionDb store(session_directory);
    Check(bool(store.Open()), "open session store");
    Check(bool(store.Views().Save(Json::array({{{"viewId", "1"}}, {{"viewId", "2"}}}))),
          "save views");
    Check(bool(store.Views().Close("1", "requested")), "commit close");
  }
  media::Sdk sdk;
  media::FrameAdmission admission;
  Link link;
  objects::ObjectService objects(parsed.value().data, link, cluster::Key{}, "test", "dev");
  {
    Session session(sdk, parsed.value(), "tenant", "0123456789abcdef0123456789abcdef", 1,
                    cluster::Key{}, link, objects, admission);
    Check(bool(session.Initialize()), "initialize controller composition");
    Check(!session.Views().Contains("1") && session.Views().Contains("2"),
          "replay durable close events into desired views");
    session.BeginManagementRequest(7);
    Check(session.ManagementCurrent(), "management generation wiring");
    auto policy = session.Media().ManageSessionMediaPolicy(
        {{"audio", true}, {"maxFps", 30}, {"degradationPreference", "balanced"}});
    Check(bool(policy) && session.Media().MaxFps() == 30,
          "media policy belongs to pipeline before peer creation");
    auto invalid = session.Media().ManageSessionMediaPolicy(
        {{"audio", true}, {"maxFps", 0}, {"degradationPreference", "balanced"}});
    Check(!invalid && invalid.error().code == ErrorCode::kInvalidRequest,
          "invalid policy preserves typed error");
    DcFileServices::Job stale;
    auto file = session.Files().DirectFileCommand(stale);
    Check(!file && file.error().code == ErrorCode::kConflict,
          "retired file work returns an operational error");
    auto snapshot = session.Views().Snapshot();
    Check(bool(snapshot) && !snapshot.value().at("running").get<bool>() &&
              snapshot.value().at("events").size() == 1 &&
              snapshot.value().at("stats").at("audio").at("submitted") == 0,
          "inactive diagnostics assemble controller snapshots without launching browser");
    const auto desired = session.Views().Desired("2");
    auto configured = session.Views().ApplyView(
        {{"viewId", "2"}, {"visible", true}, {"width", 800}, {"height", 600}}, false);
    Check(!configured && configured.error().code == ErrorCode::kUnavailable &&
              session.Views().Desired("2") == desired && session.Views().ReconciliationPending(),
          "failed output configuration preserves desired views and schedules reconciliation");
    Check(bool(session.Stop()) && bool(session.Stop()), "shutdown is idempotent");
  }
  SessionDb store(session_directory);
  Check(bool(store.Open()), "reopen store");
  const auto saved = store.Views().Load().value();
  Check(saved.size() == 1 && saved.at(0).at("viewId") == "2",
        "close reconciliation is durable across composition shutdown");
}
