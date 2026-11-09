#include "crypto.hpp"
#include <bcrypt.h>

namespace remotekit::release {
namespace {
void Cng(NTSTATUS status) {
  Io(status >= 0, "release cryptography failed");
}
struct Algorithm {
  BCRYPT_ALG_HANDLE value = nullptr;
  ~Algorithm() {
    if (value)
      BCryptCloseAlgorithmProvider(value, 0);
  }
};
struct Hash {
  BCRYPT_HASH_HANDLE value = nullptr;
  ~Hash() {
    if (value)
      BCryptDestroyHash(value);
  }
};
struct Cipher {
  BCRYPT_KEY_HANDLE value = nullptr;
  ~Cipher() {
    if (value)
      BCryptDestroyKey(value);
  }
};
Key Hmac(std::span<const uint8_t> key, std::span<const uint8_t> bytes) {
  Algorithm algorithm;
  Cng(BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  BCRYPT_ALG_HANDLE_HMAC_FLAG));
  Hash hash;
  Cng(BCryptCreateHash(algorithm.value, &hash.value, nullptr, 0, const_cast<PUCHAR>(key.data()),
                       static_cast<ULONG>(key.size()), 0));
  Cng(BCryptHashData(hash.value, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()),
                     0));
  Key out;
  Cng(BCryptFinishHash(hash.value, out.data(), static_cast<ULONG>(out.size()), 0));
  return out;
}
Bytes Gcm(const Key& key,
          std::span<const uint8_t> nonce,
          std::span<const uint8_t> aad,
          std::span<const uint8_t> input,
          bool encrypt) {
  Require(nonce.size() == 12 && input.size() <= UINT32_MAX && (encrypt || input.size() >= 16),
          "invalid encrypted release data");
  Algorithm algorithm;
  Cng(BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_AES_ALGORITHM, nullptr, 0));
  Cng(BCryptSetProperty(algorithm.value, BCRYPT_CHAINING_MODE,
                        reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(BCRYPT_CHAIN_MODE_GCM)),
                        sizeof(BCRYPT_CHAIN_MODE_GCM), 0));
  Cipher cipher;
  Cng(BCryptGenerateSymmetricKey(algorithm.value, &cipher.value, nullptr, 0,
                                 const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()),
                                 0));
  size_t size = encrypt ? input.size() : input.size() - 16;
  Bytes output(encrypt ? size + 16 : size);
  std::array<uint8_t, 16> tag{};
  if (!encrypt)
    std::copy(input.end() - 16, input.end(), tag.begin());
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO auth;
  BCRYPT_INIT_AUTH_MODE_INFO(auth);
  auth.pbNonce = const_cast<PUCHAR>(nonce.data());
  auth.cbNonce = static_cast<ULONG>(nonce.size());
  auth.pbAuthData = const_cast<PUCHAR>(aad.data());
  auth.cbAuthData = static_cast<ULONG>(aad.size());
  auth.pbTag = tag.data();
  auth.cbTag = static_cast<ULONG>(tag.size());
  ULONG written = 0;
  auto operation = encrypt ? BCryptEncrypt : BCryptDecrypt;
  auto status = operation(cipher.value, const_cast<PUCHAR>(input.data()), static_cast<ULONG>(size),
                          &auth, nullptr, 0, output.data(), static_cast<ULONG>(size), &written, 0);
  if (!encrypt && status < 0)
    Fail(ErrorCode::kRejected, "release key does not match or data corrupted");
  Cng(status);
  Require(written == size, "invalid release cipher output");
  if (encrypt)
    std::copy(tag.begin(), tag.end(), output.begin() + size);
  return output;
}
}  // namespace
Key RandomKey() {
  Key key;
  Cng(BCryptGenRandom(nullptr, key.data(), static_cast<ULONG>(key.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG));
  return key;
}
Key Hkdf(std::span<const uint8_t> salt, std::span<const uint8_t> ikm, std::string_view info) {
  auto prk = Hmac(salt, ikm);
  Bytes expand(info.begin(), info.end());
  expand.push_back(1);
  auto out = Hmac(prk, expand);
  SecureZeroMemory(prk.data(), prk.size());
  return out;
}
Bytes Seal(const Key& key,
           std::span<const uint8_t> nonce,
           std::span<const uint8_t> aad,
           std::span<const uint8_t> plaintext) {
  return Gcm(key, nonce, aad, plaintext, true);
}
Bytes Open(const Key& key,
           std::span<const uint8_t> nonce,
           std::span<const uint8_t> aad,
           std::span<const uint8_t> ciphertext) {
  return Gcm(key, nonce, aad, ciphertext, false);
}
Key LoadKey(const fs::path& path) {
  auto raw = Read(path, 256);
  while (!raw.empty() && (raw.back() == '\r' || raw.back() == '\n'))
    raw.pop_back();
  auto result = cluster::DecodeKey({reinterpret_cast<const char*>(raw.data()), raw.size()});
  SecureZeroMemory(raw.data(), raw.size());
  if (!result)
    Fail(ErrorCode::kInvalidRequest, "release key must be base64 of 32 bytes");
  auto key = result.value();
  SecureZeroMemory(result.value().data(), result.value().size());
  return key;
}
std::string EncodeKey(const Key& key) {
  constexpr std::string_view alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  uint32_t value = 0;
  unsigned bits = 0;
  for (auto byte : key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += alphabet[(value >> bits) & 63];
    }
  }
  if (bits)
    out += alphabet[(value << (6 - bits)) & 63];
  out += "=\n";
  return out;
}
}  // namespace remotekit::release
