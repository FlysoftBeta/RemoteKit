#include "browser/pdf_viewer.h"

#include <limits>
#include <map>
#include <memory>
#include <string_view>
#include <utility>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/memory/self_deleting.h"
#include "base/path_service.h"
#include "base/base_paths.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/supports_user_data.h"
#include "base/task/thread_pool.h"
#include "content/public/browser/file_url_loader.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"
#include "net/base/filename_util.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/self_deleting_url_loader_factory.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"

namespace remotekit::browser {
namespace {
const char kPdfKey = 0;
constexpr char kViewerHost[] = "viewer";
constexpr char kDocumentPath[] = "/document.pdf";
// The viewer's own resources load from its origin; everything else is refused. connect-src
// stays on the origin so the page cannot reach the network even if a loader were added later.
constexpr char kViewerPolicy[] =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
    "style-src 'self'; img-src 'self' blob: data:; media-src blob:; font-src 'self' data:; "
    "connect-src 'self' blob: data:; frame-src 'none'; object-src 'none'; base-uri 'none'; "
    "form-action 'none'";

class PdfBindingData final : public base::SupportsUserData::Data {
 public:
  explicit PdfBindingData(base::WeakPtr<PdfDocument> value) : value(std::move(value)) {}
  base::WeakPtr<PdfDocument> value;
};

void Fail(mojo::PendingRemote<network::mojom::URLLoaderClient> pending, net::Error error) {
  mojo::Remote<network::mojom::URLLoaderClient> client(std::move(pending));
  client->OnComplete(network::URLLoaderCompletionStatus(error));
}

bool ViewerUrl(const GURL& url) {
  return url.SchemeIs(kPdfScheme) && url.host() == kViewerHost && !url.has_username() &&
         !url.has_password() && !url.has_port();
}

// `path` is the ASCII URL path of a viewer resource.
const char* MimeType(std::string_view path) {
  constexpr std::pair<std::string_view, const char*> kTypes[] = {
      {".html", "text/html"},
      {".mjs", "text/javascript"},
      {".js", "text/javascript"},
      {".css", "text/css"},
      {".svg", "image/svg+xml"},
      {".png", "image/png"},
      {".gif", "image/gif"},
      {".json", "application/json"},
      {".ftl", "text/plain"},
      {".properties", "text/plain"},
      {".bcmap", "application/octet-stream"},
      {".pfb", "application/octet-stream"},
      {".icc", "application/octet-stream"},
      {".ttf", "font/ttf"},
      {".wasm", "application/wasm"},
  };
  const auto dot = path.rfind('.');
  if (dot == std::string_view::npos || path.find('/', dot) != std::string_view::npos)
    return nullptr;
  const auto extension = base::ToLowerASCII(path.substr(dot));
  for (const auto& [name, mime] : kTypes)
    if (extension == name)
      return mime;
  return nullptr;
}

// Maps a viewer URL path to a file under `pdfjs/`. Segments are plain names: no escapes,
// separators, drive letters or parent references.
std::optional<base::FilePath> ViewerFile(const GURL& url) {
  std::string_view path = url.path();
  if (path.size() < 2 || path.front() != '/')
    return std::nullopt;
  path.remove_prefix(1);
  base::FilePath assets;
  if (!base::PathService::Get(base::DIR_ASSETS, &assets))
    return std::nullopt;
  auto file = assets.AppendASCII("pdfjs");
  for (const auto segment :
       base::SplitStringPiece(path, "/", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
    if (segment.empty() || segment == "." || segment == ".." || !base::IsStringASCII(segment) ||
        segment.find_first_of("%\\:") != std::string_view::npos)
      return std::nullopt;
    file = file.AppendASCII(segment);
  }
  return file;
}

scoped_refptr<net::HttpResponseHeaders> ResponseHeaders(const char* mime, bool viewer_page) {
  std::string raw = "HTTP/1.1 200 OK\r\nContent-Type: ";
  raw += mime;
  raw += "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n";
  if (viewer_page) {
    raw += "Content-Security-Policy: ";
    raw += kViewerPolicy;
    raw += "\r\n";
  }
  raw += "\r\n";
  return net::HttpResponseHeaders::TryToCreate(raw);
}

void StartFile(const network::ResourceRequest& request,
               const base::FilePath& file,
               scoped_refptr<net::HttpResponseHeaders> headers,
               mojo::PendingReceiver<network::mojom::URLLoader> loader,
               mojo::PendingRemote<network::mojom::URLLoaderClient> client) {
  network::ResourceRequest file_request(request);
  file_request.url = net::FilePathToFileURL(file);
  content::CreateFileURLLoaderBypassingSecurityChecks(
      file_request, std::move(loader), std::move(client), nullptr, false, std::move(headers));
}

bool FileHasSize(const PdfBinding& binding) {
  return base::GetFileSize(binding.path) == binding.size;
}

void StartDocument(const network::ResourceRequest& request,
                   const PdfBinding& binding,
                   mojo::PendingReceiver<network::mojom::URLLoader> loader,
                   mojo::PendingRemote<network::mojom::URLLoaderClient> client,
                   bool intact) {
  auto headers = net::HttpResponseHeaders::TryToCreate(
      "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nAccept-Ranges: bytes\r\n"
      "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n");
  if (!intact || !headers)
    return Fail(std::move(client), net::ERR_FILE_NOT_FOUND);
  StartFile(request, binding.path, std::move(headers), std::move(loader), std::move(client));
}

class PdfLoaderFactory final : public network::SelfDeletingURLLoaderFactory {
 public:
  // Serves the viewer and `document`'s file.
  static mojo::PendingRemote<network::mojom::URLLoaderFactory> Create(
      base::WeakPtr<PdfDocument> document) {
    mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
    base::MakeSelfDeleting<PdfLoaderFactory>(std::move(document), true,
                                             remote.InitWithNewPipeAndPassReceiver());
    return remote;
  }
  // Serves only viewer resources.
  static mojo::PendingRemote<network::mojom::URLLoaderFactory> CreateStatic() {
    mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
    base::MakeSelfDeleting<PdfLoaderFactory>(base::WeakPtr<PdfDocument>(), false,
                                             remote.InitWithNewPipeAndPassReceiver());
    return remote;
  }

  void CreateLoaderAndStart(mojo::PendingReceiver<network::mojom::URLLoader> loader,
                            int32_t,
                            uint32_t,
                            const network::ResourceRequest& request,
                            mojo::PendingRemote<network::mojom::URLLoaderClient> client,
                            const net::MutableNetworkTrafficAnnotationTag&) override {
    if (!ViewerUrl(request.url))
      return Fail(std::move(client), net::ERR_ACCESS_DENIED);
    if (request.url.path() == kDocumentPath) {
      if (!serves_document_ || !document_)
        return Fail(std::move(client), net::ERR_FILE_NOT_FOUND);
      const PdfBinding binding = document_->binding();
      base::ThreadPool::PostTaskAndReplyWithResult(
          FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
          base::BindOnce(&FileHasSize, binding),
          base::BindOnce(&StartDocument, request, binding, std::move(loader), std::move(client)));
      return;
    }
    const auto file = ViewerFile(request.url);
    const char* mime = file ? MimeType(request.url.path()) : nullptr;
    auto headers = mime ? ResponseHeaders(mime, std::string_view(mime) == "text/html" ||
                                                    std::string_view(mime) == "text/javascript")
                        : nullptr;
    if (!headers)
      return Fail(std::move(client), net::ERR_FILE_NOT_FOUND);
    StartFile(request, *file, std::move(headers), std::move(loader), std::move(client));
  }

 private:
  friend base::internal::MakeSelfDeletingImpl;
  PdfLoaderFactory(base::WeakPtr<PdfDocument> document,
                   bool serves_document,
                   mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
                   base::SelfDeletingPassKey key)
      : network::SelfDeletingURLLoaderFactory(std::move(receiver), key),
        document_(std::move(document)),
        serves_document_(serves_document) {}
  ~PdfLoaderFactory() override = default;

  base::WeakPtr<PdfDocument> document_;
  const bool serves_document_;
};

class DenyFactory final : public network::mojom::URLLoaderFactory {
 public:
  void CreateLoaderAndStart(mojo::PendingReceiver<network::mojom::URLLoader>,
                            int32_t,
                            uint32_t,
                            const network::ResourceRequest&,
                            mojo::PendingRemote<network::mojom::URLLoaderClient> client,
                            const net::MutableNetworkTrafficAnnotationTag&) override {
    Fail(std::move(client), net::ERR_ACCESS_DENIED);
  }
  void Clone(mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver) override {
    mojo::MakeSelfOwnedReceiver(std::make_unique<DenyFactory>(), std::move(receiver));
  }
};

bool ViewerOrigin(const std::optional<url::Origin>& origin) {
  return origin && origin->scheme() == kPdfScheme && origin->host() == kViewerHost;
}

class PdfNavigationThrottle final : public content::NavigationThrottle {
 public:
  explicit PdfNavigationThrottle(content::NavigationThrottleRegistry& registry)
      : NavigationThrottle(registry) {}
  const char* GetNameForLogging() override { return "RemoteKitPdf"; }
  ThrottleCheckResult WillStartRequest() override { return Check(); }
  ThrottleCheckResult WillRedirectRequest() override { return Check(); }

 private:
  // A document view stays on its viewer page in every frame; no other WebContents may load the
  // scheme at all.
  ThrottleCheckResult Check() {
    auto* navigation = navigation_handle();
    const auto& url = navigation->GetURL();
    if (!PdfDocument::ForContents(navigation->GetWebContents()))
      return url.SchemeIs(kPdfScheme) ? CANCEL_AND_IGNORE : PROCEED;
    return url.GetWithoutRef() == PdfViewerStartUrl() ? PROCEED : CANCEL_AND_IGNORE;
  }
};
}  // namespace

std::optional<PdfBinding> DecodePdfBinding(const base::DictValue& wire) {
  const auto* path = wire.FindString("path");
  const auto* size = wire.FindString("size");
  uint64_t bytes = 0;
  if (wire.size() != 2 || !path || !size || path->empty() || !base::StringToUint64(*size, &bytes) ||
      bytes > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
    return std::nullopt;
  const auto file = base::FilePath::FromUTF8Unsafe(*path);
  if (!file.IsAbsolute() || file.ReferencesParent())
    return std::nullopt;
  return PdfBinding{file, static_cast<int64_t>(bytes)};
}

PdfDocument::PdfDocument(PdfBinding binding) : binding_(std::move(binding)) {}
PdfDocument::~PdfDocument() = default;
void PdfDocument::Attach(content::WebContents* contents) {
  contents->SetUserData(&kPdfKey, std::make_unique<PdfBindingData>(GetWeakPtr()));
}
PdfDocument* PdfDocument::ForContents(content::WebContents* contents) {
  if (!contents)
    return nullptr;
  auto* data = static_cast<PdfBindingData*>(contents->GetUserData(&kPdfKey));
  return data ? data->value.get() : nullptr;
}

GURL PdfViewerStartUrl() {
  return GURL(std::string(kPdfScheme) + "://" + kViewerHost +
              "/web/viewer.html?file=%2Fdocument.pdf");
}

mojo::PendingRemote<network::mojom::URLLoaderFactory> CreatePdfNavigationFactory(
    content::WebContents* contents) {
  auto* document = PdfDocument::ForContents(contents);
  if (!document)
    return {};
  return PdfLoaderFactory::Create(document->GetWeakPtr());
}

void RegisterPdfSubresourceFactories(
    int render_process_id,
    int render_frame_id,
    const std::optional<url::Origin>& initiator,
    content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap* factories) {
  if (auto* frame = content::RenderFrameHost::FromID(render_process_id, render_frame_id)) {
    auto* document = PdfDocument::ForContents(content::WebContents::FromRenderFrameHost(frame));
    // Only the bound view's main document reads the file; its other frames get nothing.
    if (document && frame->IsInPrimaryMainFrame())
      factories->emplace(kPdfScheme, PdfLoaderFactory::Create(document->GetWeakPtr()));
    return;
  }
  RegisterPdfWorkerFactories(initiator, factories);
}

void RegisterPdfWorkerFactories(
    const std::optional<url::Origin>& initiator,
    content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap* factories) {
  if (ViewerOrigin(initiator))
    factories->emplace(kPdfScheme, PdfLoaderFactory::CreateStatic());
}

void AddPdfNavigationThrottle(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<PdfNavigationThrottle>(registry));
}

void DenyPdfNetworkRequests(const url::Origin& initiator,
                            network::URLLoaderFactoryBuilder& builder) {
  if (initiator.scheme() != kPdfScheme)
    return;
  auto [receiver, target] = builder.Append();
  mojo::MakeSelfOwnedReceiver(std::make_unique<DenyFactory>(), std::move(receiver));
  target.reset();
}
}  // namespace remotekit::browser
