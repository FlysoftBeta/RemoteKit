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

三者可以并行构建；同一个 Chromium out 目录不要并发构建。Endpoint 不包含 Chromium 私有头，只依赖导出的 SDK；Endpoint 的依赖（nlohmann/json、oneVPL、NVENC 头、zstd 1.5.7 源码）由 `tools/fetch-media-deps.py` 按固定版本与 hash 获取；Endpoint 链接完整 zstd，updater 只链接解压部分，人脸与图像依赖（静态 OpenCV、静态 libwebp 1.5.0、YuNet/SFace/MiniFASNet 与文档方向模型 PP-LCNet_x1_0_doc_ori 及许可证）由 `tools/setup-face-auth.py` 按 `tools/face-auth-deps.json` 准备，必要时从官方权重转换 ONNX；模型运行时位于 `endpoint_service.exe` 旁的 `models/`。文档渲染依赖（裁剪后的 LibreOffice 与 pdfrender）由 `tools/fetch-document-deps.py` 准备到 `build/dependencies/documents/`，构建后复制到 `endpoint_service.exe` 旁的 `documents/`，并打进 Endpoint 运行时包（见[文件与相机 · 文档预览](files-and-camera.md#文档预览)）；pdfrender 的固定值指向一个 GitHub Actions 产物，过期前需要刷新。

**Chromium 叠加层**：`browser/` 不是 Chromium tracked 源码，由 `tools/chromium.py stage` 复制到 Chromium 树中（只更新变化文件的 mtime，带 hash 保护地清理已删除的文件）。**补丁**：对 Chromium tracked 源码的修改只能放在 `patches/` 的有序补丁里，由 `tools/patchset.py --chromium-root C:/src/chromium/src status|apply|revert` 管理；`patches/manifest.json` 记录顺序与每个补丁的 SHA-256。修改补丁后更新 hash，并验证可以完整撤回与重放。不要 reset 或 clean Chromium checkout（其中还有无关的分支与暂存）。

| 补丁 | 作用 |
|---|---|
| 0010 client-gesture-arbitration | 客户端手势候选的 touch-action/preventDefault 与逐包 ACK 仲裁、惯性期间保持 touch-action |
| 0013 remotekit-osr-output | 离屏 OSR 输出设备：完整 token、Begin 到 GPU 的顺序、完整重绘、真实 ANGLE Fence |
| 0014 webrtc-screenshare-adaptation | RemoteKit screencast 的 BALANCED/质量缩放资格 |
| 0015 page-lifecycle-ack | 冻结/解冻的精确 renderer 回执与连接代次 |
| 0016 file-chooser-input-anchor | 报告文件输入框的实时位置用于锚定文件篮 |
| 0017 origin-worker-identity | 按 worker 自身 origin 选择 UA/UA-CH/`WorkerNavigator.platform`（`OverrideWorkerIdentity`），覆盖 worker 启动、主脚本与 fetch |
| 0018 host-device-isolation | `AllowHostDeviceAccess()`：媒体设备、蓝牙、WebAuthn、语音识别不使用宿主设备；`ScreenOrientationDelegate::IsOrientationLockAllowed` |
| 0019 non-backed-clipboard-privacy | 非系统剪贴板保留保密与排除历史标记 |
| 0020 pointer-refocus-observation | 点按已聚焦元素时再次报告 pointer focus，脚本来源保持独立 |
| 0021 occlusion-plane | 稳定 Viz target 与页面高度分离，每帧清理键盘下方空带 |

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

Control 只读一个环境变量 `REMOTEKIT_CONTROL_CONFIG`（默认 `control/data/control.json`，不存在时按默认值创建，同时生成 Control 身份密钥 `control.key` 与本地节点的 `node.json`）。所有监听、访问地址、存储与节点配置都在这个文件里，格式与校验规则见[多节点 · 配置](cluster.md#配置)。默认配置有一个本地节点 `local`，`local.executable` 指向 `build/endpoint/endpoint/endpoint_service.exe`；Browser 必须在 Endpoint 同目录（开发时由构建脚本或测试把两者放到同一个运行目录）。编码器与码控参数（见[编码](encoding.md#适配器与后端选择)）写在顶层 `media` 或节点的 `media` 里；Endpoint 不接受这些命令行参数。开发追踪开关 `REMOTEKIT_SERVER_TRACE`、`REMOTEKIT_MEDIA_TRACE` 仍是环境变量（见[诊断](diagnostics.md#开发侧追踪)）。

**远端节点**：在 Control 配置的 `nodes` 中加入节点 ID，写 `remote.control`（节点访问 Control 的 `ws(s)://<地址>:<端口>/api/node`）与 `peer`，Viewer 不在同一网络时再设 `rtc.ports` 与 `rtc.address`（见[多节点 · 配置](cluster.md#配置)）。Control 启动后为它生成身份并写出 `config/nodes/<节点 ID>/node.json`。节点身份改变时（新加入、Control 的 `control.key` 被替换，或从旧的共享集群密钥升级上来）必须把新的 `node.json` 与当前版本的 `remotekit_node.exe` 重新复制到节点上；旧 updater 无法连接新版 Control。在节点上建一个目录，放入 `remotekit_node.exe`（GitHub 发布页的独立下载，或 Control 主机的 `versions/<buildId>/bin/remotekit_node.exe`）和原样复制的 `node.json`，再运行：

```powershell
.\remotekit_node.exe run "--root=$PWD"
# 或注册为 Windows 服务（管理员）
.\remotekit_node.exe service-install "--root=$PWD"
```

节点从 Control 下载与之相同版本的运行时后启动 Endpoint。`peer.listen` 端口要对其他节点开放，`rtc.ports` 的 UDP 端口段要对 Viewer 开放（经路由器时转发到节点）。局域网或远程部署需要正确的监听地址、Origin 与可信 HTTPS：摄像头、文件选择中的拍照等能力要求安全上下文；集群通道自身已加密，不依赖 TLS。

## 发布

发布物经 GitHub Releases（`FlysoftBeta/RemoteKit`）分发，内容加密；Control 主机上只有一个自更新的管理器 `remotekit_control.exe`，它按 manifest 下载增量或完整包、安装、监管 Control。节点仍从 Control 取运行时（见[多节点 · 版本锁定与更新](cluster.md#版本锁定与更新)）。

```powershell
C:\src\depot_tools\python3.bat tools/release.py --publish
```

`tools/release.py` 是唯一的发布入口：工作树有未提交改动时拒绝；依次执行 stage、Chromium `out/rel` 构建（Browser + SDK）、SDK 导出、Endpoint 打包构建（含 `remotekit_control`、`remotekit_node`、`remotekit_release`）、Control 构建，再运行 `package-runtime.py --smoke`，`--publish` 时最后执行 `publish-release.py`。任一步失败即停止。

### 版本树与 payload

`tools/package-runtime.py`（默认 `--out rel`）在 `develop/tmp/<时间戳>/` 输出一个版本树和它的 payload。它先检查产物是否新鲜，任一项不满足就拒绝打包并指出是哪个组件：`tools/chromium.py stage --check` 有待同步的源码；Chromium out 目录对 `remotekit_browser remotekit_sdk` 还有待执行的构建（ninja 干跑）；Endpoint 打包构建目录还有待执行的构建；`control/dist` 比 `control/server`、`client`、`shared` 下最新的源文件旧。

```
build.json                 {buildId}
manifest.json              来源与逐文件 hash
recover-credentials.cmd
bin/node.exe  bin/remotekit_control.exe  bin/remotekit_node.exe
control/dist/…  control/node_modules/…  control/runtime-manifest.json
licenses/…
node/…                     节点运行时：Endpoint、Browser、SDK、oneVPL、CRT、文档与人脸依赖
```

**payload** 是这个树的确定性 PAX tar（按路径排序，mtime、uid/gid、属主名与权限固定），同样内容总是得到同样字节，这是增量能对齐的前提。构建 ID 由 `bin/`、`control/`、`node/bin/` 下文件的路径和 hash 计算。`remotekit_control.exe` 与 `remotekit_node.exe` 静态链接 CRT，各自是单个可执行文件；Endpoint 仍用 `/MD`，`node/bin/` 带 Release CRT。

**来源**：manifest 记录 `source{commit, dirty}`（dirty 指 browser/、endpoint/、control/、protocol/、sdk/、tools/、patches/ 下有未提交改动；只有 `release.py` 保证为 false）和 `artifacts`（实际打包的 Browser、Endpoint、Node、Control 服务端文件的 SHA-256），据此可以确认某个修复是否在包里。`build.json`（`{buildId}`）与 `release/node.json`（`{buildId, sha256, size}`）是管理器、updater 和 Control 严格校验的运行时契约，不放额外字段。

**Node 运行时**：`tools/node_runtime.py` 固定一个版本（v24.20.0，ABI 137，与 Control 的 better-sqlite3 匹配），从 nodejs.org 下载官方 Windows x64 zip，用脚本内写死的 SHA-256 校验，解压到仓库外的构建缓存 `%LOCALAPPDATA%/RemoteKit/build-cache/`，带官方 `LICENSE`。打包只用这个运行时，不接受手动指定。

`--smoke` 在隔离根目录里用 `remotekit_control.exe install --payload=` 安装 payload，再由 `remotekit_control.exe run` 启动，验证启动、鉴权和 Endpoint 管理。真实 Viewer 的产品操作和媒体验证使用独立端到端测试。

Endpoint 编译直接包含仓库 `sdk/include` 公共头，不链接 SDK import lib；运行时通过 `LoadLibraryExW` 加载 Browser 同目录的 `remotekit_sdk.dll` 并解析 C ABI。发布 SDK 导出到独立 `sdk/dist/rel`；非 component 构建的 runtime deps 缩减后，打包仍从 GN 图收集 Browser 和 SDK 的完整运行依赖，不沿用开发 DLL 目录。

### 发布格式

每个 GitHub Release 带一个 `control.manifest` 和一或两个资产，每个资产切成不超过 32 MiB 的片：

- **patch**：以上一版 payload 为原始内容前缀（`--patch-from` 方式：refPrefix、长距离匹配、窗口覆盖整个 payload）压缩新 payload 的单个 zstd frame。
- **full**（可选）：新 payload 的普通 zstd 流。没有上一版、显式 `--full`、或自上一个 full 以来的 patch 累计超过那个 full 的大小时才带，使任何主机的下载量都不超过约两个 full。

加密用发布密钥（32 字节随机数，base64 文件；发布机默认在 `%LOCALAPPDATA%/RemoteKit/release/release.key`，部署时由 `init` 写入主机的 `config/release.key`），每个 manifest 和资产各用随机 salt 经 HKDF-SHA256 派生自己的 AES-256-GCM 密钥：

- manifest：`"RKRM" 01 salt(32)` + 密文 + tag，nonce 为零，前 37 字节作 AAD；明文 JSON 不超过 1 MiB。
- 资产片：明文按 32 MiB − 16 字节切块，第 i 片 = 密文 + tag，nonce = `00000000 ‖ u64be(i)`，AAD = `"RKRS" 01 ‖ u32be(i) ‖ u32be(片数)`，片序、截断与替换都会使认证失败。

```json
{
  "format": 1, "buildId": "…", "published": "2026-11-09T12:00:00Z",
  "payload": { "size": 0, "sha256": "…" },
  "patch": { "from": "<上一版 buildId>", "manifest": "<上一版 manifest 的绝对 URL>", "asset": ASSET },
  "full": ASSET
}
ASSET = { "salt": "…", "size": <压缩后明文字节>, "slices": [ { "url": "<绝对 URL>", "size": 0 } ] }
```

manifest 只含绝对 URL，管理器只认识配置里的一个 manifest URL（`https://github.com/FlysoftBeta/RemoteKit/releases/latest/download/control.manifest`），沿 `patch.manifest` 回溯；GitHub 的接口只出现在发布脚本里。校验严格：键集合固定、片数与片大小由 `size` 决定、至少有一个资产。

### 上传

`tools/publish-release.py --package <版本树>`（`release.py --publish` 调用它）：

1. 生成确定性 payload 到缓存 `%LOCALAPPDATA%/RemoteKit/release/payloads/<buildId>.tar`。
2. 用 `gh` 找到最新 Release，解密其 manifest 得到上一版 buildId；相同则停止。上一版 payload 不在缓存时用 `remotekit_release fetch` 按发布链从 GitHub 重建。
3. `remotekit_release pack` 生成 patch（必要时加 full）、manifest 和上传清单，输出保留在 `cache/out/<buildId>/`：salt 是随机的，续传必须用同一批文件。打包后把每个资产解回去核对 payload hash。
4. 建草稿 Release（tag `control-<UTC 时间>-<buildId 前 8 位>`，指向来源 commit），按清单逐个上传：先全部片，最后 manifest；不并行，每个文件独立重试（最多 8 次，5–60 秒退避），已存在且大小相同的跳过。重跑同一 buildId 会找到草稿继续。另外上传不加密的 `remotekit_control.exe` 与 `remotekit_node.exe` 供首次部署下载。
5. 全部上传后把草稿发布为 latest，主机下一次检查即可看到。`--dry-run` 只做本地步骤并列出计划上传的文件。

`remotekit_release.exe` 是发布机工具（不进发布包）：`keygen` 生成密钥，`inspect` 解密并校验 manifest，`pack` 生成资产与 manifest，`fetch` 用与管理器相同的规划与解码代码重建 payload。

### Control 主机

```
<root>/
  remotekit_control.exe   管理器
  current                 当前 buildId
  config/                 manager.json、release.key、control.json、control.key、nodes/<远端节点>/node.json
  data/                   control.db、诊断、本地节点根 node/
  versions/<buildId>/     唯一的当前版本：版本树 + release/node.tar.zst + payload.tar
  work/                   下载片、中间 payload、安装暂存
  logs/                   manager.log；control.jsonl（Control 自己写）；control.stdout.log（Control 控制台输出，只有崩溃时有内容）
```

```powershell
# 首次部署（管理员）：只需要 remotekit_control.exe 和发布密钥文件
.\remotekit_control.exe init "--root=C:\RemoteKit" "--manifest=https://github.com/FlysoftBeta/RemoteKit/releases/latest/download/control.manifest" "--key-file=D:\release.key"
C:\RemoteKit\remotekit_control.exe service-install "--root=C:\RemoteKit"
# 或前台运行
C:\RemoteKit\remotekit_control.exe run "--root=C:\RemoteKit"
# 离线安装一个 payload（无网络主机、打包 smoke）
C:\RemoteKit\remotekit_control.exe install "--root=C:\RemoteKit" "--payload=D:\payload.tar"
```

`config/manager.json` 是 `{"manifest", "checkIntervalMinutes"?, "proxy"?}`：检查间隔默认 60 分钟（5–1440）；不设 `proxy` 时用系统自动代理。管理器启动时立即检查一次，之后按间隔检查；重启管理器（或服务）即强制检查。

**规划**：取最新 manifest；与当前 buildId 相同则无事。否则沿 `patch.manifest` 回溯，累计 patch 大小：遇到 `from` 等于当前版本且本地 `payload.tar` 可用，得到"全 patch"方案；途中每个带 full 的 manifest 给出"full + 其后 patch"方案；累计已超过最便宜方案、链断（manifest 404、解密或校验失败、buildId 不连贯、重复）、回溯 64 级时停止。取下载量最小的方案；都没有则等下一次检查。一次查询暂时失败（`unavailable`、`rate_limited`、`busy`）按[错误模型](architecture.md#错误模型)退避，不当作链断。

**执行**：逐片顺序下载到 `work/assets/<salt>/`，断点用 HTTP Range 续传（206 追加，200 从头）；边解密边解码。full 流式解压；patch 把基准 payload 和预先定长的输出文件都内存映射，`ZSTD_d_stableOutBuffer` 让解码器直接用输出作窗口，不分配与 payload 等大的缓冲。每一步的结果按该 manifest 的 `payload.size/sha256` 校验。片 404 或认证失败时删除该片、排除该资产并立即重新规划（通常改用 full）；基准 payload 校验不过时放弃增量重新规划。

**安装**：payload 中 `node/` 以外的条目解到 `work/stage-<id>/`；`node/` 下的 tar 记录原样流入多线程 zstd，生成 Control 分发给节点的 `release/node.tar.zst` 与 `release/node.json`；核对两处 `build.json`；payload 本身留作下一次增量的基准；最后改名为 `versions/<id>`。

**切换**：新版本装好后才停 Control（关闭其 stdin，最多等 60 秒，再结束其作业对象），原子写 `current`，删除旧版本目录与 `work/` 残留，再启动新版 Control。版本中的 `bin/remotekit_control.exe` 与运行中的不同时先自更新：运行中的文件改名为 `.old`、复制新文件、启动后继进程（服务模式以失败退出，由服务恢复策略重启），后继启动时删除 `.old`。没有二进制回滚：坏版本通过发布新版本修复；Control 迁移数据库前写出经校验的备份（见[存储与迁移](control-plane.md#存储与迁移)），迁移失败时事务整体回滚、库保持原版本。Control 异常退出按 1、2、4…30 秒退避重启，健康运行 60 秒后复位。

管理器以 `REMOTEKIT_CONTROL_CONFIG=<root>/config/control.json` 启动 `versions/<id>/bin/node.exe versions/<id>/control/dist/server.mjs`。配置不存在时打包版 Control 写出默认配置：监听 `127.0.0.1:3001`，数据在 `../data/`，带本地节点 `../data/node`。不要本地节点时从配置里删掉该项。`data/control.db` 损坏时，停止服务后先把 `data/backups/` 里最近的迁移前备份复制回 `data/control.db`（删除 `-wal`/`-shm`）；备份不可用或版本不被接受时运行 `versions\<buildId>\recover-credentials.cmd`，只保留账户与凭据重建数据库（见[凭据恢复](auth.md#凭据恢复)）。默认打开 `http://127.0.0.1:3001` 创建首个管理员账号。

从旧的 Control 包目录迁移：停止旧服务，在同一根目录 `init`（`config/`、`data/` 原样保留），删除旧的 `bin/`、`control/`、`release/`、`run*.cmd`、`data/local/`，再 `service-install`。

## 测试

| 位置 | 内容 | 运行 |
|---|---|---|
| `control/test/` | Control 服务端与 Viewer 客户端的单元与集成测试 | `npm test`，或 `npx tsx --import ./test/css-stub.mjs --test test/<file>.test.ts`（组件 CSS 在测试中导入为空） |
| `endpoint/tests/` | Endpoint 策略、文件、编码器状态机（注入式 NVENC）、集群通道（Noise 向量、通道、ClusterLink）、对象存储与节点间传输、checkpoint、updater（下载、解包、监管、自我替换）、发布格式（HKDF 向量、manifest 与分片加解密、严格校验、规划的各种链况、patch 往返、payload 安装）与管理器文件管理 | `tools\build-endpoint.cmd` 自带 CTest |
| `browser/*_probe.cc`、`*_tests.cc` | 直接运行生产代码与官方 Chromium 过滤器的确定性检查（BeginFrame 调度、手势包与仲裁、控制回复、Profile 隔离、渲染通道寿命、滚动策略、导航账本与错误页） | GN 目标，构建后运行 |
| `sdk/` | SDK 消费者 smoke（控制、渲染、RTC、音频） | `tools\verify-sdk.cmd` |
| `tools/tests/` | 构建工具（补丁管理、stage、打包布局） | `python -m unittest` |
| `tests/integration/` | 原生 Endpoint/Browser 集成（服务、恢复、几何、信令、关闭 ACK、生命周期、Profile、sessionStorage 与优雅关闭、checkpoint 跨节点恢复、硬件编码 SPS 检查；Noise 互通与 updater 端到端）。Python 测试经 `cluster-bridge.mjs` 扮演 Control（握手、下发配置、发布期望状态），对外仍是 JSONL | 需要构建好的原生二进制 |
| `tests/e2e/kit/` 与 `workspace-ui.mjs`、`web-app-install.mjs`、`drive.mjs` | Viewer UI 的真实栈场景。`kit/stack.mjs` 是唯一的一次性栈启动器（Control 源码 + Vite + 夹具服务器，运行目录在 `develop/tmp/e2e/`，数据目录刻意不在 TEMP 下）；夹具有带 manifest 的笔记页和使用 File System API 的 `/fs/`。`kit/viewer.mjs` 提供 Playwright 会话（Edge 或 Chrome 89、DPR、鼠标或触摸，Chrome 89 与触摸用原始 CDP 事件）、逐步 ok/FAIL 日志、开始屏幕与地址栏操作、锁定与按键/点按区域解锁、Browser 是否重启的检查。开发构建里的 `window.__remotekitTest`（`state()`、`unlock()`）直接读产品状态并走与完成图案相同的解锁路径，生产构建中不存在。`drive.mjs` 保持栈与 Viewer 打开，经本地 HTTP 接受点击、输入、截图等命令，用于探索；`kit/usage-report.mts` 输出 usage 记录与 frecency 得分 | `node tests/e2e/workspace-ui.mjs [--browser chrome89] [--dpr 2] [--pointer touch]`，任一步失败退出码非零；需要已构建的 `out/rel` Browser 与 Endpoint |
| `tests/e2e/`（其余） | 真实栈产品场景（Viewer + Control + Endpoint + Browser + H.264）：通用产品流、手势、键盘与移动 IME、文件库与相机（`test-camera-scan.mjs` 用 Chromium 假摄像头拍夹具页面，验证方向、透视、WebP、手动旋转与按 accept 转码；Y4M 由夹具 JPEG 在运行时生成，需要 ffmpeg 或用 `REMOTEKIT_CAMERA_PYTHON` 指定带 OpenCV 的 Python）、全屏、诊断、首帧；两个本地节点的同时串流、停止提交与跨节点重新打开（`test-cluster-nodes.mjs`）；updater 下载、安装与版本切换（`test-node-updater.mjs`，用 `make-node-release.mjs` 从开发产物构造最小发布）；发布工具 `pack`/`fetch` 经本地 HTTP 服务器的往返与 Range 续传（`release_tool.mjs`）；Control 发布全流程（`tests/integration/test-control-release.mjs`：首次 full 安装与断点续传、patch、错过的增量、断链改用 full、损坏 patch、自更新、远端节点跟随、错误密钥） | 需要完整构建与浏览器 |

Viewer 外壳的界面检查不需要原生栈：用独立的 `REMOTEKIT_CONTROL_CONFIG`（另一个端口与数据目录，放在 `develop/tmp/`）启动第二个 Control，`REMOTEKIT_VITE_CONTROL=http://127.0.0.1:<端口>` 让 Vite 开发服务器（现代浏览器）或 `vite build --watch` + `vite preview`（Chrome 89 只能跑构建产物）代理到它。`tools/cdp.mjs` 用独立 Profile 启动任意 Chromium（含 Chrome 89），之后每次调用对同一调试端口执行 `eval`、鼠标 `click` / 触摸 `tap`（可 `--hold` 按住）、`key`、`type`、`shot`；启动参数关闭窗口遮挡判定，被其他窗口盖住或在 RDP 下页面也保持可见。

CPU 单元测试、编译、真实 GPU 运行、实体设备验证是不同层级的证据，分开记录。

RDP 启动回归：`remotekit_service_gpu_policy_probe` 将 primary vendor `0x1414` 输入 Chromium 正式 blocklist/功能决策，验证条目 74 在服务 GPU 策略前禁止硬件 GL OSR、策略后允许；随后用真实栈检查 Intel 串流。`remotekit_sdk_control_lifetime_probe` 用真实 Mojo 管道验证超时后续请求、迟到附件释放和断线；CTest `endpoint_control_reliability`、`endpoint_comp_pacing` 覆盖控制句柄语义、启动退避与缓存 Idle 身份。模拟不能代替真实 RDP 连接状态验证。
