#include "browser/signin.h"

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/strings/string_number_conversions.h"
#include "base/uuid.h"
#include "browser/signin_result.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "base/containers/span.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/single_request_url_loader_factory.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include <map>
#include "browser/resources/signin/changyan_page.h"

namespace remotekit::browser {
namespace {
const char kSignInKey = 0;
class SignInBinding final : public base::SupportsUserData::Data {
 public:
  explicit SignInBinding(base::WeakPtr<SignIn> value) : value(std::move(value)) {}
  base::WeakPtr<SignIn> value;
};

struct SignInRequests {
  base::WeakPtr<SignIn> signin;
  std::map<int32_t, base::WeakPtr<SignIn>> pending;
};

class SignInHeaderClient final : public network::mojom::TrustedHeaderClient {
 public:
  explicit SignInHeaderClient(base::WeakPtr<SignIn> signin) : signin_(std::move(signin)) {}
  void OnBeforeSendHeaders(const GURL& url,
                           const net::HttpRequestHeaders& headers,
                           OnBeforeSendHeadersCallback callback) override {
    if (signin_ && !signin_->completed()) {
      if (auto result = XinjiaoyuSignInResult(url, headers))
        signin_->Complete(std::move(*result));
    }
    std::move(callback).Run(net::OK, std::nullopt, std::nullopt);
  }
  void OnHeadersReceived(const std::string&,
                         const net::IPEndPoint&,
                         const std::optional<net::SSLInfo>&,
                         OnHeadersReceivedCallback callback) override {
    std::move(callback).Run(net::OK, std::nullopt, std::nullopt);
  }

 private:
  base::WeakPtr<SignIn> signin_;
};

class SignInHeaderFactory final : public network::mojom::TrustedURLLoaderHeaderClient {
 public:
  explicit SignInHeaderFactory(std::shared_ptr<SignInRequests> requests)
      : requests_(std::move(requests)) {}
  void OnLoaderCreated(
      int32_t id,
      mojo::PendingReceiver<network::mojom::TrustedHeaderClient> receiver) override {
    auto found = requests_->pending.find(id);
    base::WeakPtr<SignIn> signin;
    if (found != requests_->pending.end()) {
      signin = std::move(found->second);
      requests_->pending.erase(found);
    }
    mojo::MakeSelfOwnedReceiver(std::make_unique<SignInHeaderClient>(std::move(signin)),
                                std::move(receiver));
  }
  void OnLoaderForCorsPreflightCreated(
      const network::ResourceRequest&,
      mojo::PendingReceiver<network::mojom::TrustedHeaderClient> receiver) override {
    mojo::MakeSelfOwnedReceiver(std::make_unique<SignInHeaderClient>(nullptr), std::move(receiver));
  }

 private:
  std::shared_ptr<SignInRequests> requests_;
};

class SignInRequestFactory final : public network::mojom::URLLoaderFactory {
 public:
  SignInRequestFactory(std::shared_ptr<SignInRequests> requests,
                       mojo::PendingRemote<network::mojom::URLLoaderFactory> target)
      : requests_(std::move(requests)), target_(std::move(target)) {}
  void CreateLoaderAndStart(mojo::PendingReceiver<network::mojom::URLLoader> loader,
                            int32_t id,
                            uint32_t options,
                            const network::ResourceRequest& request,
                            mojo::PendingRemote<network::mojom::URLLoaderClient> client,
                            const net::MutableNetworkTrafficAnnotationTag& annotation) override {
    if (requests_->signin && !requests_->signin->completed()) {
      requests_->pending[id] = requests_->signin->GetRequestWeakPtr();
      options |= network::mojom::kURLLoadOptionUseHeaderClient;
    }
    target_->CreateLoaderAndStart(std::move(loader), id, options, request, std::move(client),
                                  annotation);
  }
  void Clone(mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver) override {
    mojo::PendingRemote<network::mojom::URLLoaderFactory> target;
    target_->Clone(target.InitWithNewPipeAndPassReceiver());
    mojo::MakeSelfOwnedReceiver(
        std::make_unique<SignInRequestFactory>(requests_, std::move(target)), std::move(receiver));
  }

 private:
  std::shared_ptr<SignInRequests> requests_;
  mojo::Remote<network::mojom::URLLoaderFactory> target_;
};

class SignInNavigationThrottle final : public content::NavigationThrottle {
 public:
  explicit SignInNavigationThrottle(content::NavigationThrottleRegistry& registry)
      : NavigationThrottle(registry) {}
  const char* GetNameForLogging() override { return "RemoteKitSignIn"; }
  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }

 private:
  ThrottleCheckResult Check() {
    auto* navigation = navigation_handle();
    const auto& url = navigation->GetURL();
    if (!url.SchemeIs("remotekit-signin"))
      return PROCEED;
    auto* signin = SignIn::ForContents(navigation->GetWebContents());
    if (!signin || signin->purpose() != "changyan" || !navigation->IsInPrimaryMainFrame() ||
        url.host() != "changyan" || url.has_username() || url.has_password() || url.has_port())
      return CANCEL_AND_IGNORE;
    if (url.path() == "/verify")
      return PROCEED;
    if (auto result = ChangyanSignInResult(url))
      signin->Complete(std::move(*result));
    return CANCEL_AND_IGNORE;
  }
};
}  // namespace

SignIn::SignIn(std::string purpose, WebViewId view) : purpose_(std::move(purpose)), view_(view) {}
SignIn::~SignIn() = default;
void SignIn::Attach(content::WebContents* contents) {
  contents->SetUserData(&kSignInKey, std::make_unique<SignInBinding>(GetWeakPtr()));
}
SignIn* SignIn::ForContents(content::WebContents* contents) {
  if (!contents)
    return nullptr;
  auto* binding = static_cast<SignInBinding*>(contents->GetUserData(&kSignInKey));
  return binding ? binding->value.get() : nullptr;
}
void SignIn::Reset() {
  request_weak_factory_.InvalidateWeakPtrs();
  completed_ = false;
  event_.clear();
}
void SignIn::Complete(base::DictValue result) {
  if (completed_ || !SignInResultFits(result))
    return;
  completed_ = true;
  event_.Set("type", std::string(protocol::kViewSignIn));
  event_.Set("version", protocol::kControlVersion);
  event_.Set("eventId", base::Uuid::GenerateRandomV4().AsLowercaseString());
  event_.Set("webviewId", base::NumberToString(view_));
  event_.Set("provider", purpose_);
  event_.Set("result", std::move(result));
  LOG(INFO) << "sign-in completed for view " << view_;
}
void SignIn::Acknowledge(const base::ListValue& ids) {
  const auto* id = event_.FindString("eventId");
  if (!id)
    return;
  for (const auto& value : ids) {
    if (value.is_string() && value.GetString() == *id) {
      event_.clear();
      return;
    }
  }
}
void InstallSignInRequestObserver(
    content::WebContents* contents,
    network::URLLoaderFactoryBuilder& builder,
    mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>* headers) {
  auto* signin = SignIn::ForContents(contents);
  if (!signin || signin->purpose() != "xinjiaoyu" || !headers)
    return;
  auto requests = std::make_shared<SignInRequests>();
  requests->signin = signin->GetWeakPtr();
  mojo::MakeSelfOwnedReceiver(std::make_unique<SignInHeaderFactory>(requests),
                              headers->InitWithNewPipeAndPassReceiver());
  auto [receiver, target] = builder.Append();
  mojo::MakeSelfOwnedReceiver(
      std::make_unique<SignInRequestFactory>(std::move(requests), std::move(target)),
      std::move(receiver));
}
void AddSignInNavigationThrottle(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<SignInNavigationThrottle>(registry));
}
mojo::PendingRemote<network::mojom::URLLoaderFactory> CreateSignInPageFactory(
    content::WebContents* contents) {
  const auto* signin = SignIn::ForContents(contents);
  const bool allowed = signin && signin->purpose() == "changyan";
  auto factory = base::MakeRefCounted<network::SingleRequestURLLoaderFactory>(base::BindOnce(
      [](bool allowed, const network::ResourceRequest& request,
         mojo::PendingReceiver<network::mojom::URLLoader>,
         mojo::PendingRemote<network::mojom::URLLoaderClient> pending_client) {
        mojo::Remote<network::mojom::URLLoaderClient> client(std::move(pending_client));
        if (!allowed || request.url.host() != "changyan" || request.url.path() != "/verify") {
          client->OnComplete(network::URLLoaderCompletionStatus(net::ERR_ACCESS_DENIED));
          return;
        }
        const std::string_view html = kChangyanPage;
        mojo::ScopedDataPipeProducerHandle producer;
        mojo::ScopedDataPipeConsumerHandle consumer;
        MojoCreateDataPipeOptions options{sizeof(options), MOJO_CREATE_DATA_PIPE_FLAG_NONE, 1,
                                          static_cast<uint32_t>(html.size())};
        if (mojo::CreateDataPipe(&options, producer, consumer) != MOJO_RESULT_OK ||
            producer->WriteAllData(base::as_byte_span(html)) != MOJO_RESULT_OK) {
          client->OnComplete(network::URLLoaderCompletionStatus(net::ERR_FAILED));
          return;
        }
        producer.reset();
        auto head = network::mojom::URLResponseHead::New();
        head->mime_type = "text/html";
        head->charset = "utf-8";
        head->content_length = html.size();
        head->headers = net::HttpResponseHeaders::TryToCreate(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: "
            "no-store\r\n\r\n");
        client->OnReceiveResponse(std::move(head), std::move(consumer), std::nullopt);
        client->OnComplete(network::URLLoaderCompletionStatus(net::OK));
      },
      allowed));
  mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
  factory->Clone(remote.InitWithNewPipeAndPassReceiver());
  return remote;
}
}  // namespace remotekit::browser
