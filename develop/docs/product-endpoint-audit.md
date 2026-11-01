# 产品化前Endpoint / Browser接口审计

2026-11-01，只读源码审计，行号按本次审计时工作区。没有启动浏览器、GPU采样、构建或性能组，没有修改源码。用户已取消性能复验；本文件不安排任何性能组。下文指出可复用入口和必须解决的冲突，接口命名及最终状态机由主Agent确定。

## 总览

|主题|现有能力|产品化缺口|
|---|---|---|
|每WebView尺寸/DPR|独立width/height/deviceScaleFactor，真实backing scale override|tablet布尔同时控制UA、CH、输入能力和viewport；无每站点UA接口|
|可见性/出帧|WebView::SetVisible和SetRenderDemand两个函数；RTC close会停输出|实际仍相互影响，Control连接存活没有对应visibility状态|
|memory saver|Browser具有freeze/discard/unload/restore、真实完成及恢复数据|Endpoint服务没有lifecycle转发、没有canDiscard；Control没有决策算法|
|新窗口|Browser拦截并报告blocked_popup|不创建NewContents；没有provisional/adopt；现有事件被Endpoint snapshot消费后丢弃|
|orphan|Control周期关闭产品状态以外的实际view|与先创建后adopt popup冲突；也可能把自然关闭误重建|
|旧ready清理|Endpoint输入授权可清空，Client布局/断线会失效旧plane|fatal/reconfigure没有立即下发失效布局，Client可能保留旧ready/旧画面|

## 1. 现有操作边界和数据归属

Control→Endpoint是stdio JSON，`endpoint/src/service.cpp:1083` 的 `Session::Command`。外层入口 `service.cpp:1153`附近按tenantId查registry持久化映射到Session。每Session一个browser、desired view配置及recovery目录。

|Endpoint method|字段与现有行为|源码入口|
|---|---|---|
|session.ensure|启动/恢复Session browser，返回sessionId/browserPid/running|service.cpp:1085，Start:254|
|session.snapshot|返回views、browserPid、stats、running|service.cpp:578|
|view.ensure|viewId、url、width/height、device:{mode,width,height,deviceScaleFactor}、visible；存在则ApplyView|service.cpp:1101，ApplyView:364，CreateView:409|
|view.configure|合并desired，再配置Browser并重算atlas|service.cpp:1125|
|view.navigate / view.command|url；或back/forward/reload/stop|service.cpp:1121 / 1116|
|view.close / view.close.reply|force；或requestId/accept；真实beforeunload等待|service.cpp:1105 / 1111|
|rtc.offer / rtc.ice / rtc.close|connectionId、SDP/ICE；close只接受当前connectionId|service.cpp:1015 / 1087|

Browser控制服务为 `browser/harness.cc:279` 的HandleControl，协议envelope是version=1、id、method。已有view.create/configure/recreate/close、navigate、visible、focus、lifecycle、navigation.export/import.*、page.requests/reply/command和output.*。它们经SDK通用UTF-8 JSON传递，不是每个操作一个C ABI。

Browser snapshot（harness.cc:410）含token的session/view/instance/document/focus、profile、actual、desired、pending、focused、lifecycle_generation、last_lifecycle:{generation,action,succeeded,detail}，及visible、device、width/height/deviceScaleFactor、url/title/loading、audible/captured/crashed、compositor、close_state等。`actual/desired`枚举见 `endpoint/include/remotekit/core.hpp:42`：live/frozen/discarded/unloaded。Endpoint会复制view字段并补viewId，但当前没有canDiscard或拒绝原因集合。

## 2. viewport/DPR与每站点tablet UA

实际链路：Control `control/server/control.ts:71` 把同一state.device下发每个tab；Endpoint `service.cpp:381` 将device.mode映射为Browser的device字符串，deviceScaleFactor改名device_scale_factor；Browser `harness.cc:620` 配置每view spec，`WebView::ConfigureDevice`（webview.cc:246）应用。

当前可复用入口：

- viewport是每WebView的width/height DIP，OffscreenHost::SetViewport（browser/offscreen_host.cc:133）设置宿主。
- DPR由ConfigureDevice参数scale与 `ApplyBackingScale`（webview.cc:298）控制。后者按页面DPR/真实宿主DPI计算SetScaleOverrideForCapture，不能只改变JS DPR。共享元数据分别保留page_device_scale_factor和atlas_pixels_per_dip（shared_atlas.h:50）。
- `ApplyDevice`（webview.cc:322）向FrameWidget发送DeviceEmulationParams，包括screen/view size、DPR和方向。这是当前几何入口，能够独立于媒体下采样工作。
- Google Chrome基线UA/CH在compat.cc:64/68；ConfigureDevice在webview.cc:265–289构造Android tablet UA和CH（mobile=false、Android、arm64、Tablet），通过SetUserAgentOverride下发。

当前耦合必须拆开：同一个tablet_还控制OverridePreferences的coarse/no-hover/touch10（webview.cc:226），ApplyDevice的mobile screen/force_viewport_meta/text_size_adjust/Android scrollbar（330–341），Navigate的UA_OVERRIDE_TRUE（408），并将**整个history**的override标志一起修改（281–287）。Renderer compat_renderer.cc:174还根据Android CH设置navigator.platform。产品要求“每站点仅UA，不模拟平板viewport”，因此不能保留device.mode=tablet链路却只在UI改名字。

最小可复用面是已有原生UA/CH构造和SetUserAgentOverride：让UA选择有独立状态，几何继续使用真实可用区域/DPR。Control托管站点规则，Browser必须在导航起点就拿到匹配策略，包括重定向、back/forward、reload、新窗口和restore；只在已commit URL更新后由Control再改UA，会让首个导航请求使用旧UA。现有Control仅在snapshot观察url（control.ts:51），没有请求前站点匹配接口。站点键按origin/host/registrable-domain何者确定、继承及例外由主Agent定，不在本审计固化。

旧Device对象还含viewport尺寸；Control.types/store的迁移需保留几何和UA不同含义，不能把旧tablet宽高再次用于新UA菜单。当前Browser允许DPR 0.5–4（harness.cc:635），后续Client Scale自适应若超出该范围须定义处理。

## 3. visibility、RTC及memory saver

现有独立函数不等于状态已分离：

- `WebView::SetVisible`（webview.cc:414）调用WasShown/WasHidden，隐藏会取消focus，显示要求live且无pending。它同时改变pacer需求。
- `SetRenderDemand`（219）在enabled且当前hidden时调用SetVisible(true)，随后以enabled && visible_驱动pacer。
- `Harness::UpdateOutput`（harness.cc:183–220）只向specs.visible且live的view发render demand，也仅把可见view放入atlas。
- `Session::OpenOutput`（service.cpp:696）按desired.visible判断output_suspended；`PauseOutput`（330）停media线程、清坐标ready并关闭Browser输出；`ClosePeer`（1050）停止编码器/输出与RTC，保留Browser/恢复数据。

因此已有RTC媒体生命周期入口可复用，但需求仍由“是否创建peer、desired.visible、output对象”混合表达。MediaLoop的RTC state=connected仅设置refresh_connected（855附近），disconnected未形成单独渲染需求关闭策略；连接创建不等于已连接。Control::closeRtc（control.ts:154）也不会修改view visibility。

**直接转发Browser visible方法有一致性问题**：harness.cc:797只调用adapter.SetVisible，不更新specs。snapshot.visible仍读specs（443），UpdateOutput仍能SetRenderDemand(true)再WasShown。现有view.configure链路会更新specs，不能绕过这层造成visible状态漂移。

产品化需要的最小入口是：Control在线/Viewer连接的可见性状态；独立RTC实际媒体需求；Browser可见性与pacer/捕获需求的明确组合。状态机由主Agent决定；本审计不把“hidden还必须出帧”或“断Control一定立刻discard”作为既定策略。

## 4. discard / restore / canDiscard与恢复归属

Browser已经有完整执行链：`RequestLifecycle`（webview.cc:1310）、`PollLifecycle`（1469）、`OnDiscarded`（1507），model在 `endpoint/src/core.cpp:218/255` 跟踪accepted/pending/actual及generation，不能把accepted当完成。

- freeze/discard先 `CheckQuiescent`（webview.cc:1238）：hidden、idle、无声音/导航/崩溃；排除related active contents、capture、PiP、fullscreen、playing video、filesystem handles、inner contents、活动USB/Bluetooth/HID/serial/geolocation、输入锁、子frame导航及音视频stream等。
- discard要求WebContentsDiscard feature启用；main_delegate.cc:98当前已把它加入启用列表。执行使用官方WebContents::Discard真实ACK；恢复discarded复用原controller，LoadIfNecessary；restore完成绑定非错误主frame commit（DidFinishNavigation:1574）。
- unload先CaptureNavigationState，再销毁WebContents；restore创建新的WebContents并重接offscreen/input适配。
- 失败/10秒timeout会lifecycle_uncertain，后续需unload；显示在restore完成前会被拒绝。

CheckQuiescent是private执行前守卫，当前没有只读canDiscard导出。它还不包含所有RequestLifecycle前置条件（pending/uncertain、touch cleanup、feature enable等），不能简单把“hidden且不audible”称作canDiscard。可复用守卫拆出诊断评估，并保持执行时再次检查；Control拥有策略/时机，Browser拥有实时可执行性。Endpoint目前没有lifecycle method，需增加服务层桥接及完成结果/快照透出。

恢复数据继续留在Browser/Endpoint：`NavigationState`（browser/navigation_state.h:24）保存完整committed history/PageState及同BrowserContext的sessionStorage namespace引用；二进制export不含跨browser sessionStorage。`WebView::ExportNavigation/ImportNavigation`（344/374）envelope验证schema、Chromium revision及Session/Profile归属。`CheckAutomaticNavigationRestore`（navigation_state.cc:122）拒绝POST自动重放。

Endpoint `CaptureNavigation`（service.cpp:458）在document稳定且非loading/pending时分块导出至Session recovery/view.json，`RestoreNavigation`（420）unload→import→restore，失败回落产品URL fresh GET。`Save`（240）另存desired views；Start（254）恢复同Session配置。Control不需要复制PageState；但仅按document去重导出可能漏同document内后续PageState变化，应在工程化恢复任务中明确保存时机，不能扩大为DOM/JS heap恢复承诺。

## 5. window.open、事件与orphan冲突

当前window.open在 `PageRequests::IsWebContentsCreationOverridden`（browser/page_requests.cc:420）直接生成 `blocked_popup`，字段url、reason=dynamic_webview_creation_unsupported，然后return true。没有NewContents创建、pending popup存储、provisional/adopt状态或产品窗口模型。

可复用上游公共API：Chromium `content/public/browser/web_contents_delegate.h:205` 的AddNewContents接收unique_ptr<WebContents>、source/target_url/disposition/window_features/user_gesture/was_blocked；WebContentsCreated（428）提供opener_id、frame_name等。**应保留该WebContents的真实opener、sessionStorage等关系**；只把target_url交给现有view.create会创建另一个独立WebContents。当前WebView构造/CreateContents（webview.cc:155/187）只会自己Create，没有adopt现成contents入口，PageRequests/OffscreenHost/input观察也都需重新绑定。

两个必须先处理的集成冲突：

1. `PageRequests::Snapshot`（page_requests.cc:226）会drain events；Endpoint `Session::Snapshot`（service.cpp:578）调用page.requests后仅AddCloseRequest抽取beforeunload，**没有转发events**。新建事件不能接入这条链后期待Control自动收到。事件确认/重放/幂等归属由主Agent决定。
2. Control::reconcile（control/server/control.ts:77）对所有不在state.tabs的actual view立即 `view.close force:true orphan:true`。Browser先创建provisional popup而Control尚未adopt，下一tick就会清理；orphan字段目前仅请求标记，Endpoint并无特殊保护语义。需产品关联状态与清理规则一致再放开popup。另一方面，非pendingClose tab若Browser自然closed从snapshot消失，observe不会删除产品tab，reconcile会view.ensure重建，window.close闭环也需处理。

当前Control只有activeTabId/splitTabId（client/types.ts:3），没有独立window容器；AddNewContents的disposition/window_features不能直接丢成“第二个split tab”。窗口、tab、focus、站点规则继承和无用户手势策略需主Agent先定。

## 6. empty / fatal / reconfigure的旧ready清理

|入口|当前清理|缺口/复用点|
|---|---|---|
|Browser geometry/document变化|GpuAtlas::ClearStage（gpu_atlas.cc:495）、MarkLastStale（530），StopView（542）；capture-to-atlas路径要求新generation|保留这些GPU lease/Fence退役约束，不能用CPU清ready替代GPU完成|
|Browser fatal/reconfigure|Lost（292）/ReconfigureNeeded（277）停capture、发布terminal status|状态经共享mapping由Endpoint Poll发现；不需新增逐帧Mojo|
|Endpoint empty visible集合|MediaLoop（service.cpp:905）发布generation0、16×16、views=[]、递增epoch；PublishLayout（726）清对应coordinate readiness/feedback绑定|这是可复用的无内容失效布局入口|
|Endpoint reconfigure|MediaLoop:869清坐标ready、latest frame、layout/feedback并重开output|Client此时未收到立即失效布局，需等新generation首次布局；旧ready可能保留|
|Endpoint fatal|MediaLoop:900清坐标ready、记录stats.error后break|未立即发Client失效布局/终止通知；服务端拒绝输入不等于Client清旧ready|
|RTC close / PauseOutput|service.cpp:1050 / 330清坐标ready及媒体状态|暂停到下一布局的间隔也需与Client失效语义统一|
|Client收到新/empty layout|transport.ts:495关闭不匹配processor owners、删除paintedPlanes/viewPresentations、renderer.ready(false)、frameGate epoch变化|可复用；物理canvas旧像素未必主动clear，只失去ready；产品需明确空/恢复/错误占位|
|Client RTC失败/teardown|transport.ts:192 connectionstate，cleanup:614清paintedPlanes/renderer ready并关闭peer|可复用断线失效，不能让fatal只更新HUD error而保留可输入画面|

坐标授权单点是 `endpoint/include/remotekit/coordinate_readiness.hpp:11`，Clear:16；客户端授权还匹配wire RTP、layout epoch和plane身份。这些应维持，不能为快速restore跳过instance/document/epoch约束。

## 7. patch、公共header与验证影响

- 上述UA/CH、device emulation、lifecycle和NewContents均有现成Chromium API；本次审计没有发现必须新改Chromium tracked文件的要求。相关WebView内部头、PageRequests回调、Endpoint JSON、Control TS类型可在仓库内扩展。是否需要新增patch由实施中真实缺口决定。
- 现有capture-to-atlas依赖patch0007（含Viz公共Mojo/traits及FrameSink接口），backing scale使用Chromium内部RenderWidgetHostViewBase API；产品改造不能误删仍在用的捕获依赖。
- `sdk/include/remotekit_sdk.h:85`有通用JSON command；新增控制操作不必改C ABI。不要跨DLL传C++对象；NewContents adoption仅在Browser内部。
- shared_atlas.h当前version2；只改控制面状态不必扩共享mapping。若改二进制layout，须版本/尺寸断言及Browser+SDK+Endpoint一起重建。
- 新功能至少需要覆盖UA与几何独立、首导航/重定向/history/restore的UA、断Viewer可见性与RTC状态独立、discard安全拒绝/真实完成、popup adopt和orphan幂等、empty/fatal/reconfigure后旧ready清理。这里列的是接口正确性验证需求，不是新增性能矩阵。
