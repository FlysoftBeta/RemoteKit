#pragma once
#include "cluster/noise.hpp"
#include <json.hpp>
namespace remotekit::cluster {
using Json = nlohmann::json;
struct Message {
  enum class Kind { kJson, kBinary } kind;
  Json json;
  Bytes bytes;
};
inline constexpr size_t kMaxJson = 1024 * 1024;
size_t JsonLimit(const Json& message);
Result<Bytes> EncodeJson(const Json& message);
Result<Bytes> EncodeBinary(const Json& header, std::span<const uint8_t> bytes);
Result<Message> DecodeFrame(std::span<const uint8_t> plaintext);
std::array<uint8_t, 4> EncodeLength(uint32_t length);
uint32_t DecodeLength(std::span<const uint8_t, 4> bytes);
}  // namespace remotekit::cluster
