#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

#include "render_slots.h"

namespace remotekit {
using RenderWireBytes = std::array<uint8_t, 48>;

constexpr bool ValidateRenderWire(const RenderWireMessage& message) {
  if (message.magic != kRenderWireMagic || message.version != kRenderWireVersion)
    return false;
  switch (message.type) {
    case RenderWireType::kBegin:
      return !message.reason && ValidRenderBegin(message.begin);
    case RenderWireType::kReject:
      return message.reason >= static_cast<uint32_t>(RenderRejectReason::kIdle) &&
             message.reason <= static_cast<uint32_t>(RenderRejectReason::kStopped) &&
             ValidRenderIdentity(message.begin.identity) && !message.begin.interval_us &&
             !message.begin.force;
    case RenderWireType::kStop:
    case RenderWireType::kStopped:
      return ValidRenderGenerationControl(message);
    case RenderWireType::kWake:
      return ValidRenderWake(message);
  }
  return false;
}

inline std::optional<RenderWireBytes> EncodeRenderWire(const RenderWireMessage& message) {
  if (!ValidateRenderWire(message))
    return std::nullopt;
  return std::bit_cast<RenderWireBytes>(message);
}

inline std::optional<RenderWireMessage> DecodeRenderWire(std::span<const uint8_t> bytes,
                                                         size_t attached_handles = 0) {
  if (bytes.size() != sizeof(RenderWireMessage) || attached_handles)
    return std::nullopt;
  RenderWireBytes storage;
  std::ranges::copy(bytes, storage.begin());
  auto message = std::bit_cast<RenderWireMessage>(storage);
  if (!ValidateRenderWire(message))
    return std::nullopt;
  return message;
}

static_assert(std::endian::native == std::endian::little);
static_assert(sizeof(RenderWireMessage) == 48);
static_assert(offsetof(RenderWireMessage, magic) == 0);
static_assert(offsetof(RenderWireMessage, version) == 4);
static_assert(offsetof(RenderWireMessage, type) == 8);
static_assert(offsetof(RenderWireMessage, reason) == 12);
static_assert(offsetof(RenderWireMessage, begin) == 16);
static_assert(offsetof(RenderBegin, identity) == 0);
static_assert(offsetof(RenderBegin, interval_us) == 24);
static_assert(offsetof(RenderBegin, force) == 28);
static_assert(offsetof(RenderIdentity, generation) == 0);
static_assert(offsetof(RenderIdentity, value) == 8);
static_assert(offsetof(RenderIdentity, slot) == 16);
static_assert(offsetof(RenderIdentity, reserved) == 20);
}  // namespace remotekit
