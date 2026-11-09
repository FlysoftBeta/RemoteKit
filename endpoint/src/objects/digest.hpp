#pragma once
#include "cluster/noise.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <stdexcept>
namespace remotekit::objects {
using cluster::Key;
struct Digest {
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_HASH_HANDLE hash{};
  explicit Digest(const Key* key = nullptr) {
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                    key ? BCRYPT_ALG_HANDLE_HMAC_FLAG : 0) < 0 ||
        BCryptCreateHash(algorithm, &hash, nullptr, 0,
                         key ? const_cast<PUCHAR>(key->data()) : nullptr,
                         key ? static_cast<ULONG>(key->size()) : 0, 0) < 0)
      throw std::runtime_error("object hash initialization failed");
  }
  ~Digest() {
    if (hash)
      BCryptDestroyHash(hash);
    if (algorithm)
      BCryptCloseAlgorithmProvider(algorithm, 0);
  }
  void Add(std::span<const uint8_t> bytes) {
    if (BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()),
                       0) < 0)
      throw std::runtime_error("object hash failed");
  }
  Key Finish() {
    Key value;
    if (BCryptFinishHash(hash, value.data(), static_cast<ULONG>(value.size()), 0) < 0)
      throw std::runtime_error("object hash failed");
    return value;
  }
};
}  // namespace remotekit::objects
