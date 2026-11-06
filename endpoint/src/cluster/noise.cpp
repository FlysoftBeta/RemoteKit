#include "cluster/noise.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <source_location>

namespace remotekit::cluster {
namespace {
void Check(NTSTATUS status, std::source_location location = std::source_location::current()) {
  if (status < 0)
    throw std::runtime_error("CNG operation failed at " + std::to_string(location.line()) + ": " +
                             std::to_string(static_cast<uint32_t>(status)));
}
struct Algorithm {
  BCRYPT_ALG_HANDLE value = nullptr;
  Algorithm(LPCWSTR name, ULONG flags = 0) {
    Check(BCryptOpenAlgorithmProvider(&value, name, nullptr, flags));
  }
  ~Algorithm() {
    if (value)
      BCryptCloseAlgorithmProvider(value, 0);
  }
};
struct CryptoKey {
  BCRYPT_KEY_HANDLE value = nullptr;
  ~CryptoKey() {
    if (value)
      BCryptDestroyKey(value);
  }
};
struct Secret {
  BCRYPT_SECRET_HANDLE value = nullptr;
  ~Secret() {
    if (value)
      BCryptDestroySecret(value);
  }
};
struct WipedKey {
  Key value{};
  ~WipedKey() { SecureZeroMemory(value.data(), value.size()); }
};
struct Derived {
  std::array<Key, 3> keys{};
  ~Derived() { SecureZeroMemory(keys.data(), sizeof(keys)); }
};
struct WipeBuffer {
  Bytes& bytes;
  ~WipeBuffer() { SecureZeroMemory(bytes.data(), bytes.size()); }
};
WipedKey Hash(std::span<const uint8_t> input,
              std::span<const uint8_t> key = {},
              bool hmac = false) {
  Algorithm alg(BCRYPT_SHA256_ALGORITHM, hmac ? BCRYPT_ALG_HANDLE_HMAC_FLAG : 0);
  BCRYPT_HASH_HANDLE hash = nullptr;
  Check(BCryptCreateHash(alg.value, &hash, nullptr, 0, const_cast<PUCHAR>(key.data()),
                         static_cast<ULONG>(key.size()), 0));
  auto status =
      BCryptHashData(hash, const_cast<PUCHAR>(input.data()), static_cast<ULONG>(input.size()), 0);
  WipedKey out;
  if (status >= 0)
    status = BCryptFinishHash(hash, out.value.data(), 32, 0);
  BCryptDestroyHash(hash);
  Check(status);
  return out;
}
Derived Hkdf(const Key& salt, std::span<const uint8_t> input) {
  auto temp = Hash(input, salt, true);
  Derived out;
  Bytes previous;
  previous.reserve(33);
  WipeBuffer wipe{previous};
  for (uint8_t i = 1; i <= 3; ++i) {
    previous.push_back(i);
    out.keys[i - 1] = Hash(previous, temp.value, true).value;
    SecureZeroMemory(previous.data(), previous.size());
    previous.assign(out.keys[i - 1].begin(), out.keys[i - 1].end());
  }
  SecureZeroMemory(previous.data(), previous.size());
  return out;
}
void Curve(Algorithm& alg) {
  Check(BCryptSetProperty(alg.value, BCRYPT_ECC_CURVE_NAME,
                          reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(BCRYPT_ECC_CURVE_25519)),
                          sizeof(BCRYPT_ECC_CURVE_25519), 0));
}
struct EccBlob {
  BCRYPT_ECCKEY_BLOB header;
  Key x{}, y{}, d{};
};
WipedKey Dh(Algorithm& alg, BCRYPT_KEY_HANDLE own, const Key& peer) {
  EccBlob blob{{BCRYPT_ECDH_PUBLIC_GENERIC_MAGIC, 32}};
  // Curve25519 CNG blobs use RFC 7748 byte order (unlike NIST ECC blobs).
  std::copy(peer.begin(), peer.end(), blob.x.begin());
  CryptoKey imported;
  Check(BCryptImportKeyPair(alg.value, nullptr, BCRYPT_ECCPUBLIC_BLOB, &imported.value,
                            reinterpret_cast<PUCHAR>(&blob), 8 + 64, 0));
  Secret secret;
  Check(BCryptSecretAgreement(own, imported.value, &secret.value, 0));
  WipedKey raw;
  ULONG count = 0;
  Check(BCryptDeriveKey(secret.value, BCRYPT_KDF_RAW_SECRET, nullptr, raw.value.data(), 32, &count,
                        0));
  if (count != 32 ||
      std::all_of(raw.value.begin(), raw.value.end(), [](uint8_t b) { return b == 0; }))
    throw std::runtime_error("invalid X25519 shared secret");
  WipedKey result;
  // BCRYPT_KDF_RAW_SECRET returns the opposite order for this curve.
  std::reverse_copy(raw.value.begin(), raw.value.end(), result.value.begin());
  return result;
}
Error CryptoError() {
  return {ErrorCode::kUnauthenticated, "Noise authentication failed"};
}
}  // namespace
Key Sha256(std::span<const uint8_t> bytes) {
  return Hash(bytes).value;
}
std::string Hex(std::span<const uint8_t> bytes) {
  constexpr char digits[] = "0123456789abcdef";
  std::string out;
  for (auto b : bytes) {
    out += digits[b >> 4];
    out += digits[b & 15];
  }
  return out;
}
Result<Key> Sha256File(const std::filesystem::path& path) {
  try {
    std::ifstream file(path, std::ios::binary);
    if (!file)
      return Error{ErrorCode::kUnavailable, "cannot open file for SHA-256"};
    Algorithm alg(BCRYPT_SHA256_ALGORITHM);
    BCRYPT_HASH_HANDLE hash = nullptr;
    Check(BCryptCreateHash(alg.value, &hash, nullptr, 0, nullptr, 0, 0));
    std::array<uint8_t, 65536> buffer;
    NTSTATUS status = 0;
    while (file && status >= 0) {
      file.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
      status = BCryptHashData(hash, buffer.data(), static_cast<ULONG>(file.gcount()), 0);
    }
    Key result{};
    if (status >= 0)
      status = BCryptFinishHash(hash, result.data(), 32, 0);
    BCryptDestroyHash(hash);
    Check(status);
    if (!file.eof())
      return Error{ErrorCode::kUnavailable, "file read failed"};
    return result;
  } catch (...) {
    return Error{ErrorCode::kInternal, "SHA-256 failed"};
  }
}
struct CipherState::Impl {
  Algorithm alg{BCRYPT_AES_ALGORITHM};
  CryptoKey key;
  uint64_t nonce = 0;
  bool failed = false;
  explicit Impl(const Key& bytes) {
    Check(BCryptSetProperty(alg.value, BCRYPT_CHAINING_MODE,
                            reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(BCRYPT_CHAIN_MODE_GCM)),
                            sizeof(BCRYPT_CHAIN_MODE_GCM), 0));
    Check(BCryptGenerateSymmetricKey(alg.value, &key.value, nullptr, 0,
                                     const_cast<PUCHAR>(bytes.data()), 32, 0));
  }
  Result<Bytes> Crypt(std::span<const uint8_t> input, std::span<const uint8_t> ad, bool encrypt) {
    if (failed || nonce == UINT64_MAX) {
      failed = true;
      return Error{ErrorCode::kUnavailable, "cipher closed"};
    }
    if (input.size() > (encrypt ? kMaxPlaintext : kMaxCiphertext) ||
        (!encrypt && input.size() < 16)) {
      failed = true;
      return Error{ErrorCode::kLimitExceeded, "Noise message size invalid"};
    }
    std::array<uint8_t, 12> iv{};
    for (int i = 0; i < 8; ++i)
      iv[11 - i] = static_cast<uint8_t>(nonce >> (8 * i));
    size_t length = encrypt ? input.size() : input.size() - 16;
    Bytes output(length + (encrypt ? 16 : 0));
    uint8_t empty = 0;
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO auth;
    BCRYPT_INIT_AUTH_MODE_INFO(auth);
    auth.pbNonce = iv.data();
    auth.cbNonce = 12;
    auth.pbAuthData = const_cast<PUCHAR>(ad.data());
    auth.cbAuthData = static_cast<ULONG>(ad.size());
    auth.pbTag = encrypt ? output.data() + length : const_cast<PUCHAR>(input.data() + length);
    auth.cbTag = 16;
    ULONG count = 0;
    auto operation = encrypt ? BCryptEncrypt : BCryptDecrypt;
    NTSTATUS status =
        operation(key.value, input.empty() ? &empty : const_cast<PUCHAR>(input.data()),
                  static_cast<ULONG>(length), &auth, nullptr, 0,
                  output.empty() ? &empty : output.data(), static_cast<ULONG>(length), &count, 0);
    if (status < 0) {
      failed = true;
      return CryptoError();
    }
    ++nonce;
    return output;
  }
};
CipherState::CipherState(const Key& key) : impl_(std::make_unique<Impl>(key)) {}
CipherState::~CipherState() = default;
CipherState::CipherState(CipherState&&) noexcept = default;
CipherState& CipherState::operator=(CipherState&&) noexcept = default;
Result<Bytes> CipherState::Encrypt(std::span<const uint8_t> bytes, std::span<const uint8_t> ad) {
  return impl_->Crypt(bytes, ad, true);
}
Result<Bytes> CipherState::Decrypt(std::span<const uint8_t> bytes, std::span<const uint8_t> ad) {
  return impl_->Crypt(bytes, ad, false);
}
TransportKeys::~TransportKeys() {
  SecureZeroMemory(send.data(), 32);
  SecureZeroMemory(receive.data(), 32);
}
TestEphemeral::~TestEphemeral() {
  SecureZeroMemory(private_key.data(), 32);
}
struct Noise::Impl {
  Role role;
  int step = 0;
  bool failed = false;
  WipedKey ck, psk;
  Key h{}, public_key{}, remote{};
  Algorithm alg{BCRYPT_ECDH_ALGORITHM};
  CryptoKey ephemeral;
  std::unique_ptr<CipherState> cipher;
  Impl(Role r, const Key& key, std::string_view prologue, const TestEphemeral* test)
      : role(r), psk{key} {
    constexpr std::string_view name = "Noise_NNpsk0_25519_AESGCM_SHA256";
    std::copy(name.begin(), name.end(), h.begin());
    ck.value = h;
    MixHash({reinterpret_cast<const uint8_t*>(prologue.data()), prologue.size()});
    Curve(alg);
    if (test) {
      EccBlob blob{{BCRYPT_ECDH_PRIVATE_GENERIC_MAGIC, 32}};
      WipedKey clamped{test->private_key};
      clamped.value[0] &= 248;
      clamped.value[31] &= 127;
      clamped.value[31] |= 64;
      std::copy(clamped.value.begin(), clamped.value.end(), blob.d.begin());
      auto status = BCryptImportKeyPair(alg.value, nullptr, BCRYPT_ECCPRIVATE_BLOB,
                                        &ephemeral.value, reinterpret_cast<PUCHAR>(&blob),
                                        sizeof(blob), BCRYPT_NO_KEY_VALIDATION);
      SecureZeroMemory(&blob, sizeof(blob));
      Check(status);
    } else {
      Check(BCryptGenerateKeyPair(alg.value, &ephemeral.value, 255, 0));
      Check(BCryptFinalizeKeyPair(ephemeral.value, 0));
    }
    Key base{};
    base[0] = 9;
    public_key = Dh(alg, ephemeral.value, base).value;
  }
  void MixHash(std::span<const uint8_t> bytes) {
    Bytes joined(h.begin(), h.end());
    WipeBuffer wipe{joined};
    joined.insert(joined.end(), bytes.begin(), bytes.end());
    h = Hash(joined).value;
  }
  void MixKey(std::span<const uint8_t> input) {
    Derived derived{Hkdf(ck.value, input)};
    ck.value = derived.keys[0];
    cipher = std::make_unique<CipherState>(derived.keys[1]);
  }
  void Psk() {
    Derived derived{Hkdf(ck.value, psk.value)};
    ck.value = derived.keys[0];
    MixHash(derived.keys[1]);
    cipher = std::make_unique<CipherState>(derived.keys[2]);
  }
  void E(std::span<const uint8_t> bytes) {
    MixHash(bytes);
    MixKey(bytes);
  }
  void Ee() {
    WipedKey shared{Dh(alg, ephemeral.value, remote)};
    MixKey(shared.value);
  }
};
Noise::Noise(Role r, const Key& psk, std::string_view prologue, const TestEphemeral* test)
    : impl_(std::make_unique<Impl>(r, psk, prologue, test)) {}
Noise::~Noise() = default;
Key Noise::handshake_hash() const {
  return impl_->h;
}
Result<Bytes> Noise::Write(std::span<const uint8_t> payload) {
  auto& s = *impl_;
  if (s.failed || s.step != (s.role == Role::kInitiator ? 0 : 1) || payload.size() > 65535 - 48)
    return Error{ErrorCode::kInvalidRequest, "invalid Noise handshake write"};
  try {
    if (s.step == 0)
      s.Psk();
    s.E(s.public_key);
    if (s.step == 1)
      s.Ee();
    auto encrypted = s.cipher->Encrypt(payload, s.h);
    if (!encrypted) {
      s.failed = true;
      return encrypted.error();
    }
    s.MixHash(encrypted.value());
    Bytes out(s.public_key.begin(), s.public_key.end());
    out.insert(out.end(), encrypted.value().begin(), encrypted.value().end());
    ++s.step;
    return out;
  } catch (...) {
    s.failed = true;
    return CryptoError();
  }
}
Result<Bytes> Noise::Read(std::span<const uint8_t> message) {
  auto& s = *impl_;
  if (s.failed || s.step != (s.role == Role::kInitiator ? 1 : 0) || message.size() < 48 ||
      message.size() > 65535) {
    s.failed = true;
    return CryptoError();
  }
  try {
    if (s.step == 0)
      s.Psk();
    std::copy_n(message.begin(), 32, s.remote.begin());
    s.E(s.remote);
    if (s.step == 1)
      s.Ee();
    auto plain = s.cipher->Decrypt(message.subspan(32), s.h);
    if (!plain) {
      s.failed = true;
      return plain.error();
    }
    s.MixHash(message.subspan(32));
    ++s.step;
    return plain;
  } catch (...) {
    s.failed = true;
    return CryptoError();
  }
}
Result<TransportKeys> Noise::Split() {
  if (impl_->failed || impl_->step != 2)
    return Error{ErrorCode::kInvalidRequest, "Noise handshake incomplete"};
  Derived derived{Hkdf(impl_->ck.value, {})};
  impl_->step = 3;
  if (impl_->role == Role::kInitiator)
    return TransportKeys{derived.keys[0], derived.keys[1]};
  return TransportKeys{derived.keys[1], derived.keys[0]};
}
}  // namespace remotekit::cluster
