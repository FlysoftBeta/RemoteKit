# 单plane直接发布实验实现

2026-11-01。主Agent选定GPU-copy报告候选1，源码实现、独立审阅及browser/browser_demo/SDK统一增量构建完成；没有运行GPU实验或改默认策略。Feature `RemoteKitSinglePlaneDirect` 默认关闭。同binary通过`--browser-enable-features=RemoteKitSinglePlaneDirect`启用；正式实验工具增加`-SinglePlaneDirect`，与Client的`-PresentationMode single-plane-direct`是两个不同开关。

## 行为和边界

开启Feature后，`SetViews`只在唯一view且capture enabled、capturer存在时选择direct；多个view继续stage路径。保守地把“有其他未启用view”的情况也留在stage路径。SDK、shared mapping和ready/consumed Fence ABI保持不变，没有新增逐帧Mojo。

direct正常新像素：官方capture source→可用shared slot→Endpoint现有private pool→VPP。省去browser的stage→shared全atlas copy，同时不再将source写stage。每次copy后真实ready Signal/Flush同时保护共享帧和source读取；原source lease轮询观察GPU完成后才Done。

没有空闲槽或未到发布节拍时，只保留一个尚未Acquire mutex、尚未被bridge GPU读取的source。新capture替换它时立即Done旧pending；已经提交GPU读取的source在独立leases列表，不能被这种替换释放。`Poll`负责在节拍到达/consumed推进后提交pending，所以静态最终帧不依赖下一次callback。source mutex获取失败沿用10ms RequestRefresh及2秒失败规则。

最新发布的shared slot作为browser自己的只读pixel base；即使consumed已过也不选它作为写目标。metadata-only更新（焦点、IME text input、stale等）从base复制到另一个consumed可用slot，再发布新metadata；复制和后来可能的旧base复用都在同一browser immediate context保序。Endpoint持有哪个旧slot仍由consumed fence决定，base保护不代替该判断。

每个slot在当前稳定几何下第一次用于source copy时先clear白色，初始化整个atlas及padding；随后只覆盖source矩形。metadata base clone覆盖整个目标，标记目标已初始化，不额外clear。稳态不会逐帧clear。

## 变更与恢复

沿用`SetViews/ClearStage`的几何、文档、instance、宿主identity及view增删边界。每次ClearStage：丢弃未提交pending、取消base、使三个slot的初始化标记失效、将所有view设stale并请求capture refresh。单↔多direct选择变化也触发此边界。已提交source leases继续等待真实GPU完成。

direct在等待新source期间可发布初始化白色slot及**当前几何的stale metadata**；不复制旧stage、不沿用旧像素base。原last frame也先通过`MarkLastStale`发布stale状态，因此即使三个slot均忙，新像素到达前旧坐标也会失效。返回多plane时重新clear stage并refresh全部view，不把direct期间未维护的stage当有效底图。

新输出generation是新State，pending/base/初始化标记从空开始；Stop、Lost、consumer退出均立即Done未提交pending。submitted source继续原有keepalive/drain机制。正常capture提交后若Signal失败，lease保留；ReleaseSync或CPU提交返回均不冒充GPU完成。

## 文件与观测

- `browser/gpu_atlas.cc`：Feature、pending、只读base、直接发布、共用source mutex获取函数；未改header或外部接口。
- `tools/prepare-streaming-case.ps1`：`-SinglePlaneDirect`，写入config和browser feature透传。
- 本文是独立实施报告；前置操作清点见`gpu-copy-next.md`。

`output.status`和browser trace摘要增加：`single_plane_direct_enabled/active`、`source_stage_copies`、`stage_slot_copies`、`source_slot_copies`、`direct_metadata_copies`、`direct_slot_clears`、`direct_pending_replaced`；status另有`pending_direct_capture`。已有dropped包含未提交pending替换/作废，captured表示实际source copy提交。诊断trace另有`direct_source_copy`，serial沿用原capture callback序号，便于匹配source_read_done；不增加IPC。

同binary Feature off时计数应落在source_stage/stage_slot，Feature on且稳定单plane时source_stage/stage_slot为零，source_slot增长。direct_metadata_copies只在无新capture而dirty的发布增长；direct_slot_clears每稳定几何至多三个。output.frame_id也包括初始白色stale及metadata帧，因此不能把所有publication都解释为source新画面。

## 已执行检查

源码逐分支审阅：未提交/已提交lease、Signal失败、mutex失败、base排除、ClearStage、Stop/Lost/consumer exit、metadata-only、单↔多。独立审阅未发现具体问题。`git diff --check`通过；PowerShell Parser解析实验脚本通过。

统一使用正式`tools/chromium.py stage`及一次`build --target remotekit_browser --target remotekit_browser_demo --target remotekit_sdk`，out/dev增量15.54秒、4个实际步骤成功；SDK目标已最新，两份browser的gpu_atlas均重新编译并链接。随后`tools/export-sdk.py`成功导出`sdk/dist/dev`。二进制指纹记录`develop/tmp/single-plane-direct-build/binaries.json`：browser SHA256 `309a535cb8e8520953d5f213a9201a4073fa78eff017520d463628edb2e7deab`，browser_demo `844bcc1bc64c9ce7eb45b247e1b9a55c461402ac4936cad5a19f738054a78ec1`，SDK `91433dd933a89557108b590093bac751e6d583bc66775d569fbfe4d074b19922`。未修改其他Chromium tracked文件，未启动实播，运行结果由后续A/B填写。

## 主Agent后续统一验证

1. 统一构建与SDK导出已完成；使用上述指纹的同binary做Feature off/on，不在实验组之间改变源码或构建产物。
2. 首帧静态、change-stop尾帧、slot全忙后最终最新像素、反复连接refresh；记录source_slot和真实ready完成，确认没有需要下一次源damage才能发布的停帧。
3. 无新像素时焦点/IME caret/selection/stale更新；旧像素保持，layout epoch/输入授权与新metadata一致。
4. 文档/instance变化及desktop↔tablet/mixed-DPR，单→多→单；等待新source时白色stale帧禁止输入，padding无旧图残留，全部plane重新fresh后恢复坐标。
5. 真实source GPU故障、consumer退出、output close及尺寸重建；源码lease的drain语义与原路径一致，验证没有source池永久占用或device重建失败。
6. profile-off、Chrome89默认flag、marker开启、同分辨率、RTT10ms/24–48Mbps、d1/TU1/VBR，先四1080精准render16做off/on交错组，再上50/60Hz负载；同组报告GPU占用、capture/atlas/encode/decode/canvas FPS和marker p95。删copy本身不充当性能验收。

独立审阅优先看`PublishIfFree`在base clone/新source/白色stale三种情况下的槽和source所有权，以及`ClearStage`到下一fresh之间的输入状态。没有把Endpoint直接消费slot或NV12缓存复用并入本轮。
