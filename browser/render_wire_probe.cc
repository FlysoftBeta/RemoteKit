#include "remotekit/protocol/render_wire.h"
#include "base/check.h"

namespace {
using namespace remotekit;
void RoundTrip(RenderWireMessage message) {
  const auto encoded = EncodeRenderWire(message);
  CHECK(encoded);
  const auto decoded = DecodeRenderWire(*encoded);
  CHECK(decoded);
  CHECK(EncodeRenderWire(*decoded) == encoded);
  CHECK(!DecodeRenderWire(*encoded, 1));
  CHECK(!DecodeRenderWire(std::span(*encoded).first(47)));
  auto corrupt = *encoded;
  corrupt[0] ^= 1;
  CHECK(!DecodeRenderWire(corrupt));
  message.magic = 0;
  CHECK(!EncodeRenderWire(message));
}
}  // namespace

int main() {
  using namespace remotekit;
  RenderWireMessage message;
  message.begin = {{7, 19, 3, 0}, 16667, 1};
  RoundTrip(message);
  message.begin.force = 2;
  CHECK(!EncodeRenderWire(message));
  message.begin.force = 1;
  message.begin.interval_us = 0;
  CHECK(!EncodeRenderWire(message));
  message.begin.force = 0;
  message.type = RenderWireType::kReject;
  for (uint32_t reason = 1; reason <= 4; ++reason) {
    message.reason = reason;
    RoundTrip(message);
  }
  message.reason = 5;
  CHECK(!EncodeRenderWire(message));
  message.type = RenderWireType::kWake;
  message.reason = 0;
  RoundTrip(message);
  message.begin.identity.reserved = 1;
  CHECK(!EncodeRenderWire(message));
  message.begin = {};
  message.begin.identity.generation = 7;
  for (auto type : {RenderWireType::kStop, RenderWireType::kStopped}) {
    message.type = type;
    RoundTrip(message);
    message.begin.identity.value = 1;
    CHECK(!EncodeRenderWire(message));
    message.begin.identity.value = 0;
  }
  message.type = static_cast<RenderWireType>(99);
  CHECK(!EncodeRenderWire(message));
}
