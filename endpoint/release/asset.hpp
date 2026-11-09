#pragma once
#include "manifest.hpp"
namespace remotekit::release {
Bytes EncryptSlice(const Key& release_key,
                   const Asset& asset,
                   uint32_t index,
                   std::span<const uint8_t> plaintext);
Bytes DecryptSlice(const Key& release_key,
                   const Asset& asset,
                   uint32_t index,
                   std::span<const uint8_t> ciphertext);
}  // namespace remotekit::release
