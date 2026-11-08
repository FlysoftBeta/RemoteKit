#pragma once

#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/supports_user_data.h"
#include "base/values.h"
#include "browser/view_model.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/url_loader_factory.mojom-forward.h"
#include "services/network/public/mojom/network_context.mojom-forward.h"
namespace network {
class URLLoaderFactoryBuilder;
}

namespace content {
class WebContents;
class NavigationThrottleRegistry;
}  // namespace content
namespace remotekit::browser {
class SignIn final {
 public:
  SignIn(std::string purpose, WebViewId view);
  ~SignIn();
  void Attach(content::WebContents*);
  static SignIn* ForContents(content::WebContents*);
  const std::string& purpose() const { return purpose_; }
  bool completed() const { return completed_; }
  void Reset();
  void Complete(base::DictValue);
  const base::DictValue& event() const { return event_; }
  void Acknowledge(const base::ListValue& ids);
  base::WeakPtr<SignIn> GetRequestWeakPtr() { return request_weak_factory_.GetWeakPtr(); }
  base::WeakPtr<SignIn> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  const std::string purpose_;
  const WebViewId view_;
  bool completed_ = false;
  base::DictValue event_;
  base::WeakPtrFactory<SignIn> weak_factory_{this};
  base::WeakPtrFactory<SignIn> request_weak_factory_{this};
};

void InstallSignInRequestObserver(
    content::WebContents*,
    network::URLLoaderFactoryBuilder&,
    mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>*);
void AddSignInNavigationThrottle(content::NavigationThrottleRegistry&);
mojo::PendingRemote<network::mojom::URLLoaderFactory> CreateSignInPageFactory(
    content::WebContents*);
}  // namespace remotekit::browser
