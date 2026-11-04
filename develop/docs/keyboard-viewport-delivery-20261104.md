# 键盘与视口修复交付记录

本包来自干净的功能源码 `e910231cdd289e76a7e90eacbcaa6166a76e9085`，已推送到 `FlysoftBeta/RemoteKit`。包含尺寸过渡期间的编辑焦点、IME 与输入租约修复、Viewer 键盘 peek 与普通布局过渡，以及此前未单独打包的锁定默认值与纯白锁屏。

- 文件名 `RemoteKit-win-x64-streaming-qsv-nvenc-20261104-091638.zip`
- 大小 504941930 bytes
- SHA-256 `618ef0d6cfe8530fc19ef8e41708adb39c1eb2d90fbb5955f6851a6a130a8d40`
- manifest 记录 `remotekit_source_dirty=false`。571 项文件的大小和 SHA-256、ZIP 条目及 CRC、ZIP 内容哈希、校验和 sidecar 及 11 项人脸资产均通过。

## 验收

`tools/package-runtime.py --smoke` 使用包内 Node、Control、Endpoint 通过启动、首位管理员注册、已认证 WebSocket、Endpoint 管理链路、人脸模型可用性和有 Cookie 重附着锁定及密码恢复。产品操作走 RTC 的门禁通过。

另用隔离的 Chrome157 验证实际产品会话。包内 Endpoint、Browser 和 SDK 路径与已校验的产物一致。Viewer 真实收到 H.264，锁定期间没有新产品快照，PIN 解锁后恢复同一 peer 上的 H.264，保持两条 DataChannel。日志无 FATAL/CHECK/GPU 退出，本次包内验证进程已退出。

发布前的实际 Chrome157/89 键盘回归覆盖连续尺寸变化、composition 保持及一次提交、旧目标拒绝、真实失焦、两类画面过渡及媒体身份保持。Chrome89 使用合成的本地 composition 事件，远端走 Native IME。实体 Android/iOS 软键盘仍待验收。[构建](keyboard-viewport-build-20261104.md) · [运行](keyboard-viewport-runtime-20261104.md)

证据保存在 `develop/tmp/keyboard-viewport-delivery-20261104/package-verification.json`、`develop/tmp/package-smoke/1793755001574241300/result.json` 和 `develop/tmp/advanced-auth-qa/packaged-RemoteKit-win-x64-streaming-qsv-nvenc-20261104-091638/`。

## 上传

2026-11-04 09:20:04（Asia/Shanghai）核对 AirPortal 回执“文件已成功发送”。取件码 [137959](https://airportal.cn/137959/kAlssAvih0)。发送表单设置为 24 小时、2 次下载、无密码。通过页面复制链接取得地址，未发起下载。

共享 Edge 配置正在使用，本次使用已安装的 Playwright MCP 独立无头会话。上传确认页的工具回显显示了已登录账号邮箱。凭据文件及其内容未写入交付记录或打包，回执证据只保留非账户字段。
