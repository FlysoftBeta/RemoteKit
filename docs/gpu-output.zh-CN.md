# Windows GPU atlas 输出

默认串流服务按Session建立browser进程与Fence atlas，经Endpoint编码后由WebRTC传到客户端。服务页面采用每WebView独立的无HWND Aura宿主，ui::Compositor从创建时使用null accelerated widget，直接输出离屏纹理；保留Aura内容视图、输入与IME支持。atlas在GPU桥合并，不再绘制到本地atlas窗口。运行验收状态见[当前状态](current-state.zh-CN.md)。

browser本地external BeginFrame pacer按输出需求驱动各页，最多一个未ACK tick；ACK用于调度，不表示纹理GPU完成。宿主使用虚拟DSF1，页面DPR与实际backing独立配置。`--browser-render-host=window`是旧宿主的显式诊断对照，默认`offscreen`。原生demo独立保留Views窗口，使用`--presentation=fence`；`--presentation=native`仍是其显式HWND对照入口。

## 资源与完成点

browser 通过官方 FrameSinkVideoCapturer 的 Windows mappable GPU 路径获取 BGRA capture 纹理。该路径先完成 Skia GPU finished callback，再交付 capture；交付本身没有 D3D ready fence。桥接 device 在能够打开源纹理的硬件 adapter 上建立，与 endpoint 使用同一 adapter LUID。

| 顺序 | 操作 | 允许回收的资源 |
| --- | --- | --- |
| 1 | 源 keyed mutex key=0，非阻塞取得；GPU copy 源 → staging atlas | 尚不能归还 capture lease |
| 2 | GPU signal ready fence `s`，提交队列 | CPU 查到 ready completed ≥ `s` 才调用内部 capture Done |
| 3 | 找到 consumed 已完成的输出槽；GPU copy staging → 输出槽，signal ready `p` | 输出槽仍由 producer 保留 |
| 4 | 共享内存 seqlock 发布 generation、frame、slot、`p`、时间戳和布局 | CPU 发布不代替 GPU 完成 |
| 5 | endpoint GPU wait ready `p`，copy 输出槽 → 自有 cache，signal consumed `p` | consumed 实际完成后，producer 可复用该槽及更旧的槽 |
| 6 | 串流服务从自有cache转换为NV12并异步编码；原生demo绘制、Present | cache及编码surface保留至各自实际GPU工作完成，不再读取已释放的producer纹理 |

capture 源 lease 与共享输出槽属于两个完成域。前者保护 Viz pool，后者保护跨进程源纹理；任何一边都不能用“copy 调用已经返回”作为 GPU 读完的证据。源纹理的 keyed mutex 属于 Chromium capture 适配，browser↔endpoint 输出同步使用两条 shared fence。

固定三个输出槽。全 atlas 按配置帧率发布；多个 WebView 的 damage 合并到 staging，槽满时保留最新内容。静态内容保留最后cache。冻结/卸载及尚未取得有效捕获的平面标为stale，串流客户端显示等待状态并停止坐标输入。stale→ready变化进入新layout epoch，必须与实际wire RTP匹配的视频一起授权，不能仅根据较新的布局消息解锁旧画面。

capture 的 keyed mutex 随 GPU write access scope 结束释放，不等 consumer Done。GPU finished 与 CPU EndAccess 之间可能有短暂竞争；bridge 遇 timeout 放弃本次读取并请求内部 refresh，不阻塞 UI。持续2秒仍无法取得锁或锁已 abandoned，则使本代输出失败并进入有界重建。

设备尺寸切换时，Chromium可能暂时把旧比例内容放入新画布。每次capture绑定从首张几何不匹配帧起允许固定2秒过渡，丢弃这些帧并合并refresh，不复制旧比例像素到新atlas。独立轮询负责超时，后续坏帧不延长期限；首次正确几何结束过渡。格式、共享句柄、纹理与设备错误仍明确失败。

Fence保证读写顺序，不保证GPU任务立即执行。官方capture的begin→end包含CopyOutput排队、GPU工作和完成回调；它发生在本项目桥接ready fence之前。共享帧的`capture_time_us`采用Chromium的capture **end**，HUD“捕获完成→纹理就绪”不包含捕获本身。分段测量与默认关闭的ready gate/capture限流实验见[串流实验](streaming-experiments.zh-CN.md)。

## 通信边界

Mojo只承担建立、句柄、配置、输入和资源重建。Endpoint消费线程本地轮询共享元数据；没有browser↔endpoint的逐帧ready、present、release通知或回复。Chromium内部renderer/Viz/GPU的frame与capture callback/Done IPC保留。Endpoint↔Client的WebRTC视频与DataChannel属于另一条通信边界。

映射ABI在`endpoint/include/remotekit/shared_atlas.h`：版本2、三槽、固定宽度字段与对齐，Windows Interlocked发布seqlock。句柄已经Duplicate到目标进程，由consumer关闭。shared fence的`UINT64_MAX`不作为完成值。句柄建立回复未送达时，SDK无法回收未知句柄，进程退出负责最终收尾。

资源代次变化重新导入 texture/fence，旧代停止输入和发布。DPI 改变通过关闭旧输出、配置新 scale、重建资源处理；控制连接失败明确停止。健康设备尚有 GPU read 时不强制回收；真实 device removal 与普通输出失败分别报告。关闭、重建有等待上限，不伪造 consumed。

## 构建与运行边界

browser/SDK使用Chromium GN增量产物；endpoint用独立CMake/Ninja和Windows D3D11/DXGI，不包含Chromium私有头。NV12转换、oneVPL异步H.264及WebRTC已通过UHD630/Chrome89真实链路检查；NVENC已编译，本机无NVIDIA硬件运行证据。音频未接入。各项功能与性能验证以[当前状态](current-state.zh-CN.md)为准。
