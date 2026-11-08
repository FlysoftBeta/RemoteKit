#include "browser/device_configuration.h"
#include "browser/chrome_parity.h"
#include "third_party/blink/public/common/renderer_preferences/renderer_preferences.h"
#include "ui/base/ui_base_paths.h"
#include "base/files/file.h"
#include "base/files/memory_mapped_file.h"
#include "browser/context_menu.h"
#include "remotekit/browser/main_delegate.h"
#include "remotekit/browser/crash_reporter.h"
#include "remotekit/browser/audio_target.h"
#include "media/audio/audio_manager.h"

#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/logging/logging_settings.h"
#include "base/memory/ref_counted_memory.h"
#include "base/path_service.h"
#include "base/strings/string_number_conversions.h"
#include "components/embedder_support/user_agent_utils.h"
#include "content/public/browser/browser_main_parts.h"
#include "content/public/browser/content_browser_client.h"
#include "content/public/common/content_client.h"
#include "content/public/common/content_features.h"
#include "content/public/renderer/content_renderer_client.h"
#include "remotekit/browser/compat.h"
#include "remotekit/browser/compat_renderer.h"
#include "remotekit/browser/browser_runtime.h"
#include "remotekit/browser/browser_context.h"
#include "remotekit/browser/service_input_policy.h"
#include "remotekit/browser/service_gpu_policy.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "ui/base/l10n/l10n_util.h"
#include "ui/base/resource/resource_bundle.h"

namespace remotekit::browser {
namespace {
class ContentClient final : public content::ContentClient {
 public:
  std::u16string GetLocalizedString(int id) override { return l10n_util::GetStringUTF16(id); }
  std::string_view GetDataResource(int id, ui::ResourceScaleFactor scale) override {
    return ui::ResourceBundle::GetSharedInstance().GetRawDataResourceForScale(id, scale);
  }
  scoped_refptr<base::RefCountedMemory> GetDataResourceBytes(int id) override {
    return ui::ResourceBundle::GetSharedInstance().LoadDataResourceBytes(id);
  }
  std::string GetDataResourceString(int id) override {
    return ui::ResourceBundle::GetSharedInstance().LoadDataResourceString(id);
  }
  gfx::Image& GetNativeImageNamed(int id) override {
    return ui::ResourceBundle::GetSharedInstance().GetNativeImageNamed(id);
  }
};
class BrowserClient final : public content::ContentBrowserClient {
 public:
  std::unique_ptr<media::AudioManager> CreateAudioManager(media::AudioLogFactory* log) override {
    return CreateAudioTarget(log);
  }
  bool OverridesAudioManager() override { return true; }
  std::unique_ptr<content::WebContentsViewDelegate> GetWebContentsViewDelegate(
      content::WebContents* contents) override {
    return CreateRemoteContextMenuDelegate(contents);
  }
  void OnWebContentsCreated(content::WebContents* contents) override {
    DeviceConfiguration::InstallSiteIdentity(contents);
  }
  bool CanCreateWindow(content::RenderFrameHost*,
                       const GURL&,
                       const GURL&,
                       const url::Origin&,
                       content::mojom::WindowContainerType,
                       const GURL&,
                       const content::Referrer&,
                       const std::string&,
                       WindowOpenDisposition,
                       const blink::mojom::WindowFeatures&,
                       bool user_gesture,
                       bool,
                       bool* no_javascript_access) override {
    *no_javascript_access = false;
    return user_gesture;
  }
  std::unique_ptr<content::BrowserMainParts> CreateBrowserMainParts(bool) override {
    return std::make_unique<RemoteKitMainParts>();
  }
  std::string GetUserAgent() override { return ChromeUserAgent(); }
  std::string GetProduct() override { return embedder_support::GetProductAndVersion(); }
  blink::UserAgentMetadata GetUserAgentMetadata() override { return ChromeUserAgentMetadata(); }
  std::string GetApplicationLocale() override { return kChromeLocale; }
  std::string GetAcceptLangs(content::BrowserContext*) override { return ChromeAcceptLanguage(); }
  void OverrideWebPreferences(content::WebContents*,
                              content::SiteInstance&,
                              blink::web_pref::WebPreferences* prefs) override {
    ApplyChromeWebPreferences(*prefs);
  }
  void UpdateRendererPreferencesForWorker(content::BrowserContext*,
                                          blink::RendererPreferences* prefs) override {
    ApplyChromeRendererPreferences(*prefs);
  }
  void OverrideWorkerIdentity(content::BrowserContext* context,
                              const url::Origin& origin,
                              blink::RendererPreferences* prefs) override {
    const bool tablet =
        context && static_cast<BrowserContext*>(context)->TabletUaFor(origin.GetURL());
    prefs->user_agent_override = ChromeUserAgentOverride(tablet);
    prefs->navigator_platform_override = tablet ? kTabletNavigatorPlatform : "";
  }
  void ConfigureNetworkContextParams(content::BrowserContext* context,
                                     bool in_memory,
                                     const base::FilePath& relative_partition_path,
                                     network::mojom::NetworkContextParams* params,
                                     cert_verifier::mojom::CertVerifierCreationParams*) override {
    params->user_agent = ChromeUserAgent();
    params->accept_language = ChromeAcceptLanguage();
    params->enable_zstd = true;
    static_cast<BrowserContext*>(context)->ConfigureNetworkContext(in_memory,
                                                                   relative_partition_path, params);
  }
};
}  // namespace

MainDelegate::MainDelegate() = default;
MainDelegate::~MainDelegate() = default;
std::optional<int> MainDelegate::BasicStartupComplete() {
  auto& command = *base::CommandLine::ForCurrentProcess();
  ConfigureServiceScrollPolicy(command);
  ConfigureServiceGpuPolicy(command);
  // Service Aura roots are offscreen; product visibility controls demand.
  command.AppendSwitch("disable-backgrounding-occluded-windows");
  std::string disabled = command.GetSwitchValueASCII("disable-features");
  if (!disabled.empty())
    disabled += ",";
  disabled += "CalculateNativeWinOcclusion";
  // Our AudioManager owns the in-process playback target. Device monitoring
  // also routes by this feature, so it must match the actual service placement.
  disabled += ",";
  disabled += features::kAudioServiceOutOfProcess.name;
  command.AppendSwitchASCII("disable-features", disabled);
  std::string enabled = command.GetSwitchValueASCII("enable-features");
  if (!enabled.empty())
    enabled += ",";
  enabled += features::kWebContentsDiscard.name;
  enabled += ",RemoteKitOsrOutput";
  command.AppendSwitchASCII("enable-features", enabled);
  logging::LoggingSettings settings;
  settings.logging_dest = logging::LOG_TO_STDERR;
  auto log_path = command.GetSwitchValuePath("log-file");
  // Chromium child processes receive an inherited logging HANDLE, not a path.
  // Preserve it so GPU/renderer failures reach this Session's browser log.
  if (command.GetSwitchValueASCII("enable-logging") == "handle") {
    uint64_t log_handle = 0;
    if (base::StringToUint64(command.GetSwitchValueASCII("log-file"), &log_handle) && log_handle) {
      settings.logging_dest |= logging::LOG_TO_FILE;
      settings.log_file = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(log_handle));
    }
  }
  if (log_path.empty() && command.HasSwitch("data-path"))
    log_path = command.GetSwitchValuePath("data-path").AppendASCII("browser.log");
  if (!log_path.empty() && log_path.IsAbsolute() && base::CreateDirectory(log_path.DirName())) {
    settings.logging_dest |= logging::LOG_TO_FILE;
    settings.log_file_path = log_path.value().c_str();
    settings.lock_log = logging::LOCK_LOG_FILE;
  }
  const bool logging_ready = logging::InitLogging(settings);
  if (!command.HasSwitch("type"))
    LOG(INFO) << "RemoteKit startup InitLogging=" << logging_ready;
  if (command.GetSwitchValueASCII("type") == "gpu-process") {
    const auto error = ValidateServiceGpuAdapter(command);
    if (!error.empty()) {
      LOG(ERROR) << "RemoteKit GPU startup: " << error;
      return 78;
    }
  }
  return std::nullopt;
}
void MainDelegate::PreSandboxStartup() {
  InitializeCrashReporter();
  base::FilePath assets;
  CHECK(base::PathService::Get(base::DIR_ASSETS, &assets));
  const auto locales = assets.AppendASCII("locales");
  const auto primary = locales.AppendASCII("zh-CN.pak");
  const auto secondary = locales.AppendASCII("en-US.pak");
  CHECK(base::PathExists(primary)) << primary;
  CHECK(base::PathExists(secondary)) << secondary;
  CHECK(base::PathService::Override(ui::DIR_LOCALES, locales));
  CHECK_EQ(ui::ResourceBundle::InitSharedInstanceWithLocale(
               kChromeLocale, nullptr, ui::ResourceBundle::DO_NOT_LOAD_COMMON_RESOURCES),
           kChromeLocale);
  auto& bundle = ui::ResourceBundle::GetSharedInstance();
  bundle.AddDataPackFromPath(assets.AppendASCII("remotekit.pak"), ui::kScaleFactorNone);
  bundle.LoadAdditionalLocaleDataWithPakFileRegion(
      base::File(secondary, base::File::FLAG_OPEN | base::File::FLAG_READ),
      base::MemoryMappedFile::Region::kWholeFile);
}
content::ContentClient* MainDelegate::CreateContentClient() {
  content_client_ = std::make_unique<ContentClient>();
  return content_client_.get();
}
content::ContentBrowserClient* MainDelegate::CreateContentBrowserClient() {
  browser_client_ = std::make_unique<BrowserClient>();
  return browser_client_.get();
}
content::ContentRendererClient* MainDelegate::CreateContentRendererClient() {
  renderer_client_ = std::make_unique<CompatRendererClient>();
  return renderer_client_.get();
}
}  // namespace remotekit::browser
