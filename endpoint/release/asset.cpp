#include "asset.hpp"
namespace remotekit::release {
namespace {
Bytes Crypt(const Key& release_key,
            const Asset& asset,
            uint32_t index,
            std::span<const uint8_t> input,
            bool encrypt) {
  Require(index < asset.slices.size() && asset.slices.size() <= UINT32_MAX,
          "invalid release slice index");
  auto key = Hkdf(Unhex(asset.salt), release_key, "remotekit release asset v1");
  std::array<uint8_t, 12> nonce{};
  uint64_t i = index;
  for (int n = 11; n >= 4; --n, i >>= 8)
    nonce[n] = static_cast<uint8_t>(i);
  Bytes aad{'R', 'K', 'R', 'S', 1};
  for (uint32_t value : {index, static_cast<uint32_t>(asset.slices.size())})
    for (int n = 24; n >= 0; n -= 8)
      aad.push_back(static_cast<uint8_t>(value >> n));
  auto out = encrypt ? Seal(key, nonce, aad, input) : Open(key, nonce, aad, input);
  SecureZeroMemory(key.data(), key.size());
  return out;
}
}  // namespace
Bytes EncryptSlice(const Key& key,
                   const Asset& asset,
                   uint32_t index,
                   std::span<const uint8_t> plaintext) {
  return Crypt(key, asset, index, plaintext, true);
}
Bytes DecryptSlice(const Key& key,
                   const Asset& asset,
                   uint32_t index,
                   std::span<const uint8_t> ciphertext) {
  return Crypt(key, asset, index, ciphertext, false);
}
}  // namespace remotekit::release
