# RemoteKit 当前实现

基线：官方 Chromium Release **157.0.8103.15**（`1aa07b638799e59656559ae6c6649d4b197f555e`），Windows x64。源码在本仓库；`tools/chromium.py` 把 browser、共享模型和 SDK shim 放入 Chromium 的 `//remotekit`。

## 结构

- **browser**：独立 ContentMain/ContentBrowserClient/ContentRendererClient、BrowserContext 和 WebView adapter，不链接 Chrome 的 Browser/TabStripModel/BrowserView。当前呈现 backend 使用官方 Views/Aura。
- **endpoint**：独立 C++20 + CMake/Ninja。Tenant → Session → Profile → WebView；当前每 Session 一个 Profile。MaxRects、不旋转、有 padding、显式排布失败；输入用 viewport DIP。
- **SDK**：GN 构建 C ABI DLL，外部 CMake 只消费 C 头与 import lib。Mojo 本地 pipe 与跨进程 isolated 控制连接；libwebrtc 接入目前是 timeutils 链接探针。
- **harness/client**：默认 Fence atlas 呈现；native HWND 为显式对照入口。测试管理器目前在 browser harness 中，原生 endpoint client 管理进程、输入与 GPU 消费。启动参数分配多个 Session，每 Session 独立 BrowserContext/存储目录；同 Session 页面共享 Profile。

## 已实现

| 能力 | 当前状态 |
|---|---|
| 独立 content embedder、多页呈现 | 已构建运行；使用 Views/Aura |
| 原生窗口 DPI | endpoint/browser 统一 PMv2；嵌入窗口从创建时即为无边框；父窗口响应 DPI 变化，以物理客户区像素调整子窗口 |
| GPU atlas | 官方 GPU capture → browser staging/三槽共享纹理 → endpoint 自有 cache；ready/consumed shared fence；共享内存发布帧与布局；已编译，未运行验证 |
| 输出节拍/重建 | 全 atlas 帧率上限、damage 合并、槽满保留最新；DPI 新代资源导入、GPU 失败最多3次重建；稳态无 browser↔endpoint 逐帧 Mojo |
| Session 存储隔离 | 独立 BrowserContext/路径，localStorage 隔离测试通过 |
| UA/Client Hints | 官方 embedder_support 算法、Chrome 品牌、GREASE、平台与完整版本；运行验证通过 |
| window.chrome | 官方 loadTimes/csi；普通网页 chrome.app stub；范围见[兼容表面](browser-compatibility.md) |
| 输入模型 | Session/实例/文档/焦点 token 与序号校验；UTF-16 composition 校验 |
| browser 输入 adapter | 实际 focused widget、OOPIF 路由、独立 char、双三击、按键/鼠标/IME 收尾；触控采用官方 TouchEmulator 与最终 ACK/gesture 路径 |
| Fence client 输入 | letterbox/atlas 像素 → viewport DIP；SDK 工作线程保序；busy 有界重试、旧 token/输出代次丢弃；IMM composition/caret 候选窗反馈 |
| 生命周期 | desired/actual、request/complete 分开；freeze/thaw 检查 renderer ack；原地 discard 等待实际回调 |
| unload/restore adapter | 完整 history/PageState，同进程 sessionStorage namespace；真实提交后完成；opaque chunk 导入导出校验 Session/Profile/版本，POST 自动恢复明确拒绝 |
| 页面请求 | dialog/beforeunload、普通文件选择、context menu、pseudo fullscreen、find/zoom/edit/navigation；once 回复、文档失效取消，控制端轮询 pending/events |
| Profile 服务 | 默认 deny 的 origin/embedding 权限配置；HTTPS-only 会话目录下载、进度/取消和 Windows quarantine；不包含 SafeBrowsing |
| patchset | SHA-256 清单、检查/应用/逆序撤回、失败回滚；当前只需 WebRTC target visibility patch |
| 独立 SDK 消费 | GN build、完整 runtime 导出、MSVC CMake/Ninja link 和 smoke 通过 |

## 验证与限制

此前 native 路径的 endpoint 核心测试、4 项 patchset 测试、SDK smoke 和隐藏窗口集成测试已通过，涵盖 identity、Session 存储隔离、输入 token、生命周期与 URL restore。SDK 50ms 无响应请求在63ms结束并使旧 handle 失效。这些结果不覆盖本轮新增 GPU、完整导航恢复及页面请求。

本轮 browser/SDK 与独立 CMake Release endpoint 已编译链接；按用户要求不启动额外运行验证。新 GPU 链路、真实 Windows IME、触控手势、下载和资源重建尚需目标机器测试。测试包记录 backend、构建指纹和文件校验和。

保留 Aura，不称为无窗口 embedder。固定 WebView 集合，window.open 明确阻止；原生 popup 在 GPU 输出中的合成/命中尚未验证。pointer/keyboard lock 明确拒绝。目录上传、tooltip 原生 hook、HTTP/代理认证、客户端证书、PDF/打印及生产重连/认证未接通。跨 browser 的 sessionStorage 不随导航 blob 恢复。CDP 附加期间远程触控明确拒绝，以免争用同一个 emulator；native 与 injected touch 也遵循官方互斥规则。没有接编码器、音频或 WebRTC 传输；SDK 的 WebRTC 范围仍是 timeutils，不能称为完整 libwebrtc API 包。

## 入口

构建与运行：[README](../README.md)；[系统设计](architecture.zh-CN.md)；[GPU 输出](gpu-output.zh-CN.md)；[架构取舍](design-review.zh-CN.md)；[打包](packaging.zh-CN.md)；[控制协议](control-protocol.md)；[SDK](sdk.md)。本机调试输出为 `C:\src\chromium\src\out\dev\remotekit_browser.exe`。
