#include "browser/compat_renderer.h"
#include "browser/navigation_error_page.h"

#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/renderer/loadtimes_bindings.h"
#include "content/public/renderer/chrome_object_extensions_utils.h"
#include "content/public/renderer/render_frame.h"
#include "content/public/renderer/render_frame_observer.h"
#include "gin/converter.h"
#include "net/base/net_errors.h"
#include "third_party/blink/public/platform/task_type.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url_error.h"
#include "third_party/blink/public/common/renderer_preferences/renderer_preferences.h"
#include "third_party/blink/public/web/web_settings.h"
#include "third_party/blink/public/web/web_view.h"
#include "third_party/blink/public/web/web_view_observer.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-persistent-handle.h"
#include "v8/include/v8-primitive.h"

namespace remotekit::browser {
namespace {
// Ordinary webpage subset of app_hooks_delegate.cc. No extension registry,
// hosted-app execution, or installation service exists in this embedder.
void EmptySetter(v8::Local<v8::Name>,
                 v8::Local<v8::Value>,
                 const v8::PropertyCallbackInfo<v8::Boolean>&) {}

void IsInstalledGetter(v8::Local<v8::Name>, const v8::PropertyCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(false);
}

void ThrowInvocationError(v8::Isolate* isolate,
                          const char* method,
                          const char* signature,
                          const char* detail = "") {
  // api_binding.cc / api_invocation_errors.cc produce this wrapper. The app
  // native hook returns INVALID_INVOCATION without retaining the parser error.
  std::string error =
      std::string("Error in invocation of app.") + method + "(" + signature + "): " + detail;
  isolate->ThrowException(v8::Exception::TypeError(gin::StringToV8(isolate, error)));
}

bool NoArguments(const v8::FunctionCallbackInfo<v8::Value>& info, const char* method) {
  if (info.Length() == 0)
    return true;
  ThrowInvocationError(info.GetIsolate(), method, "");
  return false;
}

void GetDetails(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!NoArguments(info, "getDetails"))
    return;
  info.GetReturnValue().SetNull();
}

void GetIsInstalled(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!NoArguments(info, "getIsInstalled"))
    return;
  info.GetReturnValue().Set(false);
}

void RunningState(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!NoArguments(info, "runningState"))
    return;
  info.GetReturnValue().Set(gin::StringToV8(info.GetIsolate(), "cannot_run"));
}

void CompleteInstallState(v8::Global<v8::Context> saved_context,
                          v8::Global<v8::Function> saved_callback) {
  auto* isolate = v8::Isolate::GetCurrent();
  v8::HandleScope scope(isolate);
  auto context = saved_context.Get(isolate);
  auto* frame = blink::WebLocalFrame::FrameForContext(context);
  // A pending callback must not re-enter a document replaced by navigation.
  if (!frame || frame->MainWorldScriptContext() != context)
    return;
  v8::Context::Scope context_scope(context);
  v8::Local<v8::Value> args[] = {gin::StringToV8(isolate, "not_installed")};
  // Blink performs the native callback entry and reports exceptions. This is
  // a posted task, not a microtask or an inline invocation of the callback.
  (void)frame->CallFunctionEvenIfScriptDisabled(saved_callback.Get(isolate), context->Global(), 1,
                                                args);
}

void InstallState(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto* isolate = info.GetIsolate();
  if (info.Length() != 1 || !info[0]->IsFunction()) {
    // The current schema parser admits callback omission, but AppHooksDelegate
    // still DCHECKs that the parsed argument is a Function. Do not reproduce
    // that unsafe path or advertise Promise support for this limited stub.
    ThrowInvocationError(isolate, "installState", "optional function callback",
                         "This embedder stub requires one callback function.");
    return;
  }
  auto context = isolate->GetCurrentContext();
  auto* frame = blink::WebLocalFrame::FrameForContext(context);
  auto* render_frame = frame ? content::RenderFrame::FromWebFrame(frame) : nullptr;
  if (!render_frame)
    return;
  render_frame->GetTaskRunner(blink::TaskType::kInternalDefault)
      ->PostTask(FROM_HERE,
                 base::BindOnce(&CompleteInstallState, v8::Global<v8::Context>(isolate, context),
                                v8::Global<v8::Function>(isolate, info[0].As<v8::Function>())));
}

void SetMethod(v8::Local<v8::Context> context,
               v8::Local<v8::Object> object,
               const char* name,
               v8::FunctionCallback callback) {
  auto* isolate = v8::Isolate::GetCurrent();
  v8::Local<v8::Function> function;
  if (v8::Function::New(context, callback, v8::Local<v8::Value>(), 0,
                        v8::ConstructorBehavior::kThrow)
          .ToLocal(&function)) {
    function->SetName(gin::StringToV8(isolate, name));
    object->Set(context, gin::StringToV8(isolate, name), function).Check();
  }
}

void InstallApp(v8::Local<v8::Context> context) {
  auto* isolate = v8::Isolate::GetCurrent();
  auto chrome = content::GetOrCreateChromeObject(isolate, context);
  auto app = content::GetOrCreateObject(isolate, context, chrome, "app");
  // Match AppHooksDelegate::InitializeTemplate's native data property and its
  // intentionally empty setter; assigning must not replace the getter.
  app->SetNativeDataProperty(context, gin::StringToV8(isolate, "isInstalled"), IsInstalledGetter,
                             EmptySetter)
      .Check();
  SetMethod(context, app, "getDetails", GetDetails);
  SetMethod(context, app, "getIsInstalled", GetIsInstalled);
  SetMethod(context, app, "runningState", RunningState);
  SetMethod(context, app, "installState", InstallState);

  auto install_state = content::GetOrCreateObject(isolate, context, app, "InstallState");
  install_state
      ->Set(context, gin::StringToV8(isolate, "DISABLED"), gin::StringToV8(isolate, "disabled"))
      .Check();
  install_state
      ->Set(context, gin::StringToV8(isolate, "INSTALLED"), gin::StringToV8(isolate, "installed"))
      .Check();
  install_state
      ->Set(context, gin::StringToV8(isolate, "NOT_INSTALLED"),
            gin::StringToV8(isolate, "not_installed"))
      .Check();
  auto running_state = content::GetOrCreateObject(isolate, context, app, "RunningState");
  running_state
      ->Set(context, gin::StringToV8(isolate, "CANNOT_RUN"), gin::StringToV8(isolate, "cannot_run"))
      .Check();
  running_state
      ->Set(context, gin::StringToV8(isolate, "READY_TO_RUN"),
            gin::StringToV8(isolate, "ready_to_run"))
      .Check();
  running_state
      ->Set(context, gin::StringToV8(isolate, "RUNNING"), gin::StringToV8(isolate, "running"))
      .Check();
}

// Public Blink settings API, the same native setting used by official device
// emulation. RendererPreferences are per WebView and reach OOPIF pages too.
class CompatViewObserver final : public blink::WebViewObserver {
 public:
  explicit CompatViewObserver(blink::WebView* view) : blink::WebViewObserver(view) {
    OnRendererPreferencesUpdated(view->GetRendererPreferences());
  }
  void OnRendererPreferencesUpdated(const blink::RendererPreferences& prefs) override {
    const auto& metadata = prefs.user_agent_override.ua_metadata_override;
    const bool tablet = metadata && metadata->platform == "Android";
    if (GetWebView())
      GetWebView()->GetSettings()->SetFromStrings(
          blink::WebString::FromAscii("navigatorPlatformOverride"),
          tablet ? blink::WebString::FromAscii("Linux armv81") : blink::WebString());
  }
  void OnDestruct() override { delete this; }
};
class CompatFrameObserver final : public content::RenderFrameObserver {
 public:
  explicit CompatFrameObserver(content::RenderFrame* frame) : content::RenderFrameObserver(frame) {}
  void DidCreateScriptContext(v8::Local<v8::Context> context, int32_t world_id) override {
    auto* isolate = v8::Isolate::GetCurrent();
    v8::HandleScope handle_scope(isolate);
    v8::Context::Scope context_scope(context);
    LoadTimesBindings::Install(context);
    // Chrome installs loadTimes/csi in every frame world. app's emulation is
    // intentionally scoped to ordinary webpages, not extension/content scripts.
    if (world_id == 0)
      InstallApp(context);
  }
  void OnDestruct() override { delete this; }
};
}  // namespace

void CompatRendererClient::WebViewCreated(blink::WebView* view, bool, const url::Origin*) {
  new CompatViewObserver(view);
}
void CompatRendererClient::RenderFrameCreated(content::RenderFrame* render_frame) {
  new CompatFrameObserver(render_frame);
}

void CompatRendererClient::PrepareErrorPage(
    content::RenderFrame*,
    const blink::WebURLError& error,
    const std::string&,
    content::mojom::AlternativeErrorPageOverrideInfoPtr,
    std::string* error_html) {
  // A null output means Chromium already supplied the error document. Do not
  // replace it or navigate again: retry stays in the normal toolbar/POST path.
  if (error_html && error_html->empty()) {
    *error_html = BuildNavigationErrorHtml(
        error.url().GetString().Utf8(), error.reason(),
        error.reason() < 0 ? net::ErrorToString(error.reason()) : "UNKNOWN_ERROR");
  }
}
}  // namespace remotekit::browser
