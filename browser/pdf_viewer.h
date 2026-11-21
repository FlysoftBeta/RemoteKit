#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "base/files/file_path.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/content_browser_client.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/url_loader_factory.mojom-forward.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace network {
class URLLoaderFactoryBuilder;
}
namespace content {
class NavigationThrottleRegistry;
class WebContents;
}  // namespace content

namespace remotekit::browser {
inline constexpr char kPdfScheme[] = "remotekit-pdf";

// The staged file a document view renders. The Endpoint owns the file; the Browser only reads it.
struct PdfBinding {
  base::FilePath path;
  int64_t size = 0;
  bool operator==(const PdfBinding&) const = default;
};
// Decodes the wire form {path, size} (size is a decimal string); rejects unknown fields,
// relative paths and parent references.
std::optional<PdfBinding> DecodePdfBinding(const base::DictValue& wire);

// A view's document, attached to each WebContents the view creates. Only a WebContents that
// carries one may load the bound file or stay on the viewer page.
class PdfDocument final {
 public:
  explicit PdfDocument(PdfBinding binding);
  ~PdfDocument();
  void Attach(content::WebContents*);
  static PdfDocument* ForContents(content::WebContents*);
  const PdfBinding& binding() const { return binding_; }
  base::WeakPtr<PdfDocument> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  const PdfBinding binding_;
  base::WeakPtrFactory<PdfDocument> weak_factory_{this};
};

// The page a document view actually loads; the Endpoint only names the marker URL.
GURL PdfViewerStartUrl();

// Non-network loaders for the scheme. Viewer resources come from `pdfjs/` next to the
// executable; the document path is served only through a frame of a bound WebContents.
mojo::PendingRemote<network::mojom::URLLoaderFactory> CreatePdfNavigationFactory(
    content::WebContents*);
void RegisterPdfSubresourceFactories(int render_process_id,
                                     int render_frame_id,
                                     const std::optional<url::Origin>& initiator,
                                     content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap*);
// Dedicated workers cannot be tied to a WebContents, so they only receive viewer resources.
void RegisterPdfWorkerFactories(const std::optional<url::Origin>& initiator,
                                content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap*);
void AddPdfNavigationThrottle(content::NavigationThrottleRegistry&);
// Requests initiated by the viewer never reach the network.
void DenyPdfNetworkRequests(const url::Origin& initiator, network::URLLoaderFactoryBuilder&);
}  // namespace remotekit::browser
