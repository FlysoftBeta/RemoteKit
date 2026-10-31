# 实施记录

2026-10-31。此文件记录过程；正式能力与构建入口以 `/docs`、`/tools` 为准。

1. 识别原 Chromium rb 分支及已有修改。保存 tracked edits 到 stash，从官方 Release 157.0.8103.15 建立 remotekit，保留 dev/rel 缓存。
2. 完成独立 endpoint 模型、MaxRects、UTF-16 输入类型与代次校验，MSVC CMake/Ninja 测试通过。
3. 建立独立 content 启动、BrowserContext、单窗口多 WebView、本地 Win32 client。选择 Views/Aura 作为当前 Windows backend。
4. 建立 C ABI SDK 与完整 runtime_deps 导出，独立 CMake 消费成功。WebRTC 当前仅链接 timeutils。
5. 用 IsolatedConnection 连接 endpoint 与 content 的独立 Mojo 进程图；接通版本化 JSON 控制、实际输入与状态观察。
6. freeze/thaw 等待所有相关 RVH 的 renderer ack，discard 使用原地机制与实际回调；隐藏窗口验收通过远程 composition/键盘/鼠标/touch、隔离、stale、生命周期与正常退出。
7. 用户要求停止 computer-use，已停止全部鼠标/键盘/窗口自动操作。后续只运行隐藏窗口测试。
8. 用户允许全部 CPU，默认构建并行度改为本机全部16逻辑核心；源文件改动不再重复 GN gen。
9. 按用户澄清迁移目录：正式文档 `/docs`，构建/导出/验证工具 `/tools`；`/develop` 可丢弃且没有构建必需输入。
10. 修复原生宿主的 DPI 配置和嵌入窗口非客户区布局：endpoint manifest/入口与 browser 入口统一 PMv2，嵌入 widget 在 Init 前选择 frameless，处理父窗口 WM_DPICHANGED，补正确的 screen 坐标。用户关闭占用的测试窗口后，两端编译与链接均已通过。按用户要求不增加或运行验证。

仍需后续工作的边界集中维护于 `docs/current-state.zh-CN.md`，不在这里追加另一份功能清单。
