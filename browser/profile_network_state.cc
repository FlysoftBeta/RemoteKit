#include "remotekit/browser/profile_network_state.h"

#include "base/check.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "remotekit/browser/profile_key.h"
#include "services/network/public/cpp/cookie_encryption_provider_impl.h"
#include "services/network/public/mojom/network_context.mojom.h"

namespace remotekit::browser {
ProfileNetworkState::ProfileNetworkState(const base::FilePath& profile_path,
                                         std::unique_ptr<ProfileKey> key)
    : profile_path_(profile_path), key_(std::move(key)) {
  CHECK(profile_path_.IsAbsolute());
  CHECK(key_);
  CHECK(base::CreateDirectory(profile_path_));
  std::vector<std::pair<os_crypt_async::OSCryptAsync::Precedence,
                        std::unique_ptr<os_crypt_async::KeyProvider>>>
      providers;
  providers.emplace_back(1, std::make_unique<ProfileKeyProvider>(*key_));
  crypt_ = std::make_unique<os_crypt_async::OSCryptAsync>(std::move(providers));
  base::RunLoop ready;
  crypt_->GetInstance(base::BindOnce(
      [](base::OnceClosure quit, scoped_refptr<os_crypt_async::Encryptor> encryptor) {
        CHECK(encryptor && encryptor->IsEncryptionAvailable());
        std::move(quit).Run();
      },
      ready.QuitClosure()));
  ready.Run();
  encryption_provider_ = std::make_unique<CookieEncryptionProviderImpl>(crypt_.get());
}
ProfileNetworkState::~ProfileNetworkState() = default;

void ProfileNetworkState::Configure(bool in_memory,
                                    const base::FilePath& relative_partition_path,
                                    network::mojom::NetworkContextParams* params) {
  if (in_memory)
    return;
  CHECK(!relative_partition_path.IsAbsolute());
  CHECK(!relative_partition_path.ReferencesParent());
  const auto partition_path = profile_path_.Append(relative_partition_path);
  params->file_paths = network::mojom::NetworkContextFilePaths::New();
  params->file_paths->data_directory = partition_path.AppendASCII("Network");
  // Chromium 157's Windows network sandbox grants this isolated Network
  // directory through the official migration/checkpoint mechanism. The old
  // path is still within this partition; no host or other Profile is read.
  params->file_paths->unsandboxed_data_path = partition_path;
  params->file_paths->trigger_migration = true;
  params->file_paths->cookie_database_name = base::FilePath(FILE_PATH_LITERAL("Cookies"));
  params->enable_encrypted_cookies = true;
  params->cookie_encryption_provider = encryption_provider_->BindNewRemote();
  // Both persistent and session cookies survive Browser restarts.
  params->persist_session_cookies = true;
  params->restore_old_session_cookies = true;
}
}  // namespace remotekit::browser
