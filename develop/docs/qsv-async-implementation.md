# QSV 同 session 异步 VPP 实施

候选源码接入、独立审阅、正式增量构建和 CPU CTest 已完成。随后独占 GPU 的 Chrome89 验证通过深度1/2/4、输入、重连、几何切换与尾帧；性能对照没有最终呈现收益，external 保持默认。运行证据及尚未覆盖的 Composite、NULL flush 细分时序见 [运行报告](qsv-async-runtime.md)。下文保留实现规则与审阅依据。

## 接口与工作流

`EncoderSettings::qsv_async_vpp` 默认 false。`HardwareEncoder::InputFormat()` 默认 NV12；QSV async 返回 BGRA。NVENC与QSV external继续使用外部 Nv12Converter 和真实 ready fence。显式 async 不自动降级 NVENC。

Worker async 跳过 converter 创建与 Convert，用原来的 async_depth token 管理 inflight 容量，仍然只保存一个可替换 pending。Worker 对源 BGRA 同时持有 COM 引用和 atlas-pool lease；QSV accepted 后只有匹配完成或 backend Close 才能归还。尾 IDR 的 TailRefreshLease 完成确认、队列计数和现有 trace 保留。

## Backend 生命周期

Task 由 unique_ptr 固定地址持有，包含源 Memory/surface、持久 EncodeCtrl、VPP 同步点、NV12 池对象指针、阶段和接受时间。VPP 输出 surface 本体是独立 unique_ptr 池对象，Encode 收到同一个 surface 地址，期间不改 surface.Info。NV12 池按 VPP output 与 Encode QueryIOSurf suggested 之和减 AsyncDepth，并满足各 minimum 和 worker 深度分配。

正常 Submit 调用 VPP 后立即提交 Encode，没有中间 VPP Sync。VPP busy 尚未接受输入，可以返回普通 busy；VPP 接受后即使 Encode busy，仍对 Worker 返回 accepted，Poll 重试 Encode 阶段，不重复 VPP。编码按输入 cookie 顺序提交，busy 时继续 Poll 已有较早 Encode sync，避免阻塞其完成。busy 的 packet 缓冲保留，避免反复分配大块 bitstream 内存。

Packet 与 Task 分离，避免把一次 Encode 调用的输出错误地假定为该次输入。Encode 一旦接受输入（包括 MORE_DATA 和返回 sync 的调用），该输入一直标记 held，直到它自己的 timestamp 最终完成；不因该次调用产出 packet 就认为输入已有对应输出。最终 Encode Sync 成功后，必须用 bitstream timestamp 找到真实 Task，并确认源 BGRA 与 NV12 surface Locked 均为 0，才产出 AccessUnit、归还 NV12 slot、销毁 Task。未知 cookie、空/越界 bitstream、仍 Locked、同步错误或超过五秒的任务均显式报错；已提交资源保留到组件/session Close。

## 几何与颜色

VPP 首输入按真实 texture desc lazy-init；BGRA 的物理宽高必须 16 对齐，单 texture、单 mip、单 sample。不把未对齐纹理虚报成对齐尺寸。有效输入是整个实际 atlas；页面 plane 保持外层元数据给出的原矩形。

源宽高变化时，在所有旧 jobs/packets 完成后验证 VPP 空 drain，再 Close/Init VPP 并重建 NV12 池。即使输出编码尺寸未变化，也会重配源参数。协商编码尺寸变化仍走 Worker 既有 Configure/Stop 整体重建。

输入 RGB full、输出 BT.709 limited；VPP Query/Init/GetVideoParam 警告和格式/颜色修改均明确失败，继续保留 Encode 的 BT.709 limited VUI 校验。allocator 对 async 的 RGB4/VPP output/internal encoder 请求使用对应真实格式和 bind；external 保留旧 NV12 array/decoder 分配。

等比 fit 与 external converter 使用同一计算（偶数四舍五入、左上对齐）。full-fit 不加 Composite。需要留黑边时使用单输入 mfxExtVPPComposite、DstW/H=fit、完整输出 surface.Info、黑色 YUV16/128/128；Query/Init 不支持、修改配置或跳过滤镜会失败，不拉伸填满、不在 Locked 时改 Crop。**Composite 分支尚未硬件验证**，RGB4+composition 的 legacy 能力可能拒绝该配置；需要单独颜色/几何测试才可声明支持。

## MORE_DATA、异常和关闭

VPP MORE_DATA 保存源与输出 slot，暂停接收后续输入，由 Poll 以 NULL 输入显式 drain 一次输出；仍无输出或 MORE_SURFACE/非一对一状态会明确失败，再以 Close 结束资源使用。候选不实现时域/多输出滤镜。

Encode MORE_DATA 保存 Task，后续输出仍按 timestamp 匹配；当无可同步 packet 时显式 NULL-input flush，避免 d1 永远等待第二输入。flush 若在 outstanding input 存在时返回无输出，就失败并保留资源到 Close。

Drain 先推进现有 jobs/packets，再要求 VPP 和 Encode NULL-input 返回空队列 MORE_DATA；意外输出或超时失败，源和 bitstream 所有权仍留到 Close。Worker 即使 drain 最后失败，也交付此前实际同步完成的 AccessUnit；Submit error 先销毁 backend，再释放当前源 lease。析构先关闭 Encode、VPP、session，之后销毁 packet、Task、NV12 池与 allocator 内存。

普通码率调整仍只执行 Encode Reset(StartNewSequence=OFF)，要求 jobs/packets 已清空，保留名义 fps 和已初始化 VPP，不因 BWE 报告的 observed fps 改时间基。

## 本轮文件与后续验证

文件：`endpoint/src/media/hardware_encoder.hpp`、`encoder_worker.hpp`、`encoder_worker.cpp`、`qsv_encoder.cpp`。开关、browser atlas 对齐和实际 atlas/stats 由另一实施任务接入；本轮没有修改 service、browser、tools 或 CMake，没有 commit/push。

后续必须覆盖：统一编译；单 plane/full-fit 静态与动态颜色/白边；正常码率 Reset/尾 IDR；source desc 改变但 encoded 不变；level 下采样；Composite 黑边正确性或明确拒绝；d1 与较大深度 cookie；busy/MORE_DATA/错误/关闭 lease。之后才进入同 binary、同 16 对齐尺寸的 external/async 1/4 租户 Chrome89 RTT10ms、24–48Mbps 对照。正式 marker 和现有分辨率不变，整体目标仍未达成。
## 审阅修正与有界时序检查

首轮独立审阅发现：若 j1 返回 MORE_DATA，j2 的调用返回 sync 但实际输出 cookie1，把 j2 标为“有输出”会导致最后一个输入失去 flush 触发。本轮最小修复删除该阶段，所有被 Encode 接受的输入一律 held，packet 仅代表尚待最终同步的输出工作。packet.submit_cookie 只用于 trace。

d2：j1 MORE_DATA→held；j2 返回 P2(output1)→held；Sync P2 只删除 j1；队列无 packet、j2 仍 held→NULL flush(output2)→Sync 后删除 j2。

d4：j1 MORE_DATA；j2/P2→out1、j3/P3→out2、j4/P4→out3。依次 Sync P2/P3/P4 只删除 j1/j2/j3；包空后 j4 仍 held→flush out4。所有时间戳必须指向已接受且尚未完成的输入，未知或重复输出均报错。代码已无 encode_submitted 判断。

这是静态状态演算，不替代硬件覆盖。后续硬件需包含 depth2/depth4 和动态→静态/drain；如果真实 runtime 未自然出现 MORE_DATA/错位输出，应明确记录该分支尚未运行触发，不把普通 d1 成功当作已覆盖。
## mixed busy 修正与 CPU 构建

独立补查发现：只有旧 held 输入，但较新 job 的 VPP/Encode 正在 busy 时，旧规则会在较新输入尚待提交期间调用 Encode(NULL)。本轮最小修正为：packet 空、存在 held、且不存在任何 encode_pending/vpp_delayed 时才调用 NULL flush；混合情况优先继续新输入与已有输出工作。

纯 held/d1 的原有 flush 逻辑保留。官方 API 把 NULL 输入定义为 end-of-sequence；当前 legacy1.35 在这种 midstream drain 后能否继续接受非 NULL 输入没有本机证据。已有三组360帧 probe 的 Encode status 全为0、flushCalls为0，没有覆盖该分支。该兼容性要由后续独立 probe 验证，不因静态演算和 CPU 测试通过就声明已支持。

2026-11-01 15:27:43（Asia/Singapore）完成主 Agent 分配的 Endpoint CPU 短窗口：`tools/build-endpoint.cmd verify-media` 正式增量5步通过，约6.4秒；CPU CTest `endpoint_core`、`endpoint_media_feedback`、`endpoint_encoder_stats` 3/3通过。没有运行 encoder smoke 或任何 GPU 任务。仅有既有 libvpl C4201 与 RateControl 枚举转换 C4244 警告。

日志：`develop/tmp/qsv-mixed-busy-build.log`。

- `build/endpoint-package/endpoint/endpoint_service.exe` SHA256：`B7FB545A05359417DA74A390ACD260D8C565004D3B1D6392D13199FF74C50208`
- `endpoint/src/media/qsv_encoder.cpp` SHA256：`3B6DF183B855788D3605E61956FF18861E1B42116D3793253393F629F7EB8365`
