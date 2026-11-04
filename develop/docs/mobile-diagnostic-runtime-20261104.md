# Viewer 诊断采集运行验收

[运行器](../../tools/test-diagnostic-collection.mjs)通过正常 Viewer 的账户入口和生产 Control 服务执行。每组使用独立的 loopback 端口、数据库、Endpoint 数据目录和浏览器 Profile。远端 Chromium 页面每 80 ms 改变 24×24 的画面标记，用于保持真实 H.264 活跃并避开 Chrome 89 已知的 QSV 静态 1 FPS 路径。检查只涉及功能。

- 设置中开始采集，浮动控制中停止。采集期间检查无已完成文件、界面不显示 ID，停止后核对完成回执和界面 ID，并检查浏览器下载事件。
- 采集前、中、后核对同一 RTCPeerConnection、接收 track 和两个 DataChannel。媒体证据来自真实 H.264 解码和视频元素。
- 使用 Node Zstandard 解压验证服务端归档，核对 tar 校验和、结束块、JSON 条目及样本计数。样本须包含客户端入站计数和视频呈现、Endpoint 发送端计数、编码计数和 Chromium 输出状态。
- 可选重启组使用原数据库和原账户，通过新的已授权 Viewer WebSocket 查询已完成 ID。

实际用户环境为 UD710/Brave 138。此次桌面浏览器用例无法判定该设备上的卡顿、网络和解码行为。

## 实测结果

使用 Control 生产构建 `index-BDY4L7yy.js`、Node 24.22.0、现有 `build/endpoint-package/endpoint/endpoint_service.exe` 和 `C:/src/chromium/src/out/dev/remotekit_browser.exe`。客户端均使用隔离 Profile、无头模式、1152×820、DPR 1。试验端口均已释放。

| Viewer | 临时证据目录 | 归档大小 | 样本数（客户端 / Control / Endpoint / 事件） | 重启读回 |
| --- | --- | ---: | --- | --- |
| Chromium 157.0.8103.15 | `develop/tmp/diagnostic-collection-157-final` | 10,309 B | 4 / 3 / 3 / 2 | 同账户解锁后，`diagnostics.status` 返回原 ID、完成状态、停止原因和字节数 |
| Google Chrome 89.0.4389.90 | `develop/tmp/diagnostic-collection-89` | 10,401 B | 4 / 3 / 3 / 2 | 此组只验收采集、停止和落盘 |

两组均真实解码 H.264，采集前、中、后同一 peer、两个接收 track 和两个已打开的 DataChannel 保持。采集中没有已完成的服务端文件，也没有展示 ID。停止后完成回执和只读 ID 一致，浏览器未触发下载。归档可解压，包含五个预期成员，manifest 与条目样本数一致，无来源缺失或截断。入站视频帧、Endpoint 出站包、编码帧均有正值，Chromium 输出状态可用。两个版本的视频回调均保留呈现计数、回调时间、compositor 提交时间、预期显示时间和接收时间。每组有 101 条回调样本按 RTP 时间戳与媒体元数据匹配，样本窗口重叠。

Chrome 89 的稳定截图覆盖设置入口、浮动停止控件和结果框。157 的设置和浮动控件截图拍到了 MUI 淡入淡出过渡，完成截图中的完整 ID 可读。两组均未使用系统鼠标或切换窗口。

157 初次试验的本机 ICE mDNS 解析命中不可达地址，停在远端页面就绪前。在隔离 Viewer 启动时关闭本机候选地址的 mDNS 隐藏后完成连接。第二次试验已经生成含真实媒体数据的归档，运行器原先误读视频尺寸字段层级，按实际归档结构修正后两组通过。此处关闭 mDNS 仅属于运行器配置。
