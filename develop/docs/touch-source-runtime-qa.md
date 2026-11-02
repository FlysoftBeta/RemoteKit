# 触控源时钟真实运行检查

2026-11-02，Sol。正式生产Viewer、真实DataChannel/Endpoint/Browser与QSV H264，
接收端是隔离Chromium157.0.8103.15 headless。CDP仅对接收端注入真实浏览器触摸
输入；未向页面手工dispatch DOM TouchEvent，未连接远端WebView DevTools，未抢桌面。
这是自动化触摸，不是实体触屏手感或物理显示验收。

最终服务策略已通过：固定GENERIC_DESKTOP/逻辑PPI96、默认新惯性曲线，正常/70ms
中途停顿/UP延迟100ms最终scroll为502/501/502DIP，零拒绝，END后有189–221DIP
真实惯性。最新证据以文末“服务输入参数独立化”一节为准。

## 首轮与发现

证据：`develop/tmp/touch-source-qa-1793602501569/result.json`、
`telemetry.jsonl`、`develop/tmp/touch-source-qa-final.png`。实际native是最新
out/dev（is_debug=false/component=true）Browser及endpoint-package Release Endpoint，
生产Control dist包含源时钟与共享绘制修改。隔离Control/fixture端口33281/33282。

三条同样320 DIP/20×16ms源采样轨迹：正常、第四个move暂停发送70ms后保序批量
发送、仅UP延迟100ms。DC记录源elapsed与实际发送时刻；远端网页主动POST原生
DOM事件timestamp/dispatch与scrollTop曲线。源elapsed实测0/16000/32000/48000…，
DOM touch timestamp保持16ms区间，dispatch时刻可间隔约43–55ms；已确认采样时钟
贯通，未把接收节奏重新当作源采样节奏。

| Case | 实际结果 | 严格结论 |
|---|---|---|
| 正常/stall70/up100 | 最终root scrollTop 1 / 1 / 26；各20条输入拒绝 | 失败，不能比较惯性 |
| 嵌套overflow | root=0、nested=1，后续19条拒绝 | 初始命中正确，完整滚动失败 |
| cross-origin iframe | child root=1、外层root=0，后续19条拒绝；同view renderer_pids为17276/22492 | 初始OOPIF路由正确，完整滚动失败 |
| touch-action:none | root=0，完整touch交互、无拒绝 | 通过 |
| touchmove preventDefault | root=0、blocked=0，完整touch交互、无拒绝 | 通过 |
| cancel/lostcapture | 观察到touchcancel，但此前同样误拒绝 | 受污染，不能记正式终止通过 |
| DPR2 | Viewer DPR=2，网页实际DPR=1.833397 | smooth面积预算导致前提不满足，不能把requested=2记actual=2 |

失败根因是旧SendTouchEvent把任何同步completion当作派发失败。自然scroll开始后，
官方优化路径可同步canonical ACK，旧逻辑因此主动CancelTouches；网页日志确实
收到随后由服务端注入的touchcancel。第一次错误为
`Touch delivery unconfirmed: native touch or browser filtering`，以后全为
`Invalid touch contact transition`。本轮真实检查揭示此问题，不以模型通过掩盖。

首轮服务和自有157 context正常关闭，run路径无残留Browser/Endpoint进程；随后
才交出GPU/构建窗口。Sol已查看截图：产品外壳稳定，fixture自身固定宽度导致
窄700px视口裁切，未将该fixture布局现象记为产品布局问题。

## 最小修复

root批准后，`0008-touch-injection-dispatch-result.patch`保留原void API，新增bool
`InjectTouchEventWithResult`。只依据官方HandleEmulatedTouchEvent是否到达Forward
返回派发接受；completion同步/异步不代表失败，也不代表页面消费结果。native流
排他、gesture provider拒绝及无start仍拒绝；touch-action/preventDefault和canonical
ACK路径不变。Browser只对显式预路由拒绝取消序列。

patchset record/hash/status已通过：SHA256
`9b339df08086930cf7773bd99245f0ae291ed4ab33a78622de5ba02063d69a92`，有序清单8项
applied，检查在临时快照中可逆/重放，没有撤回开发机其他项目修改。官方unit新增
同步ACK接受、native排他拒绝、无start拒绝三条分支；content_unittests未预建，
这些unit未执行，不为其追加全量构建。

统一native/Control增量构建由A执行。复验只重跑失败/受影响的8项，跳过首轮完整
无拒绝通过的none/preventDefault；DPR2单项改高画质并记录实际quality/backing。
正式可复现入口见[触控检查工具](../../docs/touch-source-qa.md)。

## 修复后复验

统一构建后运行`develop/tmp/touch-source-qa-1793604048834/result.json`：8项全部
零input.result拒绝、零pageerror；nested/OOPIF、cancel/lostcapture、实际DPR2与
坐标映射通过。正常/stall70/up100的最终root scroll为201/249/241，END后无新增
滚动，因此轨迹比较未通过，尚不能据此宣布惯性修复完成。

离线核对发现驱动前提偏差：每步await CDP响应再sleep16，使正常wire总历时716ms、
stall70为732ms、up100为849ms；CDP回复会等待帧。与之对应，显式源采样仍固定
0..320ms，UP336ms，320DIP位移在22条wire和最终DOM y180中完整存在；末端源年龄
分别455/413/532ms。这个“正常”组人为制造持续增长迟到，不能据其结果直接推断
native速度规则失败。没有坐标缩放或丢失wire位移的证据。

root批准下一次仅3条轨迹的判别实验：driver改为固定deadline每16ms发CDP，保持
协议指令顺序，所有响应集中等待；记录每条指令实际issuedElapsed与源elapsed、
wire发送时序和Browser源年龄。A质量QA占用GPU期间没有追加运行。修正驱动后的
结果待补；不得拿前两轮替代该实验。

## 固定deadline三轨迹

证据：`develop/tmp/touch-source-qa-1793604552739/result.json`、`telemetry.jsonl`及
run内`final.png`。源码与构建未变化，仅修正驱动调度；只跑3条轨迹，无重复语义组。

| case | 源时长/最后MOVE→UP | 指令最大deadline迟到 | wire首包→UP | Browser末端源年龄 | 最终scrollTop |
|---|---|---:|---:|---:|---:|
| 正常 | 336ms / 16ms | 10ms | 284.1ms | 15.213ms | 313 |
| 中途70ms暂停后批量 | 336ms / 16ms | 12ms | 334.4ms | 23.577ms | 313 |
| UP单独延迟100ms | 336ms / 16ms | 7ms | 435.2ms | 115.926ms | 313 |

三组各22条wire，源坐标y500→180，共320DIP；源clock全部source，所有输入接受、
无pageerror。正常首包受focus ACK排队，和首move一起发出，因此wire首包→UP可以
短于源时间跨度；不能误记为采样时钟压缩。Viewer与远端DOM最后位置都180。

三组拖动完全一致，313DIP与320减约7DIP原生touch slop相符。这是有效的网络扰动
下拖动位移一致性结果。原driver的trajectoryConsistent把“最终>320”惯性条件混在
同一布尔值，所以该历史raw结果为false；正式工具已把一致性与flingObserved分开，
没有改动raw证据，也没有伪造更长/更快输入迎合阈值。

三组END后2.2秒观察窗都没有新增滚动，惯性尚未出现，不能宣布fling通过。离线
核对项目未设disable-fling/scroll或GestureConfiguration覆盖；CURRENT_PLATFORM在
Windows的fling门槛30、上限17000、LSQ2_RESTRICTED，给定源采样约1000DIP/s足够。
源采样和位移已正确到达，下一步应区分GestureFlingStart是否生成、canonical ACK
过滤、路由接受以及FlingScheduler动画推进；不能把无惯性仅归因于接收端慢。

还有一项既有语义限制：官方TouchEmulator injecting模式把longpress/showpress
timeout设为TimeDelta::Max，源时间贯通不应被描述为原生长按完整实现。这不是本轮
源时钟引入的新限制，亦未在本轮越界修改gesture策略。

第三轮结束后自有context、服务、Endpoint/Browser正常关闭exit0，GPU/host窗口
已交回；后续调查只读，不与A质量QA并跑媒体。

## 惯性根因判别与正式复验

只读review发现：ServiceScreen不是实际ScreenWin，官方FallbackScreenWin不能提供
有效物理PPI；Windows默认ExperimentalFlingAnimation的物理曲线将0 PPI用于减速度，
导致无有效位移。项目正常UP仅移除contact，不Disable/Cancel；三组native
cancelled=0、focused=true、touch_code=0，也排除了本地收尾主动取消。

root批准仅一条normal判别：在现有Endpoint参数中只禁ExperimentalFlingAnimation，
未改native代码。`touch-source-qa-1793605071974/result.json`最终scroll486DIP、
零拒绝/pageerror，恢复fling，为curve/PPI候选提供运行判别证据。这不是正式默认。

初版`0009-headless-fling-physical-metrics.patch`仅在Windows
FlingScheduler::GetPixelsPerInch逐轴校验finite且>0，无效轴回官方96，正常轴保持
实际值，不关闭默认新曲线、不改变Viewer DPR。SHA256
`60db7b6062887fa216e154bf5f1fcbb9ef3455df29cc67189e8fb23600a3b60d`，patchset全9
项applied并可逆/重放检查通过。新增官方unit覆盖正常PPI、零/负轴、NaN/Inf；
content_unittests仍未预建，unit未执行，不为其追加全量构建。

本agent增量构建Browser/SDK成功：仅fling_scheduler.obj及content.dll两步，23.93秒，
SDK export完成。随后A最终Control148测试、production build/startup smoke通过，
才运行最后3轨迹，未重复Endpoint套件或无关语义/性能组。

该PPI安全回退版证据：`develop/tmp/touch-source-qa-1793605369674/result.json`、`telemetry.jsonl`
及`final.png`，`browserDisableFeatures`为空，保留默认新curve。

| case | 最终scrollTop | DOM END后新增位移 | END后最后位移时间 | 末端源年龄 |
|---|---:|---:|---:|---:|
| 正常 | 502 | 205 DIP | 423.6ms | 30.136ms |
| 中途70ms暂停后批量 | 494 | 205 DIP | 419.8ms | 32.017ms |
| UP单独延迟100ms | 503 | 190 DIP | 423.8ms | 135.791ms |

三组最终差≤9DIP，全部source clock、trajectoryConsistent、flingObserved及无输入
拒绝检查通过，无pageerror。每组22包、源UP336ms、末MOVE→UP16ms，driver最大
deadline迟到8–12ms。END后190–205DIP/约420ms的真实滚动曲线证明不是只有拖动。
normal与UP100的源年龄跨过旧80ms停止阈值，惯性仍保留且最终位置一致。

Sol查看最终1000×850截图：外壳及fixture面板清楚，无异常覆盖；滚动条与页面
梯度显示实际滚动。全部自有context/服务/Endpoint/Browser正常关闭exit0，run路径
无残留进程，GPU/host窗口已直接交A spinner视觉检查。

此有界验收确认自动化触摸、源时钟、网页基础语义和惯性恢复；没有实体触摸屏
手感、原生Windows触控驱动、长按完整行为或物理屏幕点亮的验收结论。

## 服务输入参数独立化（最终）

用户进一步要求关键参数尽量独立于系统设置，root选定最小服务策略：服务构建
MainDelegate自动附加内部布尔marker`remotekit-service-input`，FlingScheduler固定
使用官方96逻辑PPI，WebView触控固定GENERIC_DESKTOP。没有新增UI/可调数值参数。
页面DPR仍来自Client Scale/资源策略，刷新仍按Client/媒体策略，96不改写页面DPR。
显式native demo不附marker、保持CURRENT_PLATFORM及正常真实物理PPI；无效物理
PPI的逐轴安全回退仍保留。demo路径由条件编译/源码核对，没有追加demo运行组。

GENERIC_DESKTOP固定slop15、fling门槛30/上限17000、平台doubletap关闭；不再读取
Aura平台单例及其touch偏好。未改为GENERIC_MOBILE，避免同时引入slop8、50/8000
速度门槛和平台doubletap/tap等待行为。源时间及canonical ACK网页语义保持不变。

0009已同步当前有序补丁/hash：
`21d00764d6710cba498c76ee5d909fec6e56762a08cbda7fe3859da3c4610bd5`，全9项
patchset status通过。新增服务逻辑PPI覆盖unit保留但未运行content_unittests。
Browser+SDK同Ninja增量5步26.39秒通过，SDK export完成；无Endpoint ABI变化，
没有再跑已通过的Endpoint套件。

最终实际运行证据：`develop/tmp/touch-source-qa-1793605790097/result.json`、
`telemetry.jsonl`、`final.png`。此次只重跑同3条轨迹，配置变化前的结果没有覆盖
此新路径。browserDisableFeatures为空，保留默认新curve。

| case | 最终scrollTop | DOM END后新增位移 | END后最后位移时间 | 末端源年龄 |
|---|---:|---:|---:|---:|
| 正常 | 502 | 221 DIP | 403.6ms | 12.825ms |
| 中途70ms暂停后批量 | 501 | 204 DIP | 415.7ms | 30.142ms |
| UP单独延迟100ms | 502 | 189 DIP | 418.2ms | 127.274ms |

最终差仅1DIP，全部sourceClock/trajectoryConsistent/flingObserved/noRejectedInput
检查通过，无pageerror；native clockRejected=0、cancelled=0。每条snapshot明确
configuration=generic-desktop、logicalPixelsPerInch=96，source UP336ms。所有自有
context、Control/fixture、Endpoint/Browser正常shutdown exit0，run路径无残留进程。
GPU/host已交最终发布，不再追加实验或构建。
