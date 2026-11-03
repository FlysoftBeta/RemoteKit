# Comp / Rend 真实功能验收（2026-11-03）

## 当前结论

第四次运行使用修复后的Viz DLL，Chrome157/DPR2与Chrome89/DPR1新Comp/Rend实际功能组通过：默认video、独立双窗、正确ROI及输入、一次静态尾IDR和Wake、resize/focus/导航保持媒体身份、三档质量映射与页面DPR不变。157实际P2P限速触发GCC降码率及恢复，持续解码；10秒恢复窗口未回到原码率，没有发生编码尺寸降级。两组保持同一Browser，GPU无退出，旧代退休收敛。前三次首帧失败的独立证据保留在下文。旧capture路径数据不计入本报告；本QA不执行上传，交由root安排。

## 隔离与工具

运行使用当前生产`control/dist/server.mjs`、本批Endpoint、SDK与Browser；启动前保存绝对路径、SHA256、文件时间、Control bundle hash及进程身份。计划端口33603/33604，目录`develop/tmp/comp-rend-runtime-20261103`，新ControlDB、Endpoint数据与隔离客户端context，不使用用户Profile。

采用browser-use技能与host-managed Playwright；复用`tools/robust-viewer-qa-browser.js`、`tools/robust-viewer-qa-final.js`的准备/输入/媒体身份检查和既有生产Control supervisor模式，自有新增fixture/helpers只放临时目录。已准备`fixture.html`、`server.mjs`、`browser.js`、`prepare-bootstrap.ps1`与生成的`bootstrap.js`，直接执行说明见临时目录`README.md`。输入映射使用独立X/Y mediaScale。旧脚本的隐藏plane也必须ready断言不沿用，只要求实际current plane。

## 最低必要组与预算

顺序运行157/DPR2、89/DPR1，每版约90–150秒功能操作（最长180秒），一个Tenant、两个独立Window。每个阶段保存实际Viewer诊断、RTC getStats、远端fixture上报、当前布局与原生诊断；不运行历史吞吐/延迟指标矩阵。

1. 本地动态canvas、角点色块及坐标按钮、真实text/wheel；同时创建静态独立Window，确认两个不同remote view与ROI，目视检查截图。
2. animation→static至少3秒→animation，记录每段tail IDR提交/完成增量，静态稳定区必须没有重复尾帧，恢复必须有新画面。真实video/RTC身份保持。
3. resize1440→1100→390→1440、split→单窗/隐藏→恢复、导航；保存布局屏障与新帧，真实点击角点证明输入对应，新旧代不能串图；每次等待有界10秒。
4. 三档质量热切换，实际policy分别为maintain-resolution/balanced/maintain-framerate；同一几何的远端devicePixelRatio和页面DIP不变，RTC与video身份不变。
5. 实际receiver分别记录标准jitterBufferTarget属性存在性/读回及兼容playoutDelayHint，不能把89 hint视为标准支持。
6. 仅157进行一次受控带宽收缩/恢复，基线48Mbps5秒、4Mbps12秒、恢复48Mbps10秒。实际GCC bitrate/fps、AdaptFrame结果及getStats有响应才可称通过；host拒绝CDP或实际无响应则记未覆盖，不用方法返回成功代替实际反馈。QSV Reset/重init须记录实际fps/status与持续解码。
7. 最后结束自有contexts及服务，保存Stop/Stopped、旧代退休及资源计数。仅结束本任务PID；核对两个端口无listener。

## 最小原生可观察性

现有Stats提供mediaPolicy、tailIdrSubmissions/Completions、atlasSharedHeldSlots及编码统计；trace提供render_begin、slot_ready_observed、slot_consumed_submit、slot_reusable；QSV stderr提供Reset requested/actual/fps/status。

准备阶段反馈后，原生实现已新增`stats.comp` Begin/各类Reject、readyObserved、consumedCompleted、Stop/Stopped、活动深度/占用/退休代次及完成数、未知GPU保留、targetFps/officialMaxFps、AdaptFrame请求/丢帧/错误/尺寸变化，以及source/encoded尺寸；新增trace render_reject/stop/stopped/generation_retired。Idle/Wake修复另提供idle/idleEntries/wakes/resumeMaxFps；晚到普通Begin不得清理最近Idle身份。上述均等待本批build及真实运行，不能把源码字段存在视作运行成功。只有实际计数/trace收敛才证明旧代正常退休，进程内存近似不能替代。

## 真实RTC shaper的只读能力证据

本机157源码`content/browser/devtools/protocol/network_handler.cc`将`Network.emulateNetworkConditionsByRule`传给network conditions；`services/network/throttling/throttling_controller.cc`将空URL pattern作为全局条件并创建/更新P2P interceptor；`services/network/p2p/socket_udp.cc`在UDP socket构造时取得interceptor；`services/network/throttling/throttling_p2p_network_interceptor.cc`把上下行throughput映射到`webrtc::SimulatedNetwork`真实收发link capacity，分别排队P2P收发包。

因此准备的bootstrap在首次Control导航及任何RTCPeerConnection产生之前安装全局空pattern规则，使用5ms每向队列延迟、uplink48Mbps、无配置丢包/乱序，并在48→4→48时持续更新同一规则；不能等RTC socket产生后才创建interceptor。此处仅是源码级能力证据。准备阶段没有调用host浏览器或CDP；host方法支持与真实GCC响应仍待GO验证。89不参加shaper组。

## 停止条件与证据限制

任何FATAL/CHECK、GPU退出、错误ROI或资源身份冲突立即保存日志、截图、最后诊断并停止该组，报告root；不自行反复重启或更改架构。阶段10秒无法取得有效当前plane时保留失败现场；单客户端最多180秒，带宽反馈不收敛也不延长为性能组。

render_timestamp目前为0；未知render完成时间不填延迟样本，不声称capture/render→呈现延迟通过。整个Viewer真实hidden仅在实际visibilityState=hidden时计为覆盖；headless后台tab仍visible时明确留空，不伪造事件。

## 首次真实运行（当地2026-11-04 00:06–00:07）

Root确认本批四target构建、probes、Endpoint CPU检查、SDK导出与消费者smoke完成且相关构建/GPU进程退出后给GO。本QA使用独立生产Control、Endpoint与Browser，157.0.8103.15/DPR2隔离context；没有使用Computer Use或用户Profile。启动前hash在`run/artifact-hashes.json`，启动/故障实际路径在`process-start.json`、`process-failure.json`。主要SHA256：

|产物|SHA256|
|---|---|
|Endpoint|FC323D3A57283C003A0EF7591540CFBE79038B806FB7AF7C95D919A0D77DFAEC|
|Browser|A2C4A28F59F86488D7AFB821F6DA510F2FE14689B1E993A9AC12F6AF52FAA35C|
|remotekit_sdk.dll|1B1EC7FC2E762CAC68B15903636D6B4083845B66F82241CFA430F2C1D7686467|
|components_viz_service.dll|8FB8E5BDDF434B8CB84C38F9C009D2F72822F4B6259BA68DF62614D8A05DE18D|
|Control server.mjs|CA7A2A81618167DF9A7F7385396684B4AE25497CCE0B02CAFB9EC13D08E97B2F|

Browser PID17072、incarnation `a7d1e6cfece98a4085dd23f8e8054c3f`，Endpoint PID21844，Control PID8032，supervisor PID5864。`loaded-modules.json`证明Browser及Viz DLL实际加载绝对路径；未取得Endpoint的SDK模块列表，不将文件hash冒称模块加载证据。

真实成功仅限启动/连接前置条件：普通注册登录、单个Window建立及导航收敛；RTC/DC connected，peer1、connectionId `f304f5f4-c1ca-4c30-8b6b-718862bcb838`。157 video/audio receiver实际标准`jitterBufferTarget`属性存在且读回0；hint属性存在但标准成功后没有设置hint。host接受首次48Mbps P2P规则，但尚未有媒体内容，不能宣称真实拥塞验证通过。

首个新账号没有Window；初次helper直接寻找地址栏发生5秒超时，截图`157-initial-failure.png`显示正常“开始浏览/新建窗口”。随后真实鼠标点击“新建窗口”并通过真实地址栏导航fixture；这是准备脚本漏掉空workspace初始化，已只修临时helper，不属于原生故障。

导航后10秒没有有效plane，截图`157-content-failure.png`已目视检查：地址栏为`http://127.0.0.1:33604/fixture?client=157`，页面处于“正在恢复页面”，上方错误`output open SDK 4`。`server.stderr.log`持续记录：

```text
session 1 atlas open failed sdk=4 status_query=browser: output_not_open
session 1 reconciliation: output open SDK 4
```

最终快照`157-native-output-open-failure`保存在`run/metrics/client-metrics.jsonl`：planes为空，`comp.begins=0`、`readyObserved=0`、`adaptRequests=0`、`encodeSubmitted/Completed=0`、source/encoded尺寸全0。远端heartbeat的文档nonce为`qpyn5c0m6z`、1440×764/DPR2、mode animate但frames仅1；证明文档已运行，不证明渲染输出成功。首次日志未见FATAL、Check failed或GPU process exited，只有一次Browser启动；STUN10051日志存在，RTC实际已连接，不把它当作output.open失败的已证实原因。

按停止条件停止该组，没有启动89、收缩带宽、输入或再次启动Native。已即时报告root要求output.open owner定位，不猜测根因、不自行改架构。

## 结果与清理

- 真实成功：生产进程路径/版本启动、普通注册/创建Window/导航前置、RTC/DC连接；157 receiver标准target0读回。
- 真实失败：首个Window新路径output.open，SDK4/Browser output_not_open；无视频帧。
- 未覆盖：89全部、默认video实际画面、双Window ROI/输入、尾IDR/Wake、质量热切换/DPR不变、真实带宽反馈、QSV Reset/重init连续性、旧代退休收敛及任何新路径延迟。

自有context关闭，fixture `/shutdown`使supervisor/Control/Endpoint/Browser退出；`cleanup.json`于UTC16:07:56确认自有PID列表为空且33603/33604无listener，host默认browser_close也完成。没有按进程名清理，没有上传、打包或commit。GPU已释放，可由root安排后续构建/定位。全部证据保留`develop/tmp/comp-rend-runtime-20261103/run/`。

## 修复后第二次首帧组（当地00:12–00:13，run2）

Root确认output.open的fps契约不匹配已修复、无效Rend output_fps/SetFps链已删除；Browser/SDK增量、重新导出与三项外部smoke通过后再次GO。独立`run2`保留新账号/DB/Profile和完整hash，旧`run`未改。新Browser SHA256 `7A41644E8E29A9F350033C9F8F0728DD30924C2FF47E6BFE850FB635A71C3A69`，SDK `5F6B564F2FEC00A04782A1FABB9F4019E6E592730E1B2C1715FC951F24114C8E`；Endpoint与前组相同。

这次首导航10秒仍无当前plane；没有自行重试。截图`run2/157-first-frame-failure.png`已目视核验，上方显示“原页面实例已结束，导航执行结果未知”，页面回到本地起始页。Browser日志两次startup：PID27216/incarnation `fa9c4d0a71ec7b4aa3a34de0e1b59dec`自动换到PID17520/incarnation `60edc48e4e3b1f438d8ab67101026b47`；Endpoint PID2388。该替换由产品发生，本QA没有结束或重启Browser。日志没有FATAL/CHECK/GPU退出，根因仍需owner调查，不能仅凭无fatal认为生命周期正确。

最终metrics `157-second-attempt-failure`显示RTC peer创建2次、原页面导航unknown、planes空；`comp.begins=53`、`rejectStopped=53`、`readyObserved=0`、`adaptRequests=0`、encode0。此组与首次“完全未发Begin”区分。RTC关闭后落盘trace `run2/server-trace/server-2388-session-1.jsonl`确有53个render_begin、53个render_reject（generation1、slot0、value1起、status4），render_stop/stopped及render_generation_retired各1；没有slot_ready_observed。Stop/退役仅证明这组无成功帧请求的停止路径有记录，不代替成功帧GPU/编码租约退休验收。

首帧失败后立即向root报告，未继续输入、IDR/Wake、双窗、质量/带宽或89。`run2/cleanup.json`于UTC16:13:18确认自有supervisor4588/Control11228/Endpoint2388及两个Browser PID均不存在、33603/33604无listener，context/host默认browser均关闭，GPU释放。所有后续功能仍未覆盖。

## 单Isolated修复后第三次首帧组（当地00:27–00:28，run3）

Root确认控制回复携带独立render MessagePipe、opaque token一次claim修复及4target/probes/SDK导出smoke完成后第三次GO。新独立`run3`，Browser SHA256 `64F1797E0D5E00AF36B69178C8FAF61A25A797DD3EB0A82CECE0F884E56804BB`、SDK `197B36C8B5099D5F454B22A2164DF612DF5BF695319A1FE8CD6E3F532D0DE1D9`，Endpoint仍相同。进程路径与hash均先保存。

首次导航10秒内未取得首帧。Browser PID29456/incarnation `cbfda3519365a54da0a6c54f2392cf02`、Endpoint29208。Browser在00:28:05.596实际触发：

```text
FATAL gpu/command_buffer/service/scheduler_sequence.cc:111
DCHECK failed: !schedule_task_disallowed
```

栈从`SchedulerSequence::ScheduleTaskImpl`、`GpuTaskSchedulerHelper::ScheduleGpuTask`进入`SkiaOutputSurfaceImpl::FlushGpuTasksWithImpl(:1447)`、`ConfigureRemoteKitOutput(:1314)`、`Display::ConfigureRemoteKitOutput`、`RootCompositorFrameSinkImpl::ConfigureRemoteKitOutput`及DisplayPrivate Mojo dispatch。GPU随后exit_code=-2147483645，Browser自动重建GPU。Endpoint明确记录`render producer GPU failure; resources retained`。已即时向root提供具体行和栈，未自行更改调度或重试。

实际截图`run3/157-first-frame-failure.png`已目视检查：fixture URL正确、内容仍为“正在恢复页面”。metrics `157-third-attempt-gpu-failure`有connected RTC/DC、同一peer、receiver标准target0、planes为空；Endpoint周期stats尚未到达故障后样本，`endpoint`字段缺失，不能编造comp快照。独立trace实际有31个Begin/31个Reject、generation_retired1，无ready事件。fixture heartbeat1440×812/DPR2、frames1仅证明文档运行。没有验证任何成功GPU/编码输出。

保存现场后立即关闭自有context及服务，未启动89或其他步骤。临时返回摘要曾读取缺失endpoint.comp而报TypeError，样本此前已写入metrics、q.close已执行；此helper错误不替代原生GPU故障证据。`run3/cleanup.json`于UTC16:28:50确认supervisor15520/Control28560/Endpoint29208/Browser29456均退出，33603/33604无listener；host默认browser_close完成，GPU释放。前两组证据不变。

## 修复Viz调度后的真实功能组（当地00:32–00:36，run4）

Root确认Windows真OSR Configure/Begin/Finish使用官方ScopedAllowScheduleGpuTask、Viz最小增量和BeginFrame三组/导出hash通过后给GO。新`run4`隔离账号、DB、Profile、33603/33604；先录`artifact-hashes.json`。Viz SHA256 `A0F7ACB1B5D91E658211D015C494753738CB5B984D960403A3B84C5B08C49C57`，Browser/SDK与run3相同，Endpoint与前组相同。`loaded-modules.json`记录PID25180实际加载`C:/src/chromium/src/out/dev/remotekit_sdk.dll`及包内libvpl，Browser23980加载同out的Viz DLL。Browser incarnation `5e575b1b9a8b614ba7852d19773a637e`在两组间保持，只有一次launch。日志未见FATAL、Check failed、GPU退出、Native media错误或QSV负Reset状态。

|真实检查|157.0.8103.15 / DPR2|89.0.4389.90 / DPR1|
|---|---|---|
|实际运行|133.419秒|91.631秒|
|画面与独立Window|首帧默认video；动态primary与静态child并排，MSTP0、稳态canvas draw0|相同通过|
|输入与导航|两plane四角真实click、text、wheel均由远端事件证明；child实际地址栏导航后nonce变化，继续正确呈现|相同，且导航后child再次通过四角/text/wheel|
|布局|1440→1100→390→1440；390单一当前plane；显式focused与恢复split均ready|相同通过|
|媒体身份|48个保存样本，同一peer/RTC `757eebb2-ba77-4c9e-afb0-d1d4999bb6e3`；primary video2/stream3，child video4/stream5；共享原track|21个保存样本，同一peer/RTC `39926ea3-8f50-4b58-bfe0-9117a060ecc9`；primary video2/stream3，child video4/stream5；共享原track|
|质量|maintain-resolution→balanced→maintain-framerate实际热切换，远端DPR2、718×812 DIP不变|相同映射，远端DPR1、718×812 DIP不变|
|Idle / Wake|尾IDR提交/完成0→1；稳定段保持1，Begin停在936，targetFps0、occupied0；点击Animate后Wake+1、ready928→1018|该段累计尾IDR提交/完成3→4，稳定段无新增；Begin停止；点击Animate后Wake+1及新ready|
|接收端|video/audio标准jitterBufferTarget存在、读回0；hint存在未设置|标准属性不存在；video/audio实际兼容playoutDelayHint读回0|

已逐图目视核对两版split与390，以及157首帧：primary/child标签、彩格、角点和文本对应正确。390末端的“打开键盘”悬浮控件覆盖部分BR，属于真实已聚焦编辑器控件；该截图不作为390四角输入验证。实际四角输入证据在独立可见主窗与split子窗，89导航后再验；没有实体移动软键盘、整个Viewer真实hidden或模拟额外手势覆盖。Chrome89启动时先关闭上组遗留child，避免把两客户端的fixture/输入混成一个组。

临时QA helper首次尝试直接点击MUI radio，因原生input opacity0被helper拒绝，超时截图`157-layout-quality-failure.png`保留。设置实际正常可见，换真实可见label鼠标点击完成三档；未使用app私有onclick或直接写状态，未修改生产代码。此helper超时不视为产品回归。

### WebRTC限速、QSV与退休

仅157以首次socket创建前装好的P2P规则完成48→4→48Mbps。低带宽段GCC target由33.6Mbps降至最低0.791Mbps，恢复10秒后3.512Mbps，未回到原33–38.6Mbps；发送目标fps保持55–57附近。真实inbound decoded frames基线尾4969→低带宽尾5296→恢复尾5587，连接身份不变。低带宽AdaptFrame drop累计9→12，`adaptSizeChanges=7`未增长；本段证明网络反馈和少量source drop，不能宣称实际带宽触发分辨率变化。由于没有跑额外恢复尾段，恢复程度只按观测记录。窗口布局变化另有实际编码尺寸切换，不能挪作网络降级证据。

两组实际QSV Reset共588条：396条status0、192条正status5，无负状态。`newSequence=ON`、fps 50/53/55/58等真实变化后继续解码；部分受限码率请求被硬件调整，例如请求1.5Mbps实际4.908Mbps，不能把请求码率当实际应用。没有宣称GCC可强制硬件准确达到低码率，也未验证NVENC硬件。

157最终`begins=6909`、`readyObserved=6851`、`consumedCompleted=6850`、`encodeCompleted=6385`，Stop/Stopped及已完成退休13/13/13。89结束累计11590/11465/11464/10971、Stop/Stopped及已完成退休29/29/29；两阶段最终`retiredGenerations=0`、`retiredOccupied=0`、`unknownGpuRetentions=0`。活跃代`occupied`可非零，不是退休泄漏。独立trace保存了Begin/Reject/真实ready fence观察/consumed fence提交/复用/Stop/Stopped/Wake；容量65536的环形trace会覆写前段，以周期累计计数区分完整总数。157 RTC关闭后快照另存`157-server-trace.jsonl`，89结束后的保留段在`server-trace/server-25180-session-1.jsonl`。这是当前路径GPU Fence证据，不填不存在的render时间戳，不宣称端到端延迟或历史性能矩阵通过。

`run4/metrics/client-metrics.jsonl`保存上述阶段、原始网络三段样本及最终统计，`fixture-events.jsonl`保存实际鼠标/文字/滚动与heartbeat。自有contexts和host默认浏览器已关闭；supervisor28108/Control27080/Endpoint25180/Browser23980与33603/33604已退出，`cleanup.json` UTC16:36:27验证为空。GPU已释放，无打包上传或commit。
