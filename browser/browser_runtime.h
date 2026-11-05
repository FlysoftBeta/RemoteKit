#pragma once
#include <memory>
#include "content/public/browser/browser_main_parts.h"
namespace remotekit::browser {
class RemoteKitMainParts final : public content::BrowserMainParts {
 public:
  RemoteKitMainParts();
  ~RemoteKitMainParts() override;
  void PostCreateMainMessageLoop() override;
  int PostCreateThreads() override;
  int PreMainMessageLoopRun() override;
  void WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>& run_loop) override;
  void PostMainMessageLoopRun() override;

 private:
  struct State;
  std::unique_ptr<State> state_;
};
}  // namespace remotekit::browser
