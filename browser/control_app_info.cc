#include "browser/control_dispatcher.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/ref_counted.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "browser/browser_runtime.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "skia/ext/image_operations.h"
#include "third_party/blink/public/common/manifest/manifest_util.h"
#include "third_party/blink/public/mojom/favicon/favicon_url.mojom.h"
#include "third_party/blink/public/mojom/manifest/manifest.mojom.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"

namespace remotekit::browser {
namespace {
constexpr int kIconSize = 192;
constexpr int kMaxBitmapSize = 1024;

int IconScore(int size) {
  return size >= kIconSize ? size - kIconSize : kMaxBitmapSize + kIconSize - size;
}

bool LiveView(BrowserRuntime& runtime, SessionId session, WebViewId view) {
  const auto* model = runtime.view_model.FindWebView(session, view);
  const auto* record = runtime.views.Find(session, view);
  if (runtime.shutting_down || !model || !record || model->actual != Residency::live ||
      model->pending || record->webview->lifecycle_uncertain() || !record->requests->IsOpen())
    return false;
  auto* contents = record->webview->contents();
  return contents && !contents->IsBeingDestroyed() && contents->GetPrimaryMainFrame() &&
         contents->GetPrimaryMainFrame()->IsRenderFrameLive();
}

class AppInfoTask final : public base::RefCounted<AppInfoTask>,
                          public content::WebContentsObserver {
 public:
  AppInfoTask(content::WebContents* contents,
              base::RepeatingCallback<bool()> live,
              base::OnceCallback<void(base::DictValue, bool)> completion)
      : content::WebContentsObserver(contents),
        live_(std::move(live)),
        completion_(std::move(completion)) {
    info_.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
    info_.Set("url", contents->GetLastCommittedURL().spec());
  }

  void Start() {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&AppInfoTask::Finish, base::WrapRefCounted(this)),
        base::Seconds(5));
    web_contents()->GetPrimaryPage().GetManifest(
        base::BindOnce(&AppInfoTask::OnManifest, weak_factory_.GetWeakPtr()));
  }

 private:
  friend class base::RefCounted<AppInfoTask>;
  ~AppInfoTask() override = default;

  void WebContentsDestroyed() override {
    page_changed_ = true;
    Finish();
  }
  void PrimaryPageChanged(content::Page&) override {
    page_changed_ = true;
    Finish();
  }
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus) override {
    page_changed_ = true;
    Finish();
  }

  void OnManifest(blink::mojom::ManifestRequestResult result,
                  const GURL&,
                  blink::mojom::ManifestPtr manifest) {
    if (!live_.Run()) {
      Finish();
      return;
    }
    GURL icon_url;
    if (result == blink::mojom::ManifestRequestResult::kSuccess && manifest) {
      base::DictValue summary;
      if (manifest->name)
        summary.Set("name", base::UTF16ToUTF8(*manifest->name));
      if (manifest->short_name)
        summary.Set("shortName", base::UTF16ToUTF8(*manifest->short_name));
      if (manifest->start_url.is_valid())
        summary.Set("startUrl", manifest->start_url.spec());
      if (manifest->scope.is_valid())
        summary.Set("scope", manifest->scope.spec());
      if (manifest->theme_color)
        summary.Set("themeColor", base::StringPrintf("#%06x", *manifest->theme_color & 0xffffff));
      const auto display = blink::DisplayModeToString(manifest->display);
      if (!display.empty())
        summary.Set("display", display);
      info_.Set("manifest", std::move(summary));

      int best_score = std::numeric_limits<int>::max();
      for (const auto& icon : manifest->icons) {
        if (!icon.src.is_valid())
          continue;
        for (const auto& size : icon.sizes) {
          const bool any_size = size == gfx::Size();
          if (!any_size && std::min(size.width(), size.height()) < 96)
            continue;
          const int score = IconScore(any_size ? kIconSize : std::max(size.width(), size.height()));
          if (score < best_score) {
            best_score = score;
            icon_url = icon.src;
          }
        }
      }
    }
    if (icon_url.is_valid())
      Download(icon_url, false);
    else
      DownloadFavicon();
  }

  void DownloadFavicon() {
    GURL url;
    int best_score = std::numeric_limits<int>::max();
    for (const auto& icon : web_contents()->GetFaviconURLs()) {
      if (!icon->icon_url.is_valid())
        continue;
      int score = IconScore(16);
      for (const auto& size : icon->icon_sizes)
        score = std::min(score, IconScore(std::max(size.width(), size.height())));
      if (score < best_score) {
        best_score = score;
        url = icon->icon_url;
      }
    }
    if (url.is_valid())
      Download(url, true);
    else
      Finish();
  }

  void Download(const GURL& url, bool favicon) {
    web_contents()->DownloadImage(
        url, favicon, gfx::Size(kIconSize, kIconSize), kMaxBitmapSize, false,
        base::BindOnce(&AppInfoTask::OnImage, weak_factory_.GetWeakPtr(), favicon));
  }

  void OnImage(bool favicon,
               int,
               int,
               const GURL&,
               const std::vector<SkBitmap>& bitmaps,
               const std::vector<gfx::Size>& sizes) {
    if (!live_.Run()) {
      Finish();
      return;
    }
    const SkBitmap* best = nullptr;
    int best_score = std::numeric_limits<int>::max();
    for (size_t i = 0; i < bitmaps.size(); ++i) {
      const auto& bitmap = bitmaps[i];
      if (bitmap.drawsNothing() || std::max(bitmap.width(), bitmap.height()) > kMaxBitmapSize ||
          std::max(sizes[i].width(), sizes[i].height()) > kMaxBitmapSize ||
          (!favicon && std::min(bitmap.width(), bitmap.height()) < 96))
        continue;
      const int score = IconScore(std::max(bitmap.width(), bitmap.height()));
      if (score < best_score) {
        best_score = score;
        best = &bitmap;
      }
    }
    if (best) {
      SkBitmap bitmap = *best;
      const double scale =
          std::min(1.0, static_cast<double>(kIconSize) / std::max(bitmap.width(), bitmap.height()));
      if (scale < 1) {
        bitmap = skia::ImageOperations::Resize(
            bitmap, skia::ImageOperations::RESIZE_BEST,
            std::max(1, static_cast<int>(std::lround(bitmap.width() * scale))),
            std::max(1, static_cast<int>(std::lround(bitmap.height() * scale))));
      }
      auto png = gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
      if (png && png->size() <= 64 * 1024) {
        base::DictValue icon;
        icon.Set("png", base::Base64Encode(*png));
        icon.Set("width", bitmap.width());
        icon.Set("height", bitmap.height());
        info_.Set("icon", std::move(icon));
      }
      Finish();
      return;
    }
    if (favicon)
      Finish();
    else
      DownloadFavicon();
  }

  void Finish() {
    if (!completion_)
      return;
    const bool available = !page_changed_ && web_contents() && live_.Run();
    weak_factory_.InvalidateWeakPtrs();
    Observe(nullptr);
    std::move(completion_).Run(std::move(info_), available);
  }

  base::DictValue info_;
  base::RepeatingCallback<bool()> live_;
  base::OnceCallback<void(base::DictValue, bool)> completion_;
  bool page_changed_ = false;
  base::WeakPtrFactory<AppInfoTask> weak_factory_{this};
};
}  // namespace

Result<AppInfoRequest> DecodeAppInfo(const base::DictValue& wire, RequestEnvelope envelope) {
  AppInfoRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.session = decoder.Optional<uint64_t>("session").value_or(0);
  request.view = decoder.Optional<uint64_t>("view").value_or(0);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

void ControlDispatcher::HandleAppInfo(const AppInfoRequest& request, Reply reply) {
  auto* record = runtime_.views.Find(request.session, request.view);
  if (!record || !runtime_.view_model.FindWebView(request.session, request.view)) {
    std::move(reply).Run(
        ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session"));
    return;
  }
  if (!LiveView(runtime_, request.session, request.view)) {
    std::move(reply).Run(
        ControlResult::Failure(request.id, ErrorCode::kUnavailable, "View is not live"));
    return;
  }
  auto task = base::MakeRefCounted<AppInfoTask>(
      record->webview->contents(),
      base::BindRepeating(
          [](base::WeakPtr<ControlDispatcher> dispatcher, SessionId session, WebViewId view) {
            return dispatcher && LiveView(dispatcher->runtime_, session, view);
          },
          weak_factory_.GetWeakPtr(), request.session, request.view),
      base::BindOnce(
          [](int id, Reply reply, base::DictValue info, bool available) {
            if (!available) {
              std::move(reply).Run(
                  ControlResult::Failure(id, ErrorCode::kUnavailable, "View is not live"));
              return;
            }
            base::DictValue fields;
            fields.Set("appInfo", std::move(info));
            std::move(reply).Run(ControlResult::Success(id, std::move(fields)));
          },
          request.id, std::move(reply)));
  task->Start();
}
}  // namespace remotekit::browser
