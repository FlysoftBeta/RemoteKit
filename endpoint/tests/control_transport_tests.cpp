#include "control_transport.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

int main(int argc, char** argv) {
  try {
    if (argc == 1) {
      const char* invalid[] = {"http://example.com/api/endpoint",
                               "ftp://127.0.0.1/api/endpoint",
                               "https://example.com/wrong",
                               "https://user:pass@example.com/api/endpoint",
                               "https://example.com/api/endpoint?token=bad",
                               "https://example.com/api/endpoint#fragment"};
      for (auto url : invalid) {
        bool rejected = false;
        try {
          remotekit::ControlTransport transport(url, "test-node", "test-secret");
        } catch (const std::exception&) {
          rejected = true;
        }
        if (!rejected)
          throw std::runtime_error("invalid URL accepted");
      }
      for (auto pair : {std::pair{"", "test-secret"},
                        {"bad/id", "test-secret"},
                        {"test-node", ""},
                        {"test-node", "bad\r\nheader"}}) {
        bool rejected = false;
        try {
          remotekit::ControlTransport transport("http://127.0.0.1/api/endpoint", pair.first,
                                                pair.second);
        } catch (const std::exception&) {
          rejected = true;
        }
        if (!rejected)
          throw std::runtime_error("invalid identity accepted");
      }
      std::cout << "control transport configuration tests passed\n";
      return 0;
    }
    // Native half of tests/integration/test-endpoint-control-transport.mjs. No SDK/GPU load.
    remotekit::ControlTransport transport(argv[1], "test-node", "test-secret");
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
    uint64_t old_generation = 0;
    while (std::chrono::steady_clock::now() < deadline) {
      std::string bytes;
      uint64_t generation = 0;
      if (!transport.Next(bytes, generation))
        continue;
      if (bytes == "{\"id\":\"old\"}") {
        old_generation = generation;
        continue;
      }
      if (bytes == "{\"id\":\"new\"}") {
        if (!old_generation || generation == old_generation || transport.Current(old_generation))
          throw std::runtime_error("generation isolation failed");
        if (transport.TrySend("{\"id\":\"stale\"}", old_generation))
          throw std::runtime_error("stale queue admission accepted");
        if (!transport.TrySend("{\"id\":\"fresh\"}", generation))
          throw std::runtime_error("current queue admission rejected");
      } else if (bytes == "{\"id\":\"finish\"}") {
        transport.Send("{\"id\":\"finished\"}", generation);
        return 0;
      } else
        throw std::runtime_error("unexpected inbound message");
    }
    throw std::runtime_error("transport integration deadline expired");
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
