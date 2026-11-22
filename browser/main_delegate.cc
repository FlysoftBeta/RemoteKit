#include "browser/device_configuration.h"
#include "browser/diagnostic_log.h"
#include "browser/pdf_viewer.h"
#include "browser/signin.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "browser/services_browser.h"
#include <atomic>
#include "components/embedder_support/origin_trials/origin_trial_policy_impl.h"
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
#include "base/memory/ref_counted_memory.h"
#include "base/path_service.h"
#include "components/embedder_support/user_agent_utils.h"
#include "content/public/browser/browser_main_parts.h"
#include "content/public/browser/child_process_launcher_utils.h"
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
  void AddAdditionalSchemes(Schemes* schemes) override {
    schemes->standard_schemes.push_back("remotekit-signin");
    schemes->secure_schemes.push_back("remotekit-signin");
    schemes->cors_enabled_schemes.push_back("remotekit-signin");
    schemes->standard_schemes.push_back(kPdfScheme);
    schemes->secure_schemes.push_back(kPdfScheme);
    schemes->cors_enabled_schemes.push_back(kPdfScheme);
  }
  blink::OriginTrialPolicy* GetOriginTrialPolicy() override {
    if (!origin_policy_logged_.exchange(true, std::memory_order_relaxed)) {
      LogEvent("info", "browser.origin_trial_policy",
               base::DictValue().Set("supported", origin_trials_.IsOriginTrialsSupported()));
    }
    return &origin_trials_;
  }
  std::atomic<bool> origin_policy_logged_{false};
  embedder_support::OriginTrialPolicyImpl origin_trials_;
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
class BrowserClient final : public ServicesBrowserClient {
 public:
  void AppendExtraCommandLineSwitches(base::CommandLine* command, int child_process_id) override {
    ServicesBrowserClient::AppendExtraCommandLineSwitches(command, child_process_id);
    constexpr const char* switches[] = {"crash-dir", "tenant-id"};
    command->CopySwitchesFrom(*base::CommandLine::ForCurrentProcess(), switches);
  }
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
    InstallServiceOrientationDelegate();
  }
  void WillCreateURLLoaderFactory(
      content::BrowserContext*,
      content::RenderFrameHost* frame,
      int,
      URLLoaderFactoryType,
      const url::Origin& initiator,
      const net::IsolationInfo&,
      std::optional<int64_t>,
      ukm::SourceIdObj,
      network::URLLoaderFactoryBuilder& builder,
      mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>* headers,
      bool*,
      bool*,
      network::mojom::URLLoaderFactoryOverridePtr*,
      scoped_refptr<base::SequencedTaskRunner>,
      bool is_for_network_service) override {
    // The viewer's own scheme loads through non-network factories that are wrapped by this hook
    // too; only the network path is denied.
    if (is_for_network_service)
      DenyPdfNetworkRequests(initiator, builder);
    InstallSignInRequestObserver(content::WebContents::FromRenderFrameHost(frame), builder,
                                 headers);
  }
  void CreateThrottlesForNavigation(content::NavigationThrottleRegistry& registry) override {
    AddSignInNavigationThrottle(registry);
    AddPdfNavigationThrottle(registry);
  }
  mojo::PendingRemote<network::mojom::URLLoaderFactory> CreateNonNetworkNavigationURLLoaderFactory(
      const std::string& scheme,
      content::FrameTreeNodeId frame) override {
    if (scheme == "remotekit-signin")
      return CreateSignInPageFactory(content::WebContents::FromFrameTreeNodeId(frame));
    if (scheme == kPdfScheme)
      return CreatePdfNavigationFactory(content::WebContents::FromFrameTreeNodeId(frame));
    return {};
  }
  void RegisterNonNetworkSubresourceURLLoaderFactories(
      int render_process_id,
      int render_frame_id,
      const std::optional<url::Origin>& initiator,
      NonNetworkURLLoaderFactoryMap* factories) override {
    RegisterPdfSubresourceFactories(render_process_id, render_frame_id, initiator, factories);
  }
  void RegisterNonNetworkWorkerMainResourceURLLoaderFactories(
      content::BrowserContext*,
      const std::optional<url::Origin>& initiator,
      network::mojom::RequestDestination,
      NonNetworkURLLoaderFactoryMap* factories) override {
    RegisterPdfWorkerFactories(initiator, factories);
  }
  bool CanCreateWindow(content::RenderFrameHost* opener,
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
    auto* contents = content::WebContents::FromRenderFrameHost(opener);
    return user_gesture && !SignIn::ForContents(contents) && !PdfDocument::ForContents(contents);
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
  if (!InitializeDiagnosticLog())
    return 2;
  if (!command.HasSwitch("type")) {
    content::SetChildLogHandleProvider(DuplicateDiagnosticLogHandle);
    LogEvent("info", "browser.startup", base::DictValue().Set("phase", "logging_ready"));
  }
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
