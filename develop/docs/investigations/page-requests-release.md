# 页面请求接口调查（Chromium 157.0.8103.15）

范围：当前 `browser/browser_context.*`、`webview.*`、`harness.cc`，对照本机 `C:/src/chromium/src` 的 content 公共头及相关默认实现。本文只记录现状和最小接口，不规定 UI 或协议设计。未运行测试。

## 现状与生命周期

`BrowserContext` 为每个实例持有 client-hints delegate，权限和下载 delegate 均返回空；`CreateZoomLevelDelegate` 返回空。`PageDelegate` 仅阻止新 WebContents 创建，未覆盖本调查中的请求接口。控制通道目前有 snapshot、focus、visible、navigate、lifecycle、input、shutdown，没有下面这些请求的应答或操作。`WebView::CreateContents` 新建实例；unload/restore、渲染进程退出和销毁可使原实例或文档失效，harness 在恢复后重新设置 delegate。

异步请求不能只保存裸 `RenderFrameHost*` 或 `WebContents*` 后等待 UI：frame 可能删除、跨文档提交或进入 BFCache，整个 WebContents 也可能销毁。使用对应 frame/document 身份及弱引用，在回应前核验当前文档和存活状态；观察 `RenderFrameDeleted`、`PrimaryPageChanged`、`WebContentsDestroyed` 和适用的导航/进程退出事件。`DidFinishNavigation` 不保证旧文档已销毁，同文档导航也不等于新文档；子 frame 请求还需识别其自身文档，不能仅靠主 frame token。被取消或失效的请求应按具体 API 完成一次取消/拒绝，之后不再使用其 callback；Chromium 已明确负责回复的情况除外。具体请求 API 与失效语义如下。

## 请求与默认行为

| 类型 | 当前行为和缺口 | 最小接入 API、终止方式和依赖 |
| --- | --- | --- |
| JS alert/confirm/prompt、beforeunload | 默认 `GetJavaScriptDialogManager()` 为 null，无 DevTools handler 时普通对话框被抑制并按取消返回；beforeunload 不显示并继续离开。已有 DevTools handler 时情况不同。没有本地交互 UI。 | `WebContentsDelegate::GetJavaScriptDialogManager` 返回 `JavaScriptDialogManager`；实现 `RunJavaScriptDialog`、`RunBeforeUnloadDialog`、`CancelDialogs`，可选 `HandleJavaScriptDialog`。`DialogClosedCallback` 为 once，返回 accept 和输入；普通 dialog 若设 `did_suppress_message=true`，content 负责伪造回复，不能再调用已交出的 callback。取消管理器的当前/待处理对话框时确保只结束一次；`CancelDialogs` 的 `reset_state` 按契约清除状态。依赖 `content/public/browser/javascript_dialog_manager.h`、dialog type 和 UI。 |
| 文件输入和目录 | 默认 `RunFileChooser`、`EnumerateDirectory` 均调用 `FileSelectionCanceled()`；无文件选择 UI。 | 覆盖上述两个 `WebContentsDelegate` 方法，按 chooser 参数返回 `FileSelectListener::FileSelected`，或取消时 `FileSelectionCanceled`；每个 listener 只完成一次，持有 scoped ref，文档失效/销毁时取消并丢弃迟到结果。依赖 `file_select_listener.h`、Blink file chooser mojom 和文件选择器；目录枚举必须遵守接口的路径及授权语义。 |
| 下载 | `CanDownload` 默认同步允许，但 `GetDownloadManagerDelegate()` 为 null；不能由此推断下载可用。content 的导航下载路径在无 manager delegate 时丢弃下载；当前没有目标选择、进度或取消 UI。 | 提供 `DownloadManagerDelegate` 并从 BrowserContext 返回；至少处理目标选择 `DetermineDownloadTarget`、必要的下载 ID 和 `DownloadManager`/`DownloadItem` 观察。`CanDownload` 可作入口许可；其 once callback 必须完成。目标方法返回 true 时取得并完成 callback，空 target path 表示取消；返回 false 交由默认目标处理。以 item 生命周期和 manager `Shutdown`/observer 销毁事件结束待处理工作，下载一旦脱离发起文档不必把所有进行中的下载当成文档回调。依赖 content download 公共接口与 `components/download/public`，以及目标路径选择。 |
| 权限 | `GetPermissionControllerDelegate()` 为 null；`PermissionControllerImpl` 对未被覆盖的请求和状态默认 DENIED。摄像头/麦克风还有单独 `WebContentsDelegate::RequestMediaAccessPermission` 路径，不能假定一个 delegate 涵盖所有设备能力。 | BrowserContext 提供 `PermissionControllerDelegate`，实现当前文档批量请求和所有纯虚状态查询、reset，必要时实现订阅；按请求数量返回 `PermissionResult`。销毁/文档切换时拒绝或取消未决请求，且不能把旧文档授权回传给新文档；撤销订阅。媒体设备另查 `RequestMediaAccessPermission` 及其 callback、设备选择和系统权限。依赖 permission controller、Blink permission mojom、content settings 和实际 UI/设备权限。 |
| 右键菜单 | 默认 `HandleContextMenu` 返回 false，没有应用菜单；content 的上下文菜单事件/参数仍会生成。 | 覆盖 `HandleContextMenu(RenderFrameHost&, ContextMenuParams)`；返回 true 表示已处理。它本身无异步完成 callback；后续选择必须关联原 frame/document，失效或菜单关闭时丢弃命令。依赖 context menu 参数、菜单 UI 和所选命令的对应 content 接口。 |
| 指针锁 / 键盘锁 | 默认指针锁调用 `GotResponseToPointerLockRequest(kUnknownError)` 拒绝；默认键盘锁调用 `GotResponseToKeyboardLockRequest(true)` 接受，inner WebContents 另默认不允许。可用性仍受 content、平台和焦点条件影响。 | 覆盖 `RequestPointerLock` 并用 `GotResponseToPointerLockRequest(result)` 回答；失锁收到 `LostPointerLock`。覆盖 `RequestKeyboardLock` 并用 `GotResponseToKeyboardLockRequest(bool)` 回答，`CancelKeyboardLockRequest` 清理待处理 UI；其返回值表明请求是否仍有效。文档/焦点/窗口失效时撤销待处理请求，不对旧 contents 迟到回应。依赖 Blink pointer-lock mojom、content WebContents 和平台输入支持。 |
| 剪贴板 | content 已有 `WebContents::Cut/Copy/Paste/PasteAndMatchStyle` 等编辑命令，以及平台剪贴板路径；当前控制通道无对应命令或跨端剪贴板功能。异步 Clipboard API 仍受权限、安全上下文和策略限制，不能推断全部读写可用。 | 基础编辑可调用 WebContents 方法；权限通过权限控制器，策略扩展见 `ContentBrowserClient::IsClipboardPasteAllowedByPolicy` / `IsClipboardCopyAllowedByPolicy` 等。策略回调须按契约完成一次；捕获 frame/document 身份，失效时不把旧结果用于新文档。跨端传输需要另行实现，不能等同于系统剪贴板。依赖 content、`ui/base/clipboard` 和权限/平台支持。 |
| 查找 | Blink/content 查找能力存在，但当前无控制入口或结果转发。 | `WebContents::Find`、`StopFinding`，通过 `WebContentsObserver::DidReceiveFindReply` 获取匹配数、位置和 final 标志。`on_request_id` 在调用中同步接收 ID，回复也可能同步；必须先保存 ID。新 find session 可静默丢弃旧 session，final reply 不保证送达；关闭、导航或销毁时自行使旧结果失效。依赖 Blink find mojom 和 content observer。 |
| 缩放 | content 有 `HostZoomMap`；当前无缩放控制入口，`ContentsZoomChange` 默认空实现；zoom level delegate 为空意味着未接入自定义持久化，并非 content 缩放 API 不存在。 | 用 `HostZoomMap::GetZoomLevel/SetZoomLevel(WebContents*, ...)` 读取/设置；处理 UI 手势时可覆盖 `ContentsZoomChange`。必要时用 `AddZoomLevelChangedCallback`，其 subscription 控制监听生命周期。设置是同步接口、没有请求完成 callback；页面/contents 重建时重新获取状态，注意默认 host/scheme 与临时级别的作用范围。依赖 content `host_zoom_map.h`，按需 zoom UI/持久化。 |

## Client hints 的边界

`ClientHintsControllerDelegate` 与页面权限请求不是同一个接口。当前实现按 origin 在内存记录 opt-in、合并 additional hints，提供 UA metadata 和 viewport 值；`IsJavaScriptAllowed` 固定返回 true。它不提供权限 UI，也不代表所有 JS 或权限策略已实现。`SetMostRecentMainFrameViewportSize` 必须由 embedder 在视口变化时调用；当前审阅范围内未发现调用。client hints 的内存状态随 BrowserContext 生命周期结束，非跨重启持久化。

## 核对入口

- Chromium `content/public/browser/{client_hints_controller_delegate.h,permission_controller_delegate.h,javascript_dialog_manager.h,web_contents_delegate.h,web_contents.h,web_contents_observer.h,file_select_listener.h,download_manager_delegate.h,host_zoom_map.h}`。
- 默认行为：`content/public/browser/web_contents_delegate.cc`、`content/browser/web_contents/web_contents_impl.cc`、`content/browser/permissions/permission_controller_impl.cc`、`content/browser/download/download_manager_impl.cc`。
- 仓库 `browser/{browser_context.h,browser_context.cc,compat.cc,webview.h,webview.cc,harness.cc}`。
