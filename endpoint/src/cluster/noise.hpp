#pragma once
#include "util/error.hpp"
#include <array>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

namespace remotekit::cluster {
using Key = std::array<uint8_t, 32>;
using Bytes = std::vector<uint8_t>;
inline constexpr size_t kMaxPlaintext = 4 * 1024 * 1024;
inline constexpr size_t kMaxCiphertext = kMaxPlaintext + 16;
Key PublicKey(const Key& private_key);
Key Sha256(std::span<const uint8_t> bytes);
Result<Key> Sha256File(const std::filesystem::path& path);
std::string Hex(std::span<const uint8_t> bytes);

class CipherState {
 public:
  explicit CipherState(const Key& key);
  ~CipherState();
  CipherState(CipherState&&) noexcept;
  CipherState& operator=(CipherState&&) noexcept;
  Result<Bytes> Encrypt(std::span<const uint8_t> plaintext, std::span<const uint8_t> ad = {});
  Result<Bytes> Decrypt(std::span<const uint8_t> ciphertext, std::span<const uint8_t> ad = {});

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
struct TransportKeys {
  Key send, receive;
  ~TransportKeys();
};
enum class Role { kInitiator, kResponder };
// Explicit test-only input: never populated by production callers.
struct TestEphemeral {
  Key private_key;
  ~TestEphemeral();
};
class Noise {
 public:
  Noise(Role role,
        const Key& private_key,
        std::optional<Key> responder_public_key = {},
        std::string_view prologue = "remotekit-cluster-2",
        const TestEphemeral* test_only = nullptr);
  ~Noise();
  Result<Bytes> Write(std::span<const uint8_t> payload);
  Result<Bytes> Read(std::span<const uint8_t> message);
  Result<TransportKeys> Split();
  Key handshake_hash() const;
  Key remote_public_key() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace remotekit::cluster
