# Comp / Rend 最终发布记录

2026-11-04，Windows x64。实际上传的源码版本为 `94cd1740148dda41f5609eb604bbd2d9d669fee3`，manifest 记录 clean。包内 Chromium 为 157.0.8103.15，Node 为 v24.22.0，默认 Intel QSV，附 NVENC 运行支持。

- ZIP `RemoteKit-win-x64-streaming-qsv-nvenc-20261104-004705.zip`，462555599 bytes。SHA-256 `3eb873b833d8e7a958726861187f190a35a8c12c8ef6b4e2dce28db4c3dc0117`。
- AirPortal 回执已确认，取件码 **352318**。上传表单显示 24 小时、可下载 2 次、无密码。回执于 2026-11-04 00:50:19（UTC+8）核对。 [下载链接](https://airportal.cn/352318/RGG7EQ9ZwD)

## 构建与包完整性

先构建并验收了 `54ae4c2` 临时包，ZIP 462555597 bytes，SHA-256 `75d7061a88c0862c25d13eef2ebd3d3bbe506200105ba0c9ceb031cff1342ffb`，保留在本地。该包四个主要原生模块 hash 与源码运行记录 run4 一致。随后移除 SDK 已不可达的 `invalid_output_fps` 日志白名单项，并修正 Endpoint 注释中的槽池名。增量 stage/build SDK、导出 SDK 和构建 Endpoint Release 后，外部 SDK、RTC 和 audio smoke 3/3 通过。Chromium Browser 和 Viz 复用 run4 构建。逐项对比两包 560 个 manifest runtime 条目，只有 Endpoint 和 SDK 的文件 hash 改变。

| 最终包内实际加载模块 | SHA-256 |
| --- | --- |
| `remotekit_browser.exe` | `64f1797e0d5e00af36b69178c8faf61a25a797dd3eb0a82cece0f884e56804bb` |
| `components_viz_service.dll` | `a0f7acb1b5d91e658211d015c494753738cb5b984d960403a3b84c5b08c49c57` |
| `endpoint_service.exe` | `012f9ef7a50900453b660242e50b9f89f01aa47387d98fcab6dd64f722e8c77a` |
| `remotekit_sdk.dll` | `59d6abc75cce7a54f0e80d1cfdfa63922daaae0558bae54817315289d75be63d` |
| `node.exe` | `ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c` |

最终包 `tools/package-runtime.py --smoke` 通过包内 Node、生产 UI、SQLite 首管理员注册、鉴权 WS、时钟、Endpoint 管理对账和 WS 拒绝产品操作检查。独立校验 560 项逐项大小和 SHA-256、ZIP 全部条目 CRC 及解压内容 hash、ZIP sidecar，以及 102 项随包 SDK 依赖。包中未发现 Profile、数据、凭据、PDB、日志或编译输入。manifest 渲染协议为 `slot-begin-reject-fence-v1`，标记逐帧 Begin 和 Reject IPC，成功帧无 IPC。

## 最终包独立产品检查

用包内 Node、Control 生产 bundle、Endpoint 和 Browser，在独立临时数据目录及端口 33821/33822 执行 host-managed Playwright。通过 UI 注册首管理员、退出后登录、创建 Window 并导航到受控页。浏览器页在播放前枚举到 `audiooutput`。RTC connected，DataChannel open，实际解码 H264，默认 video 为 1296×720、关闭原生 controls 并禁用画中画。实际鼠标点击由远端收到可信事件 (147, 90)，实际滚轮使远端 `scrollY=690`。RTC peer 和 video stream 对象保持，Browser 进程 30800 和 incarnation `5da7b9693f75a94784e8394dc6330664` 保持，运行日志无 fatal 或 GPU process exit。目视确认截图显示受控页和滚动结果。QA 进程与端口均释放后执行上传。

证据目录 `develop/tmp/comp-rend-delivery-20261104/final/`，含 `package-verification.json`、`result.json`、`loaded-hashes.json`、`packaged-viewer.png` 和经过筛选的 `upload-receipt.json`。本轮发布验证范围为最终包启动与最小产品链路。源码阶段 Chrome89、布局与输入、Idle/Wake、质量切换及网络短组见[真实运行记录](comp-rend-runtime-20261103.md)，新路径未重跑历史性能矩阵，也没有 NVENC 硬件验收。
