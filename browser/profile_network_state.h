#pragma once

#include <memory>
#include "base/files/file_path.h"
#include "services/network/public/mojom/network_context.mojom-forward.h"

class CookieEncryptionProviderImpl;
namespace os_crypt_async {
class OSCryptAsync;
}

namespace remotekit::browser {
class ProfileKey;
// Owned by one BrowserContext; outlives all of that Profile's partitions.
class ProfileNetworkState final {
 public:
  ProfileNetworkState(const base::FilePath& profile_path, std::unique_ptr<ProfileKey> key);
  ~ProfileNetworkState();
  void Configure(bool in_memory,
                 const base::FilePath& relative_partition_path,
                 network::mojom::NetworkContextParams* params);

 private:
  const base::FilePath profile_path_;
  const std::unique_ptr<ProfileKey> key_;
  std::unique_ptr<os_crypt_async::OSCryptAsync> crypt_;
  std::unique_ptr<CookieEncryptionProviderImpl> encryption_provider_;
};
}  // namespace remotekit::browser
