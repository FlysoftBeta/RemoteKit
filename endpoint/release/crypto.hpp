#pragma once
#include "common.hpp"
namespace remotekit::release {
Key RandomKey();
Key Hkdf(std::span<const uint8_t> salt, std::span<const uint8_t> ikm, std::string_view info);
Bytes Seal(const Key& key,
           std::span<const uint8_t> nonce,
           std::span<const uint8_t> aad,
           std::span<const uint8_t> plaintext);
Bytes Open(const Key& key,
           std::span<const uint8_t> nonce,
           std::span<const uint8_t> aad,
           std::span<const uint8_t> ciphertext);
Key LoadKey(const fs::path& path);
std::string EncodeKey(const Key& key);
}  // namespace remotekit::release
