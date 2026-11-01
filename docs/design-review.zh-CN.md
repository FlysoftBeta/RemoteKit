# 架构选择与实现差距

系统职责和行为约束见 [系统设计](architecture.zh-CN.md)，运行证据与完整能力清单见 [当前状态](current-state.zh-CN.md)。本页只保留影响实现的选择、理由和尚未满足的目标。

| 主题 | 当前选择与理由 | 实现差距／边界 |
| --- | --- | --- |
| 进程和 ABI | GN content embedder、独立 CMake endpoint、C ABI SDK，避开跨工具链 C++ ABI | 单个测试管理连接；生产认证、重连和多客户端未接 |
| 管理与身份 | Control 保存产品 Tab 与配置；Endpoint Session 持有恢复信息，每租户独立 browser/atlas，避免跨租户像素泄露 | 每 Session 当前一个 Profile；动态页面与对账的接入状态见当前状态 |
| 内容视图 | 服务端每页使用无页面HWND的Aura宿主，null widget离屏合成；保留Aura输入/OOPIF/IME，原生demo独立保留Views窗口 | 多页/混合DPR/输入及GPU故障恢复已验证；popup像素合成与命中仍须验证 |
| 生命周期 | 用 renderer ack、原地 discard、独立 unload/restore，保留代次和超时结果 | 提供 primitive，尚无自动淘汰或完整期望状态 reconciliation |
| 导航 | 完整 history/PageState，同进程保持 sessionStorage namespace；opaque 状态绑定 owner | 无跨 browser sessionStorage；无外部持久保存确认；POST 自动恢复拒绝 |
| GPU 输出 | 固定三槽 shared texture 和双向 GPU Fence，消费端持有自己的 cache | browser做源→staging、staging→输出两段copy；新旧宿主均有真实串流证据，性能目标未达 |
| 元数据 | 当前共享内存发布一致快照，稳定帧不走 Mojo | 此机制受到用户质疑，保留／替换尚未决定；Fence value 编码方案尚未实施 |
| 节拍 | 离屏宿主使用browser本地external BeginFrame pacer，每host独立source ID、最多一个未ACK tick并合并过期tick；断连可恢复 | 60FPS驱动下四租户仍过量提交，继续调优背压；ACK不替代GPU完成 |
| 输入 | browser 逻辑焦点、实际 focused widget、OOPIF 和官方 touch ACK/gesture；DIP/像素分开 | CDP touch 互斥；完整 IME replacement range/span、逐字符几何和真实输入法验证未完成 |
| 页面功能 | 文档绑定的异步请求及一次回复；权限、下载归 Profile | 普通文件/dialog/menu/find/zoom/edit 已接；动态 popup、目录上传、认证/证书、PDF/打印等尚缺接线 |
| 媒体边界 | Endpoint 持有 oneVPL/NVENC 编码器和纹理池，GN SDK 提供 WebRTC C ABI；保留异步纹理租约 | 音频不接；本机只有 UHD630，NVENC 实测需 NVIDIA 硬件；性能目标待实验 |

GPU 的两个完成域分别保护 Viz capture 池和跨进程输出池：capture lease 只能在桥接 GPU 读完后归还，输出槽只能在 endpoint GPU 读完后复用。窗口重绘使用 endpoint cache，设备错误不伪装为完成。这是资源正确性的约束，与元数据选择共享内存还是其他机制无关。

尚未接通的目标保留为差距，不因当前 demo 采用拒绝策略或省略某项服务而视为用户永久取消。后续实现需要按系统职责补齐接口，同时更新当前状态；不把设计描述写成已验证结果。
