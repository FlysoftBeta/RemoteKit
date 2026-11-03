# Chromium tab 激活、后台行为与 content API

调查日期：2026-11-03。基于本机 Chromium 157.0.8103.15，基线 `1aa07b638799e59656559ae6c6649d4b197f555e`，以及 RemoteKit 当前源码。本文是静态调用链调查，没有执行新的运行实验，也不代表修改了后台策略。

## 结论与状态映射

Chrome 切换 tab 确实会改变页面运行行为。入口是产品层的选中关系，实际运行变化主要由传入 content 的**可见性**触发；焦点、窗口激活、冻结和丢弃是另外的状态。没有一个 `WebContents::SetTabActive(bool)` 能覆盖它们。

| 产品行为 | content 公共 API | 生效范围与责任 |
| --- | --- | --- |
| tab 显示/隐藏 | `WebContents::WasShown()` / `WasHidden()`；统一视图入口 `UpdateWebContentsVisibility(Visibility)` | content 通知 Page、RenderWidget、观察者，并更新 renderer 优先级输入；Blink 调整页面调度 |
| 窗口内容被遮挡 | `WasOccluded()` / `Visibility::OCCLUDED` | 不等于切到另一个 tab；没有捕获等例外时 Page 也可成为 hidden，但视图资源处理不同 |
| 输入焦点 | `WebContents::Focus()`，对应 widget 的 `Focus()` / `Blur()` | 页面焦点、输入路由；失焦本身不等于后台 |
| 原生窗口/控件激活态 | `RenderWidgetHost::SetActive(bool)` | 控制 renderer 控件激活外观；不是降低优先级的 API |
| 冻结执行 | `WebContents::SetPageFrozen(bool)` | 仅对非 visible 页面使用；恢复可见会自动解冻。调用返回不是 renderer 已确认完成 |
| 丢弃页面 | `WebContents::Discard(callback)`，受 `kWebContentsDiscard` 控制 | 释放执行页面；需要恢复/重载，不保留原 JS 堆。资格、计时、失败与恢复由产品管理 |
| 显式覆盖 renderer 优先级 | `RenderProcessHost::SetPriorityOverride()` / `ClearPriorityOverride()` | 整个 renderer 进程；不适合直接按单个 tab 无条件覆盖 |

`UpdateWebContentsVisibility` 有首次显示门禁：首次实际显示前会忽略 hidden/occluded 更新；不能机械替换当前初始化与直接 hide 调用。见 `content/public/browser/web_contents.h:1029`、`content/browser/web_contents/web_contents_impl.cc:12728`。`SetActive` 的语义见 `content/public/browser/render_widget_host.h:175`。

## Chrome 产品层调用链与额外策略

`TabStripModel::OnChange` 先处理 active 变化，再通知 observers，并让新 tab `DidEnterForeground`（`chrome/browser/ui/tabs/tab_strip_model.cc:697`）。普通 Views 路径由 `BrowserView` 保存旧焦点、拆下旧 WebContents、装入新 WebContents，并在窗口 active 且可见时恢复焦点（`chrome/browser/ui/views/frame/browser_view.cc:1984`、`:2023`、`:2087`、`:2111`）。split view 特判保留另一个可见 pane，因此 Chrome 自己也不把 inactive 与 hidden 完全等同。

`views::WebView` 的 NativeViewHost attach/detach（`ui/views/controls/webview/webview.cc:598`）使 Aura 视图可见性变化；`WebContentsViewAura` 将 VISIBLE/OCCLUDED/HIDDEN 映射到 `UpdateWebContentsVisibility`（`content/browser/web_contents/web_contents_view_aura.cc:1026`、`:1460`）。离屏 embedder 直接同步产品可见性即可使用同一 content 机制。

Chrome 另外装配 Performance Manager（PM），这部分不由纯 content 自动完成：

| 策略 | 实际行为与源证据 |
| --- | --- |
| active-tab 产品信号 | Chrome 的 `PageLiveStateDecoratorHelper` 观察 selection，将旧/新 Page 标为 inactive/active；`chrome/browser/performance_manager/decorators/helpers/page_live_state_decorator_helper.cc:158` |
| 优先级投票 | visibility voter 按 frame 可见性/important 属性投 `kUserBlocking/kUserVisible/kMinValue`；有声或采集媒体的 frame 可提权。入口在 `components/performance_manager/performance_manager_lifetime.cc:73`，visibility 实现在 `execution_context_priority/frame_visibility_voter.cc:23`；是否装配受 graph/feature 设置控制 |
| 投票实际落点 | `PrioritySetter` 写 frame/worker 图属性 → `ProcessPriorityAggregator` 取 hosted 内容最高级 → `ProcessPriorityPolicy` 调 `RenderProcessHost::SetPriorityOverride`。不是直接设置 RFH priority。见 `execution_context_priority/priority_setter.cc:45`、`decorators/process_priority_aggregator.cc:96`、`graph/policies/process_priority_policy.cc:28`。Chrome policy 装配在 `chrome_browser_main_extra_parts_performance_manager.cc:279`，其 feature 源码默认开启 |
| 加载中的 active/inactive 差异 | `LoadingPageVoter` 可以给 active loading root tab 投 `kUserBlocking`、后台 loading 投 `kUserVisible`；V2进一步限制后台来源。但 V1/V2 源码默认均关闭，不能写成默认行为。见 `execution_context_priority/loading_page_voter.cc:110`、`:143`，`components/performance_manager/features.cc:177` |
| 冻结 | `FreezingPolicy` 对 visible、recently-visible、MRU 等设置保护；经 `Freezer` 调 `WebContents::SetPageFrozen`。见 `components/performance_manager/freezing/freezing_policy.cc:684`、`freezing/freezer.cc:16`。切后台不等于立即冻结 |
| Memory Saver | hidden 后按模式启动 discard timer，visible 取消；资格保护还检查 active tab、媒体、采集/设备、用户编辑等。见 `chrome/browser/performance_manager/policies/memory_saver_mode_policy.cc:38`、`:188`，`discard_eligibility_policy.cc:276`、`:373` |

特别注意：Chrome 的 discard 资格明确保护**任何窗口的 active tab，即使该窗口当前不可见**（`discard_eligibility_policy.cc:404`）。RemoteKit 目前以 Viewer/Window 实际可见性决定自身回收资格，不应把两者宣称完全一致。Windows Chrome 的正常 discard 机制还经 `TabLifecycleUnitExternal::DiscardTab`（`components/performance_manager/mechanisms/page_discarder.cc:69`），不是只调用 content visibility 就自动获得完整回收/恢复策略。

## content 自动完成的变化

### 页面可见性、绘制和调度

`WasShown/WasHidden` → `UpdateVisibilityAndNotifyPageAndView` → `RenderViewHostImpl::SetFrameTreeVisibility` 与主视图 show/hide。它同时处理子 frame、跨进程 frame 和嵌套 WebContents，而不是只改一个浏览器侧布尔值。

源证据：`content/browser/web_contents/web_contents_impl.cc:3182`、`:5276`、`:5306`。Blink `PageSchedulerImpl::SetPageVisible` 和 `UpdatePolicyOnVisibilityChange` 根据页面可见性更新预算池、后台 timer 唤醒及冻结状态：`third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.cc:207`、`:671`。

后台并不保证 JS 全停。调度会限制可节流队列的唤醒/CPU 预算，强化节流有宽限期；音频、实时通信、具体队列和 feature/参数有各自例外，不能用一个固定“后台 FPS”或 timer 周期描述所有任务。桌面的 `kStopInBackground` 默认关闭，因此仅调用 `WasHidden()` 不等于产品已执行冻结：`third_party/blink/common/features.cc:2206`，`page_scheduler_impl.cc:807`、`:827`。

隐藏 widget 还会暂停输入 ACK 超时监测、处理 pointer lock（等待用户授权提示时有例外）、通知 Viz；显示时恢复相关同步和帧资源。这些随正常 content show/hide 链路发生，无需 embedder 重新实现。见 `content/browser/renderer_host/render_widget_host_impl.cc:908`、`:952`。

### renderer 进程优先级

`RenderWidgetHostImpl::WasHidden/WasShown` → `RenderProcessHost::UpdateClientPriority` → `RenderProcessHostImpl::UpdateProcessPriorityInputs` → `UpdateProcessPriority` → launcher 设置 OS 优先级，并将进程状态通知 renderer。

优先级按**一个进程中的全部 priority clients 聚合**。同进程有可见 widget，或存在媒体流、XR、待创建 view、前台 Service Worker、加载/后台执行/discard 提权时，不能简单因为某个 tab hidden 就降整个进程。默认判断不读取 Control 的 activeTab。

源证据：`content/browser/renderer_host/render_widget_host_impl.cc:943`、`:1008`，`render_process_host_impl.cc:5994`、`:6051`，`content/browser/child_process_launcher.cc:403`、`:434`。没有额外提权时，后台可降到 `base::Process::Priority::kBestEffort`；前台为 `kUserBlocking`。

Windows 的 `Process::SetPriority` 将 `kBestEffort` 映射为 `IDLE_PRIORITY_CLASS`，并在相应 feature 与系统能力允许时启用 EcoQoS；`kUserBlocking` 清除 EcoQoS，OS class 默认 NORMAL，也可受 feature 影响使用 ABOVE_NORMAL。见 `base/process/process_win.cc:308`。这是可影响争抢 CPU 时运行速度的真实 OS 策略，不是仅改任务标签；本次未测量实际性能差值。

renderer 接收状态后也调整主线程 scheduler，部分 feature 还调整 ThreadPool/V8 isolate 优先级。见 `content/renderer/render_thread_impl.cc:1259`、`:1704`。独立 embedder 的默认 `ContentBrowserClient::IsRendererProcessPriorityEnabled()` 返回 true（`content/public/browser/content_browser_client.cc:2010`），不需要装配 Chrome Browser 才能启用基础优先级机制。

## 捕获例外

`IncrementCapturerCount(size, stay_hidden, stay_awake, is_activity)` 很关键：`stay_hidden=false` 会让被捕获页面在 renderer 一侧保持 visible；`stay_hidden=true` 则保留页面 hidden，同时允许 hidden-but-painting。但这也不保证调度进入普通 hidden 模式：`WebViewImpl::SetVisibilityState` 在 `DispatchHiddenVisibilityTransitions` 路径将 hidden-but-painting 作为 scheduler visible，以维持绘制（`third_party/blink/renderer/core/exported/web_view_impl.cc:4330`）。WebContents 的产品可见性与 renderer 的 Page/调度可见性因此可能不同。PiP/VR 也有相应绘制例外。

见 `content/public/browser/web_contents.h:914`、`content/browser/web_contents/web_contents_impl.cc:5276`。不能只看 `GetVisibility()` 就断言页面已经进入所有后台节流。

## RemoteKit 对应

- `browser/webview.cc:613` 的 `SetVisible` 已对应 `WasShown/WasHidden`；隐藏前先撤焦点。`Focus`（`:802`）单独调用 `Focus/Blur/SetActive`，符合可见性与焦点拆分。
- `browser/gpu_atlas.cc:452` 当前捕获使用 `stay_hidden=false`。`browser/harness.cc:285` 只把产品 visible 的 view 加入输出，`Capture::Stop`（`gpu_atlas.cc:87`）释放捕获计数。正常操作先 `SetVisible(false)`，之后 `ApplyLayout/UpdateOutput` 才删除 capture；同一同步操作内短暂保留 Page-visible 例外，释放后重新计算 visibility。因此正常隐藏路径会撤掉该捕获例外；本次没有据此发现“后台永久 visible”的已证实 bug，也未新增运行证据。
- `browser/main_delegate.cc:115` 关闭宿主原生窗口遮挡引起的后台化及 `CalculateNativeWinOcclusion`，用于隔离服务器屏幕状态；这不等于关闭产品 `WasHidden()`、Blink timer 节流或全部 renderer 后台优先级。
- 当前 Browser 未装配 Chrome Performance Manager，未显式调用 `SetPriorityOverride`。基础 content 后台机制仍生效；Chrome 额外投票策略不会因此自动存在。
- Control 的隐藏计时与 Memory Saver 属于自身产品策略，见 [Control 可见性与 Memory Saver](control-plane.zh-CN.md#可见性与memory-saver)。多个独立 Window 同时显示时，其中页面应保持 visible，只有接收输入的目标获得 focus；不能把未聚焦 Window 的可见页面当作后台 tab。

适配方向是继续让 Control 决定产品 visible/focus/residency，Browser 映射 content API。若希望补齐 Chrome 的媒体/加载等优先级例外，应单独定义并验证进程聚合策略；不要引入 Browser/TabStripModel 产品对象图，也不要直接按 tab 焦点调用进程级 override。

公开 API 可在线核对 [Chromium WebContents 声明](https://chromium.googlesource.com/chromium/src/+/main/content/public/browser/web_contents.h)；本文细节以以上固定本机版本为准。
