#include "browser/services_browser.h"

#include "browser/browser_context.h"
#include "browser/page_requests.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "content/public/browser/web_contents.h"
#include "net/base/auth.h"
#include "net/base/host_port_pair.h"
#include "net/http/http_response_headers.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "third_party/blink/public/common/loader/url_loader_throttle.h"

namespace remotekit::browser {
namespace {
void ClearSecret(std::u16string& value) {
  for (auto& character : value)
    static_cast<volatile char16_t&>(character) = 0;
  value.clear();
}
class PageLogin final : public content::LoginDelegate {
 public:
  PageLogin(PageRequests* page, base::DictValue data, LoginAuthRequiredCallback callback)
      : page_(page->GetWeakPtr()), callback_(std::move(callback)) {
    request_ = page->RequestAuth(
        std::move(data), base::BindOnce(
                             [](base::WeakPtr<PageLogin> self, bool accept,
                                const std::string& username, const std::string& password) {
                               if (!self)
                                 return;
                               if (self->creating_) {
                                 base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
                                     FROM_HERE, base::BindOnce(
                                                    [](base::WeakPtr<PageLogin> self) {
                                                      if (self)
                                                        self->Reply(false, {}, {});
                                                    },
                                                    self));
                                 return;
                               }
                               self->Reply(accept, username, password);
                             },
                             weak_factory_.GetWeakPtr()));
    creating_ = false;
  }

  ~PageLogin() override {
    callback_.Reset();
    weak_factory_.InvalidateWeakPtrs();
    if (page_)
      page_->CancelRequest(request_);
  }

 private:
  void Reply(bool accept, const std::string& username, const std::string& password) {
    std::optional<net::AuthCredentials> credentials;
    if (accept) {
      auto native_username = base::UTF8ToUTF16(username);
      auto native_password = base::UTF8ToUTF16(password);
      credentials.emplace(native_username, native_password);
      ClearSecret(native_username);
      ClearSecret(native_password);
    }
    auto callback = std::move(callback_);
    if (callback)
      std::move(callback).Run(credentials);
    if (credentials) {
      ClearSecret(const_cast<std::u16string&>(credentials->username()));
      ClearSecret(const_cast<std::u16string&>(credentials->password()));
    }
  }
  base::WeakPtr<PageRequests> page_;
  std::uint64_t request_ = 0;
  bool creating_ = true;
  LoginAuthRequiredCallback callback_;
  base::WeakPtrFactory<PageLogin> weak_factory_{this};
};
class ProtocolThrottle final : public blink::URLLoaderThrottle {
 public:
  explicit ProtocolThrottle(BrowserContext* context) : context_(context) {}
  void WillStartRequest(network::ResourceRequest* request, bool*) override {
    request->url = context_->TranslateProtocolUrl(request->url);
  }
  void WillRedirectRequest(net::RedirectInfo* redirect,
                           const network::mojom::URLResponseHead&,
                           bool*,
                           network::HttpRequestHeadersUpdateParams*) override {
    redirect->new_url = context_->TranslateProtocolUrl(redirect->new_url);
  }

 private:
  raw_ptr<BrowserContext> context_;
};
}  // namespace
std::unique_ptr<content::LoginDelegate> ServicesBrowserClient::CreateLoginDelegate(
    const net::AuthChallengeInfo& challenge,
    content::WebContents* contents,
    content::BrowserContext*,
    const content::GlobalRequestID&,
    bool,
    bool,
    const GURL& url,
    scoped_refptr<net::HttpResponseHeaders>,
    bool,
    bool do_not_prompt,
    content::GuestPageHolder*,
    content::LoginDelegate::LoginAuthRequiredCallback callback) {
  auto* page = PageRequests::ForContents(contents);
  if (!page || do_not_prompt)
    return nullptr;
  base::DictValue data;
  data.Set("kind", "http_auth");
  data.Set("origin", challenge.is_proxy
                         ? net::HostPortPair::FromSchemeHostPort(challenge.challenger).ToString()
                         : challenge.challenger.Serialize());
  data.Set("realm", std::string(base::TruncateUTF8ToByteSize(challenge.realm, 2048)));
  data.Set("scheme", base::ToLowerASCII(challenge.scheme));
  data.Set("proxy", challenge.is_proxy);
  GURL::Replacements replacements;
  replacements.ClearUsername();
  replacements.ClearPassword();
  data.Set("url", std::string(base::TruncateUTF8ToByteSize(
                      url.ReplaceComponents(replacements).spec(), 2048)));
  return std::make_unique<PageLogin>(page, std::move(data), std::move(callback));
}
std::vector<std::unique_ptr<blink::URLLoaderThrottle>>
ServicesBrowserClient::CreateURLLoaderThrottles(
    const network::ResourceRequest&,
    content::BrowserContext* context,
    const base::RepeatingCallback<content::WebContents*()>&,
    content::NavigationUIData*,
    content::FrameTreeNodeId,
    std::optional<int64_t>) {
  std::vector<std::unique_ptr<blink::URLLoaderThrottle>> result;
  result.push_back(std::make_unique<ProtocolThrottle>(static_cast<BrowserContext*>(context)));
  return result;
}
bool ServicesBrowserClient::HasCustomSchemeHandler(content::BrowserContext* context,
                                                   const std::string& scheme) {
  const GURL url(scheme + ":remotekit");
  return static_cast<BrowserContext*>(context)->TranslateProtocolUrl(url) != url;
}
}  // namespace remotekit::browser
