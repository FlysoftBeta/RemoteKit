#include "browser/compat_renderer.h"
#include "browser/navigation_error_page.h"

#include <iterator>
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
#include "third_party/blink/public/web/web_frame_widget.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "ui/display/screen_info.h"
#include "v8/include/v8-container.h"
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
  SetMethod(context, app, "installState", InstallState);
  SetMethod(context, app, "runningState", RunningState);

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

bool IsTabletIdentity(const blink::RendererPreferences& prefs) {
  const auto& metadata = prefs.user_agent_override.ua_metadata_override;
  return metadata && metadata->platform == "Android";
}

// Legacy window.orientation / orientationchange, which Android exposes and the
// tablet identity's UA promises. Blink gates them behind the process-global
// OrientationEvent flag (DevTools mobile emulation flips it for the whole
// renderer), so install them per context instead. Sites that see a mobile UA
// read window.orientation, not innerWidth/innerHeight, to choose geometry; a
// missing value means portrait and makes landscape games rotate themselves.
v8::Local<v8::Private> OrientationHandlerKey(v8::Isolate* isolate) {
  return v8::Private::ForApi(isolate, gin::StringToV8(isolate, "remotekit.onorientationchange"));
}

void OrientationGetter(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto* frame = blink::WebLocalFrame::FrameForContext(info.GetIsolate()->GetCurrentContext());
  auto* widget = frame ? frame->LocalRoot()->FrameWidget() : nullptr;
  // Same value as LocalDOMWindow::orientation: the view's screen angle,
  // reported in WebKit's [-90, 180] range.
  const int angle = widget ? widget->GetScreenInfo().orientation_angle : 0;
  info.GetReturnValue().Set(angle == 270 ? -90 : angle);
}

void OrientationHandlerGetter(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto* isolate = info.GetIsolate();
  v8::Local<v8::Value> handler;
  auto context = isolate->GetCurrentContext();
  if (context->Global()->GetPrivate(context, OrientationHandlerKey(isolate)).ToLocal(&handler) &&
      handler->IsObject()) {
    info.GetReturnValue().Set(handler);
  } else {
    info.GetReturnValue().SetNull();
  }
}

void OrientationHandlerSetter(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto* isolate = info.GetIsolate();
  // EventHandler attributes keep objects and turn every other value into null.
  v8::Local<v8::Value> handler = v8::Null(isolate);
  if (info.Length() > 0 && info[0]->IsObject())
    handler = info[0];
  auto context = isolate->GetCurrentContext();
  (void)context->Global()->SetPrivate(context, OrientationHandlerKey(isolate), handler);
}

// Window listener registered before any page script, standing in for the
// event handler attribute's listener slot.
void InvokeOrientationHandler(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto* isolate = info.GetIsolate();
  auto context = isolate->GetCurrentContext();
  auto global = context->Global();
  v8::Local<v8::Value> handler;
  if (!global->GetPrivate(context, OrientationHandlerKey(isolate)).ToLocal(&handler) ||
      !handler->IsFunction()) {
    return;
  }
  v8::Local<v8::Value> args[] = {info.Length() > 0 ? info[0] : v8::Undefined(isolate)};
  v8::Local<v8::Value> result;
  if (!handler.As<v8::Function>()->Call(context, global, 1, args).ToLocal(&result))
    return;
  if (result->IsFalse() && args[0]->IsObject()) {
    v8::Local<v8::Value> prevent;
    auto event = args[0].As<v8::Object>();
    if (event->Get(context, gin::StringToV8(isolate, "preventDefault")).ToLocal(&prevent) &&
        prevent->IsFunction()) {
      (void)prevent.As<v8::Function>()->Call(context, event, 0, nullptr);
    }
  }
}

// screen.orientation's change fires from the same WebFrameWidget orientation
// update that would send the legacy event. The Event constructor and
// dispatchEvent are captured before page script can replace them.
void DispatchOrientationChange(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto* isolate = info.GetIsolate();
  auto context = isolate->GetCurrentContext();
  auto data = info.Data().As<v8::Array>();
  v8::Local<v8::Value> event_constructor;
  v8::Local<v8::Value> dispatch;
  if (!data->Get(context, 0).ToLocal(&event_constructor) ||
      !data->Get(context, 1).ToLocal(&dispatch)) {
    return;
  }
  v8::Local<v8::Value> type = gin::StringToV8(isolate, "orientationchange");
  v8::Local<v8::Object> event;
  if (!event_constructor.As<v8::Function>()->NewInstance(context, 1, &type).ToLocal(&event))
    return;
  v8::Local<v8::Value> args[] = {event};
  (void)dispatch.As<v8::Function>()->Call(context, context->Global(), 1, args);
}

v8::MaybeLocal<v8::Function> GetMethod(v8::Local<v8::Context> context,
                                       v8::Local<v8::Object> object,
                                       const char* name) {
  v8::Local<v8::Value> value;
  if (!object->Get(context, gin::StringToV8(v8::Isolate::GetCurrent(), name)).ToLocal(&value) ||
      !value->IsFunction()) {
    return {};
  }
  return value.As<v8::Function>();
}

v8::MaybeLocal<v8::Function> NewFunction(v8::Local<v8::Context> context,
                                         v8::FunctionCallback callback,
                                         const char* name,
                                         int length,
                                         v8::Local<v8::Value> data = {}) {
  v8::Local<v8::Function> function;
  if (!v8::Function::New(context, callback, data, length, v8::ConstructorBehavior::kThrow)
           .ToLocal(&function)) {
    return {};
  }
  function->SetName(gin::StringToV8(v8::Isolate::GetCurrent(), name));
  return function;
}

void InstallOrientation(v8::Local<v8::Context> context) {
  auto* isolate = v8::Isolate::GetCurrent();
  auto global = context->Global();
  v8::Local<v8::Function> event_constructor;
  v8::Local<v8::Function> add_listener;
  v8::Local<v8::Function> dispatch;
  v8::Local<v8::Value> screen;
  v8::Local<v8::Value> screen_orientation;
  if (!GetMethod(context, global, "Event").ToLocal(&event_constructor) ||
      !GetMethod(context, global, "addEventListener").ToLocal(&add_listener) ||
      !GetMethod(context, global, "dispatchEvent").ToLocal(&dispatch) ||
      !global->Get(context, gin::StringToV8(isolate, "screen")).ToLocal(&screen) ||
      !screen->IsObject() ||
      !screen.As<v8::Object>()
           ->Get(context, gin::StringToV8(isolate, "orientation"))
           .ToLocal(&screen_orientation) ||
      !screen_orientation->IsObject()) {
    return;
  }

  v8::Local<v8::Function> orientation_getter;
  v8::Local<v8::Function> handler_getter;
  v8::Local<v8::Function> handler_setter;
  v8::Local<v8::Function> invoke_handler;
  v8::Local<v8::Value> captured[] = {event_constructor, dispatch};
  v8::Local<v8::Function> dispatch_change;
  if (!NewFunction(context, OrientationGetter, "get orientation", 0).ToLocal(&orientation_getter) ||
      !NewFunction(context, OrientationHandlerGetter, "get onorientationchange", 0)
           .ToLocal(&handler_getter) ||
      !NewFunction(context, OrientationHandlerSetter, "set onorientationchange", 1)
           .ToLocal(&handler_setter) ||
      !NewFunction(context, InvokeOrientationHandler, "", 1).ToLocal(&invoke_handler) ||
      !NewFunction(context, DispatchOrientationChange, "", 0,
                   v8::Array::New(isolate, captured, std::size(captured)))
           .ToLocal(&dispatch_change)) {
    return;
  }
  global->SetAccessorProperty(gin::StringToV8(isolate, "orientation"), orientation_getter,
                              v8::Local<v8::Function>());
  global->SetAccessorProperty(gin::StringToV8(isolate, "onorientationchange"), handler_getter,
                              handler_setter);

  v8::Local<v8::Value> window_args[] = {gin::StringToV8(isolate, "orientationchange"),
                                        invoke_handler};
  v8::Local<v8::Value> screen_args[] = {gin::StringToV8(isolate, "change"), dispatch_change};
  (void)add_listener->Call(context, global, 2, window_args);
  (void)add_listener->Call(context, screen_orientation, 2, screen_args);
}

// Public Blink settings API, the same native setting used by official device
// emulation. RendererPreferences are per WebView and reach OOPIF pages too.
class CompatViewObserver final : public blink::WebViewObserver {
 public:
  explicit CompatViewObserver(blink::WebView* view) : blink::WebViewObserver(view) {
    OnRendererPreferencesUpdated(view->GetRendererPreferences());
  }
  void OnRendererPreferencesUpdated(const blink::RendererPreferences& prefs) override {
    if (GetWebView())
      GetWebView()->GetSettings()->SetFromStrings(
          blink::WebString::FromAscii("navigatorPlatformOverride"),
          blink::WebString::FromUtf8(prefs.navigator_platform_override));
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
    if (world_id != 0)
      return;
    InstallApp(context);
    // The identity is chosen and synced to the WebView before the navigation
    // commits, so the new document's context already sees it.
    auto* view = render_frame()->GetWebView();
    if (view && IsTabletIdentity(view->GetRendererPreferences()))
      InstallOrientation(context);
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

void CompatRendererClient::PrepareErrorPage(content::RenderFrame*,
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
