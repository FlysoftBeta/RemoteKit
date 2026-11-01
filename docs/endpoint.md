# Endpoint core

Public C++20 API: `endpoint/include/remotekit/core.hpp`; CMake target `remotekit_endpoint`.
This library contains no Chromium dependency or browser execution. It is a serial,
in-memory model; callers must synchronize access. Const pointers remain valid until
the owning Endpoint is destroyed, but observe later mutations.

`CreateSession(tenant)` enforces one session per tenant, `AddProfile` currently
rejects a second profile with `unsupported`, and `CreateWebView` checks profile
ownership. All view operations require its owning session. The transport/host
must authenticate the session before calling this API; IDs are not credentials.

Host flow: `CreateSession`, `AddProfile`, `CreateWebView`, `SetFocus`, `Token`,
then `AcceptInput(authenticated_session, event)`. Input has a strictly increasing,
nonzero per-view sequence, retained across document/instance changes. Accepted
input is validated only; the host still needs to dispatch it to the browser.
All input requires focus; pointer focus acquisition must precede dispatch.

`RequestLifecycle` updates desired state and returns a request generation. Execute
the browser operation externally and report its outcome with `CompleteLifecycle`.
Actual changes only on successful completion. Failure retains desired intent and
clears pending, allowing retry. Every lifecycle request invalidates focus, including
failed operations. Discard/unload success invalidates instance and document tokens;
`CommitDocument` invalidates document tokens after an external navigation commits.
Restore from frozen preserves instance/document identity; after discard/unload
the new instance/document generations were already reserved at destruction.
No serialization, renderer memory reclamation, navigation, or restore is performed.

`last_lifecycle` retains the last operation generation, outcome and detail for
observation after pending clears. Navigation serialization belongs to the browser
adapter, not this portable model.

Packing takes content dimensions in physical pixels plus positive pixels-per-DIP
scale. Padding surrounds each content rectangle; hit tests exclude padding and use
half-open bounds. `DipToPixel` rejects coordinates outside content. MaxRects uses
input order, no rotation, deterministic short-side/long-side/y/x scoring, splitting
and containment pruning. A failure returns no partial atlas. This is a heuristic:
`no_space` can mean this ordering did not fit, even if another layout could fit.

The root CMake project should enable CTest and add this directory. `endpoint_tests`
and `endpoint_demo` link only this portable model.

The Windows `endpoint_client` also builds independent D3D11 atlas consumption and
an SDK worker. Its default Fence mode imports three GPU slots and two fences,
copies into a private cache before releasing the source, and sends input through
the C ABI. Native HWND hosting is the explicit `--presentation=native` comparison
path. Build/package details are in `packaging.zh-CN.md` and `gpu-output.zh-CN.md`.

## 串流服务的输入与观察

DataChannel序号只在当前peer内单调，必须在mousemove合并前验证。InputLoop另分配跨RTC重连持续单调的Browser序号；客户端原sequence保留用于receipt。旧peer、重复/倒退序号、失效输入token仍拒绝，不能靠放松Browser校验解决重载后首击无效。

session.snapshot为只读观察，不启动Browser。离线维护使用requireRunning守卫，不能因为配置/回收操作唤醒已停止进程；显式ensure负责创建/恢复。产品状态与Browser恢复状态的归属见[Control设计](control-plane.zh-CN.md)。
