#pragma once
#include "retry_owner_drivers.hpp"
#include "peer_fixture.hpp"

namespace remotekit::retry_test {
inline OwnerDriver SourceDriver(const fs::path& root) {
  struct Fixture {
    Boundary boundary;
    ObjectLink link;
    objects::ObjectStore remote;
    objects::ObjectService owner;
    objects::ObjectInfo object;
    std::unique_ptr<cluster::TcpListener> listener;
    std::jthread server;
    std::atomic<bool> stop = false;
    std::string peer = "source";
    std::optional<Error> failure;
    std::exception_ptr server_error;
    std::mutex error_mutex;
    explicit Fixture(const fs::path& root)
        : remote(root / "remote"),
          owner(root / "local", link, TestPrivateKey(1), "local", "build") {
      objects::Keys keys{};
      object = Take(remote.WriteChunk(keys, "object payload"));
      Take(owner.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                            {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
      listener = Take(cluster::TcpListener::Listen("127.0.0.1:0"));
      Configure();
      server = std::jthread([&] {
        try {
          while (!stop) {
            auto incoming = listener->Accept(std::chrono::milliseconds(50));
            if (!incoming) {
              if (incoming.error().code == ErrorCode::kBusy || stop)
                continue;
              throw std::runtime_error(incoming.error().message);
            }
            auto established = Take(cluster::AcceptCarrier(
                std::move(incoming).value(), TestPrivateKey(2),
                [](const Json&, const cluster::Key&) -> Result<Json> {
                  return Json{{"type", "node.ready"}, {"nodeId", "source"}, {"buildId", "build"}};
                }));
            auto message = Take(established.channel->Receive(std::chrono::seconds(2)));
            auto result = boundary.Call(message.json);
            if (!result) {
              auto reply = WireError(result.error());
              reply["type"] = "object.error";
              Take(established.channel->Send(reply));
            } else {
              std::ifstream input(Take(remote.StoredPath(object.id)), std::ios::binary);
              std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(input), {}};
              Take(established.channel->SendBinary(
                  {{"type", "object.chunk"}, {"offset", uint64_t(0)}}, bytes));
              Take(established.channel->Send({{"type", "object.end"},
                                              {"size", object.stored_size},
                                              {"sha256", object.stored_sha256}}));
            }
            established.channel->Receive(std::chrono::milliseconds(100));
          }
        } catch (...) {
          std::lock_guard lock(error_mutex);
          server_error = std::current_exception();
        }
      });
    }
    ~Fixture() {
      stop = true;
      listener->Close();
      if (server.joinable())
        server.join();
    }
    void Configure() {
      Take(owner.SetPeers(Json::array({TestPeer(peer, listener->Address(), TestPrivateKey(2))})));
    }
    void Tick() {
      auto result = owner.EnsureUncommitted(
          object.id, Json::array({{{"nodeId", peer}, {"address", listener->Address()}}}));
      if (!result)
        failure = result.error();
      std::lock_guard lock(error_mutex);
      if (server_error)
        std::rethrow_exception(server_error);
    }
  };
  auto f = std::make_shared<Fixture>(root);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] {
            f->peer = "changed";
            f->Configure();
          },
          [f] { return NativeRetryOwnerProbe::Source(f->owner); },
          [f] { return f->failure.has_value(); }};
}
inline OwnerDriver AcceptDriver(const fs::path& root) {
  class Carrier final : public cluster::Carrier {
   public:
    Result<void> Send(std::span<const uint8_t>) override { return {}; }
    Result<cluster::Bytes> Receive(std::chrono::milliseconds) override {
      return Error{ErrorCode::kBusy, "readiness timeout"};
    }
    void Close() override {}
  };
  struct Fixture {
    Boundary boundary;
    objects::ObjectStore store;
    objects::PeerSet peers;
    objects::PeerServer owner;
    std::string input = "127.0.0.1:1";
    std::optional<Error> failure;
    explicit Fixture(const fs::path& root)
        : store(root), owner(store, {}, "node", "build", peers) {}
    void Tick() {
      auto result = NativeRetryOwnerProbe::Accept(
          owner, input, [&]() -> Result<std::unique_ptr<cluster::Carrier>> {
            auto accepted = boundary.Call({{"listen", input}});
            if (!accepted)
              return accepted.error();
            return std::unique_ptr<cluster::Carrier>(std::make_unique<Carrier>());
          });
      if (!result)
        failure = result.error();
    }
  };
  auto f = std::make_shared<Fixture>(root);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->input = "127.0.0.1:2"; },
          [f] { return f->owner.AcceptRetryStatus(); },
          [f] { return f->failure.has_value(); }};
}
}  // namespace remotekit::retry_test
