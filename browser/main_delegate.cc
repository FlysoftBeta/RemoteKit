#include "remotekit/browser/main_delegate.h"

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
#include "content/public/browser/devtools_manager_delegate.h"
#include "content/public/common/content_client.h"
#include "content/public/common/content_features.h"
#include "content/public/renderer/content_renderer_client.h"
#include "remotekit/browser/compat.h"
#include "remotekit/browser/compat_renderer.h"
#include "remotekit/browser/harness.h"
#include "remotekit/browser/webview.h"
#include "remotekit/browser/browser_context.h"
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
  void OnWebContentsCreated(content::WebContents* contents) override {
    BrowserContext::InstallSiteIdentity(contents);
  }
  bool CanCreateWindow(content::RenderFrameHost*, const GURL&, const GURL&,
      const url::Origin&, content::mojom::WindowContainerType, const GURL&,
      const content::Referrer&, const std::string&, WindowOpenDisposition,
      const blink::mojom::WindowFeatures&, bool user_gesture, bool,
      bool* no_javascript_access) override {
    *no_javascript_access = false;
    return user_gesture;
  }
  std::unique_ptr<content::DevToolsManagerDelegate> CreateDevToolsManagerDelegate() override {
    return std::make_unique<content::DevToolsManagerDelegate>();
  }
  std::unique_ptr<content::BrowserMainParts> CreateBrowserMainParts(bool) override {
    return std::make_unique<HarnessMainParts>();
  }
  void OverrideWebPreferences(content::WebContents* contents,
                              content::SiteInstance&,
                              blink::web_pref::WebPreferences* prefs) override {
    WebView::OverridePreferences(contents, prefs);
  }
  std::string GetUserAgent() override { return ChromeUserAgent(); }
  std::string GetProduct() override { return embedder_support::GetProductAndVersion(); }
  blink::UserAgentMetadata GetUserAgentMetadata() override { return ChromeUserAgentMetadata(); }
  std::string GetAcceptLangs(content::BrowserContext*) override { return "en-US,en"; }
  void ConfigureNetworkContextParams(content::BrowserContext*,
                                     bool,
                                     const base::FilePath&,
                                     network::mojom::NetworkContextParams* params,
                                     cert_verifier::mojom::CertVerifierCreationParams*) override {
    params->user_agent = ChromeUserAgent();
    params->accept_language = "en-US,en";
    params->enable_zstd = true;
  }
};
}  // namespace

MainDelegate::MainDelegate() = default;
MainDelegate::~MainDelegate() = default;
std::optional<int> MainDelegate::BasicStartupComplete() {
  auto& command = *base::CommandLine::ForCurrentProcess();
#if defined(REMOTEKIT_DEMO_HARNESS)
  command.AppendSwitch("demo-harness");
#else
  if (command.HasSwitch("demo-harness") || command.HasSwitch("sessions") ||
      command.HasSwitch("urls") || command.HasSwitch("parent-window"))
    return 2;
  command.AppendSwitch("gpu-output");
#endif
  if (command.HasSwitch("gpu-output")) {
    // This shown, nonzero Aura host is clipped out of the endpoint window.
    // Output demand, rather than native HWND occlusion, controls its capture.
    command.AppendSwitch("disable-backgrounding-occluded-windows");
    std::string disabled = command.GetSwitchValueASCII("disable-features");
    if (!disabled.empty())
      disabled += ",";
    disabled += "CalculateNativeWinOcclusion";
    command.AppendSwitchASCII("disable-features", disabled);
  }
  std::string enabled = command.GetSwitchValueASCII("enable-features");
  if (!enabled.empty())
    enabled += ",";
  enabled += features::kWebContentsDiscard.name;
#if !defined(REMOTEKIT_DEMO_HARNESS)
  enabled += ",RemoteKitCaptureRoot,RemoteKitCaptureToAtlas,RemoteKitSinglePlaneDirect";
#endif
  command.AppendSwitchASCII("enable-features", enabled);
  logging::LoggingSettings settings;
  settings.logging_dest = logging::LOG_TO_STDERR;
  auto log_path = command.GetSwitchValuePath("log-file");
  // Chromium child processes receive an inherited logging HANDLE, not a path.
  // Preserve it so GPU/renderer failures reach this Session's browser log.
  if (command.GetSwitchValueASCII("enable-logging") == "handle") {
    uint64_t log_handle = 0;
    if (base::StringToUint64(command.GetSwitchValueASCII("log-file"), &log_handle) &&
        log_handle) {
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
  logging::InitLogging(settings);
  return std::nullopt;
}
void MainDelegate::PreSandboxStartup() {
  base::FilePath assets;
  CHECK(base::PathService::Get(base::DIR_ASSETS, &assets));
  ui::ResourceBundle::InitSharedInstanceWithPakPath(assets.AppendASCII("remotekit.pak"));
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
