# Windows 本机测试包

## 串流包

在开发机完成构建：

```powershell
python3 tools/chromium.py build --target remotekit_browser --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
Push-Location control
npm ci
npm run build
Pop-Location
python3 tools/package-runtime.py
```

默认输出到 `develop/tmp/RemoteKit-win-x64-streaming-qsv-nvenc-<时间>` 与同名 ZIP。复制到目标Windows x64机器并完整解压，运行 `run.cmd`，在客户端打开 `http://127.0.0.1:3001`。包中包含Node、Control生产bundle、React客户端和最小SQLite运行依赖，不需要开发工具。硬件编码运行时由目标机器Intel/NVIDIA驱动提供。

`run.cmd` 设置Endpoint/browser路径、SQLite和Session数据位置。初次运行在包内创建 `data/`，诊断结果写入 `metrics/`。不同浏览器会话对应独立Tenant。接收档、设备配置和网络模拟见 [Control说明](../control/README.md)，实际性能结果见 [串流实验](streaming-experiments.zh-CN.md)。

可在命令行追加Endpoint参数，例如`run.cmd --browser-render-fps=16 --rtc-playout-max-ms=0`。参数使用`--name=value`，包含空格时加引号；包内Node launcher将参数作为数据追加到默认参数之后，不需手改JSON或启动脚本。无参数运行保持默认设置，具体实验档位的效果见串流实验。

## 原生对照包

```powershell
python3 tools/chromium.py build --target remotekit_browser_demo --target remotekit_sdk
tools\build-endpoint.cmd package-demo
python3 tools/package-runtime.py --kind demo
```

此包使用显式编译的 `remotekit_browser_demo` 和原生Endpoint client，默认打开离线输入页面。`run-web.cmd` 可打开指定网页，`run-native.cmd` 明确选择HWND路径；Fence失败不会自动切换。`--kind demo --presentation native` 可单独生成native包。

## 内容与可追踪性

脚本收集browser/SDK的GN运行依赖、Release Endpoint与CRT、Control生产运行文件和许可证；排除PDB、编译输入、凭据及开发Profile。`manifest.json` 记录源码基线、构建参数指纹、backend和逐文件SHA-256，ZIP另有 `.sha256` 文件。

browser↔endpoint稳态没有逐帧Mojo；endpoint↔client会发送视频对应的RTP/显示代次元数据。Chromium内部frame IPC保留。打包本身不代表该ZIP已启动验收；交付记录应说明是否对最终包另行运行，以及当前硬件与性能结果。
