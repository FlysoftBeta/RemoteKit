# 构建、补丁与发布

## 环境

- Windows x64，Visual Studio 18 Community（`REMOTEKIT_VS` 可覆盖安装路径）。
- Chromium 固定官方 157.0.8103.15，checkout 在 `C:\src\chromium\src`（基线 `1aa07b638799e59656559ae6c6649d4b197f555e`），复用 `out/dev`（开发）与 `out/rel`（发布）增量产物。
- Python 使用 depot_tools 的解释器 `C:\src\depot_tools\python3.bat`（`REMOTEKIT_PYTHON` 可覆盖）。不要用 WindowsApps 的 `python3` 空别名。
- Node.js 与 npm（Control）。

## 三个独立的构建域

| 域 | 命令 | 产物 |
|---|---|---|
| Browser + SDK（在 Chromium 树内） | `tools/chromium.py stage` → `tools/chromium.py build --target remotekit_browser --target remotekit_sdk` | `out/dev/remotekit_browser.exe`、`remotekit_sdk.dll` |
| Endpoint（CMake/Ninja） | `tools\build-endpoint.cmd`（构建 + CTest）；`build-only`；`package`（Release `endpoint_service`）；`fresh` | `build/endpoint`、`build/endpoint-package` |
| Control（npm） | `npm ci`；`npm test`；`npm run build` | `control/dist` |

三者可以并行构建；同一个 Chromium out 目录不要并发构建。Endpoint 不包含 Chromium 私有头，只依赖导出的 SDK；Endpoint 的媒体依赖（nlohmann/json、oneVPL、NVENC 头）由 `tools/fetch-media-deps.py` 按固定版本与 hash 获取，人脸依赖（静态 OpenCV、YuNet/SFace/MiniFASNet 模型与许可证）由 `tools/setup-face-auth.py` 按 `tools/face-auth-deps.json` 准备，必要时从官方权重转换 ONNX。

**Chromium 叠加层**：`browser/` 不是 Chromium tracked 源码，由 `tools/chromium.py stage` 复制到 Chromium 树中（只更新变化文件的 mtime，带 hash 保护地清理已删除的文件）。**补丁**：对 Chromium tracked 源码的修改只能放在 `patches/` 的有序补丁里，由 `tools/patchset.py --chromium-root C:/src/chromium/src status|apply|revert` 管理；`patches/manifest.json` 记录顺序与每个补丁的 SHA-256。修改补丁后更新 hash，并验证可以完整撤回与重放。不要 reset 或 clean Chromium checkout（其中还有无关的分支与暂存）。

| 补丁 | 作用 |
|---|---|
| 0010 client-gesture-arbitration | 客户端手势候选的 touch-action/preventDefault 与逐包 ACK 仲裁、惯性期间保持 touch-action |
| 0013 remotekit-osr-output | 离屏 OSR 输出设备：完整 token、Begin 到 GPU 的顺序、完整重绘、真实 ANGLE Fence |
| 0014 webrtc-screenshare-adaptation | RemoteKit screencast 的 BALANCED/质量缩放资格；导出 H.264 解析器 |
| 0015 page-lifecycle-ack | 冻结/解冻的精确 renderer 回执与连接代次 |
| 0016 file-chooser-input-anchor | 报告文件输入框的实时位置用于锚定文件篮 |

**SDK 导出**：`tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev` 导出公共头、import lib、DLL 以及 GN 生成的 `remotekit_sdk.runtime_deps` 中的全部文件（component 构建需要整套依赖 DLL），并写 manifest（Chromium HEAD、args.gn hash、PE 架构、编译器、ABI 版本）。`tools\verify-sdk.cmd` 用独立的 CMake 消费者（`sdk/`）构建并运行 SDK smoke。Browser、SDK、Endpoint 的 ABI 与映射版本必须一起更新。

## 运行

```powershell
cd control
npm ci
npm run build
$env:REMOTEKIT_ENDPOINT = (Resolve-Path ..\build\endpoint-package\endpoint\endpoint_service.exe).Path
npm start
```

默认监听 `http://127.0.0.1:3001`。开发时 `npm run dev`（服务端）+ `npm run client`（Vite 5173，代理 HTTP/WS）。

| 环境变量 | 用途 |
|---|---|
| `PORT`、`REMOTEKIT_CONTROL_HOST` | 端口与监听地址 |
| `REMOTEKIT_CONTROL_ORIGINS` | 允许的完整 Origin，逗号分隔 |
| `REMOTEKIT_CONTROL_DB` | SQLite 文件 |
| `REMOTEKIT_ENDPOINT`、`REMOTEKIT_ENDPOINT_ARGS` | 本地 Endpoint 可执行文件与 JSON 参数数组 |
| `REMOTEKIT_ENDPOINT_NODE_ID`、`REMOTEKIT_ENDPOINT_TOKEN` | 远端节点 ID 与管理 Bearer 密钥；设置后不启动本地 Endpoint |
| `REMOTEKIT_ENDPOINT_TLS_PROXY=1` | 位于本机 TLS 反向代理之后（只接受 loopback 代理且 `X-Forwarded-Proto=https`） |
| `REMOTEKIT_HTTPS_KEY`、`REMOTEKIT_HTTPS_CERT` | 直接 TLS |
| `REMOTEKIT_DIAGNOSTICS_DIR` | 诊断归档目录 |

Endpoint 侧：`REMOTEKIT_BROWSER`（Browser 可执行文件）、`REMOTEKIT_DATA_PATH`、`REMOTEKIT_ENCODER` / `--encoder=qsv|nvenc|auto`、码率/GOP/TU 等编码参数（见[编码](encoding.md#encoderworker帧的所有权)）、`--browser-trace-dir`、`REMOTEKIT_SERVER_TRACE`、`REMOTEKIT_MEDIA_TRACE`。

局域网或远程部署需要正确的监听地址、Origin 与可信 HTTPS：摄像头、文件选择中的拍照等能力要求安全上下文。远端 Endpoint 主动连接 `/api/endpoint`（WSS），loopback 明文只用于开发；Control 当前只绑定一个配置的节点。

## 发布包

```powershell
C:\src\depot_tools\python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk
C:\src\depot_tools\python3.bat tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
npm --prefix control run build
C:\src\depot_tools\python3.bat tools/package-runtime.py --smoke
```

`tools/package-runtime.py` 把 Browser/SDK 运行依赖、Release Endpoint 与 CRT、Node、Control 生产 bundle 与最小 node_modules（better-sqlite3 的原生 ABI 与 Node 一起校验）、oneVPL 依赖、人脸模型与许可证组装成目录、ZIP 和 SHA-256，输出在 `develop/tmp`。完整解压后运行 `run.cmd`，打开 `http://127.0.0.1:3001` 创建首个管理员账号。首次运行在包外创建 data；包里不含开发账号、Profile、凭据、数据库、日志、PDB 或构建输入。`--smoke` 在临时数据目录启动包内服务，检查静态资源、注册、鉴权 WS、SQLite 与时钟接口，并确认 WS 无法绕过 WebRTC 提交产品动作；它不验证媒体链路。manifest 记录源码与 Chromium 身份、GN 参数、后端与渲染协议、逐文件 hash。注意：manifest 里的源码 HEAD 是打包时的源码，不证明每个增量产物都由它重新构建——曾经只拷贝了 Browser EXE 而漏掉了包含修复的 Viz 组件 DLL。

## 测试

| 位置 | 内容 | 运行 |
|---|---|---|
| `control/test/` | Control 服务端与 Viewer 客户端的单元与集成测试 | `npm test`，或 `npx tsx --test test/<file>.test.ts` |
| `endpoint/tests/` | Endpoint 策略、文件、编码器状态机（注入式 NVENC）、传输 | `tools\build-endpoint.cmd` 自带 CTest |
| `browser/*_probe.cc`、`*_tests.cc` | 直接运行生产代码与官方 Chromium 过滤器的确定性检查（BeginFrame 调度、手势包与仲裁、控制回复、Profile 隔离、渲染通道寿命、滚动策略、导航账本与错误页） | GN 目标，构建后运行 |
| `sdk/` | SDK 消费者 smoke（控制、渲染、RTC、音频） | `tools\verify-sdk.cmd` |
| `tools/tests/` | 构建工具（补丁管理、stage、打包布局） | `python -m unittest` |
| `tests/integration/` | 原生 Endpoint/Browser 集成（服务、恢复、几何、信令、关闭 ACK、生命周期、Profile、硬件编码 SPS 检查） | 需要构建好的原生二进制 |
| `tests/e2e/` | 真实栈产品场景（Viewer + Control + Endpoint + Browser + H.264）：通用产品流、手势、键盘与移动 IME、文件库与相机、全屏、诊断、首帧 | 需要完整构建与浏览器 |

CPU 单元测试、编译、真实 GPU 运行、实体设备验证是不同层级的证据，分开记录。
