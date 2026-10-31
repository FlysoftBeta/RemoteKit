#include "remotekit/browser/main_delegate.h"

#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/logging/logging_settings.h"
#include "base/memory/ref_counted_memory.h"
#include "base/path_service.h"
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
  std::unique_ptr<content::DevToolsManagerDelegate> CreateDevToolsManagerDelegate() override {
    return std::make_unique<content::DevToolsManagerDelegate>();
  }
  std::unique_ptr<content::BrowserMainParts> CreateBrowserMainParts(bool) override {
    return std::make_unique<HarnessMainParts>();
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
  command.AppendSwitchASCII("enable-features", enabled);
  logging::LoggingSettings settings;
  settings.logging_dest = logging::LOG_TO_STDERR;
  auto log_path = command.GetSwitchValuePath("log-file");
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
