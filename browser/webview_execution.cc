#include "browser/webview_execution.h"
#include "browser/webview_internal.h"
#include "browser/device_configuration.h"
#include "browser/webview_navigation.h"
#include "browser/webview_input.h"
#include "browser/webview_touch.h"
#include "browser/webview_lifecycle.h"

namespace remotekit::browser {
WebViewExecution::WebViewExecution(WebView& owner) : owner_(owner) {}
WebViewExecution::~WebViewExecution() = default;
void WebViewExecution::CreateContents(std::unique_ptr<content::WebContents> adopted) {
  owner_.touch_->ResetExecution();
  owner_.input_->input_commit_navigations_.clear();
  content::WebContents::CreateParams params(owner_.context_);
  params.initially_hidden = !visible_;
  contents_ = adopted ? std::move(adopted) : content::WebContents::Create(params);
  InstallContents();
}
Status WebViewExecution::RestoreContents(NavigationState& checkpoint) {
  owner_.Observe(nullptr);
  DropContents();
  owner_.touch_->ResetExecution();
  auto restored = CreateRestoredWebContents(owner_.context_, checkpoint, true);
  if (!restored)
    return restored.status;
  contents_ = std::move(restored.value);
  InstallContents();
  owner_.device_->Reapply();
  visible_ = false;
  return {};
}
bool WebViewExecution::IsInPrimaryPage(content::NavigationHandle* navigation) const {
  bool primary = navigation->IsInPrimaryMainFrame();
  if (contents_ && contents_->GetPrimaryMainFrame())
    contents_->GetPrimaryMainFrame()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
      primary |= frame->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId();
    });
  return primary;
}
void WebViewExecution::InstallContents() {
  DeviceConfiguration::InstallSiteIdentity(contents_.get());
  owner_.Observe(contents_.get());
  AttachOffscreenHost();
  auto* implementation = static_cast<content::WebContentsImpl*>(contents_.get());
  if (auto* manager = implementation->GetTextInputManager())
    owner_.input_->text_input_observation_.Observe(manager);
  implementation->GetInputEventRouter();
}
void WebViewExecution::AttachOffscreenHost() {
  if (!contents_)
    return;
  offscreen_host_ = std::make_unique<OffscreenHost>(
      contents_.get(),
      gfx::Size(
          std::max(1, owner_.device_->viewport_width_ ? owner_.device_->viewport_width_ : 480),
          std::max(1, owner_.device_->viewport_height_ ? owner_.device_->viewport_height_ : 360)));
  offscreen_host_->SetRenderDemand(render_demand_ && visible_);
}
void WebViewExecution::DropContents() {
  owner_.input_->text_input_observation_.Reset();
  owner_.input_->editable_target_.reset();
  auto host = std::move(offscreen_host_);
  if (host)
    host->Detach();
  contents_.reset();
  OffscreenHost::Retire(std::move(host));
}
void WebViewExecution::SetRenderDemand(bool enabled) {
  render_demand_ = enabled;
  if (offscreen_host_)
    offscreen_host_->SetRenderDemand(enabled && visible_);
}
Status WebViewExecution::SetVisible(bool visible) {
  if (!contents_ && !visible) {
    visible_ = false;
    return {};
  }
  if (!contents_)
    return Fail(ErrorCode::unavailable, "WebView is unloaded");
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (visible && (owner_.lifecycle_->lifecycle_uncertain_ || !model ||
                  model->actual != Residency::live || model->pending))
    return Fail(ErrorCode::unavailable, "Restore must complete before showing the WebView");
  if (!visible) {
    auto status = owner_.input_->Focus(false);
    if (!status)
      return status;
  }
  visible_ = visible;
  if (offscreen_host_)
    offscreen_host_->SetRenderDemand(visible && render_demand_);
  if (visible)
    contents_->WasShown();
  else
    contents_->WasHidden();
  return {};
}
base::DictValue WebViewExecution::CompositorDiagnostics() const {
  base::DictValue result;
  base::DictValue timing;
  timing.Set("sourceGestures", static_cast<double>(owner_.touch_->touch_source_gestures_));
  timing.Set("arrivalFallbackGestures",
             static_cast<double>(owner_.touch_->touch_fallback_gestures_));
  timing.Set("clockRejected", static_cast<double>(owner_.touch_->touch_clock_rejected_));
  timing.Set("cancelled", static_cast<double>(owner_.touch_->touch_cancelled_));
  timing.Set("samples", static_cast<double>(owner_.touch_->touch_samples_));
  timing.Set("lastDispatchWallMs", owner_.touch_->touch_last_dispatch_wall_ms_);
  timing.Set("lastSourceAgeMs", owner_.touch_->touch_last_source_age_ms_);
  timing.Set("configuration", "generic-desktop");
  timing.Set("logicalPixelsPerInch", 96.0);
  result.Set("touchTiming", std::move(timing));
  if (offscreen_host_)
    result.Set("renderHost", offscreen_host_->Diagnostics());
  auto* native_view = RootView(contents_.get());
  if (!native_view)
    return result;
  const auto size_value = [](const gfx::Size& size) {
    base::DictValue value;
    value.Set("width", size.width());
    value.Set("height", size.height());
    return value;
  };
  const float native_scale = native_view->GetDeviceScaleFactor();
  if (std::isfinite(native_scale) && native_scale > 0)
    result.Set("nativeDeviceScaleFactor", native_scale);
  result.Set("pageBackingScaleOverride", native_view->GetScaleOverrideForCapture());
  if (auto* screen = display::Screen::Get()) {
    auto* window = native_view->GetNativeView();
    const auto display =
        window ? screen->GetDisplayNearestView(window) : screen->GetPrimaryDisplay();
    result.Set("hostDisplayDeviceScaleFactor", display.device_scale_factor());
  }
  const auto requested = native_view->GetRequestedRendererSizeDevicePx();
  if (!requested.IsEmpty())
    result.Set("requestedRendererDevicePixels", size_value(requested));
  const auto viewport = native_view->GetCompositorViewportPixelSize();
  if (!viewport.IsEmpty())
    result.Set("compositorViewportPixels", size_value(viewport));
  if (auto* host = content::RenderWidgetHostImpl::From(native_view->GetRenderWidgetHost())) {
    // This is the last metadata already delivered to the browser; do not turn
    // on ReportAllFrameSubmissionsForTesting or introduce per-frame IPC.
    const auto& metadata = host->render_frame_metadata_provider()->LastRenderFrameMetadata();
    if (!metadata.viewport_size_in_pixels.IsEmpty()) {
      base::DictValue submitted;
      if (std::isfinite(metadata.device_scale_factor) && metadata.device_scale_factor > 0)
        submitted.Set("deviceScaleFactor", metadata.device_scale_factor);
      submitted.Set("viewportPixels", size_value(metadata.viewport_size_in_pixels));
      result.Set("lastSubmittedFrame", std::move(submitted));
    }
  }
  return result;
}
}  // namespace remotekit::browser
