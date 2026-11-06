# RemoteKit

在 Windows 服务器上运行 Chromium，把网页离屏渲染、经硬件 H.264 编码与 WebRTC 直接串流到用户浏览器，并把键鼠、触控和文本输入送回页面。多租户，每个用户一个独立的 Browser 进程与 Profile。

从 [系统架构](docs/architecture.md) 开始阅读，其中有全部文档的索引。

## 构建与运行

Python 使用 `C:\src\depot_tools\python3.bat`。完整说明见 [构建与发布](docs/build.md)。

```powershell
C:\src\depot_tools\python3.bat tools/patchset.py --chromium-root C:/src/chromium/src apply
C:\src\depot_tools\python3.bat tools/chromium.py stage
C:\src\depot_tools\python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk
C:\src\depot_tools\python3.bat tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd
cd control
npm ci
npm run build
New-Item -ItemType Directory -Force data | Out-Null
$config = @{
  nodeDefaults = @{ browser = 'C:/src/chromium/src/out/dev/remotekit_browser.exe' }
  nodes = @{ local = @{ launch = @{ executable = '../../build/endpoint/endpoint/endpoint_service.exe'; root = 'node' } } }
}
[System.IO.File]::WriteAllText("$PWD/data/control.json", ($config | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
npm start
```

打开 http://127.0.0.1:3001，按"上上下下左右左右"显示登录表单，注册首个管理员账号。

## 目录

| 目录        | 内容                                                                |
| ----------- | ------------------------------------------------------------------- |
| `control/`  | Control 服务端（Node/TypeScript/SQLite）与 Viewer 前端（React/MUI） |
| `endpoint/` | Endpoint 服务（C++20，CMake）                                       |
| `browser/`  | Chromium content embedder 与 SDK（GN，在 Chromium 树内构建）        |
| `protocol/` | 跨组件契约                                                          |
| `sdk/`      | SDK 公共 C 头与独立消费者 smoke                                     |
| `patches/`  | 有序 Chromium 补丁                                                  |
| `tools/`    | 构建、补丁、打包；`tools/measure/` 性能测量                         |
| `tests/`    | `e2e/` 真实栈产品场景，`integration/` 原生集成                      |
| `docs/`     | 设计文档                                                            |

Control reads `REMOTEKIT_CONTROL_CONFIG`, defaulting to `control/data/control.json`.
All HTTP, TLS, storage, encoder, and node settings belong in that JSON file. Paths are
relative to the config directory; node browser/data paths are relative to the node root.
For a remote node, configure its ID under `nodes` without `launch` and set
`cluster.advertiseUrl` to `ws(s)://host:port/api/node`. Copy the generated `node.json`
to the remote node root and run `remotekit_node.exe run --root=<absolute root>`.
Keep `cluster.key`, `node.json`, and database `.key` files private.
Packaged `run.cmd` creates `config/control.json` on first run and accepts no arguments.
