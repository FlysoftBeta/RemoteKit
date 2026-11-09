// CPU-only regression: inherited profile keys, OSCrypt and non-backed clipboard APIs.
// No Browser, GPU, network traffic or Windows clipboard is created.
#include "remotekit/browser/profile_network_state.h"
#include "remotekit/browser/profile_key.h"

#include <windows.h>

#include <array>

#include "base/check.h"
#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_executor.h"
#include "base/task/thread_pool/thread_pool_instance.h"
#include "base/win/scoped_handle.h"
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
std::unique_ptr<remotekit::browser::ProfileKey> ReadKey(base::span<const uint8_t> bytes) {
  HANDLE read_handle = nullptr;
  HANDLE write_handle = nullptr;
  CHECK(CreatePipe(&read_handle, &write_handle, nullptr, 0));
  base::win::ScopedHandle reader(read_handle);
  base::win::ScopedHandle writer(write_handle);
  if (!bytes.empty()) {
    DWORD written = 0;
    CHECK(
        WriteFile(writer.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr));
    CHECK(written == bytes.size());
  }
  writer.Close();
  base::CommandLine command(base::CommandLine::NO_PROGRAM);
  command.AppendSwitchASCII("profile-key-handle",
                            base::NumberToString(reinterpret_cast<uintptr_t>(reader.release())));
  auto key = remotekit::browser::ProfileKey::ReadFromCommandLine(command);
  DWORD flags = 0;
  CHECK(!GetHandleInformation(read_handle, &flags));
  CHECK(GetLastError() == ERROR_INVALID_HANDLE);
  return key;
}

void CheckKeyHandoff() {
  base::CommandLine missing(base::CommandLine::NO_PROGRAM);
  CHECK(!remotekit::browser::ProfileKey::ReadFromCommandLine(missing));
  for (const auto* value :
       {"", "0", "-1", "+123", " 123", "123x", "18446744073709551616", "18446744073709551615"}) {
    base::CommandLine invalid(base::CommandLine::NO_PROGRAM);
    invalid.AppendSwitchASCII("profile-key-handle", value);
    CHECK(!remotekit::browser::ProfileKey::ReadFromCommandLine(invalid));
  }
  std::array<uint8_t, 64> bytes = {};
  CHECK(!ReadKey({}));
  CHECK(!ReadKey(base::span(bytes).first<31>()));
  CHECK(ReadKey(base::span(bytes).first<32>()));
  CHECK(!ReadKey(base::span(bytes).first<33>()));
  CHECK(!ReadKey(bytes));
}

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
      },
      &result, loop.QuitClosure()));
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
  CheckKeyHandoff();
  base::ScopedTempDir temporary;
  CHECK(temporary.CreateUniqueTempDir());
  const auto a = temporary.GetPath().AppendASCII("tenant-a");
  const auto b = temporary.GetPath().AppendASCII("tenant-b");
  std::array<uint8_t, 32> key_a;
  key_a.fill(0x12);
  std::array<uint8_t, 32> key_b;
  key_b.fill(0x34);
  {
    const auto key = ReadKey(key_a);
    CHECK(key);
    remotekit::browser::ProfileKeyProvider provider(*key);
    CHECK(provider.UseForEncryption());
  }
  std::vector<uint8_t> ciphertext;
  {
    remotekit::browser::ProfileNetworkState state(a, ReadKey(key_a));
    auto params = network::mojom::NetworkContextParams::New();
    state.Configure(false, {}, params.get());
    CHECK(params->file_paths->data_directory.path() == a.AppendASCII("Network"));
    CHECK(params->file_paths->cookie_database_name == base::FilePath(FILE_PATH_LITERAL("Cookies")));
    CHECK(params->file_paths->trigger_migration);
    CHECK(params->enable_encrypted_cookies);
    CHECK(params->persist_session_cookies && params->restore_old_session_cookies);
    auto partition = network::mojom::NetworkContextParams::New();
    state.Configure(false, base::FilePath(FILE_PATH_LITERAL("partitions/site-a")), partition.get());
    CHECK(partition->file_paths->data_directory.path() !=
          params->file_paths->data_directory.path());
    CHECK(a.IsParent(partition->file_paths->data_directory.path()));
    auto memory = network::mojom::NetworkContextParams::New();
    state.Configure(true, {}, memory.get());
    CHECK(!memory->file_paths && !memory->cookie_encryption_provider);
    const auto encrypted = EncryptorFor(state)->EncryptString("profile-cookie-roundtrip");
    CHECK(encrypted);
    ciphertext = *encrypted;
    CHECK(base::as_string_view(base::span(ciphertext).first<3>()) == "rk1");
  }
  {
    remotekit::browser::ProfileNetworkState reopened(a, ReadKey(key_a));
    const auto plaintext = EncryptorFor(reopened)->DecryptData(ciphertext);
    CHECK(plaintext && *plaintext == "profile-cookie-roundtrip");
    remotekit::browser::ProfileNetworkState other(b, ReadKey(key_b));
    CHECK(!EncryptorFor(other)->DecryptData(ciphertext));
    const auto other_ciphertext = EncryptorFor(other)->EncryptString("other-profile-cookie");
    CHECK(other_ciphertext);
    CHECK(!EncryptorFor(reopened)->DecryptData(*other_ciphertext));
  }
  {
    remotekit::browser::ProfileNetworkState wrong_key(a, ReadKey(key_b));
    CHECK(!EncryptorFor(wrong_key)->DecryptData(ciphertext));
    remotekit::browser::ProfileNetworkState relocated(b, ReadKey(key_a));
    const auto plaintext = EncryptorFor(relocated)->DecryptData(ciphertext);
    CHECK(plaintext && *plaintext == "profile-cookie-roundtrip");
  }
  // The factory/type check is before every operation; this test can never
  // accidentally fall back to ClipboardWin or inspect the user's clipboard.
  headless::SetHeadlessClipboardForCurrentThread();
  CHECK(ui::ClipboardNonBacked::GetForCurrentThread());
  const auto empty =
      ui::Clipboard::GetForCurrentThread()->GetSequenceNumber(ui::ClipboardBuffer::kCopyPaste);
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(u"tenant-a-only");
  }
  CHECK(ui::Clipboard::GetForCurrentThread()->GetSequenceNumber(ui::ClipboardBuffer::kCopyPaste) !=
        empty);
  CHECK(!ui::Clipboard::GetForCurrentThread()->IsMarkedByOriginatorAsConfidential());
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(u"concealed");
    writer.MarkAsConfidential();
  }
  CHECK(ui::Clipboard::GetForCurrentThread()->IsMarkedByOriginatorAsConfidential());
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(u"exclude from history");
    writer.MarkAsOffTheRecord();
  }
  CHECK(ui::Clipboard::GetForCurrentThread()->IsMarkedByOriginatorAsConfidential());
  {
    ui::ScopedClipboardWriter writer(ui::ClipboardBuffer::kCopyPaste);
    writer.WriteText(u"ordinary");
  }
  CHECK(!ui::Clipboard::GetForCurrentThread()->IsMarkedByOriginatorAsConfidential());
  ui::Clipboard::DestroyClipboardForCurrentThread();
  headless::SetHeadlessClipboardForCurrentThread();
  CHECK(ui::ClipboardNonBacked::GetForCurrentThread());
  base::RunLoop read;
  ui::Clipboard::GetForCurrentThread()->ReadText(
      ui::ClipboardBuffer::kCopyPaste, std::nullopt,
      base::BindOnce(
          [](base::OnceClosure quit, std::u16string text) {
            CHECK(text.empty());
            std::move(quit).Run();
          },
          read.QuitClosure()));
  read.Run();
  ui::Clipboard::DestroyClipboardForCurrentThread();
  base::ThreadPoolInstance::Get()->Shutdown();
  return 0;
}
