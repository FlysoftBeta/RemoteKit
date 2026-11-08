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

三者可以并行构建；同一个 Chromium out 目录不要并发构建。Endpoint 不包含 Chromium 私有头，只依赖导出的 SDK；Endpoint 的依赖（nlohmann/json、oneVPL、NVENC 头、zstd 1.5.7 源码）由 `tools/fetch-media-deps.py` 按固定版本与 hash 获取；Endpoint 链接完整 zstd，updater 只链接解压部分，人脸依赖（静态 OpenCV、YuNet/SFace/MiniFASNet 模型与许可证）由 `tools/setup-face-auth.py` 按 `tools/face-auth-deps.json` 准备，必要时从官方权重转换 ONNX。

**Chromium 叠加层**：`browser/` 不是 Chromium tracked 源码，由 `tools/chromium.py stage` 复制到 Chromium 树中（只更新变化文件的 mtime，带 hash 保护地清理已删除的文件）。**补丁**：对 Chromium tracked 源码的修改只能放在 `patches/` 的有序补丁里，由 `tools/patchset.py --chromium-root C:/src/chromium/src status|apply|revert` 管理；`patches/manifest.json` 记录顺序与每个补丁的 SHA-256。修改补丁后更新 hash，并验证可以完整撤回与重放。不要 reset 或 clean Chromium checkout（其中还有无关的分支与暂存）。

| 补丁 | 作用 |
|---|---|
| 0010 client-gesture-arbitration | 客户端手势候选的 touch-action/preventDefault 与逐包 ACK 仲裁、惯性期间保持 touch-action |
| 0013 remotekit-osr-output | 离屏 OSR 输出设备：完整 token、Begin 到 GPU 的顺序、完整重绘、真实 ANGLE Fence |
| 0014 webrtc-screenshare-adaptation | RemoteKit screencast 的 BALANCED/质量缩放资格；导出 H.264 解析器 |
| 0015 page-lifecycle-ack | 冻结/解冻的精确 renderer 回执与连接代次 |
| 0016 file-chooser-input-anchor | 报告文件输入框的实时位置用于锚定文件篮 |

**SDK 导出**：`tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev` 导出公共头、import lib、DLL 以及 GN 生成的 `remotekit_sdk.runtime_deps` 中的全部文件（component 构建需要整套依赖 DLL），并写 manifest（Chromium HEAD、args.gn hash、PE 架构、编译器、ABI 版本）。`tools\verify-sdk.cmd` 用独立的 CMake 消费者（`sdk/`）构建并运行 SDK smoke。Browser、SDK、Endpoint 的 ABI 与映射版本必须一起更新。

## Chromium 配置

`chromium.py gen/build` 保留已有 `args.gn`，只补齐 RemoteKit 的 `root_extra_deps`，不从模板覆盖配置。生产包默认使用 `out/rel`，参数如下：

```gn
is_debug = false
is_component_build = false
is_official_build = false
dcheck_always_on = false
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
is_chrome_branded = false
use_siso = true
proprietary_codecs = true
ffmpeg_branding = "Chrome"
rtc_use_h264 = true
root_extra_deps = [
  "//remotekit/browser:remotekit_browser",
  "//remotekit/browser/sdk:remotekit_sdk",
]
```

开发配置 `out/dev` 继续使用 `is_component_build = true`、`dcheck_always_on = true`、`symbol_level = 1`，其余功能参数与发布配置相同；两者都不配置额外 DRM 模块。`is_official_build = false` 保留本地非官方构建，发布包关闭 DCHECK 与调试符号。

## 运行

```powershell
cd control
npm ci
npm run build
npm start
```

默认监听 `http://127.0.0.1:3001`。开发时 `npm run dev`（服务端）+ `npm run client`（Vite 5173，代理 HTTP/WS）。

Control 只读一个环境变量 `REMOTEKIT_CONTROL_CONFIG`（默认 `control/data/control.json`，不存在时按默认值创建，同时生成集群密钥文件）。所有监听、访问地址、存储与节点配置都在这个文件里，格式与校验规则见[多节点 · 配置](cluster.md#配置)。默认配置有一个本地节点 `local`，`local.executable` 指向 `build/endpoint/endpoint/endpoint_service.exe`；开发时在 `nodes.local.browser` 指向 `C:/src/chromium/src/out/dev/remotekit_browser.exe`（默认是 Endpoint 同目录）。编码器与码控参数（见[编码](encoding.md#适配器与后端选择)）、`browserTraceDir` 等都写在 `nodeDefaults` 或节点项里；Endpoint 不接受这些命令行参数。开发追踪开关 `REMOTEKIT_SERVER_TRACE`、`REMOTEKIT_MEDIA_TRACE` 仍是环境变量（见[诊断](diagnostics.md#开发侧追踪)）。

**远端节点**：在 Control 配置里设置 `cluster.controlUrl`（节点访问 Control 的 `ws(s)://<地址>:<端口>/api/node`），在 `nodes` 中加入节点 ID（不带 `local`），写明 `peer.address`，Viewer 不在同一网络时再设 `rtc.ports` 与 `rtc.address`。Control 启动后写出 `config/nodes/<节点 ID>/node.json`。在节点上解压 Endpoint 引导包，把该文件原样复制到 `run-endpoint.cmd` 同目录，再运行：

```powershell
.\run-endpoint.cmd
# 或注册为 Windows 服务（管理员）
.\remotekit_node.exe service-install "--root=$PWD"
```

节点从 Control 下载与之相同版本的运行时后启动 Endpoint。`peer.listen` 端口要对其他节点开放，`rtc.ports` 的 UDP 端口段要对 Viewer 开放（经路由器时转发到节点）。局域网或远程部署需要正确的监听地址、Origin 与可信 HTTPS：摄像头、文件选择中的拍照等能力要求安全上下文；集群通道自身已加密，不依赖 TLS。

## 发布包

```powershell
C:\src\depot_tools\python3.bat tools/release.py
```

`tools/release.py` 是唯一的发布入口：工作树有未提交改动时拒绝；依次执行 stage、Chromium `out/rel` 构建（Browser + SDK）、SDK 导出、Endpoint 打包构建、Control 构建，再运行 `package-runtime.py --smoke`，最后打印归档路径、大小、SHA-256 与 manifest 的来源摘要。任一步失败即停止。

`tools/package-runtime.py` 也可单独运行（默认 `--out rel`），在 `develop/tmp/<时间戳>/` 输出两套解包目录、`.tar.zst` 和 `.tar.zst.sha256`。它先检查产物是否新鲜，任一项不满足就拒绝打包并指出是哪个组件：`tools/chromium.py stage --check` 有待同步的源码；Chromium out 目录对 `remotekit_browser remotekit_sdk` 还有待执行的构建（ninja 干跑）；Endpoint 打包构建目录还有待执行的构建；`control/dist` 比 `control/server`、`client`、`shared` 下最新的源文件旧。

**来源**：manifest 记录 `source{commit, dirty}`（dirty 指 browser/、endpoint/、control/、protocol/、sdk/、tools/、patches/ 下有未提交改动；只有 `release.py` 保证为 false）和 `artifacts`（实际打包的 Browser、Endpoint、Node、Control 服务端文件的 SHA-256），据此可以确认某个修复是否在包里。

**Node 运行时**：`tools/node_runtime.py` 固定一个版本（v24.20.0，ABI 137，与 Control 的 better-sqlite3 匹配），从 nodejs.org 下载官方 Windows x64 zip，用脚本内写死的 SHA-256 校验，解压到仓库外的构建缓存 `%LOCALAPPDATA%/RemoteKit/build-cache/`，带官方 `LICENSE`。打包只用这个运行时，不接受手动指定。

| 部署方式 | 发布包 | 启动入口 |
|---|---|---|
| Control + 本地 Endpoint | `RemoteKit-control-win-x64.tar.zst` | `run.cmd` 首次离线安装节点运行时，再由 Control 经 stdio 启动本地 Endpoint。 |
| 仅 Control | `RemoteKit-control-win-x64.tar.zst` | `run-control.cmd`，初始配置为 `nodes: {}`。远端节点可在配置中登记。 |
| 仅 Endpoint | `RemoteKit-endpoint-win-x64.tar.zst` | 放入 Control 生成的 `config/nodes/<节点 ID>/node.json`，运行 `run-endpoint.cmd`。updater 下载、安装并监管 Endpoint。 |

Control 包包含 Node、Control 生产 bundle、匹配 Node ABI 的 better-sqlite3、updater 与 CRT。Endpoint、Browser、SDK、oneVPL 和人脸模型集中在 `release/node.tar.zst`。本地安装和远端更新共用该归档及记录 buildId、SHA-256 和大小的 `release/node.json`。Endpoint 引导包带 updater、CRT、启动脚本和许可证。

Control 启动脚本首次生成 `config/control.json`。合部署把运行时安装到 `data/local/runtime/<buildId>/`，节点根目录仍为 `data/node/`。升级时停止服务，把新版 Control 包部署到同一根目录并保留 `config/`、`data/`。`run.cmd` 每次启动先安装本包 buildId 的运行时，Control 按自身 buildId 找到本地 Endpoint，升级不改配置。如果切换到仅 Control 模式，先移除本地节点项。

默认打开 `http://127.0.0.1:3001` 创建首个管理员账号。归档只收录运行文件与许可证。Control 包 manifest 记录打包时的源码与 Chromium 身份、GN 参数、后端与渲染协议、逐文件 hash。构建 ID 由 Control 包的 `bin/`、`control/` 和归档内 `node/bin/` 的文件路径及 hash 计算。

`--smoke` 把 Control 包复制到隔离目录，在副本内安装节点运行时并验证启动、鉴权和 Endpoint 管理。安装生成的 `data/local` 留在副本内，归档继续使用原始打包目录。真实 Viewer 的产品操作和媒体验证使用独立端到端测试。

打包使用 Node 24 内置 zstd（level 12、全部逻辑 CPU），tar 以固定 32 MiB 缓冲流入压缩器，输出标准串联 zstd frames，不生成中间 tar，也不把整个包读入内存。逐 frame 使用同步结束指令，避开 Node 24 异步多线程 zstd 的提前 EOF 问题；每个 frame 内仍由原生 zstd 多线程压缩。`--out dev` 显式生成开发包。manifest 的 `browser_configuration` 标记 `rel`/`dev`，`archive` 记录完整归档名。

Endpoint 编译直接包含仓库 `sdk/include` 公共头，不链接 SDK import lib；运行时通过 `LoadLibraryExW` 加载 Browser 同目录的 `remotekit_sdk.dll` 并解析 C ABI。发布 SDK 导出到独立 `sdk/dist/rel`；非 component 构建的 runtime deps 缩减后，打包仍从 GN 图收集 Browser 和 SDK 的完整运行依赖，不沿用开发 DLL 目录。

解压支持 7-Zip ≥ 24（先解压 zstd，再解包 tar）或内置 zstd 支持的 tar。部分 Windows 11 的 tar 不支持 zstd；不要只凭操作系统版本判断。本机 `C:\Windows\System32\tar.exe --version` 为 bsdtar 3.8.9 / libzstd 1.5.7，已用归档往返验证；7-Zip 为 26.05。

```powershell
# 使用支持 zstd 的 tar；目标目录须已存在。
C:\Windows\System32\tar.exe -xf "RemoteKit-win-x64-....tar.zst" -C "C:\RemoteKit"
# 或用 7-Zip 两步解包（产生中间 .tar）。
& "C:\Program Files\7-Zip\7z.exe" x "RemoteKit-win-x64-....tar.zst" -oC:\RemoteKit
& "C:\Program Files\7-Zip\7z.exe" x "C:\RemoteKit\RemoteKit-win-x64-....tar" -oC:\RemoteKit
# 验证归档 hash 并解压到隔离目录，然后运行启动检查。
C:\src\depot_tools\python3.bat tests/e2e/test-streaming-package.py --archive "RemoteKit-win-x64-....tar.zst"
# 对解压后的独立副本检查注册、窗口、H.264 解码、可信点击与滚动；结果写入 evidence。
node tools/tests/streaming-package-real-stack.mjs "C:/RemoteKit/RemoteKit-win-x64-..." "C:/path/to/playwright" "C:/path/to/msedge.exe" "develop/tmp/package-real-stack"
```

## 测试

| 位置 | 内容 | 运行 |
|---|---|---|
| `control/test/` | Control 服务端与 Viewer 客户端的单元与集成测试 | `npm test`，或 `npx tsx --test test/<file>.test.ts` |
| `endpoint/tests/` | Endpoint 策略、文件、编码器状态机（注入式 NVENC）、集群通道（Noise 向量、通道、ClusterLink）、对象存储与节点间传输、checkpoint、updater（下载、解包、监管、自我替换） | `tools\build-endpoint.cmd` 自带 CTest |
| `browser/*_probe.cc`、`*_tests.cc` | 直接运行生产代码与官方 Chromium 过滤器的确定性检查（BeginFrame 调度、手势包与仲裁、控制回复、Profile 隔离、渲染通道寿命、滚动策略、导航账本与错误页） | GN 目标，构建后运行 |
| `sdk/` | SDK 消费者 smoke（控制、渲染、RTC、音频） | `tools\verify-sdk.cmd` |
| `tools/tests/` | 构建工具（补丁管理、stage、打包布局） | `python -m unittest` |
| `tests/integration/` | 原生 Endpoint/Browser 集成（服务、恢复、几何、信令、关闭 ACK、生命周期、Profile、sessionStorage 与优雅关闭、checkpoint 跨节点恢复、硬件编码 SPS 检查；Noise 互通与 updater 端到端）。Python 测试经 `cluster-bridge.mjs` 扮演 Control（握手、下发配置、自动 `session.open`），对外仍是 JSONL | 需要构建好的原生二进制 |
| `tests/e2e/kit/` 与 `workspace-ui.mjs`、`web-app-install.mjs`、`drive.mjs` | Viewer UI 的真实栈场景。`kit/stack.mjs` 是唯一的一次性栈启动器（Control 源码 + Vite + 夹具服务器，运行目录在 `develop/tmp/e2e/`，数据目录刻意不在 TEMP 下）；夹具有带 manifest 的笔记页和使用 File System API 的 `/fs/`。`kit/viewer.mjs` 提供 Playwright 会话（Edge 或 Chrome 89、DPR、鼠标或触摸，Chrome 89 与触摸用原始 CDP 事件）、逐步 ok/FAIL 日志、开始屏幕与地址栏操作、锁定与按键/点按区域解锁、Browser 是否重启的检查。开发构建里的 `window.__remotekitTest`（`state()`、`unlock()`）直接读产品状态并走与完成图案相同的解锁路径，生产构建中不存在。`drive.mjs` 保持栈与 Viewer 打开，经本地 HTTP 接受点击、输入、截图等命令，用于探索；`kit/usage-report.mts` 输出 usage 记录与 frecency 得分 | `node tests/e2e/workspace-ui.mjs [--browser chrome89] [--dpr 2] [--pointer touch]`，任一步失败退出码非零；需要已构建的 `out/rel` Browser 与 Endpoint |
| `tests/e2e/`（其余） | 真实栈产品场景（Viewer + Control + Endpoint + Browser + H.264）：通用产品流、手势、键盘与移动 IME、文件库与相机、全屏、诊断、首帧；两个本地节点的同时串流、休眠与跨节点唤醒（`test-cluster-nodes.mjs`）；updater 下载、安装与版本切换（`test-node-updater.mjs`，用 `make-node-release.mjs` 从开发产物构造最小发布） | 需要完整构建与浏览器 |

Viewer 外壳的界面检查不需要原生栈：用独立的 `REMOTEKIT_CONTROL_CONFIG`（另一个端口与数据目录，放在 `develop/tmp/`）启动第二个 Control，`REMOTEKIT_VITE_CONTROL=http://127.0.0.1:<端口>` 让 Vite 开发服务器（现代浏览器）或 `vite build --watch` + `vite preview`（Chrome 89 只能跑构建产物）代理到它。`tools/cdp.mjs` 用独立 Profile 启动任意 Chromium（含 Chrome 89），之后每次调用对同一调试端口执行 `eval`、鼠标 `click` / 触摸 `tap`（可 `--hold` 按住）、`key`、`type`、`shot`；启动参数关闭窗口遮挡判定，被其他窗口盖住或在 RDP 下页面也保持可见。

CPU 单元测试、编译、真实 GPU 运行、实体设备验证是不同层级的证据，分开记录。

RDP 启动回归：`remotekit_service_gpu_policy_probe` 将 primary vendor `0x1414` 输入 Chromium 正式 blocklist/功能决策，验证条目 74 在服务 GPU 策略前禁止硬件 GL OSR、策略后允许；随后用真实栈检查 Intel 串流。`remotekit_sdk_control_lifetime_probe` 用真实 Mojo 管道验证超时后续请求、迟到附件释放和断线；CTest `endpoint_control_reliability`、`endpoint_comp_pacing` 覆盖控制句柄语义、启动退避与缓存 Idle 身份。模拟不能代替真实 RDP 连接状态验证。
