#include "cluster/frames.hpp"
namespace remotekit::cluster {
namespace {
Error Invalid() {
  return {ErrorCode::kInvalidRequest, "invalid cluster frame"};
}
}  // namespace
size_t JsonLimit(const Json& message) {
  if (message.value("method", Json()) == "session.desired" ||
      message.value("event", Json()) == "session.observed" ||
      message.value("event", Json()) == "session.event")
    return kMaxPlaintext - 1;
  if (message.value("type", Json()) == "clipboard.changed")
    return 4 * 1024 * 1024 - 1;
  const auto method = message.value("method", Json());
  if (method == "clipboard.write")
    return kMaxPlaintext - 1;
  if ((method == "session.open" || method == "session.ensure") && message.contains("clipboard"))
    return kMaxPlaintext - 1;
  return kMaxJson;
}
std::array<uint8_t, 4> EncodeLength(uint32_t n) {
  return {static_cast<uint8_t>(n), static_cast<uint8_t>(n >> 8), static_cast<uint8_t>(n >> 16),
          static_cast<uint8_t>(n >> 24)};
}
uint32_t DecodeLength(std::span<const uint8_t, 4> b) {
  return uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 | uint32_t(b[3]) << 24;
}
Result<Bytes> EncodeJson(const Json& message) {
  if (!message.is_object())
    return Invalid();
  try {
    auto json = message.dump();
    if (json.size() > JsonLimit(message))
      return Error{ErrorCode::kLimitExceeded, "JSON exceeds frame limit"};
    Bytes out{1};
    out.insert(out.end(), json.begin(), json.end());
    return out;
  } catch (...) {
    return Invalid();
  }
}
Result<Bytes> EncodeBinary(const Json& header, std::span<const uint8_t> bytes) {
  if (!header.is_object())
    return Invalid();
  try {
    auto json = header.dump();
    if (json.size() > kMaxJson || json.size() + bytes.size() + 5 > kMaxPlaintext)
      return Error{ErrorCode::kLimitExceeded, "BINARY exceeds frame limit"};
    Bytes out{2};
    auto n = EncodeLength(static_cast<uint32_t>(json.size()));
    out.insert(out.end(), n.begin(), n.end());
    out.insert(out.end(), json.begin(), json.end());
    out.insert(out.end(), bytes.begin(), bytes.end());
    return out;
  } catch (...) {
    return Invalid();
  }
}
Result<Message> DecodeFrame(std::span<const uint8_t> plain) {
  if (plain.empty() || plain.size() > kMaxPlaintext)
    return Invalid();
  size_t start = 1, length = plain.size() - 1;
  bool binary = plain[0] == 2;
  if (binary) {
    if (plain.size() < 5)
      return Invalid();
    start = 5;
    length = DecodeLength(std::span<const uint8_t, 4>(plain.data() + 1, 4));
  } else if (plain[0] != 1)
    return Invalid();
  if ((binary && length > kMaxJson) || length > plain.size() - start)
    return Invalid();
  auto json = Json::parse(plain.begin() + start, plain.begin() + start + length, nullptr, false);
  if (!json.is_object())
    return Invalid();
  if (!binary && length > JsonLimit(json))
    return Invalid();
  Bytes bytes;
  if (binary)
    bytes.assign(plain.begin() + start + length, plain.end());
  return Message{binary ? Message::Kind::kBinary : Message::Kind::kJson, std::move(json),
                 std::move(bytes)};
}
}  // namespace remotekit::cluster
