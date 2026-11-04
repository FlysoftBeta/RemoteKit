# OSR 生命周期、触控与串流诊断交付

发布包来自干净的 `433655ddca7d7e44eb44f847a8c46ba0bc352675`，功能提交已推送至 `FlysoftBeta/RemoteKit`。包含页面生命周期精确回执与恢复、跨布局触控终止处理、Video Stats 修复及分段 OSR 诊断。Endpoint 的 RTP playout-delay 请求默认是 0–50 ms，Viewer 的接收缓冲目标仍为 0 ms。

- 文件名 `RemoteKit-win-x64-streaming-qsv-nvenc-20261104-144257.zip`
- 大小 504972886 bytes
- SHA-256 `730c595e92d2d1390880de2ffe793b65f41464184d5cf00b9925b123ea855349`
- manifest 标记 `remotekit_source_dirty=false`。校验了 571 项 manifest 文件、572 个 ZIP 文件（含 manifest）的大小、CRC 和 SHA-256、整包 SHA-256 与 sidecar，以及 11 项人脸资产。归档排除了 Profile、日志、凭据、PDB 和编译输入。

## 包内验收

`tools/package-runtime.py --smoke` 使用包内 Node、Control 生产 UI、SQLite 和 Endpoint，验证首位管理员注册、已认证 WebSocket、Endpoint 管理与人脸模型可用、Viewer 重附着锁定和密码恢复，以及 WebSocket 产品操作门禁。

独立 Chrome157 连接解包后的 Control、Endpoint 与 Browser。实际协商 H.264、使用 QSV、默认 video 呈现。可信触控开始与结束到达测试页，同一个终止请求收到 `accepted-pending` 后收到 `processed`。触控前后 peer、产品 DataChannel、video 元素和流对象保持，帧计数继续增长。Stats 显示 Video 提交、解码、末包至 Video 提交、接收缓冲、解码耗时、接收码率、编码器及 Atlas 尺寸。Endpoint 运行快照读到 `minMs=0`、`maxMs=50`，启动参数无 playout-delay 覆盖。Viewer 的标准 `jitterBufferTarget` 读回 0。

包内检查覆盖启动和上述单路真实媒体功能。完整功能和分段测量使用开发产物，证据见[本轮记录](osr-latency-investigation-20261104.md)、[生命周期运行](osr-lifecycle-runtime-20261104.md)和[触控运行](touch-terminal-runtime-20261104.md)。包内运行未发现 FATAL、CHECK 或 GPU 进程退出，自有测试进程均已关闭。运行生成的 Browser 调试日志已从解包目录移入证据目录。

证据位于 `develop/tmp/osr-lifecycle-delivery-20261104/`，包括 `package.log`、`package-verification.json`、`packaged-157/` 和 `airportal-receipt.json`。启动 smoke 证据位于 `develop/tmp/package-smoke/1793774580710778400/result.json`。

## 上传

2026-11-04 14:46:48（UTC+8），AirPortal 显示“文件已成功发送”。取件码 [861200](https://airportal.cn/861200/YnupKqRq8U)，有效 24 小时，可下载 2 次，无密码。通过回执的复制按钮取得链接，未发起下载。上传使用浏览器已登录的会话。
