#include "management/remote_link.hpp"
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
        auto rejected = remotekit::RemoteLink::Create(url, "test-node", "test-secret");
        if (rejected)
          throw std::logic_error("invalid URL accepted");
      }
      for (auto pair : {std::pair{"", "test-secret"},
                        {"bad/id", "test-secret"},
                        {"test-node", ""},
                        {"test-node", "bad\r\nheader"}}) {
        auto rejected =
            remotekit::RemoteLink::Create("http://127.0.0.1/api/endpoint", pair.first, pair.second);
        if (rejected)
          throw std::logic_error("invalid identity accepted");
      }
      std::cout << "control transport configuration tests passed\n";
      return 0;
    }
    // Native half of tests/integration/test-endpoint-control-transport->mjs. No SDK/GPU load.
    auto created = remotekit::RemoteLink::Create(argv[1], "test-node", "test-secret");
    if (!created)
      throw std::logic_error(created.error().message);
    auto transport = std::move(created).value();
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
    uint64_t old_generation = 0;
    while (std::chrono::steady_clock::now() < deadline) {
      std::string bytes;
      uint64_t generation = 0;
      bool eof = false;
      if (!transport->Next(bytes, generation, eof))
        continue;
      if (bytes == "{\"id\":\"old\"}") {
        old_generation = generation;
        continue;
      }
      if (bytes == "{\"id\":\"new\"}") {
        if (!old_generation || generation == old_generation || transport->Current(old_generation))
          throw std::runtime_error("generation isolation failed");
        if (transport->SendReply(old_generation, {{"id", "stale"}}))
          throw std::runtime_error("stale queue admission accepted");
        if (transport->SendEvent({{"id", "stale-event"}}, old_generation))
          throw std::logic_error("stale event admitted");
        if (!transport->SendEvent({{"id", "fresh"}}, generation))
          throw std::runtime_error("current queue admission rejected");
      } else if (bytes == "{\"id\":\"finish\"}") {
        transport->SendReply(generation, {{"id", "finished"}});
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
