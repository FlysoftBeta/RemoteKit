# Windows 本机测试包

在开发机运行：

```
python3 tools/chromium.py build --target remotekit_browser --target remotekit_sdk
tools\build-endpoint.cmd package
python3 tools/package-runtime.py
```

默认包输出到 `develop/tmp/RemoteKit-win-x64-fence-atlas-<时间>` 及同名 ZIP。复制 ZIP 到另一台 Windows x64 机器，完整解压，再运行 `run.cmd`。默认打开两份离线输入页面，不需要 Python、Node、Visual Studio 或开发机路径。`run-web.cmd` 打开示例网页，也可传入用 `|` 分隔的一组 URL。`run-native.cmd` 显式使用 HWND 对照路径；Fence 失败不会自动切换。

脚本合并 browser 与 SDK 的 GN runtime_deps，补入 RemoteKit 资源、MSVC Release CRT 和独立 endpoint；排除 PDB、构建输入和开发机用户数据。`manifest.json` 记录 backend、源码基线、构建参数指纹和逐文件 SHA-256。ZIP 校验和另存为 `.zip.sha256`。

使用 `--presentation=native` 也可单独打 native-host 包。此前已生成的 native ZIP 不随源码变化。新 Fence 包已编译，尚未做硬件运行验证；需要能够共享 D3D11 texture/fence 的 Windows 硬件 adapter。Chromium 内部 frame IPC 保留，browser↔endpoint 的稳定输出不发送逐帧 Mojo 消息。

窗口标题显示 backend 或错误；浏览器日志在包内 `data/browser.log`，CDP 地址记录在 `data/DevToolsActivePort`。DevTools 只监听本机，不自动打开窗口。新状态和边界见 [实现速查](current-state.zh-CN.md)。
