// CPU-only regression: actual DPAPI/OSCrypt and non-backed clipboard APIs.
// No Browser, GPU, network traffic or Windows clipboard is created.
#include "remotekit/browser/profile_network_state.h"

#include "base/check.h"
#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "base/task/single_thread_task_executor.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "components/headless/clipboard/headless_clipboard.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "mojo/core/embedder/embedder.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/network/public/mojom/cookie_encryption_provider.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_non_backed.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"

namespace {
scoped_refptr<os_crypt_async::Encryptor> EncryptorFor(
    remotekit::browser::ProfileNetworkState& state) {
  auto params = network::mojom::NetworkContextParams::New();
  state.Configure(false, {}, params.get());
  mojo::Remote<network::mojom::CookieEncryptionProvider> provider(
      std::move(params->cookie_encryption_provider));
  scoped_refptr<os_crypt_async::Encryptor> result;
  base::RunLoop loop;
  provider->GetEncryptor(base::BindOnce(
      [](scoped_refptr<os_crypt_async::Encryptor>* result, base::OnceClosure quit,
         scoped_refptr<os_crypt_async::Encryptor> value) {
        *result = std::move(value);
        std::move(quit).Run();
      }, &result, loop.QuitClosure()));
  loop.Run();
  CHECK(result && result->IsEncryptionAvailable());
  return result;
}
}  // namespace

int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  base::SingleThreadTaskExecutor tasks;
  base::ThreadPoolInstance::CreateAndStartWithDefaultParams("ProfileIsolationProbe");
  mojo::core::Init();
  base::ScopedTempDir temporary;
  CHECK(temporary.CreateUniqueTempDir());
  const auto a = temporary.GetPath().AppendASCII("tenant-a");
  const auto b = temporary.GetPath().AppendASCII("tenant-b");
  std::vector<uint8_t> ciphertext;
  {
    remotekit::browser::ProfileNetworkState state(a);
    auto params = network::mojom::NetworkContextParams::New();
    state.Configure(false, {}, params.get());
    CHECK(params->file_paths->data_directory.path() == a.AppendASCII("Network"));
    CHECK(params->file_paths->cookie_database_name ==
          base::FilePath(FILE_PATH_LITERAL("Cookies")));
    CHECK(params->file_paths->trigger_migration);
    CHECK(params->enable_encrypted_cookies);
    CHECK(!params->persist_session_cookies && !params->restore_old_session_cookies);
    auto partition = network::mojom::NetworkContextParams::New();
    state.Configure(false, base::FilePath(FILE_PATH_LITERAL("partitions/site-a")), partition.get());
    CHECK(partition->file_paths->data_directory.path() != params->file_paths->data_directory.path());
    CHECK(a.IsParent(partition->file_paths->data_directory.path()));
    auto memory = network::mojom::NetworkContextParams::New();
    state.Configure(true, {}, memory.get());
    CHECK(!memory->file_paths && !memory->cookie_encryption_provider);
    const auto encrypted = EncryptorFor(state)->EncryptString("profile-cookie-roundtrip");
    CHECK(encrypted);
    ciphertext = *encrypted;
  }
  {
    remotekit::browser::ProfileNetworkState reopened(a);
    const auto plaintext = EncryptorFor(reopened)->DecryptData(ciphertext);
    CHECK(plaintext && *plaintext == "profile-cookie-roundtrip");
    remotekit::browser::ProfileNetworkState other(b);
    CHECK(!EncryptorFor(other)->DecryptData(ciphertext));
  }
  // The factory/type check is before every operation; this test can never
  // accidentally fall back to ClipboardWin or inspect the user's clipboard.
  headless::SetHeadlessClipboardForCurrentThread();
  CHECK(ui::ClipboardNonBacked::GetForCurrentThread());
  const auto empty = ui::Clipboard::GetForCurrentThread()->GetSequenceNumber(ui::ClipboardBuffer::kCopyPaste);
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(u"tenant-a-only");
  }
  CHECK(ui::Clipboard::GetForCurrentThread()->GetSequenceNumber(ui::ClipboardBuffer::kCopyPaste) != empty);
  ui::Clipboard::DestroyClipboardForCurrentThread();
  headless::SetHeadlessClipboardForCurrentThread();
  CHECK(ui::ClipboardNonBacked::GetForCurrentThread());
  base::RunLoop read;
  ui::Clipboard::GetForCurrentThread()->ReadText(ui::ClipboardBuffer::kCopyPaste, std::nullopt,
      base::BindOnce([](base::OnceClosure quit, std::u16string text) {
        CHECK(text.empty());
        std::move(quit).Run();
      }, read.QuitClosure()));
  read.Run();
  ui::Clipboard::DestroyClipboardForCurrentThread();
  base::ThreadPoolInstance::Get()->Shutdown();
  return 0;
}
