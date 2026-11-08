# 渲染：Renderer → Compositor

本文描述网页像素如何从 Chromium 渲染器到达 Endpoint 的编码器入口。节奏（何时请求一帧）见[节奏与补帧](pacing.md)，编码见[编码](encoding.md)。

## 角色

| 名称 | 所在进程 | 职责 |
|---|---|---|
| **Comp**（Compositor 侧调度者） | Endpoint | 唯一的节拍所有者。选择空闲 Slot，发出 Begin，观察完成，把帧交给编码器，回收 Slot。 |
| **Rend**（Renderer 侧执行者） | Browser | 接受 Begin，驱动各页面的 Viz 根绘制到 plane 目标，再在 GPU 上把各 plane 合成到 Begin 指定的 atlas Slot。 |
| **plane** | Browser | 一个页面（WebView 的当前执行实例与文档）的离屏绘制目标集合。 |
| **atlas** | 共享纹理 | 一个 Session 内所有可见页面打包成的一张图，整张图作为一路 H.264 视频编码。 |
| **Slot** | 共享纹理 + Fence | atlas 的一个副本及其下游租约的容量单位，最多 4 个。 |

Comp 决定"要不要画"，Rend 决定"怎么画"。Browser 内没有自主的重复渲染定时器，也没有独立于 Begin 的发布节拍。

## 设计意图

1. **不经过任何屏幕呈现。** 服务端没有窗口、没有 swapchain、不调用 Present、不截屏、不走 `FrameSinkVideoCapturer` 或 `CopyOutputRequest`。像素直接写进 Endpoint 可以导入的 D3D11 共享纹理。早期方案（隐藏窗口截取、CopyOutput 捕获再拷贝到 atlas）的问题见[调优经验](tuning.md#渲染路径)：主要代价不在拷贝本身，而在 DXGI Present 阻塞和 GPU 完成观察的延迟。
2. **成功帧不产生 IPC。** 每帧的"完成"由 GPU Fence 证明，元数据通过共享内存发布。跨进程消息只用于请求（Begin）和例外（Reject、Stop/Stopped、Wake）。
3. **CPU 侧的任何事件都不是 GPU 完成证明。** 提交返回、Flush 返回、回调执行、seqlock 读到一致数据、进程退出，都不能代替 Fence 到值。不确定的 GPU 工作保留资源直到进程结束，而不是猜测已完成。
4. **页面布局与采样密度解耦。** 页面看到的 viewport（DIP）由客户端实际内容区决定；页面 DPR、atlas 密度、编码采样尺寸分别独立变化。

## 离屏宿主（OffscreenHost）

每个 WebContents 拥有独立的 Aura 根窗口和 compositor，`AcceleratedWidget` 为空，不创建页面 HWND。Aura 照常承担输入路由、焦点、IME 和 OOPIF。

- 虚拟 `ServiceScreen` 报告 DSF=1。页面 DPR 由 Control 下发的 device scale 显式决定，不继承服务器显示器的 DPI、刷新率或 RDP 状态。
- 每个根使用唯一的 `StubBeginFrameSource` source ID。共用 source ID 会让不同根的 BeginFrame 身份重叠，导致调度错乱。
- `SetNeedsBeginFrame` 只向 Comp 报告需求（用于 Wake），宿主自身不会发起 BeginFrame。
- Windows 默认的最小输入法实现不适用于这个 embedder，宿主安装 `MockInputMethod` 以获得正常的焦点和文本输入行为。
- 旧宿主在其 GPU 写入真正完成之后才销毁（`RetiredHost` 每 2ms 轮询退役探针）。销毁宿主不能当作取消 GPU 工作的手段。
- Browser 进程里仍有 Chromium 自己的 `SingletonHwnd` 等辅助窗口，"无页面 HWND"不等于"进程零 HWND"。

## Viz 输出设备（patch 0013）

`SkiaOutputDeviceRemoteKit` 是 Viz 的一个输出设备，把根绘制直接写进 Browser 分配的 plane 目标。

- 后端为 ANGLE/D3D11 上的 Ganesh GL。设备要求 `ID3D11Device5`/`ID3D11DeviceContext4`，并校验 ANGLE 实际设备的 adapter LUID 与指定 LUID 一致。
- Endpoint 枚举并验证硬件编码器与 D3D 适配器，把 LUID 传给 Browser。服务运行时使用 `ignore-gpu-blocklist`，避免 RDP 的默认 Microsoft Basic Render Driver（vendor `0x1414`）触发 Chromium 条目 74、禁用所选硬件的全部 GPU 功能；驱动缺陷规避仍保留。GPU 子进程启动前检查指定 LUID 存在且为硬件，禁止缺失时静默换卡；OSR 配置再次验证 ANGLE 实际 LUID。日志记录实际 ANGLE 名称、LUID、软硬件及 GL 合成/光栅化功能状态。
- plane 目标必须是：BGRA8、`D3D11_USAGE_DEFAULT`、单 mip/单数组/单采样、可作 RT 与 SRV、NT 共享句柄、不使用 keyed mutex。通过 SharedImage 以 `DISPLAY_WRITE | DISPLAY_READ`、sRGB、左上原点、预乘 alpha 导入。
- `supports_post_sub_buffer = false`：多个目标轮转，每次必须完整重绘根，否则下一个目标里会残留另一个历史帧的像素。
- 一帧的顺序：`PreparePaint` 校验授权 token 与尺寸 → `BeginScopedWriteAccess` 等待 begin semaphore → Skia 提交 → 结束 SharedImage 访问 → 在 ANGLE 实际 immediate context 上 `Signal` 该目标的 ready Fence → Flush。结果 `kSubmitted` 只表示写入已排队，合成方仍需在 GPU 上 Wait 这个 Fence。
- `Present` 只做 swap ack 记账，不呈现任何东西。
- Display 的 Configure/Begin/Finish 必须处在 `ScopedAllowScheduleGpuTask` 作用域内，否则首次真实 GPU 渲染会触发调度器的 `!schedule_task_disallowed` 检查。
- 配置代次单调递增；替换目标集合时要等旧集合最后一个已 Signal 的值完成。Idle 授权会消耗请求值但不 Signal，所以"最后接受的值"与"最后 Signal 的值"是两个状态。

`ExternalBeginFrameController::IssueRemoteKitBeginFrame` 返回与 token 匹配的 `FrameResult`：`kSubmitted`（写入已排队）、`Idle`（没有新内容，保留旧目标）、`NotReady`（没有可用像素或配置）、`Lost`（写入结果未知，终止此渲染路径）。根缺失时的 Idle 会被转换成 NotReady。

## plane 目标池

plane 目标与 atlas Slot 的生命周期是故意解开的：静态页面的最后一帧可能被连续多次 atlas 合成读取，而别的页面在变化。

- 每个 plane 有 5 个目标（Slot 数 4 + 1）。目标索引与 Slot 索引无关，帧 token 显式携带 `target_index`。
- `Plane.latest` 引用最新有效目标；正在进行的 Work 和 Slot 读租约各自另外引用目标。一个目标只有在没有读者、不在写入、且上一次 ready Fence 已完成时，才能被选为下次写入的目标。
- 真实的 plane 写入即使所属的 atlas 工作已过期或被拒绝，也要保留到它的 Fence 完成。Reject 不会取消已排队的 GPU 写入。
- 配置重试由后续 Begin 驱动，间隔 50ms，总期限 5 秒；重试复用已分配的句柄，不每次新建资源。
- 配置失败封存输出；`output.describe` / `output.status` 返回 `hardware_output_unavailable`、原因和可展示消息。Endpoint 将消息投影为 Session 错误，保留仍连接的 Browser，避免反复替换。
- `frame_id` 表示内容身份（版本），请求值（value）表示一次请求。强制重拷同一内容会得到新的 value，但 `frame_id` 不变。
- 同一布局已有可用缓存、没有新像素且非强制请求时返回 Idle，并保留该次完整身份供 Wake 使用。需求未知或根暂未产出新帧不使缓存失效；NotReady 只表示缺像素或配置未就绪。强制尾帧仍合成缓存。

## 一次 Begin 的处理

```
Comp: 选空闲 Slot s，分配 value v，发送 Begin{generation g, slot s, value v, interval, force}
Rend: 校验 (g, s, v)：代次匹配、v 非零且递增、Slot 已预留、上次 consumed 已完成
      → 快照每个可见 plane 的绑定、文档身份、几何
      → 对需要更新的根发出授权（可能同步完成，所以先登记待完成计数）
      → 等各根结果：Submitted / Idle / NotReady / Lost
      → 若无任何更新且非 force、且有可用缓存内容：Reject(Idle)
      → 否则在合成 context 上：清黑 atlas → Wait 各 plane 目标 ready Fence
        → 按 atlas 矩形缩放绘制 → 写 Slot 元数据快照 → Signal slot.ready(v) → Flush
Comp: 观察 slot.ready 到达 v，校验元数据快照的身份/尺寸/布局 → 交给编码器
编码器链结束所有租约 → Comp Signal slot.consumed → 观察到完成 → Slot 可复用
```

- Rend 最多排队 4 个请求，同一时刻推进一个 Work，按 Chromium 的 BeginFrame interval 规则顺序接纳同一个根；不同 Slot 可以同时处于 Browser 等待、GPU 写入、atlas 读取、编码等不同阶段。
- 焦点或光标等元数据变化但像素身份未变时，`RefreshCurrentWork` 接受更新；绑定、文档或几何变化会让像素被错误贴标签，因此拒绝。
- 首帧或布局重建期间没有可用 latest 目标时返回 NotReady，不能伪装成 Idle。Idle 只在"最后接受的内容已提交，且没有尚未合入 atlas 的新内容"时成立。
- Slot 持有的 plane 读引用要保留到 atlas ready Fence 真正完成，而不是 Draw 或 Signal 返回时。

## 渲染管道协议

Begin/Reject/Stop/Stopped/Wake 走一条独立的 Mojo message pipe（编解码在 `protocol/render_wire.h`，Browser 与 SDK 共用），与同步的控制 RPC 分开。该 pipe 在 `output.describe` 的成功回复里一次性移交。不能为同一对进程另建第二条 `IsolatedConnection`：在 ipcz 下它会替换已有的控制连接（曾表现为首帧时连续 53 次 RejectStopped）。

线格式是 48 字节定长消息，magic `0x524B5243`，version 1，不携带句柄或指针：

| 消息 | 方向 | 含义 |
|---|---|---|
| Begin=1 | Comp→Rend | 为 (g, s, v) 请求一帧，带 interval_us 与 force |
| Reject=2 | Rend→Comp | 该请求终结且没有 atlas 提交。原因：Idle=1、NotReady=2、StaleGeneration=3、Stopped=4 |
| Stop=3 | Comp→Rend | 该代次的接纳边界 |
| Stopped=4 | Rend→Comp | Stop 之前的请求全部已 Reject 或已排 Signal |
| Wake=5 | Rend→Comp | 以最后一次 Idle 的身份报告新的渲染需求 |

身份 `RenderIdentity{generation u64, value u64, slot u32, reserved u32}`：generation、value 非零，value 小于 `UINT64_MAX`，slot < 4，reserved = 0；Begin 另要求 interval > 0、force ∈ {0, 1}。

每个 Begin 恰有一个终态：Reject，或者 ready Fence 被 Signal。成功没有逐帧的 ready/present/release 消息。SDK 的 `render_observe_signal` 只关闭本地的待完成记账，既不是跨进程消息，也不是复用许可。

## 共享映射

`SharedRenderMapping` v5（`protocol/shared_render_slots.h`）只承载元数据：最新布局、剪贴板序号，以及每个 Slot 独立的帧快照（最多 64 个 view，每个 view 包含 Session/WebView/instance/document/focus 身份、atlas 像素矩形、输出像素每 DIP、页面 DPR、stale 标记、文本输入状态与稳定的编辑目标 ID、触控选择快捷菜单、上下文菜单 ID）。全局布局和每个 Slot 的快照各有独立的 seqlock。seqlock 读到一致数据只证明元数据一致，不证明 GPU 写入完成。

## Slot 与 Fence

每个 Slot 有独立的纹理、ready Fence、consumed Fence 和帧快照，各自的 Fence 时间线互不相干。其他 Slot 的更大 Fence 值不能证明本 Slot 完成。

Endpoint 侧 Slot 状态：`free → rendering → leased → consuming → free`。

- **rendering**：已发 Begin。匹配的 Reject 或 SDK BUSY 退回 free。
- **leased**：ready Fence 到达 v，且快照的 generation/slot/value、尺寸、布局缩放和边界全部校验通过。编码链可能同时持有多份租约（SDK native buffer、硬件编码器各一份）。
- **consuming**：最后一份租约归还后，Endpoint 在自己的 immediate context 上 Signal consumed Fence 并 Flush。CPU 引用计数归零只证明不会再有新读者，不证明已排队的 VPP/编码 GPU 读取已完成，consumed Fence 补上这个缺口。
- 只有观察到 consumed Fence 真正到值，Slot 才回到 free。

多个请求在途时，按最早未完成的 value 顺序交付，与 Slot 编号无关。D3D Fence 返回 `UINT64_MAX` 表示设备丢失，不是"所有工作都完成了"；把它当作最大成功值会导致不安全的复用。

## 换代、停止与退役

resize、停止输出、断链、GPU 故障都会结束当前代次。

1. Comp 发送 Stop，当前状态移入退役集合，同时可以导入下一代资源。
2. Rend 在同一个有序通道上把 Stop 之前的请求处理完（Reject 或已排 Signal）后回复 Stopped。Stopped 只证明请求的终态已确定，不证明 GPU 工作完成。
3. 退役代次中已经 ready 但从未交给编码器的帧，同样要观察 ready、再 Signal consumed。
4. 以 10ms 间隔轮询事件和 Fence，最多 5 秒。超时后无法证明完成的资源继续保留（直到进程退出），而不是释放。
5. 进程退出不是 ready 或 consumed 的替代证明：生产者退出时 GPU 命令可能还在队列里。

RenderChannel 在所有者析构时先撤销断开回调，再关闭 watcher 和 pipe。否则析构中的回调会重入正在销毁、已经释放最后一个 shared 引用的 OSR 状态（曾导致 `bad_weak_ptr` 和 0xC0000409）。活着的通道被显式关闭或对端真实断开时，仍各通知一次。

## GPU 适配器

Browser 渲染、纹理导入、VPP 和硬件编码必须在同一块物理 GPU 上。Endpoint 在启动 Browser **之前**探测实际可用的 H.264 硬件编码器，确定后端和 DXGI adapter LUID，再通过 `--use-adapter-luid=<high>,<low>` 传给 Browser；Chromium 把同一参数传给 GPU 进程的 ANGLE。Rend 按该 LUID 创建设备，Viz 输出设备校验 ANGLE 设备的 LUID，Comp 在每代导入资源前核对 LUID。同一 Browser 运行期间适配器固定不变。

显示拓扑与适配器身份是两回事：显示器 0→1、1→0 变化时，同一 UHD630/LUID 上 Browser PID、peer、track 均保持，H.264 持续输出。离屏渲染需要的是 GPU 与资源契约，而不是一个活的显示目标。

## 几何

| 量 | 含义 | 决定者 |
|---|---|---|
| viewport（DIP） | 页面布局尺寸 | 客户端 Window 内容区的实际 CSS 尺寸 |
| 页面 DPR | 页面 backing 的像素密度 | Viewer 上报的设备 DPR × 界面缩放（编码像素 = 物理像素），资源不足时由规划降低 |
| atlas 像素每 DIP | atlas 内的统一密度 | Endpoint 规划；混合 DPR 时低密度 plane 会被上采样 |
| atlas 矩形 | plane 在 atlas 里的位置 | 打包算法；只用于源裁剪 |
| 编码采样尺寸 | 实际 H.264 帧尺寸 | WebRTC `AdaptFrame` 缩放整张 atlas |
| mediaScaleX/Y | atlas 像素到编码像素的逐轴比例 | 两轴分别记录，覆盖偶数/对齐取整造成的轴向差异 |

**打包**：确定性的、不旋转的 MaxRects，按输入顺序放置，评分依次为短边、长边、y、x，然后切分并裁剪空闲矩形。每个 plane 四边各留 padding（单个 1920×1080 plane 加 4px padding 需要 1928×1088）。物理轴 = `ceil(DIP × scale)` 向上取偶；单轴不超过 8192，面积不超过 16,777,216 像素。规划同时约束面积、单轴、padding 和对齐，Control 与 Endpoint 用同一份 fixture（`protocol/atlas-plan-fixtures.txt`）验证结果一致。最低 DPR 也放不下时返回 `resourceLimitation`，保留旧的有效布局。

**原子提交**：`output.configure` 带 `viewConfigs` 时，先验证全部候选配置、物理预算和完整打包可行性，再一次性提交页面几何与 atlas 几何；任何一步失败都保持原状。新建或收养的页面先隐藏创建，再加入最终事务。这样横竖屏切换不会产生超限的中间矩形。

**客户端**：atlas 矩形只决定从视频里裁哪一块；画面在客户端的位置和大小由该 Window 的内容区决定，输入层使用同一个 bounds。坐标换算见[客户端输入](input.md#坐标)。

## 媒体追踪

- `REMOTEKIT_MEDIA_TRACE`：Browser 每代一个 32768 条的 OSR 环形记录（Begin 接纳/排队、各 plane 请求与返回、atlas 合成、Signal 调用与 Flush 返回、输入派发前后），在 Stop/Fatal 时异步落盘，正常关闭等待写完，被覆盖的条数会显式报告。
- `REMOTEKIT_SERVER_TRACE`：Endpoint 65536 条记录（Comp 实际 Fence 观察、AdaptFrame、SDK 提交、编码队列/VPP/硬件完成、SetRates、实际 wire RTP、输入接收/排队/RPC 锁等待）。
- 两边用 Browser PID + generation + slot + value 关联；Endpoint 的 frame cookie 跨代唯一；与客户端用实际 wire RTP 关联。

当前 OSR 路径没有可靠的 GPU 完成时间戳，所以 `capture_time_us = 0`，依赖源完成时间的延迟样本直接省略，不拿提交、Flush 或 Fence 观察时间顶替。测量方法见[诊断与测量](diagnostics.md)。
