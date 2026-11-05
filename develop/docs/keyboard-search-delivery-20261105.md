# 搜索框软键盘修复交付

发布包来自已推送的干净提交 `e87e6e0d3b208efa11938371ea51601a51a32377`。首次点击后，同文档搜索框换代保留本地键盘意图，旧组合输入立即失去派发资格。持续失焦会收起键盘，系统收起后可用悬浮按钮重新打开。[复现与实现](keyboard-search-investigation-20261105.md)

## 成品校验

- 文件 `RemoteKit-win-x64-streaming-qsv-nvenc-20261105-124446.zip`，505533996 bytes。
- SHA-256 `916878e67bb1ab11cdd7a54795c357fd0a4d413d4e83220bc0b4cf598574020e`。
- 570 项 manifest 文件通过大小和 SHA-256 核验，ZIP 中 571 项（含 manifest）通过 CRC 和 SHA-256 核验。52 项 Control 文件与最终生产构建逐项一致，包含 `index-C1ca75zq.js`。504 项 bin 文件与已验证的 `002aab5` 成品一致，Browser、SDK、Endpoint 和 oneVPL dispatcher 另与构建输入核对。11 项人脸运行时资产与源文件核对通过。归档含 Release CRT，未包含调试符号、编译输入、凭据、Profile、日志或测试包。
- 包内 Node、Control、Endpoint 通过启动、首位管理员注册、认证 WebSocket、Endpoint 管理、人脸模型加载、重附着锁定与密码恢复检查。

## 包内真实串流回归

由包内 Node 启动包内 Control、Endpoint 和 Browser，使用正式 `tools/test-mobile-ime.mjs` 和共享 fixture。Chrome 157.0.8103.15 Viewer 以触屏、粗指针、DPR2 和模拟视口运行，实际串流由 QSV 编码 H.264。可信点击触发搜索框替换，换代期间旧组合提交发送零包，替换目标收到一次精确 target 的 IME 提交及一次对应的远端 Native `compositionend`。模拟系统收起、手动重开和失焦后的拉丁输入通过。peer、两条 DataChannel、video、stream 和轨道保持。

测试退出码为 0，日志无 FATAL、CHECK 或 GPU 退出，测试进程已退出。数据与 Profile 在包外，Chromium 产生的 `bin/debug.log` 已移到证据目录，ZIP 在回归前生成并已逐项校验。本组使用桌面 Chromium 的 CDP 组合输入与模拟 Android 式视口，实体键盘仍待设备验收。

证据位于 `develop/tmp/keyboard-search-delivery-20261105/`，包括 `package.log`、`package-verification.json` 与 `packaged-mobile-157/`。启动检查证据位于 `develop/tmp/package-smoke/1793853888553271500/`。

## 上传与停止指示

独立无头 Playwright MCP 按此前授权执行上传。AirPortal 于 2026-11-05 12:50:37（UTC+8）确认文件已成功发送，取件码 [248478](https://airportal.cn/248478/ra8Byw97bG)。发送表单为 24 小时、2 次下载、无密码。只读核验取件页显示本次 ZIP，未触发下载。回执保存在本轮证据目录的 `upload/completion.json` 和 `upload/verified-link.json`。

随后收到用户“先不要上传”的指示。此时文件已发送成功，无法取消在途上传。12:51:13（UTC+8）已关闭自建页面和 MCP 进程，确认监听退出。未重试或撤回已完成文件。保留本地 ZIP、校验报告与运行证据。
