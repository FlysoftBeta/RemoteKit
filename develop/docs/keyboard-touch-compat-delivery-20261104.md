# 站点兼容设置、键盘与触控交付记录

发布包来自干净的 `4bf43b8b5cd72aab14a38f8dd2409a7b3005f97f`，该功能提交已推送至 `FlysoftBeta/RemoteKit`。包含站点键盘自动弹出开关与手动键盘按钮、可视视口偏移下的固定 Viewer 壳，以及无需重连的触控终止回执恢复。

- 文件名 `RemoteKit-win-x64-streaming-qsv-nvenc-20261104-111144.zip`
- 大小 504955936 bytes
- SHA-256 `3eb1522597e445fed97e4d772592c2c5e348bd77cb9e828e043b73bfec0be186`
- manifest 记录 `remotekit_source_dirty=false`。571 项文件的大小与 SHA-256、ZIP 572 个文件（含 manifest）的 CRC 和内容哈希、ZIP 的 SHA-256 与 sidecar、11 项人脸资产均通过。归档内无开发 Profile、日志、凭据、PDB 或编译输入。

## 包内验收

`tools/package-runtime.py --smoke` 使用包内 Node、Control 与 Endpoint，通过启动、首位管理员注册、已认证 WebSocket、Endpoint 管理链路、人脸模型检查、重附着锁定与密码恢复，以及 WebSocket 产品操作门禁。

包内 Node 使用未改动的 `tools/test-keyboard-viewport.mjs` 和同目录 fixture，对包内 Control dist、Endpoint 与 Browser 运行隔离的 Chrome157 回归。退出码为 0。单 Browser 实际使用 QSV 并建立 H.264 会话，手动与自动键盘、IME 单次提交、真实失焦、仅偏移时保持原布局、两指逐个抬起、可信点击与滚动均通过。屏蔽前三次查询回执后第四次确认 `processed`，保持同一 peer、两条 DataChannel 和媒体对象。日志无 FATAL、CHECK 或 GPU 退出，本次包内测试进程均已退出。包内回归产生的 `bin/debug.log` 已移到证据目录，归档生成在回归前，复核未包含该日志。

发布前的开发产物另通过 Chrome157/89 实际运行。实体 Android/iOS 键盘及系统候选窗仍待设备验收。[构建](keyboard-touch-compat-build-20261104.md) · [运行](keyboard-touch-compat-runtime-20261104.md)

证据在 `develop/tmp/keyboard-touch-compat-delivery-20261104/`，包括 `package-clean.log`、`package-verification.json` 与 `packaged-157/`。启动 smoke 证据为 `develop/tmp/package-smoke/1793761906989180300/result.json`。

首次打包过程中，Playwright MCP 的预检输出使工作树出现未跟踪的 `.playwright-mcp/`，该次 manifest 标记为 dirty。将预检输出移入 `develop/tmp` 并配置浏览器输出目录后，以同一功能提交干净重打。首包保留本地证据，未发布。包内 README 的初始屏颜色仍写为黑色，产品实际显示纯白。

## 上传

2026-11-04 11:25:42（Asia/Shanghai）核对 AirPortal 回执“文件已成功发送”。取件码 [152167](https://airportal.cn/152167/lxM1Fft5Xz)。发送表单设为 24 小时、2 次下载、无密码。通过页面的复制按钮获取地址，未发起下载。独立无头 Playwright MCP 会话的发布回执字段保存在证据目录的 `airportal-receipt.json`。

