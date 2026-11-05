#include "remotekit/raw_camera.hpp"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <json.hpp>

#define CHECK(x)                                    \
  do {                                              \
    if (!(x)) {                                     \
      std::cerr << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                 \
    }                                               \
  } while (false)

using Json = nlohmann::json;
constexpr uint64_t kPeer = 7, kEpoch = 2;
constexpr char kChallenge[] = "38901d17-8c89-45e0-8ef3-0d70ddfb37e2";
constexpr char kNextChallenge[] = "38901d17-8c89-45e0-8ef3-0d70ddfb37e3";
constexpr size_t kHeader = 68, kBytes = 64 * 64 * 3;

std::vector<uint8_t> Chunk(uint32_t capture,
                           uint32_t offset,
                           size_t count,
                           uint64_t epoch = kEpoch) {
  std::vector<uint8_t> bytes(kHeader + count, 0xA5);
  const auto write = [&](size_t start, size_t size, uint64_t value) {
    for (size_t i = 0; i < size; ++i)
      bytes[start + i] = static_cast<uint8_t>(value >> (8 * i));
  };
  write(0, 4, 0x46414b52);
  write(4, 2, 1);
  write(6, 2, kHeader);
  write(8, 8, epoch);
  write(16, 4, capture);
  write(20, 4, offset);
  write(24, 4, kBytes);
  write(28, 2, 64);
  write(30, 2, 64);
  std::copy_n(kChallenge, 36, bytes.begin() + 32);
  return bytes;
}

int main() {
  rk::auth::RawCamera camera;
  bool active = true;
  unsigned submitted = 0;
  const auto pending = [&](uint64_t, std::string_view) { return active; };
  const auto submit = [&](int width, int height, const uint8_t* rgb, int stride) {
    CHECK(width == 64 && height == 64 && stride == 192);
    CHECK(std::all_of(rgb, rgb + kBytes, [](uint8_t b) { return b == 0xA5; }));
    ++submitted;
  };
  const auto text = [&](const char* type, int64_t now, const char* challenge = kChallenge,
                        int width = 64) {
    const auto wire = Json({{"type", type},
                            {"version", 1},
                            {"authEpoch", kEpoch},
                            {"challengeId", challenge},
                            {"width", width},
                            {"height", 64},
                            {"format", "rgb24"},
                            {"maxFps", 5},
                            {"fps", 5}})
                          .dump();
    camera.Receive(kPeer, false, wire.data(), wire.size(), now, pending, submit);
  };
  const auto binary = [&](const std::vector<uint8_t>& bytes, int64_t now, uint64_t peer = kPeer) {
    camera.Receive(peer, true, bytes.data(), bytes.size(), now, pending, submit);
  };
  const auto next = [&](int64_t now) { return camera.Next(now, pending); };

  CHECK(rk::auth::CameraChallengeId(kChallenge));
  CHECK(!rk::auth::CameraChallengeId("38901D17-8c89-45e0-8ef3-0d70ddfb37e2"));
  camera.Bind(kPeer);
  camera.State(kPeer, true);
  text("auth.camera.ready", 0);
  CHECK(!next(0));  // No challenge.
  camera.Begin(kPeer, kEpoch, kChallenge, 10000);
  text("auth.camera.ready", 0, kChallenge, 641);
  CHECK(!next(0));
  text("auth.camera.ready", 0);
  text("auth.camera.accept", 0);
  auto config = next(0);
  CHECK(config && !config->capture);
  auto wire = Json::parse(config->json);
  CHECK(wire.at("chunkBytes") == 16384 && wire.at("fps") == 5 && wire.at("format") == "rgb24");
  CHECK(!next(0));  // An accept before the config is ignored.
  camera.Failed(*config);
  CHECK(next(0) && !next(0));
  text("auth.camera.accept", 0);
  const auto first = next(0);
  CHECK(first && first->capture == 1);
  camera.Sent(*first, 5);
  binary(Chunk(1, 0, 4000), 20, kPeer + 1);
  binary(Chunk(1, 0, 4000, kEpoch + 1), 20);
  binary(Chunk(1, 0, 4000), 20);
  binary(Chunk(1, 4000, kBytes - 4000), 30);
  CHECK(submitted == 1 && !next(204));
  binary(Chunk(1, 0, kBytes), 190);  // Old grant is consumed.
  const auto second = next(205);
  CHECK(second && second->capture == 2);
  binary(Chunk(2, 0, 4000), 210);
  binary(Chunk(2, 0, 4000), 220);  // Duplicate offset drops assembly.
  binary(Chunk(2, 4000, kBytes - 4000), 230);
  CHECK(submitted == 1 && !next(404));
  const auto third = next(405);
  CHECK(third && third->capture == 3);
  CHECK(!next(1404));                 // At most one uncompleted grant.
  binary(Chunk(3, 0, kBytes), 1405);  // Arrival at the deadline is stale.
  const auto fourth = next(1405);
  CHECK(fourth && fourth->capture == 4 && submitted == 1);

  camera.Cancel(kEpoch, kNextChallenge);  // Does not cancel the active challenge.
  CHECK(camera.Active());
  camera.Cancel(kEpoch, kChallenge);
  CHECK(!camera.Active());
  camera.Begin(kPeer, kEpoch, kNextChallenge, 10000);
  text("auth.camera.ready", 1500, kNextChallenge);
  CHECK(next(1500));
  text("auth.camera.accept", 1500, kNextChallenge);
  CHECK(!next(1604));  // Challenge replacement cannot bypass the peer rate cap.
  const auto fifth = next(1605);
  CHECK(fifth && fifth->capture == 5);
  camera.State(kPeer, false);
  CHECK(!next(1800));  // Closed channel revokes the grant.
  active = false;
  CHECK(!next(1801) && !camera.Active());
}
