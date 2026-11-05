#include "remotekit/browser/profile_network_state.h"

#include "base/check.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/run_loop.h"
#include "components/os_crypt/async/browser/dpapi_key_provider.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/browser/os_crypt_win.h"
#include "components/prefs/in_memory_pref_store.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/pref_service_factory.h"
#include "services/network/public/cpp/cookie_encryption_provider_impl.h"
#include "services/network/public/mojom/network_context.mojom.h"

namespace remotekit::browser {
namespace {
constexpr char kEncryptedKey[] = "os_crypt.encrypted_key";
constexpr char kAuditEnabled[] = "os_crypt.audit_enabled";
}  // namespace

ProfileNetworkState::ProfileNetworkState(const base::FilePath& profile_path)
    : profile_path_(profile_path) {
  CHECK(profile_path_.IsAbsolute());
  CHECK(base::CreateDirectory(profile_path_));
  auto registry = base::MakeRefCounted<PrefRegistrySimple>();
  os_crypt_async::RegisterLocalPrefs(registry.get());
  PrefServiceFactory factory;
  factory.set_user_prefs(base::MakeRefCounted<InMemoryPrefStore>());
  key_prefs_ = factory.Create(registry);
  const auto key_path = profile_path_.AppendASCII("NetworkKey.json");
  base::File key_file(key_path, base::File::FLAG_OPEN | base::File::FLAG_READ);
  if (key_file.IsValid()) {
    std::string json;
    CHECK(base::ReadFileToStringWithMaxSize(key_path, &json, 64 * 1024))
        << "Cannot read Profile network encryption key";
    auto stored = base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
    CHECK(stored && stored->FindString(kEncryptedKey) && stored->FindBool(kAuditEnabled));
    key_prefs_->SetString(kEncryptedKey, *stored->FindString(kEncryptedKey));
    key_prefs_->SetBoolean(kAuditEnabled, *stored->FindBool(kAuditEnabled));
    // Unlike Init(), this never replaces an existing key after DPAPI failure.
    CHECK(os_crypt_async::InitWithExistingKey(key_prefs_.get()) ==
          os_crypt_async::InitResult::kSuccess)
        << "Cannot decrypt Profile network encryption key";
  } else {
    CHECK(key_file.error_details() == base::File::FILE_ERROR_NOT_FOUND)
        << "Cannot open Profile network encryption key";
    CHECK(!base::DirectoryExists(profile_path_.AppendASCII("Network")))
        << "Profile network storage exists without its encryption key";
    CHECK(os_crypt_async::Init(key_prefs_.get())) << "Cannot create Profile network encryption key";
  }
  key_file.Close();
  base::DictValue stored;
  stored.Set(kEncryptedKey, key_prefs_->GetString(kEncryptedKey));
  stored.Set(kAuditEnabled, key_prefs_->GetBoolean(kAuditEnabled));
  const auto json = base::WriteJson(stored);
  CHECK(json && base::ImportantFileWriter::WriteFileAtomically(key_path, *json))
      << "Cannot persist Profile network encryption key";

  std::vector<std::pair<os_crypt_async::OSCryptAsync::Precedence,
                        std::unique_ptr<os_crypt_async::KeyProvider>>>
      providers;
  providers.emplace_back(1, std::make_unique<os_crypt_async::DPAPIKeyProvider>(key_prefs_.get()));
  crypt_ = std::make_unique<os_crypt_async::OSCryptAsync>(std::move(providers));
  // Validate the actual provider before opening any cookie database. DPAPI key
  // initialization alone does not validate the AES key size expected by it.
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
  // Persistent cookies survive restart. Session cookies retain Chromium's
  // default process-session lifetime; navigation recovery does not extend it.
  params->persist_session_cookies = false;
  params->restore_old_session_cookies = false;
}
}  // namespace remotekit::browser
