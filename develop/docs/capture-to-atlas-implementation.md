# Capture-to-atlas 候选实施

2026-11-01。执行主 Agent 的 capture-to-atlas-plan 决策。候选默认关闭；本阶段只做源码、CPU 检查和增量编译，不启动 GPU 功能或性能实验。

## 输出行为与接口

`RemoteKitCaptureToAtlas` 首轮限定 Windows GL/Ganesh、单 WebView、独立 offscreen root、DPR1。启用它会同时采用现有 root eligibility 检查。配置前不符合条件时，snapshot 明确记录 fallback 及原因，沿用 Fence capture。

首个普通捕获只用于选择能够打开捕获纹理的 D3D adapter。Browser 随即停止普通捕获，一次发送本代三个 DXGI GMB handle、atlas size、真实 visible rect 和 generation；Viz 创建 owning ClientSharedImage。`ConfigureCaptureToAtlas` 为一次配置接口，不能在 Viz 断线后重放旧池。现有 browser↔endpoint mapping、三槽和双 Fence 保留，无逐帧新增通信。

专用池精确持有三个目的资源。VideoFrame coded size 为实际 atlas，visible rect 为布局中的 WebView 区域，natural size 为 viewport。resolution constraints 保持 viewport，不改成 atlas；现有 BlitRequest kLetterbox 清 padding。无空槽返回背压，不分配第四个。普通池语义不变，专用池禁用 marked/resurrection，refresh 执行真实 CopyOutput。

Browser 从返回 GMB 的 DXGI token 识别本代 slot，验证 coded/visible/natural/content，再只排 ready Signal 和 Flush。候选不执行 capture→stage、capture→slot 或 slot 初始化 copy。已发布 VideoFrame lease 等 Endpoint consumed 的真实 GPU 完成再 Done；未发布的已完成结果可归还。

## 生命周期与成功完成

专用 generation state 强持 Context/SII 与三个 owning CSI。FrameCapture 强持 VideoFrame，Frame 的 release callback 强持 generation 并 post 回 reserve sequence。首轮现有 capturer/delivery/Done 的最终 Frame 释放都在该 sequence，代码 CHECK 该条件；posted return 保证 Frame 析构及 CSI 成员释放先结束，再归还 slot/Context。以后若引入异线程最终 Frame owner，必须扩展完整析构同步，不能移除该 CHECK。

Stop 不作为 GPU drain。旧请求和 Endpoint 真正读 lease 独立保活资源；任何 binding、target、尺寸、DPR 或模式转换都要求新 output generation 的新三个纹理，不把旧句柄当空闲池重配。Viz 的正常 target/geometry 失效用有原因的 disconnect 标记资源重建；GPU/context/import/CopyOutput 失败保持失败语义。

GPU finished callback 与 flush/submit 成功分开记录。ReadbackContextTexture 只有在两者都成功、impl 仍有效、output surface 未进入析构、context 未 lost/abandoned 时发送非空结果。SkiaOutputSurface 析构入口先设置销毁标记，覆盖 GrGLFinishCallbacks 析构/abandon 调用 plain finished 的路径；Graphite CallbackResult 也不再被忽略，但候选仍拒绝 Graphite。ReadbackDone 的计数对应保留，不改正常 flush/submit/完成轮询节拍。

异常 consumer 断线与显式 Done 已分开：self-owned InFlightFrameDelivery 在未 Done 就析构时，先通过强引用 closure 同步 seal 专用 generation，再通知 capturer 停止，最后才释放 VideoFrame。即使 capturer weak 已失效，pool 也不能再 reserve；已在途的不同 slot 保留原完成路径。显式 Done 先清除异常 closure，普通捕获不传该 closure，保留原行为。原先无法证明两个 Mojo 管道的 Stop/Done 处理顺序，因此没有依赖该顺序。CPU 回归实际创建 self-owned Mojo receiver，再关闭 frame callback Remote；另一路通过 Mojo 显式发送 Done 后断开，验证正常归还与异常封池分开。

## 正常资源重建

共享 enum 追加 `kReconfigureNeeded=5`，mapping 的版本、大小和字段布局不变。旧 Endpoint 不支持这一新状态；Browser/SDK/Endpoint 必须成套更新。正常导航或 capture binding 变化发布该 typed 状态，停止本代写入，并异步保留旧 consumed lease，不重启 WebContents/RTC。

Endpoint AtlasPool 返回 typed reconfigure。MediaLoop 在该边沿释放本地 latest、取消尾帧等待并清输入就绪，通过已有串行 RPC 先 output.close、再 OpenOutput，重置统计/尾帧时序并请求新帧 IDR。OpenOutput 的媒体线程路径保留原可见性，不读取控制线程正在修改的 desired map。新 pool 退休旧 State，旧 SDK/编码 worker 的实际 lease 继续控制旧 consumed，不强制释放。

冻结 producer 后读取最后稳定 publication，验证旧 generation 与不回退的合法 fence，作为 terminal watermark。普通 Pause/Close、Pool.Open 的旧代退休以及 typed 重建都走同一机制。只有 CPU 已观察 producer ready 到达 terminal，水位才可推进；最老真实 SDK/worker 读者仍限制 consumed 前缀。之后在同 GPU context 排 consumed 与本地 done，旧 State 等两者实际完成后释放。未观察到的尾帧不伪造 lease，不使用 cookie0 哨兵，也不排 future-ready GPU Wait；pending terminal 保留并在退休轮询或 Close 重试。

ClosePeer 先停止 media/SDK/worker，再确认 output.close 冻结 producer，之后 pool.Close；RPC 失败明确报告 unfinished 并保留资源。PauseOutput 的关闭失败也不能被当作已冻结。实际 private copy 次数与 done 信号序号已分开，退休信号不会增加 copy 计数。

整个 Browser 已退出时，mapping 可能仍停留 Running。Close(error, producer_exited) 将退出证据锁存在旧 State，Open/Reap 后续沿用；只有有效 process HANDLE 的 WaitForSingleObject==WAIT_OBJECT_0 可以授权接受这一稳定最后水位。RPC 失败、WAIT_FAILED、超时及缺失句柄不能生成证据；generation、单调 fence、CPU ready、真实读者和 GPU done 条件照旧。CPU 校验测试覆盖有/无退出证据、跨代、回退及非法值拒绝。

Session 保持单 producer 身份：Stop 先置 pending，TerminateJobObject 后等待同一 process。停止超时或 WAIT_FAILED 保留 process/job 并返回 false，Start 拒绝创建新 producer；Alive/control 快路径不能越过 pending。后续只重试同一句柄，确认退出后才记录 proof、清身份和重新启动，防止新进程的退出冒充旧代 proof。析构捕获停止异常，最终 OS handle 清理不生成退出证据。这些 Stop/Start 分支已源码审阅及 Debug/Release 编译；未做真实进程停止超时注入。

## 检查与构建

- 专用 pool 有五个 CPU 机制测试：三槽耗尽与异步归还、pool 销毁后 generation/Context 保活、无效几何/重复 token/部分 import 失败清理、异常 delivery 断开封池、显式 Done 正常归还。
- `tools/patchset.py` 增加有序依赖验证：只复制补丁触及文件和 .gitattributes，隔离逆序剥离后顺序重放，不对活动树 reset。依赖 patch 的 base/前缀/full 状态、roundtrip、冲突保留测试包含在 9 项工具测试中，已通过。
- 新增有序 `0007-capture-to-atlas.patch`；同时修改既有补丁文件时，内容是六项已应用基线上的增量。
- 使用原 out/dev 的 H264/component args、16 个逻辑 CPU。首次整套 viz_unittests 目标发现未有可复用产物，已移除；pool CPU 测试改用 SingleThreadTaskExecutor 和独立 gtest main，避免引入整套 Viz/Perfetto 测试依赖。

## 最终验证结果

- out/dev 的 remotekit_browser、remotekit_sdk、独立 capture_to_atlas_pool_unittests 增量编译链接通过；最终含 trace 修正的 browser 再构建通过。原 H264/component args 保留，没有构建 out/rel。
- 专用 pool 5/5 CPU 测试通过，实际运行 2ms；Endpoint Debug 编译与 7/7 CTest 通过，Endpoint Release service 增量编译通过。
- terminal CPU 测试覆盖 kStopped（普通 Pause/Close 的冻结结果）与 kReconfigureNeeded（typed 重建）的校验、跨 generation/回退/UINT64_MAX 拒绝，以及最后帧未借、producer ready 未到、旧真实 lease 阻止 terminal、释放后最终水位和新代独立。seqlock 不稳定时清空输出再 idle，避免把 torn payload 用作终点。普通 Pause/Close 和 typed 导航的完整 RPC/GPU 恢复流程仍须下一阶段实跑；没有把这些 CPU helper 测试写成已完成集成验证。
- patchset 工具 9/9 测试通过。最终 7 项在独立 replay-diagnostic 目录完整正向重放、与活动源等价、全逆向恢复基线通过，共 39 个源文件；活动 Chromium 没有 reset，status 为全 applied。
- 新 pool 独立 GN header dependency check 通过。browser/SDK 的额外 GN check 分别被既有私有头 RenderWidgetHostViewBase 和 platform_key_map_win 可见性规则阻止；本批实际编译链接成功，按主 Agent 决定记录该缺口，不扩大上游可见性。
- 两处 content 单测 capturer mock 已补新纯虚接口的明确拒绝 override；没有构建完整 content_unittests/viz_unittests。

最终 patch：0007-capture-to-atlas.patch，SHA-256 `d2c0521b9b7f99baeb6c364f8d03269f57725cc77fd74ae8a13db93d481d527d`，22 文件，83261 bytes。

证据位于 develop/tmp/capture-to-atlas：build-final-trace.log、build-verified.log、build-disconnect2.log、build-disconnect-mojo2.log、pool-tests.log、patchset-tests-diagnostic.log、patch-replay-diagnostic.log、patch-status-diagnostic.log、artifacts.json。Endpoint CTest 原始记录在 build/endpoint/Testing/Temporary/LastTest.log。

## 运行交接

以下均为本机实际编译产物，runtime 需使用这些 source component DLL，不能只换 browser.exe。启用候选用 --enable-features=RemoteKitCaptureToAtlas；默认仍关闭。


| 产物 | 实际路径 | SHA-256 |
|---|---|---|
| remotekit_browser.exe | `C:/src/chromium/src/out/dev/remotekit_browser.exe` | `039c024e4c255f5bc53345b5fc836b46bd8452c67073422f93679cbe41702c5c` |
| remotekit_sdk.dll | `C:/src/chromium/src/out/dev/remotekit_sdk.dll` | `91433dd933a89557108b590093bac751e6d583bc66775d569fbfe4d074b19922` |
| components_viz_service.dll | `C:/src/chromium/src/out/dev/components_viz_service.dll` | `6630c67bc4494030edeee9b21557222e5e854152164eb365042d8561e26441aa` |
| components_viz_host.dll | `C:/src/chromium/src/out/dev/components_viz_host.dll` | `750a3afd493211a1a1fe24a2eecbbfdb1f276be54843f39f80b4d5bd93d33afb` |
| viz_common.dll | `C:/src/chromium/src/out/dev/viz_common.dll` | `e0e041af6f692f786988b23e28b151d98105b2c97003f34397d0375ec6066a37` |
| media.dll | `C:/src/chromium/src/out/dev/media.dll` | `b1b18704cb12c2f65abb6e7363eba648d8bf5c10037ca39b6e4bfca8ec97a885` |
| content.dll | `C:/src/chromium/src/out/dev/content.dll` | `664626557c5dad93a1df4d38613ad8f5f3fbef9359f9404876179f702f8eacc7` |
| endpoint_release | `C:/Users/Flysoft/Desktop/remotekit2/build/endpoint-package/endpoint/endpoint_service.exe` | `7a708e4f1affc67b5c243845c9345cf4525b1a29204619e43b13c0b84a932e38` |

本实施任务没有自行启动 GPU。独立首轮硬件门已通过直接输出、CRC4001/4002、输入和零 source copy，但第三代导航失败；详见 capture-to-atlas-runtime.md。诊断复现后仍需完成恢复、背压、普通 Pause/Close、resize、DPR2/multiview 和故障门，再进入原条件 fixed52 两租户性能对照。FPS 与 marker p95 收益没有预记。

## 导航失败诊断版 D1

D1 只增加失败日志，保持合并校验的停代语义，不放过 empty，不改变正常 flush/submit/轮询节拍，也没有逐帧成功日志。Browser/SDK/最小 pool 测试目标增量编译通过；pool 5/5 CPU、viz_common GN check 通过。实际版本以本页的两个 Viz DLL hash 和 artifacts.json 为准，不能只替换 browser.exe。构建证据 build-diagnostic2.log；pool-tests-diagnostic.log。

capturer 的 result_rejected 记录 empty、CopyOutputResult error 名称/代码、实际/期望 format 与 destination、result rect/size 与 expected content/result rect、source rect、coded/visible/natural、pool generation、captured/current target version、requested/resolved FrameSinkId、source token、capture编号和请求年龄。Skia失败日志使用同一 request_id，细分源访问、目的 ProduceSkia/BeginWrite、selection/bounds、semaphore wait、flush/submit，完成门析构诊断还列出 impl 是否存在、destroying、context lost、Ganesh abandoned、GPU finished 与 submission 的独立结果。

专用 CSI label 的 CopyOutputRequest 在未完成就析构、或 SendError 时记录 request_id/source 与原请求几何；因此未进入 Skia 的源请求取消不再和 GPU 完成失败混成同一条日志。源码已确认普通 mappable ARGB 捕获对 empty 走 CaptureFailed/drop，而当前专用池在更早校验中停止本代；这不是 DXGI 失效的现成证据。error=embedding_token_changed 明确来自 embedding token 变化取消；timeout 来自请求超时；unknown/unsatisfied destructor 仍须结合 Skia stage 与完成门判断。旧 functional-v1 日志没有这些字段，实际 gen3 原因仍待 D1 复现后由主 Agent 决定修法。

patchset 的 manifest、snapshot 文件名和 record 三个入口都新增拒绝 PureWindowsPath.root，包含 drive 为空但以 / 或反斜杠开头的 rooted-no-drive 形式。新增回归验证这些路径被拒绝，外部 canary 不变，同时合法相对补丁路径继续通过；工具测试 9/9。

