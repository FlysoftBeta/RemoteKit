#pragma once
#include "crypto.hpp"
namespace remotekit::release {
inline constexpr uint64_t kChunkSize = 33554416;
struct Slice {
  std::string url;
  uint64_t size;
};
struct Asset {
  std::string salt;
  uint64_t size;
  std::vector<Slice> slices;
};
struct Payload {
  uint64_t size;
  std::string sha256;
};
struct Patch {
  std::string from, manifest;
  Asset asset;
};
struct Manifest {
  std::string build_id, published;
  Payload payload;
  std::optional<Patch> patch;
  std::optional<Asset> full;
};
Manifest ParseManifest(std::string_view text);
Json ToJson(const Manifest& manifest);
Bytes EncryptManifest(const Manifest& manifest, const Key& key);
Manifest DecryptManifest(std::span<const uint8_t> envelope, const Key& key);
}  // namespace remotekit::release
