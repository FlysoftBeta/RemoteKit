# Windows GPU atlas 输出

默认 client 使用 `--presentation=fence`，`--presentation=native` 是显式 HWND 对照入口。内部内容视图保留 Views/Aura；Fence 输出使用已显示、非零尺寸并移出 endpoint 可见区域的 capture host。当前不属于无 Aura/无 HWND embedder。

## 资源与完成点

browser 通过官方 FrameSinkVideoCapturer 的 Windows mappable GPU 路径获取 BGRA capture 纹理。该路径先完成 Skia GPU finished callback，再交付 capture；交付本身没有 D3D ready fence。桥接 device 在能够打开源纹理的硬件 adapter 上建立，与 endpoint 使用同一 adapter LUID。

| 顺序 | 操作 | 允许回收的资源 |
| --- | --- | --- |
| 1 | 源 keyed mutex key=0，非阻塞取得；GPU copy 源 → staging atlas | 尚不能归还 capture lease |
| 2 | GPU signal ready fence `s`，提交队列 | CPU 查到 ready completed ≥ `s` 才调用内部 capture Done |
| 3 | 找到 consumed 已完成的输出槽；GPU copy staging → 输出槽，signal ready `p` | 输出槽仍由 producer 保留 |
| 4 | 共享内存 seqlock 发布 generation、frame、slot、`p`、时间戳和布局 | CPU 发布不代替 GPU 完成 |
| 5 | endpoint GPU wait ready `p`，copy 输出槽 → 自有 cache，signal consumed `p` | consumed 实际完成后，producer 可复用该槽及更旧的槽 |
| 6 | endpoint 从自有 cache 绘制、Present | 重绘不再读取已释放的 producer 纹理 |

capture 源 lease 与共享输出槽属于两个完成域。前者保护 Viz pool，后者保护跨进程源纹理；任何一边都不能用“copy 调用已经返回”作为 GPU 读完的证据。源纹理的 keyed mutex 属于 Chromium capture 适配，browser↔endpoint 输出同步使用两条 shared fence。

固定三个输出槽。全 atlas 按配置帧率发布；多个 WebView 的 damage 合并到 staging，槽满时保留最新内容。静态内容保留最后 cache，窗口重绘直接使用 cache。冻结/卸载的最后图像标为 stale，消费端显示琥珀色边框并停止命中输入。

capture 的 keyed mutex 随 GPU write access scope 结束释放，不等 consumer Done。GPU finished 与 CPU EndAccess 之间可能有短暂竞争；bridge 遇 timeout 放弃本次读取并请求内部 refresh，不阻塞 UI。持续2秒仍无法取得锁或锁已 abandoned，则使本代输出失败并进入有界重建。

## 通信边界

Mojo 只承担建立、句柄、配置、输入和资源重建。稳定呈现期间 endpoint 工作线程等待输入任务，UI 本地轮询共享元数据；没有 browser↔endpoint 的逐帧 ready、present、release、通知或回复。Chromium 内部 renderer/Viz/GPU 的 frame 与 capture callback/Done IPC 保留。

映射 ABI 在 `endpoint/include/remotekit/shared_atlas.h`：版本 1、三槽、固定宽度字段与对齐，Windows Interlocked 发布 seqlock。句柄已经 Duplicate 到目标进程，由 consumer 关闭。shared fence 的 `UINT64_MAX` 不作为完成值。句柄建立回复未送达时，SDK 无法回收未知句柄；当前单 client demo 随进程退出收尾，不提供生产重连协议。

资源代次变化重新导入 texture/fence，旧代停止输入和发布。DPI 改变通过关闭旧输出、配置新 scale、重建资源处理；控制连接失败明确停止。健康设备尚有 GPU read 时不强制回收；真实 device removal 与普通输出失败分别报告。关闭、重建有等待上限，不伪造 consumed。

## 构建与运行边界

browser/SDK 使用 Chromium GN 增量产物；endpoint 用独立 CMake/Ninja 和 Windows D3D11/DXGI，不包含 Chromium 私有头。当前没有编码、NV12、音频或 WebRTC 传输。新链路完成编译不等于硬件呈现已实测；目标机器的硬件测试由测试包进行。
