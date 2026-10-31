# `window.chrome` ordinary-page compatibility

Inspected local official Chromium tag 157.0.8103.15. This adapter reuses the
official `chrome/renderer/loadtimes_bindings.cc` implementation for `loadTimes`
and `csi`. `ChromeRenderFrameObserver::DidCreateScriptContext` installs these
without a world-ID condition; the adapter now does the same. Chrome additionally
installs them in extension service workers; this embedder has no extension worker
framework and does not emulate that path.

The `chrome.app` implementation is a native V8 stub for main-world ordinary
webpages without installed hosted apps. It creates no `chrome.runtime`.

Source evidence:

- `chrome/common/extensions/api/app.json`: zero-argument `getDetails`,
  `getIsInstalled`, `runningState`; asynchronous `installState`; InstallState
  values `not_installed`, `installed`, `disabled`; RunningState values
  `running`, `cannot_run`, `ready_to_run`.
- `extensions/renderer/bindings/api_binding.cc`: enum member names are uppercase;
  native API methods use `ConstructorBehavior::kThrow` and length zero.
- `chrome/renderer/extensions/api/app_hooks_delegate.cc`: no hosted app means
  `getDetails() === null`, `getIsInstalled() === false`, and
  `runningState() === 'cannot_run'`. `not_installed` is an installation state,
  never a running state. `isInstalled` is a native data property with an empty
  setter, default V8 property attributes, and a getter returning the installed
  state. The stub uses the same native property API and empty setter.
- `chrome/browser/extensions/chrome_extension_frame_host.cc`: absent enabled or
  disabled hosted-app registration returns `not_installed` through a Mojo
  response. The stub posts a renderer task and calls a supplied callback with
  that value; it cancels entry into replaced/detached main-world contexts.
- `extensions/renderer/bindings/api_signature.cc`: synchronous zero-argument
  signatures reject every extra argument, including null/undefined.
  `AppHooksDelegate::HandleRequest` returns INVALID_INVOCATION on parse failure
  without copying the parser error text. `api_binding.cc` and
  `api_invocation_errors.cc` therefore wrap it in a TypeError whose message is
  `Error in invocation of app.<method>(): ` (empty final reason). The stub
  preserves that behavior for the synchronous methods.

Explicit limitations:

- No hosted-app installation, app registry, app manifest lookup, activity
  logging, extension/content-script API availability rules, or service-worker
  bindings are implemented.
- `installState(callback)` is supported. Current tag schema parsing defaults
  async callbacks to optional with Promise support, but the app native hook
  still DCHECKs a Function callback and uses the callback-only pending-request
  path. Omission/null/undefined and Promise behavior cannot honestly be claimed
  compatible from this source. The stub rejects them with a TypeError explicitly
  identifying the embedder requirement; it does not reproduce a crash or claim
  Promise compatibility.
- Function identity/source formatting, callback scheduling relative to real
  browser IPC, and behavior after copying API objects between realms are not
  claimed byte-for-byte compatible. No webpage JavaScript is injected.
