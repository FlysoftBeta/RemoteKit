#pragma once

#include <memory>
#include "base/files/file_path.h"
#include "services/network/public/mojom/network_context.mojom-forward.h"

class CookieEncryptionProviderImpl;
class PrefService;
namespace os_crypt_async {
class OSCryptAsync;
}

namespace remotekit::browser {
// Owned by one BrowserContext; outlives all of that Profile's partitions.
// Only the DPAPI-wrapped key is persisted; no host/Chrome local state is used.
class ProfileNetworkState final {
 public:
  explicit ProfileNetworkState(const base::FilePath& profile_path);
  ~ProfileNetworkState();
  void Configure(bool in_memory,
                 const base::FilePath& relative_partition_path,
                 network::mojom::NetworkContextParams* params);

 private:
  const base::FilePath profile_path_;
  std::unique_ptr<PrefService> key_prefs_;
  std::unique_ptr<os_crypt_async::OSCryptAsync> crypt_;
  std::unique_ptr<CookieEncryptionProviderImpl> encryption_provider_;
};
}  // namespace remotekit::browser
