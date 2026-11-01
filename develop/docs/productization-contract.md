# 产品化实施契约（root选定，实施中）

这是一轮实施契约，不是已完成功能清单。性能已按用户要求结束重复复验；保持Chrome89，后续只做功能变更所需检查。最终交付顺序见productization-next.md。

## 状态与隔离

- 一个User拥有一个workspace及一个Tenant/Endpoint Session，沿用Session隔离；不把窗口或tab变成隔离边界。
- workspace v2：平铺tabs（各有windowId、稳定产品id、有限webviewId引用），有序windows（id、activeTabId、weight），activeWindowId，settings，sites。每个tab只属于一个window；激活tab必须属于该window。
- Window是真正独立的标签容器；并排或窄屏仅显示聚焦Window由UI布局决定，身份与tab归属不改变。关闭最后tab保留空Window。新窗口请求生成新的产品Window或按disposition生成Tab。
- settings：qualityPreference=quality/auto/smooth，clientScaleOverride=null或0.5–4，memorySaverEnabled默认true。sites以规范化HTTP(S) origin为key，tabletUa布尔。viewport来自实际内容区，平板设置不得改变viewport/touch/pointer。
- User设置、窗口、站点偏好存SQLite。客户端只持有HttpOnly用户token，不持久化设置；删除本应用旧设置键，不清除其他应用数据。
- 旧activeTabId/splitTabId/device只是诊断兼容投影，不是v2第二份真相。旧SQLite状态迁移成一个或两个Window，保留tab和webview引用；旧平板的伪viewport参数不继续作为产品规则。

## Auth与WebSocket

- 简易username/password创建、登录、退出；密码使用Node crypto.scrypt带独立salt，比较使用timingSafeEqual，token为随机opaque值。现有匿名session迁为legacy用户以保留数据，新正常客户端走登录；自动化可在显式diagnostics模式创建隔离临时用户。
- GET /api/auth/me；POST /api/auth/register、login、logout。现有rk_session HttpOnly/SameSite=Strict cookie可继续作为唯一token，HTTPS加Secure。客户端不能指定tenant/user作用域。
- WebSocket /api/socket，鉴权与Origin校验沿用HTTP规则。请求{id,method,params}，响应{type:result,id,result}或{type:error,id,error}；状态推送{type:state,revision,state}，初次连入立即给完整state。支持action、rtc.offer/ice/close、viewport、feedback、clock.ping；媒体仍Client直连Endpoint。
- 每用户现有单活跃媒体连接沿用，明确以Viewer连接租约管理；新Viewer接管旧Viewer后，旧端不得自动反复抢回。租约/在线状态为运行时状态，不存客户端设置。
- 状态、设置和操作通过WS；认证与metrics上传可保留HTTP。HTTP legacy actions/rtc/state仅保留给明确diagnostics模式，正常Viewer不轮询。
- 所有tenant状态操作继续串行；持久状态变更递增revision并推送。离线用户不因启动对账而无条件创建全部Browser/WebView。

## 可见性、生命周期与窗口事件

- Control根据活跃Viewer WS在线、实际显示Window、每Window activeTab计算product visible。断线将对应visible置false；不能由RTC连通反推visible。
- Endpoint单独根据RTC可用性控制render demand和编码；SetRenderDemand不得修改product visible。Browser specs/snapshot/实际可见性使用统一入口。
- Endpoint补view.lifecycle(discard/restore)与snapshot lifecycle/canDiscard/blockReason；复用Browser现有内部恢复能力，不把恢复blob送Control。Control默认对隐藏且允许discard的页实施空闲回收，选中时restore；先用120秒隐藏阈值，保护正在关闭、媒体捕获/发声、beforeunload等不能安全丢弃的页。
- UA配置以session级站点规则下发并在Browser导航/重定向时应用UA和Client Hints；不调用平板viewport/touch模拟。菜单保存后刷新当前页，其他同站点页下次加载生效。
- popup必须收养实际NewContents以保留opener，不能只复制URL。Browser/Endpoint provisional身份和事件先存在，Control持久化产品Tab/Window后adopt；未adopt对象不得被普通orphan对账抢先关闭。provisional需有数量和超时边界；事件不能被page.requests读取后丢弃。具体操作字段在Endpoint实施前由root定稿。
- 输出空布局、资源重建、真正fatal时，Endpoint发送新epoch的空layout撤销旧客户端ready/输入；恢复只在新布局和匹配帧后重新授权。

## 自适应与实验隔离

- 产品质量仅三个偏好，共同决定分辨率、码率、目标FPS。低延迟编码使用已验证TU7/LPON/VBR/depth1，保留必要硬件兼容分支。
- Client报告实际内容区CSS尺寸、DPR、刷新信息。effective Browser DPR=ClientScale（override或真实DPR）×服务端resolutionFactor；viewport DIP不因质量模式改变。
- 连续高延迟>300ms触发有冷却/迟滞的降分辨率；恢复需持续健康，不能每个反馈振荡。生产延迟估计与真实Pixel marker指标分别标明，不能拿RTT冒充E2E。
- /automation为配置驱动、无交互控件的测试页面，固定条件时明确关闭自动策略；/diagnostics保留开发者观测。正常Viewer不包含实验旋钮。保留GPU/延迟分段、bounded profile、metrics重组与CRC设施。
- 无效/历史开关最终集中归档一次，删除活跃UI与文档的散落引用；不是删除证据或正式profiling工具。

## 分工和发布

root固定契约、集成与取舍并完成commit/push。Sol实施server/store/WS、Endpoint/Browser、客户端接入与功能检查；Astra已完成UI设计，Sol按设计实现并视觉验证。依赖与共享类型先固定，避免并行改同一文件。

全部功能和文档逻辑整理完成后先上传一版，再由Astra做最终代码库审查并实施必要修复；有变动再构建上传。最后删除goal。不得因为第一版发布而跳过剩余任务。

## 站点UA接入契约

- Endpoint新增session.sitePreferences {sites:Record<origin,{tabletUa:boolean}>}，Browser对应session.sitePreferences。Control下发完整表；Endpoint可保存运行恢复用缓存，产品真相仍在Control。允许在Browser未启动时保存；启动时必须先应用规则再恢复/导航WebView。
- 规则按HTTP(S)规范origin匹配；主文档每次导航和redirect目标选取UA/Client Hints，子frame继承该WebContents主文档设备身份。覆盖地址栏、renderer链接、back/forward、reload、restore及之后的popup。
- UA/CH选择与viewport/DPR/touch彻底分离。tablet只改变已有Chrome Android tablet UA/CH身份；真实CSS内容区、输入设备特征不模拟。不要再批量改写整个history的UA标志。
- Control保存site.set后先应用规则再reload指定当前tab；其他同站点tab下次导航生效。应用失败返回pending并重试，不能先reload出错误首请求。

## 新窗口收养与自然关闭契约

- Browser先保留真实新WebContents为pending popup，使用唯一provisionalId，暂不占正式WebViewId且不出现在普通views里。独立pendingPopups快照包含provisionalId、openerViewId、url、disposition、userGesture和status。不得用URL重建替代收养；首次请求也必须应用站点UA。
- Control先持久化Tab/Window及正常分配的webviewId，再发view.adopt {viewId,provisionalId,...常规view配置}。Endpoint/Browser以同一provisionalId+viewId幂等接入现有WebView；不同归属冲突明确拒绝。收养前无帧输出；完成后依正常可见性/RTC规则运行。
- NEW_FOREGROUND_TAB/BACKGROUND_TAB落入opener的产品Window，后台不抢active；NEW_WINDOW/NEW_POPUP建立产品Window。UI尺寸由实际布局决定。无用户手势的新popup默认阻止；已有命名窗口复用依Chromium行为。
- pending数量限制16，30秒未收养释放；关闭/超时要有明确状态，不能把已关闭对象误收养为新页。pending不是普通orphan，避免对账提前销毁。
- 自然window.close必须作为view.closed事件透出，不能因snapshot缺失就重建。Endpoint保存未确认closed事件（eventId、viewId、reason），snapshot.events重放，session.events.ack {eventIds:string[]}确认。Control产品删除持久化后才ack；按viewId/事件幂等。不得静默丢失未确认关闭；积压达到256时拒绝新增view并报告，直到清理，不无限增长。源Browser重启/崩溃导致缺失不能伪造自然close事件。
- 普通page.requests事件不再被Endpoint读取后无声丢弃。恢复大数据仍归Browser/Session，Control仅保留产品关联与必要事件处理状态。

## 标准页面对话框

ProductState新增临时pageDialogs数组：{id,tabId,windowId,kind,message,defaultPrompt,origin,isReload?}，kind限alert/confirm/prompt/beforeunload。id由view/instance/document/request组合生成稳定opaque身份；Control保留当前请求与这些token的映射，不持久化页面对话文本。已由workspace.pendingClose处理的关tab beforeunload排除重复展示。

新增action page.reply {dialogId,accept,text?}，Control验证当前请求仍属于本用户tab，再向Endpoint view.page.reply传viewId/requestId/instance/document/accept/text；过期明确拒绝。UI显示可见active tab中的最早请求，后台tab显示待处理标记；对话失效后关闭。alert只有确认，confirm/prompt可取消，导航beforeunload明确继续/留在页面；取消或保存失败不得误删tab。依现有MUI覆盖Dialog实现，不改变内容viewport。

## 产品质量策略与真实延迟估算

下列是root选定的初始产品策略，不是新的性能验收结果。受控自动化不调用产品mediaPolicy/自适应反馈，仍使用其显式固定配置。

- quality：总可见源像素预算3840×2160、目标50FPS、目标44/max48Mbps；auto：1920×1080、52FPS、36/44Mbps；smooth：1600×900、60FPS、24/36Mbps。目标FPS受有效刷新率上限约束，无有效反馈默认60Hz。
- 根据所有可见内容区的CSS面积和ClientScale，统一计算base resolutionFactor=min(1,sqrt(pixelBudget/(area*scale²)))；DPR=ClientScale×baseFactor×adaptiveFactor，限Browser支持的0.5–4。viewport DIP仍为真实内容区，ClientScale默认真实DPR或用户override。
- 每2秒聚合有效的新源帧“采集完成→canvas提交”估算；排除idle尾帧/同sourceCaptureId重复，不能拿静态时长当排队。该估算与Pixel marker E2E分别标明。
- 连续3个有效反馈窗口p95>300ms时adaptiveFactor乘0.8，调整最短间隔5秒；持续健康(<150ms)30秒且无新拥塞时逐级恢复，仍受像素预算/DPR上下限约束。未知或过期clock、隐藏、无新源帧不能触发降级或恢复。
- 延迟来源：SDK在原始frame.capture_qpc仍可用处，以同机QPC↔系统UTC配对映射，随现有真实wire RTP/epoch帧消息附captureWallTimeMs、captureMonotonicMs、captureClockUncertaintyMs和sourceCaptureId（原capture_qpc字符串）。无有效QPC时省略，不用当前时间伪造。
- Client通过Control clock.ping校准Client↔服务端wall offset（Control和Endpoint当前同机），保留往返不确定度；与wire RTP/epoch匹配的实际paint计算估算。总不确定度>25ms、样本过期或检测到wall/monotonic跳变时不用于策略。Stats明确报告估算与不确定度。
- WS feedback参数使用presentationLatencyMs（该窗口p95）、latencySource='capture-end-to-paint'、clockUncertaintyMs、sampleCount、windowMs、displayHzEstimate等；不发送假Pixel marker。setControlRpc增加clock.ping/feedback，由Transport提供生产发送端，UI无需自行拼时间。
- Endpoint新增session.mediaPolicy {targetFps,bitrateKbps,maxBitrateKbps,adaptive:true}，可缓存后启动；每Session独立，不修改全局options。source预算上限跟随targetFps，既有源自适应可在此上限内按显示/网络反馈降FPS；实际编码码率继续受WebRTC拥塞控制。设置变化安全送入现有编码rate路径，普通码率变化不重开序列。snapshot.stats报告requested/applied策略。
- 已验证路径成为产品默认：service启用CaptureRoot/CaptureToAtlas/SinglePlaneDirect且保留几何fallback；QSV TU7/LPON/VBR/depth1、高码率；atlas-input默认auto，兼容QSV/external/depth1时shared，其余copy，显式shared不满足条件仍报错。NVENC不套QSV私有参数。
- 普通新浏览器优先支持真实RTP身份的MSTP immutable/fifo2；能力或帧元数据不支持时回video，Chrome89保留video。诊断仍能显式选择路径。不要把不支持能力误称为正常成功，也不要在产品UI暴露这些实验选择。
