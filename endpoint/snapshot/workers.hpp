#pragma once
#include "../updater/platform.hpp"
#include <atomic>
#include <thread>
#include <memory>
#include <cstdio>

namespace remotekit::snapshot {
class Workers {
 public:
  template <class F>
  explicit Workers(F maintain) : maintenance_(std::move(maintain)) {}
  ~Workers() {
    maintenance_.request_stop();
    for (auto& connection : connections_)
      connection->worker.request_stop();
    for (auto& connection : connections_) {
      if (connection->worker.joinable())
        CancelSynchronousIo(connection->worker.native_handle());
      CancelIoEx(connection->pipe.value, nullptr);
      DisconnectNamedPipe(connection->pipe.value);
      CloseHandle(connection->pipe.Release());
    }
    connections_.clear();
    maintenance_.join();
  }
  template <class F>
  void Connect(updater::Handle pipe, F serve) {
    std::erase_if(connections_, [](const auto& connection) {
      return connection->state.load() == ConnectionState::kFinished;
    });
    auto connection = std::make_unique<Connection>(std::move(pipe));
    auto* state = connection.get();
    connections_.push_back(std::move(connection));
    state->worker = std::jthread(
        [state, pipe = state->pipe.value, serve = std::move(serve)](std::stop_token stop) {
          try {
            serve(stop, pipe);
          } catch (const std::exception& error) {
            fprintf(stderr, "snapshot connection failed: %s\n", error.what());
          }
          state->state.store(ConnectionState::kFinished);
        });
  }

 private:
  enum class ConnectionState { kServing, kFinished };
  struct Connection {
    explicit Connection(updater::Handle value) : pipe(std::move(value)) {}
    updater::Handle pipe;
    std::atomic<ConnectionState> state = ConnectionState::kServing;
    std::jthread worker;
  };
  std::jthread maintenance_;
  std::vector<std::unique_ptr<Connection>> connections_;
};
}  // namespace remotekit::snapshot
