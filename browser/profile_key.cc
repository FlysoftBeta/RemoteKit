#include "remotekit/browser/profile_key.h"

#include <windows.h>

#include <limits>
#include <utility>

#include "base/command_line.h"
#include "base/logging.h"
#include "base/strings/string_number_conversions.h"
#include "base/win/scoped_handle.h"
#include "components/os_crypt/async/common/algorithm.mojom.h"
#include "crypto/secure_util.h"

namespace remotekit::browser {
std::unique_ptr<ProfileKey> ProfileKey::ReadFromCommandLine(const base::CommandLine& command) {
  const auto value = command.GetSwitchValueASCII("profile-key-handle");
  uint64_t handle_value = 0;
  if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos ||
      !base::StringToUint64(value, &handle_value) || !handle_value ||
      handle_value > std::numeric_limits<uintptr_t>::max()) {
    LOG(ERROR) << "RemoteKit startup requires --profile-key-handle=<decimal pipe handle>";
    return nullptr;
  }
  HANDLE raw_handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_value));
  DWORD flags = 0;
  if (!GetHandleInformation(raw_handle, &flags)) {
    LOG(ERROR) << "RemoteKit startup profile key handle is invalid";
    return nullptr;
  }
  base::win::ScopedHandle handle(raw_handle);
  if (GetFileType(handle.get()) != FILE_TYPE_PIPE) {
    LOG(ERROR) << "RemoteKit startup profile key handle is not a valid pipe";
    return nullptr;
  }
  auto key = std::unique_ptr<ProfileKey>(new ProfileKey);
  auto bytes = base::span(key->bytes_);
  DWORD read = 0;
  if (!ReadFile(handle.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) ||
      read != bytes.size()) {
    LOG(ERROR) << "RemoteKit startup profile key pipe must contain exactly 32 bytes";
    return nullptr;
  }
  std::array<uint8_t, 1> extra = {};
  const bool read_extra =
      ReadFile(handle.get(), extra.data(), static_cast<DWORD>(extra.size()), &read, nullptr);
  const DWORD error = read_extra ? ERROR_SUCCESS : GetLastError();
  crypto::SecureZeroBuffer(extra);
  if ((read_extra && read != 0) || (!read_extra && error != ERROR_BROKEN_PIPE)) {
    LOG(ERROR) << "RemoteKit startup profile key pipe must end after exactly 32 bytes";
    return nullptr;
  }
  return key;
}

ProfileKey::~ProfileKey() {
  crypto::SecureZeroBuffer(bytes_);
}

ProfileKeyProvider::ProfileKeyProvider(const ProfileKey& key) : key_(key) {}
ProfileKeyProvider::~ProfileKeyProvider() = default;

void ProfileKeyProvider::GetKey(KeyCallback callback) {
  std::move(callback).Run("rk1", os_crypt_async::Encryptor::Key(
                                     key_->bytes(), os_crypt_async::mojom::Algorithm::kAES256GCM));
}

bool ProfileKeyProvider::UseForEncryption() {
  return true;
}

}  // namespace remotekit::browser
