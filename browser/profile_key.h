#pragma once

#include <array>
#include <cstdint>
#include <memory>

#include "base/containers/span.h"
#include "base/memory/raw_ref.h"
#include "components/os_crypt/async/browser/key_provider.h"

namespace base {
class CommandLine;
}

namespace remotekit::browser {
class ProfileKey final {
 public:
  static std::unique_ptr<ProfileKey> ReadFromCommandLine(const base::CommandLine& command);
  ~ProfileKey();

  ProfileKey(const ProfileKey&) = delete;
  ProfileKey& operator=(const ProfileKey&) = delete;

  base::span<const uint8_t> bytes() const { return bytes_; }

 private:
  ProfileKey() = default;
  std::array<uint8_t, 32> bytes_ = {};
};

class ProfileKeyProvider final : public os_crypt_async::KeyProvider {
 public:
  explicit ProfileKeyProvider(const ProfileKey& key);
  ~ProfileKeyProvider() override;

  void GetKey(KeyCallback callback) override;
  bool UseForEncryption() override;

 private:
  const raw_ref<const ProfileKey> key_;
};
}  // namespace remotekit::browser
