#pragma once
#include <memory>
#include "content/public/app/content_main_delegate.h"

namespace remotekit::browser {
class MainDelegate final : public content::ContentMainDelegate {
 public:
  MainDelegate();
  ~MainDelegate() override;
  std::optional<int> BasicStartupComplete() override;
  void PreSandboxStartup() override;

 protected:
  content::ContentClient* CreateContentClient() override;
  content::ContentBrowserClient* CreateContentBrowserClient() override;
  content::ContentRendererClient* CreateContentRendererClient() override;

 private:
  std::unique_ptr<content::ContentClient> content_client_;
  std::unique_ptr<content::ContentBrowserClient> browser_client_;
  std::unique_ptr<content::ContentRendererClient> renderer_client_;
};
}  // namespace remotekit::browser
