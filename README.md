# RemoteKit

Windows 上的独立 Chromium content embedder 与 CMake/Ninja endpoint testing harness。

当前能力与边界见 [实现速查](docs/current-state.zh-CN.md)，整体设计见 [架构文档](docs/architecture.zh-CN.md)。

## 构建

Chromium 基线：官方 Release `157.0.8103.15`，本地 `C:\src\chromium\src` 的 `remotekit` 分支。保留并复用 `out/dev`、`out/rel`。在仓库根目录执行：

```powershell
tools\build-endpoint.cmd
python3 tools/patchset.py --chromium-root C:/src/chromium/src apply
python3 tools/chromium.py build
python3 tools/chromium.py build --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\verify-sdk.cmd
```

`python3` 应使用 depot_tools 的实际解释器或 `python3.bat`。本机 WindowsApps 的 `python` 别名不可用。CMake 脚本默认 VS 2026 Community；`REMOTEKIT_VS` 可覆盖安装路径。首次配置或编译器语言发生变化时可执行 `build-endpoint.cmd fresh`。

## 运行本地样例

```powershell
build\endpoint\endpoint\endpoint_client.exe --browser=C:\src\chromium\src\out\dev\remotekit_browser.exe --sessions=2
```

`--urls=URL1|URL2` 指定页面；PowerShell 中请将包含 `|` 的整个参数加单引号。页面轮流分配给指定数量的 Session，当前每个 Session 一个 Profile。可用 `--data-path=<绝对目录>` 选择数据根目录。

client 默认使用 `--presentation=fence`：browser 用 MaxRects 排列网页，GPU copy 到三槽共享 atlas；endpoint 用共享 Fence 同步并呈现。输入从 endpoint 经过 SDK 工作线程和 Mojo 进入 browser，坐标按 letterbox、atlas 像素和 viewport DIP 换算。SDK DLL 及其依赖须与 browser EXE 位于同一目录。

`--presentation=native` 显式选择 HWND 对照路径，原生输入直接进入 Chromium；不会在 Fence 失败时自动切换。控制协议见 [控制协议](docs/control-protocol.md)，GPU 完成点见 [GPU 输出](docs/gpu-output.zh-CN.md)。

复制到另一台 Windows x64 测试时运行 `tools\build-endpoint.cmd package`、`python3 tools/package-runtime.py`，再复制 `develop/tmp` 下生成的 ZIP。完整解压后运行 `run.cmd`；详见 [打包](docs/packaging.zh-CN.md)。

## 自动化验证

```powershell
python3 -m unittest discover -s tools -p test_patchset.py
python3 tools/chromium.py check
python3 tools/verify-integration.py
```

集成测试创建本地 fixture server、隐藏 browser 窗口和独立 CMake 控制客户端，不操作桌面。每次运行的结果与日志写入 `develop/tmp/acceptance-*`。
