# Endpoint / Native / SDK 源码审计（2026-11-03）

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

基线：`4de343c37492d0c5d6435bf6dab1a0a62b5554dc`。本报告为静态源码审计，未修改生产源码、未构建、未运行 GPU/性能组，不影响该修复版上传。未读取旧 RemoteKit 项目。阅读 AGENTS、current-state、architecture、gpu-output、streaming-protocol、sdk、endpoint 及相关测试和协议。Browser 内部行为只追到 SDK/控制协议必要边界，其余由 Browser 审计负责。

结论：现有资源租约、代次屏障和 RTC/产品可见性分离有明确实现，并非只有设计。确认四项需要修复的实现缺陷：输入 BUSY 重试不可达、SDK 全局锁阻塞独立 Session、快照导出仍阻塞唯一 dispatcher、关键 DataChannel 发送失败后没有重试。此外，NVENC 常态完成等待缺少期限是确认的错误恢复缺口。跨机 Control、常规操作直达 Endpoint、多 Profile 是新目标与现实现之间的架构差距，不能混算为现有代码 bug。

## 确认缺陷

### EN-01 / P1：Browser BUSY 响应在到达重试循环之前被抛出

- 位置：`endpoint/src/service.cpp:326–337`（Rpc），`1153–1182`（HandleData）。
- 证据：Rpc 第 336 行对每个 `ok:false` 应用回复抛异常。HandleData 第 1163 行调用 Rpc，随后第 1168 行的 `!reply.ok && reply.code==6` 循环因此永远无法接到 BUSY。异常直接进入第 1182 行 catch，回复失败。
- 真实触发条件：Browser 正在解析 touch target、等待 touch ACK 或排空 touch owner，返回“操作尚未接纳，可用同 sequence 重试”。Browser `webview.cc:758/1173/1224` 有对应 busy 返回；`harness.cc:1225` 输出 code，`harness.cc:51` 将 busy 固定为协议 6。这里无需推测硬件故障。
- 影响：临时忙变为永久丢失本次输入；若是 up/cancel 等终结事件，手势的完整性也受影响。不能把已通过的正常触控实测当作这条 busy 分支通过证据。`inputBusyRetries` 在这条路径上不会增加。
- 建议：将传输成功/失败与应用状态分开。新增显式允许应用失败的 typed request（仅 input 使用也可），保留完整 `{ok,code,error}`；传输失败仍作连接失效处理。先接纳的异步失败不得重放；只有 pre-admission BUSY 保留相同 Browser sequence 作有界重试。
- 必要验证：通过生产 Rpc/HandleData 的 fake transport 返回 busy、busy、success，断言三次 Browser sequence 相同且只消费一次；覆盖超时、epoch/peer 改变和 accepted 后异步失败不重试。当前 core/input_sequence 测试未覆盖 Rpc 层。

### EN-02 / P1：SDK 持有全局 registry 锁等待任一 Browser，跨 Tenant 输入被串行阻塞

- 位置：`browser/sdk/remotekit_sdk.cc:259–310`，尤其第 269 行；同一 `SDKState::lock` 还用于 connect/close、初始化/关闭和 `RemoteKitSdkBeginRtc/EndRtc`。
- 证据：control_request 在整个写请求、读回复以及 1ms sleep 轮询过程中持有 `State().lock`。该锁覆盖所有 channel，而非每 channel 一把。Endpoint 每 Session 自己的 rpc_mutex 无法消除 SDK 内此串行域。Endpoint Rpc 的单次等待上限为 10 秒。
- 触发：Tenant A 的 Browser 慢回复或无响应，Tenant B 同时发送输入、调帧预算、snapshot，或建立/关闭控制连接。
- 影响：B 即使拥有独立 Browser 进程/Session/channel，也会等待 A；在故障期间破坏“独立 Native 算力节点”的隔离和交互延迟。仅把 Endpoint dispatcher 改为每 Session worker 仍无法修复此问题。
- 建议：registry/lifecycle 短锁只负责查找和 pin 一个共享 Channel 对象；请求串行锁属于 Channel。shutdown 先禁止新操作，再关闭/取消并等待在途操作，不能直接移除全局锁而留下 handle/state 寿命竞态。
- 必要验证：两个独立 fake/真实本地 channel，A 不回复，B 小回复仍在自身期限内完成；同时覆盖 A timeout、channel close 与 shutdown 的并发屏障。无需 GPU。

### EN-03 / P1：异步恢复导入已拆 phase，但恢复快照导出仍独占唯一 dispatcher

- 位置：`endpoint/src/service.cpp:640–661`（CaptureNavigation），`809–831`（Snapshot），`1849–1881`（主 dispatcher）。
- 证据：Snapshot 对每个 view 调用 CaptureNavigation；后者在一个调用内 `while(offset<size)` 导出全部 256KiB chunks、取消 transfer、序列化并写恢复文件。主循环在 `Command` 完成后才写本请求结果、FlushSignals 和推进其他 Session。页面 PageState 允许达到数十 MiB，导出可以包含数百次同步 RPC。
- 触发：页面 navigationRevision 变化后第一次 snapshot，尤其大 history/PageState 或 Browser 控制端慢回复。
- 影响：快照观察变成跨 Session 管理停顿；信令、其他 Tenant 请求与 recovery maintenance 均等待。不能用已完成的异步 import/restore 实测证明 export 没有该问题。
- 建议：导航导出也建立 Session-owned task，按 view/revision pin transfer，分 begin/chunk/commit phase，并设置每轮字节/时间预算。Snapshot 返回上一次已提交恢复状态和当前 export pending 即可；完整文件写完后原子替换。取消/超时必须结束 Browser transfer，不提交不完整快照。
- 必要验证：大恢复数据的一页导出与另一个 Tenant 高频轻量请求交错，验证不被一次完整导出卡住；导出中导航/关闭/Browser 重启、disk failure 不覆盖上次有效文件。这里的 global dispatcher 和 EN-02 全局 SDK 锁是两个独立阻塞点，均需修复。

### EN-04 / P1：关键 DataChannel 消息遇背压后被丢弃，video 屏障可永久等待

- 位置：`endpoint/src/service.cpp:1031–1037/1068–1078/1331–1333`；`browser/sdk/remotekit_rtc.cc:952–960`。
- 证据：SDK 在 buffered_amount+size 超过 1MiB 或 DataChannel::Send 失败时明确返回 BUSY。Session::Send 无条件忽略结果。PublishLayout 先关闭 presentation gate 并把 `layout` 设为 next，再各发送一次 layout 和 prepare；后续相同 layout 不重新发布。PresentationMessage 的 mode 回复也沿用此无结果 Send。
- 触发：已经进入 video 模式的 peer，在临时 DataChannel 背压/Send失败时发生布局换代。layout 或 prepare 没有排入可靠 SCTP，可靠传输本身不会替应用重试“未接纳”的消息。
- 影响：客户端可能已收到新 layout 并隐藏旧画面，但收不到 prepare，服务器一直等不存在的 ACK；或客户端没有收到 layout，无法匹配新帧。恢复网络后仍没有 pending 控制消息。无超时强行放行属于正确安全门禁，问题是未送达事务没有重试。
- 建议：有界发送 outbox 区分关键状态与可丢弃观察。layout+prepare 保留最新完整 key 和发送进度，按当前 peer/epoch 重试，确保 layout 排入队列后 prepare 才可发送；frame/stats 可合并/丢弃但要计数。关闭 peer 撤销其 outbox；新 epoch 覆盖旧事务，旧 ACK 不可放行。Send 成功只意味着入队，不等同客户端应用完成。
- 必要验证：mock SDK 分别对 layout/prepare/mode 返回 BUSY 再成功，确认最终顺序、可恢复、旧key不重发；长时间不可发送仍有界，且仍不发布未 ACK 布局关键帧。现有 presentation_barrier_tests 覆盖纯门禁，不覆盖 Session Send/outbox。

### EN-05 / P2：NVENC 常态 Poll 可以无限 pending，只有主动 Drain 才有期限

- 位置：`endpoint/src/media/nvenc_encoder.cpp:24–31/242–248/285–300`；对照 `qsv_encoder.cpp` 的 task.accepted 和 Poll 五秒完成期限。
- 证据：NVENC Task 无接纳时间。每次 Poll(timeout=2) 遇 WAIT_TIMEOUT 立即返回 pending；EncoderWorker 保留 inflight 并继续下一轮。五秒 deadline 仅在显式 Drain 才执行。
- 触发：驱动/完成事件异常，任务始终无完成信号但等待本身没有 WAIT_FAILED。
- 影响：流停止产出而 encoder error 为空；输入 surface/atlas lease 长期占用，常态循环没有进入错误退役路径。主动关闭仍会尝试有界 Drain/Destroy，因此不是“关闭必定永不返回”的断言。
- 建议：每 Task 记录提交单调时间并设可诊断完成期限，区分 pending 与 failure；超时触发 encoder terminal/error、调用原有销毁屏障后再释放 lease，不能伪造完成 Fence。
- 必要验证：注入 NVENC API/event adapter，永不 signal 时在期限后返回 error，仍恰一次释放；真实 NVIDIA 硬件再验普通完成/Drain。当前开发机没有 NVIDIA，本报告不声称硬件复现。

## 模块覆盖与状态机判断

| 模块/文件 | 已核对的边界和结论 |
|---|---|
| `endpoint/src/service.cpp` Session registry / Start / Stop | Tenant→稳定 Session ID、独立 data目录/Browser job、browserIncarnation、真实 process handle 退出证明；关闭前保留失败代。普通 snapshot 不启动 Browser，requireRunning 路径有守卫。dispatcher、RPC、输出/输入/音频/预算线程的所有权已追踪。EN-01～04 是集成层漏洞。 |
| recovery / reconcile / durable events | import 为分 phase/round robin，desired与完整恢复文件分开；自然关闭先持久事件再删 desired，ACK持久化后清理；输出重配保留同 RTC。export 未分 phase（EN-03）。恢复失败 fallback 新 GET，不重放 POST。 |
| RTC offer / trickle / ICE / close | peer 创建后才绑定 input/presentation；close join worker、SDK callback barrier 后清队列；旧peer过滤。connectionId由Control绑定；Endpoint协议自身没有独立attemptId。现实现不会因 resize 正常调用 rtc.close。 |
| DC input / focus / sequence / readiness | connection-local admission 在 move 合并前，Browser sequence 跨 peer递增；完整token交Browser验证，epoch/readiness独立锁快照。BUSY返回在 Rpc丢失（EN-01）。常规页面命令目前不在DC dispatcher。 |
| `presentation_barrier.hpp` / `coordinate_readiness.hpp` | 实际 encoded发送边界持锁；最新完整ACK/首关键帧门禁；canvas退出ACK等待仍保留关键帧要求；空layout撤销坐标ready。纯状态机实现有对应测试，未发现需要放宽门禁之处。可靠消息接纳层另见EN-04。 |
| `atlas_pool.cpp/.hpp` | 共享/私有copy两模式、ready/consumed/done三个证明、generation独立退役、untracked_read保留、refs归零后的真实GPU Signal、terminal watermark、真实device removal分开。COM引用未冒充防覆盖租约。失败Open和退役上限显式失败，未见静默native fallback。 |
| `shared_lease_retirement.hpp` / `shared_atlas.h` | 共享ABI v2、seqlock一致快照、元数据bounds检查；真实观察同代等值完成可复用，更高终点仍需新证据；孔洞不生成假lease。退出与GPU完成不等价。不能从CPU单测推导所有驱动故障已验收。 |
| `gpu_device.cpp/.hpp` | 同adapter LUID建device、多线程保护；BGRA→NV12正确建VideoProcessor/颜色/letterbox，Signal+event+有效completed检验；无法证明读完时保留lease。此处转换是同步CPU等待，性能取舍不是正确性bug。 |
| `encoder_worker.cpp/.hpp` / `hardware_encoder.hpp` | 单pending可替换、async_depth对应inflight、COM与pool lease分别持有、硬件完成后释放；rate变更等inflight清空，错误/停止先destroy硬件再退lease；presentation拒绝旧结果仍走drop/尾帧结算。worker fatal后不自动重建是现行错误策略，不能说已完整自动恢复。 |
| `qsv_encoder.cpp` | input job与bitstream packet分离，cookie对应输出、MORE_DATA/DEVICE_BUSY处理、VPP输入依赖、最终Sync与Locked检查、rate-only Reset不新序列、Drain/Close保留依赖。GPU实效继续以现有运行记录为准。 |
| `nvenc_encoder.cpp` | System32加载驱动DLL、同device NV12、registration/task/map/bitstream/event寿命、EOS/Drain/Destroy；逻辑depth与分配buffer数分开。EN-05为常态无完成的liveness缺口。无本机硬件结果。 |
| `audio_ring.hpp` / `shared_audio.h` / `audio_timeline.h` | Session共享音频环、序号/slot一致读取、有界最新块消费、50ms旧块丢弃、480帧/48k stereo、generation及样本位置控制、短gap有界静音/长gap重启。与video encoder独立线程。Source来自Browser播放target，不是系统hook。 |
| `file_upload.cpp` / `file_upload.hpp` / Session FileCommand | 文件名仅展示、随机ticket真实路径、每文件/批/Session配额、reservation跨重启保守计数、seal前完整长度、submitted不因未知RPC结果提前删除、确认原Browser退出后回收。跨Endpoint重启旧owner仅保留并占配额，自动释放需要新的可靠owner回收证明；是明确保留状态，非可随意删目录。 |
| `core.cpp/.hpp` | 串行模型层而非真实运行服务；session/profile/view归属、生命周期request/actual/last result、generation/token、UTF16输入、hover例外、PackAtlas/HitTest/DipToPixel。当前单Profile显式unsupported，不把它当用户最终需求。 |
| geometry / sampling / adaptive helpers | `atlas_dimensions.hpp`、`atlas_plan.hpp`、`capture_geometry.hpp`、`sampling.hpp`：物理分配/viewport分开、16Mi像素/8192资源预算、H264 frame/rate/axis预算、resolution-first降FPS；`adaptive_fps.hpp`、`media_feedback.hpp`：peer/layout绑定、反馈序号/TTL、单latest预算槽；`idle_idr.hpp`、`tail_refresh.hpp`：单次尾IDR只有实际成功关键帧才结算，编码开始后不按等待超时重复发起。 |
| clock helpers / trace | `capture_clock.hpp`、`touch_clock.hpp`：本机QPC↔TimeTicks↔UTC测量，时钟采样区间不冒充跨机offset界限；`server_trace.hpp`与SDK `rtc_trace.h`是有界ring，disk输出在flush。默认开关不自动启用无限逐帧日志。跨机限制见下节。 |
| `atlas_client.cpp` / `atlas_consumer.cpp` / `client_win.cpp` / manifest | 旧native demo专属：UI/worker线程、input epoch、焦点/触摸/IME、reconfigure闭合handoff、cache copy后consumed、无完成证据保留资源、Fence失败不静默native。此路径依赖HWND/Present，不能用其检查代表service离屏串流路径。 |
| `demo.cpp` / `encoder_smoke.cpp` | 显式EXCLUDE_FROM_ALL；model demo与硬编smoke分别定位，smoke有全组期限和可调backend/rate/depth。未执行。 |
| `sdk_loader.hpp` / public C ABI | 生产SDK动态加载必需export，句柄/裸缓冲/定长结构/回调过DLL，无STL/Chromium类型；exact struct_size和ABI版检查，texture提交成功转移一次release义务。loader保留模块至Session销毁后，不在活跃callback上下文中卸载。 |
| `browser/sdk/remotekit_sdk.cc` | Mojo独立broker、terminal SDK shutdown、channels生命周期、失败request失效handle、atlas返回handle失败清理、consumer pid和ABI校验。全局等待锁见EN-02。 |
| `browser/sdk/remotekit_rtc.cc` | Peer registry、每peer API串行/closing/callback barrier、SDP sendonly限制、recv H264 level、native帧租约、encoder ID不复用、actual wire RTP输出、policy/Stats及音频提交。音频track使用PageAudioSource；无Client上行音视频。DC Send显式BUSY但host不处理（EN-04）。 |
| `rtc_audio_source.h` / `rtc_silent_audio.h` / SDK build | 播放PCM source、sink互斥寿命、无真实ADM采集；GN把Mojo/libwebrtc封在SDK。跨机不意味Browser↔Endpoint共享纹理可以跨机，二者应在同一Native节点。 |
| `protocol/control.h` / `atlas-plan-fixtures.txt` | 只共享control version/busy code与packing fixtures，完整管理/DC schema实际散落在双方实现；不能把此头误认为完整协议契约。 |
| CMake / SDK consumers | Endpoint主服务独立CMake/C++20，Browser GN；demo显式排除。`sdk/CMakeLists.txt`与`rtc-tests/CMakeLists.txt`包含独立ABI/RTC/audio消费者。依赖边界符合当前设计。 |

## 测试覆盖核对

阅读 Endpoint 12个测试源：core、adaptive_fps、atlas_plan、atlas_publication、audio_ring、capture_clock、encoder_stats、file_upload、input_sequence、media_feedback、presentation_barrier、shared_lease_retirement；以及SDK smoke、control smoke/client、RTC smoke、audio smoke与其CMake注册。以上是源码覆盖判断，本次没有重新执行它们，也没有把历史通过次数写成本次结果。

现有测试较好覆盖纯模型和真实lease/tag helper，但没有把 Session/JSONL dispatcher/Rpc/Send 接到可注入 transport 的集成测试target。EN-01和EN-04正位于“helper通过，装配失败”的缝隙；EN-02/03需要两个Session并行的独立性检查。优先补这些边界，不需要重复性能矩阵或仅镜像代码的测试。

## 架构差距，交由 root 决策

1. **Control 跨机部署尚未实现。** 当前授权入口是Control启动子进程并用本机stdin/stdout JSONL。该实现可以被一个远程worker agent封装，但仓库当前没有Endpoint注册、远程鉴权/租约、健康状态和产品reconcile的网络契约。Browser+GPU/SDK仍应在Native节点本地，不能将共享HANDLE/QPC ABI误用于跨主机。
2. **时钟域没有跨机证明。** Endpoint帧metadata的captureWallTime是Endpoint本机UTC，uncertainty是本机取样括号；Client通过Control校时无法自然校准Endpoint独立UTC偏差。服务跨机后必须增加Client↔Endpoint校准或显式Endpoint↔Control时钟映射与不确定度。在该映射建立前跨机capture-end→paint应报告不可用/低置信度，不能宣称毫秒精度。input touch初始wall时间同样需要追踪映射来源，不能只复用当前同机假设。
3. **常规浏览器操作尚未直达 Endpoint DC。** HandleData目前仅接受input/focus，nav/back/reload等通过Control `view.*`管理通道。要满足用户新模型，需root规定Endpoint直接执行、Control记录产品状态的归属/命令幂等/回执/事件同步契约；不能只给DC加任意JSON转发，也不能将Control继续作为操作转发器当作完成。
4. **多Profile仍是实现缺口。** core AddProfile显式拒绝第二个，service CreateView没有Profile选择；多Profile必须沿SDK/Browser协议和恢复归属一起补齐。Tenant→Session隔离不因多Profile改变。
5. **协议定义和文档有漂移。** `docs/sdk.md`前段仍称audio capture/playback未启用，与后段新音频export和生产实现不符；`remotekit_rtc.h`receive-level注释仍写local level51，实际为52；`docs/endpoint.md`“all input requires focus”漏了hover例外。正式整理时应改写，避免读者依据旧段设计新架构。

## 后续最小批次建议

先由 root 确认 EN-01/04 的有界修复及 EN-02/03 的调度边界，再安排实现，不为本审计打断已授权上传。EN-01只需拆清传输/应用状态；EN-04只需把关键状态发送成为可重试事务。EN-02/03适合一起重构，但per-channel锁与per-Session调度两层都必须保留生命周期取消证明。NVENC完成期限可以在无NVIDIA环境先做注入CPU检查，真实运行验证明确待硬件。跨机网络契约、常规操作DC与多Profile则属于后续核心架构批次，root统一决策。
