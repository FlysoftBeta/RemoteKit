#include "remotekit/browser/crash_reporter.h"

#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/no_destructor.h"
#include "components/crash/core/app/crash_reporter_client.h"
#include "components/crash/core/app/crashpad.h"
#include "components/crash/core/common/crash_key.h"
#include "components/version_info/version_info.h"

namespace remotekit::browser {
namespace {
class CrashReporterClient final : public crash_reporter::CrashReporterClient {
 public:
  bool GetCrashDumpLocation(std::wstring* directory) override {
    const auto path = base::CommandLine::ForCurrentProcess()->GetSwitchValuePath("crash-dir");
    if (path.empty())
      return false;
    const auto& crashes = path;
    if (!base::CreateDirectory(crashes))
      return false;
    *directory = crashes.value();
    return true;
  }

  void GetProductNameAndVersion(const std::wstring&,
                                std::wstring* product,
                                std::wstring* version,
                                std::wstring*,
                                std::wstring*) override {
    *product = L"RemoteKit";
    const auto value = version_info::GetVersionNumber();
    version->assign(value.begin(), value.end());
  }

  std::string GetUploadUrl() override { return {}; }
  bool GetCollectStatsConsent() override { return false; }
  bool ReportingIsEnforcedByPolicy(bool* enabled) override {
    *enabled = false;
    return true;
  }
  bool EnableBreakpadForProcess(const std::string&) override { return true; }
};
}  // namespace

void InitializeCrashReporter() {
  if (base::CommandLine::ForCurrentProcess()->GetSwitchValuePath("crash-dir").empty())
    return;
  static base::NoDestructor<CrashReporterClient> client;
  crash_reporter::SetCrashReporterClient(client.get());
  const auto type = base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("type");
  if (type.empty()) {
    // Chromium's testing override must not turn local collection into upload.
    base::Environment::Create()->UnSetVar("CHROME_CRASHPAD_SERVER_URL");
  }
  CHECK(crash_reporter::InitializeCrashpadWithEmbeddedHandler(type.empty(), type, {}, {}));
  if (type.empty())
    crash_reporter::SetUploadConsent(false);
  crash_reporter::InitializeCrashKeys();
}
}  // namespace remotekit::browser
