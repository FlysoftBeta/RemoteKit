#pragma once
#include "retry_owner_drivers.hpp"
#include "input/input.hpp"

namespace remotekit::retry_test {
inline void InputOwnerCase(ErrorCode code) {
  NativeRetryClock clock;
  Boundary boundary;
  boundary.Inject(Error{code, "injected input boundary failure", {}, 1});
  std::mutex mutex;
  std::condition_variable wake;
  std::vector<Json> replies;
  InputController::Hooks hooks;
  hooks.control = [] { return uint64_t(1); };
  hooks.input_stamp = hooks.epoch = [] { return uint64_t(1); };
  hooks.admitted = [](const RtcEvent&) { return true; };
  hooks.admission = [] { return AuthorizationController::AdmissionToken{1, 1, 1}; };
  hooks.revalidate = [](const auto&) { return true; };
  hooks.allows = [](const std::string&, uint64_t) { return true; };
  hooks.rpc = [&](Json request, uint64_t, uint32_t, bool, const auto&) -> Result<Json> {
    const auto result = boundary.Call(request, {{"ok", true}});
    if (code == ErrorCode::kBusy && boundary.Attempts().size() == 3)
      boundary.Inject({});
    return result;
  };
  hooks.send = [&](const Json& reply, uint64_t) {
    std::lock_guard lock(mutex);
    replies.push_back(reply);
    wake.notify_all();
  };
  hooks.failed = [&] { throw std::runtime_error("input owner worker failed"); };
  hooks.trace = [] { return std::shared_ptr<media::ServerTrace>{}; };
  InputController owner("session", std::move(hooks));
  owner.Start(1);
  const auto submit = [&](const char* sequence, size_t expected) {
    RtcEvent event{};
    event.peer = event.authorization = 1;
    event.message = {{"type", "input"},    {"session", "session"},
                     {"view", "1"},        {"sequence", sequence},
                     {"layoutEpoch", "1"}, {"event", {{"type", "key"}, {"action", "down"}}}};
    owner.QueueInput(event);
    std::unique_lock lock(mutex);
    if (!wake.wait_for(lock, std::chrono::seconds(5), [&] { return replies.size() == expected; }))
      throw std::runtime_error("input owner did not complete the queued operation");
  };
  submit("1", 1);
  auto attempts = boundary.Attempts();
  if (code == ErrorCode::kBusy) {
    if (attempts.size() != 4 || !replies.front().value("ok", false))
      throw std::runtime_error("BUSY input did not recover through Browser RPC");
    for (size_t i = 1; i < attempts.size(); ++i) {
      if (attempts[i].identity != attempts[0].identity ||
          attempts[i].at - attempts[i - 1].at != std::chrono::milliseconds(1))
        throw std::runtime_error("BUSY input changed identity or ignored its retry delay");
    }
    if (owner.Snapshot().at("inputBusyRetries") != 3)
      throw std::runtime_error("BUSY retries are not surfaced by the input owner");
  } else if (attempts.size() != 1 ||
             replies.front().at("error").at("code") != std::string(ErrorCodeName(code))) {
    throw std::runtime_error("possibly executed input was replayed or its error was lost");
  }
  boundary.Inject({});
  submit("2", 2);
  attempts = boundary.Attempts();
  if (!replies.back().value("ok", false) || attempts.back().identity.at("sequence") != "2")
    throw std::runtime_error("next input identity did not recover");
  owner.Stop();
}
}  // namespace remotekit::retry_test
