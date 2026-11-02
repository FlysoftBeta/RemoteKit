# 触控滚动路径只读审计

2026-11-02。初始为只读源码调查与纯 JS 模型探针，后续root授权A方案实施及真实自动化检查。阶段状态与最终运行证据见文末和[真实触控记录](touch-source-runtime-qa.md)；这不是实体触屏手感验收。

## 结论

当前 Viewer 丢弃客户端事件时间，Browser 按 RPC 抵达时间注入 touch。Chromium 的速度跟踪器以这些时间判断停止与 fling 速度，网络微卡足以使相同手势失去惯性或被压缩成异常快的惯性。手指按住时的 scroll update 主要来自坐标差，不能把全部异常统称为服务端按时间变速。还存在独立的事件丢失路径：Browser 在异步首触点命中/取消期间返回 busy，生产 Endpoint/Viewer 没有按文档重试；本地拥塞、焦点队列、画面 epoch 门禁也会丢掉 move/end/cancel。

建议首先修复可靠 touch 序列与客户端采样时间贯通，保留 Chromium 对网页 touch-action、preventDefault、iframe 命中、嵌套滚动和手势 ACK 的判断。把所有 touch 改成 wheel 会改变网页绘图、滑块、长按选择、触控监听、pinch 与滚动链语义，不适合作为通用修复。若产品明确要求完整客户端计算惯性，需要 Browser 明确授权某条 sequence 的原生滚动，而非 Viewer 仅凭 canvas 判断。

## 实际链路与证据

| 层 | 当前行为与位置 | 影响 |
|---|---|---|
| Viewer pointer | `control/client/remote-viewport.tsx:143-210`，React pointerdown/move/up/cancel；仅 pointerType=touch 发 touch，pen 走现有 mouse 路径；每条只发改变的一点 | 无 event.timeStamp、nativeEvent.getCoalescedEvents 或采样历史；不能恢复设备采样节奏 |
| Viewer 捕获 | 同文件 `:160-176`，down preventDefault、focus、setPointerCapture；canvas `:249-254` 处理 cancel，但无 lostpointercapture handler | 正常越界捕获坐标保留；非正常 capture 丢失没有单独收尾 |
| Viewer 取消 | 同文件 `:74-108`，blur/unmount 对 map 每一点各发 cancel；Browser cancel 是整条 touch sequence | 多指时首个 cancel 已清空全部 contact，后续 cancel 会成为无序列取消；需要一次全序列取消 |
| Viewer 身份 | 同文件 `:145-150` 的 session/instance/document/layout identity 只约束 mouseCapture；touches map 没有该身份 | 布局切换/导航后仍按住的手指不应把新几何 move 当成旧序列延续；需显式 epoch/focus 屏障 |
| 坐标 | `control/client/coordinates.ts:3-27`；canvas CSS rect 比例 × encoded plane / (DPR × mediaScale)，captured move/up/cancel 允许越界 | 已正确区分 DIP、DPR、media sampling，不存在明显漏乘 DPR 的源码证据。`control/test/coordinates.test.ts` 有独立采样比例/越界覆盖 |
| CSS | `control/client/style.css:173`，canvas touch-action:none | 阻止本地浏览器把 Viewer canvas 当网页滚动目标，是传递远端 touch 所需；不会设置远端网页的 touch-action，不能直接归罪于此 |
| DC | `control/client/transport.ts:228` ordered=true，未设 maxRetransmits/maxPacketLifeTime | 可靠保序，存在丢包时队头等待；当前触控并非不可靠 UDP |
| Viewer 队列 | 同文件 `:566-573`；未绘制匹配 epoch 阻止输入，focus 队列上限64，bufferedAmount>256KiB直接返回 | send() 包装忽略成功/失败；本地 map 在确认发送前已修改，终止事件没有保底；仅显示 input.result 错误（`:551-553`） |
| Endpoint 队列 | `endpoint/src/service.cpp:995-1032` QueueInput/InputLoop；256条有界队列，只合并 mouse move；单线程同步 Rpc | touch 不合并、无源时间；busy 后继续处理下条，拒绝的终止事件不重试；每次 HandleData 生成新 Browser sequence |
| Browser 接受 | `browser/webview.cc:1061-1062` 命中/取消期间 AcceptInput 前 busy；`:1101-1104` ACK队列/前序收尾 busy | `docs/control-protocol.md:56` 明确需原 token/sequence 有界重试；生产路径缺此实现。客户端重复发同 clientSequence 会被 Endpoint arrival gate 拒绝，不能直接套 Viewer 原包重发 |
| Browser 路由 | `browser/webview.cc:879-953` 首个 start 异步 OOPIF hit test，固定目标 widget/document，验证 token/focus，保留 root coordinate 转换 | 这是应保留的实际跨进程 iframe 路由，直接 wheel 不能替代这条 touch 目标锁定链 |
| Browser 注入 | `browser/webview.cc:767-774` TouchEmulator injecting mode/CURRENT_PLATFORM；`:999` 每次 new WebTouchEvent(...TimeTicks::Now())；`:1023-1053` compact contact ID、整序列 cancel、逐改变点注入 | 源时间最终被服务端处理时间替代；多个 changed point 同批也被拆成各自事件。ACK上限128不能被忽略 |

### Chromium 原生证据

源码位于当前固定的 `C:/src/chromium/src`，没有读取旧 RemoteKit 项目。

- `content/browser/renderer_host/input/touch_emulator_impl.cc:308-350` 把 WebTouchEvent 包成 MotionEventWeb 交给 FilteredGestureProvider，之后转发真实 touch；`:353-375` renderer ACK consumed 与 blocking 决定过滤；`:422-480` 生成并转发 scroll/pinch/fling。网页仍能阻止默认触控滚动。
- `content/browser/renderer_host/input/motion_event_web.cc:202-203`：GetEventTime 直接返回 event.TimeStamp。
- `ui/events/velocity_tracker/velocity_tracker.cc:48,54,282-296,318-336`：MOVE间隔≥40ms清除历史，UP距上次move≥80ms清除历史；`:154` 最小二乘历史窗口100ms。
- `ui/events/gesture_detection/gesture_detector.cc:333-355`：scroll_x/y 是上次 focus 坐标差，超过 slop 才开始；`:426-433` UP 用 VelocityTracker 计算速度并触发 OnFling。
- `ui/events/gesture_detection/gesture_detector.cc:86-114,316-318`：长按等 timeout 仍由服务端 timer 驱动，特性开启时会补偿 now-event_time。传递采样时间也不能宣称全部手势定时已移到客户端。
- `components/input/fling_controller.cc:172-176,197-235`：惯性在服务端 BeginFrame/clock 驱动；首次进展距 fling timestamp 太远会将起点调整到当前帧附近。正确采样时间能稳定起始速度，但画面产生/传输仍受远端调度影响。

## 纯模型探针

使用 node 临时 stdin 脚本，未写产品测试。模型只复刻40/80ms清空条件与简单线性速度拟合，不是 Chromium 完整算法或真实测量。

同样80 DIP拖动，采样时间0/16/32/48/64/80ms，抬手96ms：拟合1000 DIP/s。

- 正常固定10ms传输：区间不变，速度不变。
- 到达时间10/26/42/110/111/112ms，抬手113ms：40ms停止规则清空一次，最后三点压缩为16000 DIP/s；实际 Chromium 还受算法和 max velocity 限制。
- 到达时间10/26/42/58/74/90ms，但抬手180ms：80ms停止规则清空，最终速度0。

三组总拖动距离均80 DIP。这证明时间链是独立于DPR/坐标的确定性缺陷，尚不能证明它是用户设备上的唯一原因。

## 候选协议与决策记录（A已实施，B/C未实施）

### A. 小范围、保留网页语义的修复

1. Touch sequence 显式绑定 `{session,view,instance,document,focus,layoutEpoch,outputGeneration,peer/connection}`，加 sequence ID 与客户端单调采样时间。时间可用相对某个客户端 clock epoch 的整数微秒，不能混用 wall clock/Date.now；start/move/end/cancel 都携带。Chrome89不依赖新API：getCoalescedEvents 只作 feature detection 的增强，缺失时使用单个原生 PointerEvent 与 timeStamp。
2. 每点采样保留顺序/时间；可有界批量传输连续move采样，但不能跨start/end/cancel、target token 或第二触点事件重排合并；不要只保留最后move来估计fling。客户端同一物理pointer未成功start，不发送无主move/end；局部发送失败终止本地序列并排队整序列cancel。
3. Endpoint 承担已入队包的 Browser busy 重试：只对明确 AcceptInput 前 busy，保持已分配 Browser sequence、完整 token、队列顺序，不让后面的end越过start；设总时间/尝试预算，token/epoch变化立即终止。受理后的异步失败绝不重放。ACK busy状态必须区分真正失败，错误时使客户端丢弃contact并等待下一次down。
4. 保留可靠保序DC。为end/cancel保留队列容量、正常背压时压缩/批量move；无法恢复时发送一次整序列cancel而非静默丢终止事件。无需为了本轮修复新增不可靠输入通道或绕开旧epoch门禁。
5. Browser 注入使用客户端采样间隔映射的稳定 TimeTicks 时间线，固定映射不能每包重新锚定于 now。必须定义 future/age 上界、非法/倒退时间拒绝、较长手势、客户端时钟重置和断线；不应逐样本clamp导致再次扭曲速度。首个arrival作为事件零点时，后续延迟降低会产生未来时间；盲目减固定buffer会让长按timeout看到人工事件年龄。应在实现中明确时钟映射与gesture timer测试，或把源时间仅用于速度估计且保留原生事件dispatch时钟。

以上A仍由 Chromium 根据源采样时间计算gesture/fling，不能称为完整客户端gesture计算。它已能消除“网络到达间隔充当手指速度”的主要问题，同时保持网页行为。

### B. 更贴近“客户端计算惯性”的中间方案

客户端用原始/合并采样计算有界速度与最后静止时长，end携带 `{velocityX,velocityY,sampleWindowUs,stationaryUs}`（DIP/s）。Browser 保留原生 touch 与 ACK/默认动作判断，仅在该真实 touch sequence 被 Chromium 确认为可滚动、并即将产生fling时，用验证过的客户端速度代替到达时间估计。无权限的 end metadata 不能凭空触发 scroll/fling。需为“原速度为0而未产生fling”定义等价资格判断，否则仍不能修复延迟UP灭惯性。

TouchEmulator 目前没有项目侧公开hook，可能需要一个小 Chromium patch，把源采样时间/末端速度传给GestureProvider或在正确语义边界提供回调。跨DLL继续C ABI，不能把 Chromium对象或STL结构交给Endpoint。补丁必须按patchset流程管理。这比全客户端gesture授权小，但仍需root先定边界。

### C. 完整客户端 scroll delta / inertia

Viewer 一开始仍传真实touch给Browser。Browser 经命中、touch-action和renderer ACK后，回复当前gesture可由原生滚动执行的授权（含目标/sequence/token、轴限制、scroll-chain语义、取消状态）。客户端随后用采样差分与自身时间计算drag/inertia，并发送有序scroll lifecycle/delta/phase，Browser注入 touchscreen GestureScrollBegin/Update/End/Cancel 到同一原生目标路由。Browser必须停止自己对同序列再生成scroll/fling，避免双滚动；页面消耗/取消、pinch、第二触点、导航、blur会撤销授权。不能根据“未见preventDefault”在Viewer自行猜许可。

该方案需处理远端许可RTT、touch/pointercancel对网页的标准行为、嵌套滚动/overscroll/touch-action轴、OOPIF bubbling、按住中切换手势等，范围明显更大。没有此语义握手，通用wheel方案会破坏绘图与选择。即便客户端生成惯性，服务端屏幕只在数据抵达后更新，网络微卡仍会造成短暂停顿；可保总距离/速度规则，不能承诺消除传输延迟。

## 有界验证建议

先纯模型/CPU检查，再由独占实验agent执行有限实际检查，不追加已取消的性能矩阵。

- 相同采样轨迹，在固定延迟、70ms中途停顿后批量抵达、单独UP延迟100ms三组，比较最终滚动距离与末端速度；采样速度应稳定，接收时刻可不同。
- 同一轨迹不同DPR(1/2)与mediaScale(.5/1)，CSS等大/缩放，确认DIP距离和速度一致；触点越界后up/cancel不留悬挂contact。
- 纯 transport fake：首start busy一次/多次、ACK队列busy、token变化、focus队列满、DC背压、256队列上限；确认终止/取消不会越序、重复或静默遗失。
- 页面语义每项一条：普通长页、嵌套overflow、cross-origin iframe、touch-action:none绘图、touchstart/move preventDefault、长按文本选择；触控canvas不能随手势被当滚动。
- cancel/blur/unmount/lostpointercapture、重连/导航/layout epoch改变、两指pinch后cancel、新sequence开始；pen继续现有mouse行为，不顺手改输入类型。
- Chrome89与当前157各跑最小触摸/滚动组，记录 source timestamp、dispatch timestamp、input busy/retry/drop/cancel 数量与最终滚动位置。无实体设备时明确是自动化touch，不宣称原生触屏手感验收。

现有坐标测试支持映射正确，但没有本次实际滚动/实体触屏结果。最小新增诊断应把capture time与dispatch time分开，避免只看到输入错误字符串而不知道某个end是否丢失。

## A方案实施交接（2026-11-02）

root选择保留官方网页语义的A方案并明确保守时钟契约后，已修改Viewer、Browser、输入模型/JSON解析与输入协议文档；Endpoint busy重试由连接agent独占service.cpp实现。完整客户端gesture授权方案B/C没有实施。

- `control/client/touch-input.ts`：每viewport单touch状态机、单gesture固定时钟、source elapsed、Chrome89时间戳规范化、≤32历史合并、整序列cancel。
- `CaptureLatency.inputStart`：仅健康校准下返回offset减uncertainty的server wall采样起点；无校准整gesture显式arrival-fallback，不在半途改模式。
- `remote-viewport.tsx`：有界coalesced采样、lostcapture/blur/cancel一次整序列终止、已发送序列的逻辑focus身份与epoch屏障；保留pen现有mouse路径。
- `transport.ts`：焦点ACK稳定逻辑身份，输入背压有界排队/相邻move合并，普通输入112条预算、终止保留至128条；终止可等匹配画面，drain仍严格检查同token/geometry/epoch。发送trace附source clock/elapsed/gesture ID，公开touchInputStats。交接给渲染agent后由其独占继续整合WebGL。
- `TouchInput`/harness parser/WebView：source起点仅首down用wall→ticks转换，未来/过旧/倒退/改锚取消；samples在同官方TouchEmulator路径逐条注入；源时钟与dispatch年龄诊断分开。`touch_clock.hpp`提供无Chromium依赖的边界函数。
- 已运行19项相关TS检查（新增touch状态机5项、transport故障4项，既有坐标/时钟/焦点10项）全部通过。Control类型检查通过；连接agent后续新增测试短暂implicit-any已由其修复并报告类型检查再通过。
- `endpoint/tests/core_tests.cpp`新增sample时序、非法clock、起点年龄/未来、倒退和长gesture单调时钟断言；尚未native编译运行，须由root统一增量构建/CPU suites确认。没有GPU/Browser或实体触摸运行证据。

仍需有界真实自动touch组确认start异步命中重试、70ms中途网络停顿/延迟UP、网页preventDefault/嵌套滚动/OOPIF与cancel行为。采样时钟不会消除媒体传输/远端渲染的停顿，长按/原生惯性动画仍归Chromium。

后续真实检查已完成，发现并修复同步canonical ACK误取消及离屏物理PPI缺失导致
无惯性的问题。最终服务固定generic触控/逻辑PPI96后，默认新曲线3轨迹scroll为
502/501/502DIP，零拒绝，DOM END后仍有189–221DIP惯性；完整证据、分阶段失败与复验见
[真实触控记录](touch-source-runtime-qa.md)。源时间贯通不代表完整长按：官方injecting
模式既有longpress/showpress禁用策略本轮未扩展。旧“待验”段落描述初版交接时点，
当前验收结果以真实触控记录最后一节为准。
