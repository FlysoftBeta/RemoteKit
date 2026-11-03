# RemoteKit

Windows 上的多租户 Chromium content embedder、独立 CMake/Ninja Endpoint 与浏览器串流工作区。

[当前能力](docs/current-state.zh-CN.md) · [架构](docs/architecture.zh-CN.md) · [渲染](docs/rendering.zh-CN.md) · [Control](control/README.md) · [测量与实验](docs/streaming-experiments.zh-CN.md)

## 构建

Chromium 固定官方 Release `157.0.8103.15`，复用 `C:\src\chromium\src` 的 `out/dev`、`out/rel` 增量。在仓库根目录执行：

```powershell
python3 tools/patchset.py --chromium-root C:/src/chromium/src apply
python3 tools/chromium.py build --target remotekit_browser --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
```

`python3` 使用 depot_tools 实际解释器或 `C:\src\depot_tools\python3.bat`。`REMOTEKIT_VS` 可覆盖 VS 安装路径，`REMOTEKIT_PYTHON` 可覆盖工具脚本使用的解释器。媒体依赖由固定版本/hash工具获取到 `build`；Endpoint 编译不触发 Chromium 构建。

## 串流工作区

```powershell
cd control
npm ci
npm run build
$env:REMOTEKIT_ENDPOINT = (Resolve-Path ..\build\endpoint-package\endpoint\endpoint_service.exe).Path
npm start
```

默认监听 `http://127.0.0.1:3001`。Control 使用 SQLite 保存产品状态，通过父子进程 JSONL 管理 Endpoint；客户端与 Endpoint 直接传 WebRTC 视频和输入。每租户独立 Session/browser/Profile/atlas，同租户多页面合并一条视频。

未设置 `REMOTEKIT_ENDPOINT` 时使用开发构建目录；以上命令明确选择Release服务。

browser/SDK路径、账号设置、站点UA与诊断说明见 [Control README](control/README.md)。性能结果按实际编码尺寸报告，硬件编码吞吐与端到端延迟分别测量。

## 原生对照 Demo

原内置测试控制面只在显式目标中编译：

```powershell
python3 tools/chromium.py build --target remotekit_browser_demo
tools\build-endpoint.cmd package-demo
build\endpoint-package\endpoint\endpoint_client.exe --browser=C:\src\chromium\src\out\dev\remotekit_browser_demo.exe --sessions=2 --presentation=native
```

`--urls=URL1|URL2` 指定页面，PowerShell中将整个参数加单引号。demo使用显式`--presentation=native` HWND对照；其fence模式明确拒绝，正式streaming通过新OSR/Fence路径工作，不作失败回退。SDK DLL/runtime与browser放在一起。

## 打包与检查

完成Control生产构建和Release Endpoint后，`python3 tools/package-runtime.py` 生成含Node/runtime的串流包，位于 `develop/tmp`，完整解压运行 `run.cmd`。原生包使用 `--kind demo`；详见 [打包](docs/packaging.zh-CN.md)。

```powershell
tools\verify-sdk.cmd
python3 -m unittest discover -s tools -p test_patchset.py
python3 tools/test-endpoint-service.py
```

Control检查使用 `npm test`、`npm run build`；旧harness集成工具为 `tools/verify-integration.py`，需显式demo构建。所有测试使用独立数据目录，不读取开发Profile。
