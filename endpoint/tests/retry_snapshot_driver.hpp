#pragma once
#include "retry_owner_drivers.hpp"

namespace remotekit::retry_test {
inline Json SnapshotConfig() {
  auto config = TestConfig();
  config["nodeId"] = "matrix-" + std::to_string(GetCurrentProcessId());
  return config;
}
inline OwnerDriver SnapshotDriver(const fs::path& root, std::string loop) {
  struct Fixture {
    Boundary boundary;
    ObjectLink link;
    media::Sdk sdk = BrowserSdk();
    RuntimeOptions options;
    Service owner;
    std::string loop;
    uint64_t generation = 1;
    std::optional<Error> failure;
    Fixture(const fs::path& root, std::string name)
        : options(
              Take(RuntimeOptions::FromConfig(SnapshotConfig(),
                                              root,
                                              "dev",
                                              "matrix-" + std::to_string(GetCurrentProcessId())))),
          owner(sdk, options, link, {}, "endpoint"),
          loop(std::move(name)) {}
    Result<Json> PipeTake() {
      const auto pipe = CreateNamedPipeW(
          snapshot::PipeName(options.node_id).c_str(), PIPE_ACCESS_DUPLEX,
          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, nullptr);
      if (pipe == INVALID_HANDLE_VALUE)
        throw std::runtime_error("create fake snapshot pipe");
      std::thread server([&] {
        if (!ConnectNamedPipe(pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED)
          return;
        std::vector<uint8_t> bytes;
        if (!snapshot::Receive(pipe, bytes))
          return;
        const auto request = Json::parse(bytes);
        const auto result =
            boundary.Call(request, {{"snapshotId", "snapshot"}, {"files", Json::array()}});
        const Json reply = result ? Json{{"ok", true}, {"result", result.value()}}
                                  : Json{{"ok", false}, {"error", WireError(result.error())}};
        snapshot::SendJson(pipe, reply);
      });
      Result<Json> result = Error{ErrorCode::kInternal, "snapshot client did not open"};
      {
        SnapshotClient client(options.node_id);
        if (client.Available())
          result = NativeRetryOwnerProbe::TakeSnapshot(owner, client);
        else
          CancelSynchronousIo(server.native_handle());
      }
      server.join();
      CloseHandle(pipe);
      return result;
    }
    void Tick() {
      Result<void> result;
      if (loop == "snapshot.take") {
        const auto taken = PipeTake();
        if (!taken)
          result = taken.error();
      } else if (loop == "snapshot.schedule") {
        const auto scheduled = NativeRetryOwnerProbe::Schedule(owner, generation, [&] {
          return boundary.Call({{"sessionId", std::string(32, 'a')}, {"epoch", generation}}, false);
        });
        if (!scheduled)
          result = scheduled.error();
      } else {
        const auto work = [&]() -> Result<void> {
          auto call = boundary.Call({{"generation", generation}});
          return call ? Result<void>{} : Result<void>{call.error()};
        };
        result = loop == "placement.reconcile"
                     ? NativeRetryOwnerProbe::Placement(owner, generation, work)
                     : NativeRetryOwnerProbe::SnapshotWork(owner, work);
      }
      if (!result)
        failure = result.error();
    }
    void Change() { NativeRetryOwnerProbe::ServiceGeneration(owner, ++generation); }
  };
  auto f = std::make_shared<Fixture>(root, std::move(loop));
  return {
      f,
      std::shared_ptr<Boundary>(f, &f->boundary),
      [f] { f->Tick(); },
      [f] { f->Change(); },
      [f] { return RetryUnit::Snapshot(NativeRetryOwnerProbe::ServiceState(f->owner, f->loop)); },
      [f] {
        return f->loop == "placement.reconcile" ? f->failure.has_value()
                                                : !f->owner.SnapshotFailures().empty();
      }};
}
}  // namespace remotekit::retry_test
