# 文件、音频与发布 runtime 审阅（2026-11-03）

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

审阅基线：`4de343c37492d0c5d6435bf6dab1a0a62b5554dc`。本审阅没有改动产品、发布包或构建产物，没有启动 Browser/Endpoint、GPU 实验或上传。仅增加本记录；两个临时 CPU 探针均已清理自有资源。

结论：文件发送取消有一个已用真实 `FileUploads` 复现的失效 ticket 竞态；服务关闭有一个用 Node HTTP 升级连接探针证实的关停顺序问题。另有分隔条取消后未恢复、begin 结果丢失后无法原地恢复、定制 Endpoint 文件名与 launcher 不一致三项源码可确定的问题。当前上传协议明确依赖同机文件路径，必须由 root 纳入跨机 Endpoint 与 WebRTC 数据边界重构，不能仅修改部署文档。

本报告区分源码证实、CPU 模型证实与真实运行；没有把当前状态所列 autoplay、真实网络音频 gap、实体摄像头等未验证场景宣称为缺陷。

## 覆盖范围

| 模块 | 已核对的行为与边界 | 结果 |
|---|---|---|
| `control/client/audio-output.ts` | Opus audio-only SDP、双声道 gain、mono upmix、WebAudio/静音 audio 元素、gesture resume、旧 Promise generation、track ended、detach | 未发现本轮可证实逻辑缺陷；真实 autoplay 拒绝/长网络 gap 仍未验 |
| `audio-controls.tsx` | Viewer 全局声道、保存互斥、同步 gesture resume、blocked 重试按钮 | 未发现越租户或设置本地持久化 |
| `file-upload.ts` | 同源 URL、raw Blob/XHR、cookie、timeout/progress/abort | 传输本身有取消处理；与服务端取消组合出现 F1；新边界不兼容 A1 |
| `file-selection.ts` | 单/多选合并、accept 提示语义、大小/数量、照片替换 | 未发现本轮可证实缺陷 |
| `file-chooser-dialog.tsx` | begin/stream/commit/cancel、validation poll、离线 generation、卸载、摄像头迟到结果、object URL 生命周期 | F1；异步确认错误的恢复覆盖仍需加强 |
| `camera-capture.ts` | 单在途 worker、probe/fallback、bitmap transfer、timeout、cancel 与迟到 bitmap、canvas 清理 | 旧 finalizer 不杀新 worker；迟到 bitmap 会 close；未发现本轮可证实缺陷 |
| `camera-candidates.ts` / `public/camera-score.js` | 同快照评分/编码、candidate 限额/间隔、worker 资源释放 | 候选预算与在途资源分别有界；实体摄像头效果不属于本次结论 |
| `admin-dialog.tsx` | 管理员状态读取 generation/active、提交互斥、关闭互斥、口令仅内存 | 未发现本轮跨账号泄漏；Workspace 在账号切换卸载，不能把旧 Promise 的本地 setState 直接当泄漏 |
| `product-dialogs.tsx` | Auth 请求互斥、注册状态旧回复隔离、Settings 控件保存、page dialog 按 ID 重建与回复互斥 | 未发现本轮可证实授权绕过；最终鉴权由服务端负责 |
| `window-frame.tsx` | visible Window、地址草稿、菜单命令、全局音频入口、ResizeObserver、divider preview/提交/取消 | F3；样式与视觉设计另由设计代理负责 |
| `style.css` | 显隐、内容区 bounds、输入层、divider touch-action、窄屏 dialog 与高度规则 | 已静态读全部；没有做视觉验收 |
| `control/server/file-uploads.ts` | tenant/lease/auth、ticket ownership、逐块授权、声明长度/总量、commit 幂等、撤销和 receipt 保留 | F1/F4；未发现可证实跨 tenant 接收；跨机不成立 A1 |
| `tools/package-runtime.py` | GN runtime 选择、CRT、Node ABI/真实 exe、runtime 拷贝、禁止数据/凭据、manifest/ZIP、demo 显式路径 | F5；ZIP/来源验证口径见 V1/V2 |
| `tools/streaming-launcher.cjs` | 参数作为 JSON 数据、包内路径/数据目录、环境配置 | A2；参数未拼入 Endpoint shell |
| `tools/build-endpoint.cmd` / `tools/export-sdk.py` / `tools/chromium.py` | VS/Python 覆盖、增量构建目标、依赖导出元数据、stage 所有权边界 | 已静态核对，不执行构建；本轮未发现需新增为确定缺陷的事项 |
| `tools/verify-control-build-server.mjs` / `control/test/production-smoke.mjs` | server bundle、最小生产依赖、SQLite native ABI、包外生产 smoke | smoke 不证明活 Viewer 关停，F2 未被覆盖 |
| `tools/test-streaming-package.py` / `smoke-streaming-product.mjs` | 包外数据、包内 Node/依赖、正常账号/WS/Browser 管理、归属 PID tree 清理 | 清理强杀可能掩盖 F2；明确不覆盖 RTC 媒体 |
| `README.md` / `control/README.md` / `docs/packaging.zh-CN.md` / `docs/upload/README.md` | 配置入口、职责、发布范围与上传流程 | 当前文档把同机 JSONL 作为实现事实；尚无远程 Endpoint 发布形态；未读取凭据或执行上传 |

为核对 runtime/文件集成，补读 `server/main.ts`、`server/http.ts`、`server/endpoint.ts`、`server/control.ts` 与 `endpoint/src/service.cpp`、`file_upload.cpp` 的相关段落；不扩大本代理的产品修改归属。

## 确定问题

### F1 · P2：中止 HTTP 后，失效 uploadId 令网页文件选择无法取消

位置：`control/client/file-chooser-dialog.tsx:97–104`（`cancel`）；`control/server/file-uploads.ts:82–87`（`owned`）、`:105–114`（`cancel`）、`:119–122`（`abort`）。

触发：正在上传时点“取消发送”；客户端先 `controller.abort()`，随后才发送 WS `files.cancel(requestId, uploadId)`。HTTP 的 `stream()` 失败路径先进入 `abort()`，删除这个尚未 submitted 的 upload entry；WS cancel 随后到达时，`owned(uploadId)` 抛 404，未执行按当前 Browser binding 的 `cancelRequest`。

坏状态：原网页 chooser 仍 pending；dialog 显示“暂时无法取消，请重试”，但 ref 仍为同一个已删除 uploadId，后续重试取消仍为 404。再次“使用文件”可以另开 batch，但不能实现用户刚要求的取消；离开页面/重连是额外绕行。

证据：本轮用真实 `FileUploads`、临时目录与 `Readable.from(['a'])` 对声明 3 字节文件模拟失败流；随后携原 uploadId 取消，输出：

```json
{"cancelStatus":404,"cancelError":"文件发送记录不存在","nativeCancels":0,"requestState":"pending"}
```

这是 CPU 集成模型证据，未模拟 Browser 或网络排程；实际点击时两条传输的先后决定是否触发，但先到的 HTTP 失败状态已可确定复现。

修复要求：取消必须在旧 batch 已因传输失败撤销时，仍能安全、幂等地取消当前相同 request binding；保持 tenant/lease/auth 和 request 身份验证，不能把任意不存在 uploadId 当作授权。可保留已撤销 receipt 或为匹配的当前请求提供 fallback，由实现者选择。客户端也应清理已确认失效的 batch ref。

必要回归：HTTP abort 先于 WS cancel、WS cancel 先于 abort、截断后取消、连续取消、旧租约/其他 tenant/其他 request 的 uploadId 不能借 fallback 取消当前请求。

### F2 · P1：HTTP 关闭等待活 WS，WS 清理却只放在 HTTP close 事件

位置：`control/server/main.ts:26`（`close`）；`control/server/http.ts:85`（late detach）、`:99–100`（heartbeat 与 close handler）。

触发：有正常活 Viewer WebSocket 时执行 SIGINT/SIGTERM/IPC disconnect 的 graceful close。main 调用 `server.close()` 后即停 Endpoint、关 SQLite；`http.ts` 却直到 HTTP server 的 `close` 事件才 terminate WS 并清 heartbeat。Node 的 server close 等待已升级 socket 关闭，这些 WS 本身又依赖那条尚未发生的 close 事件进行清理。

坏状态：Node 可继续被升级 socket 持有，Endpoint/数据库已经关闭。30 秒 heartbeat 下一次执行 `control.store.identity()` 会访问已关闭 SQLite；客户端自行关闭后触发的 `detachViewer` 也在数据库关闭之后。包 smoke 用 taskkill tree 强制收尾，不证明 graceful close 正确。

证据：本轮纯 Node `http.createServer()` + 自有 `net` upgrade socket 探针，`server.close()` 后 100ms 输出 `closedBeforeUpgradedSocketEnded:false`；仅显式 destroy 那条 socket 后才出现 `CLOSE callback`。真实生产代码采用相同关闭依赖。没有向生产 runtime 发信号，也未启动 GPU。

修复要求：提供显式的 HTTP/WS 关停阶段，先停止接新请求、升级与 heartbeat，撤销并关闭/有界 terminate peers，等待必要 detach/inflight 阶段，再关 Endpoint 与 SQLite；完成及超时均有确定退出行为。移除 `rtc.signal` listener 也应纳入该清理入口（当前 close handler 只 off `state`）。具体生命周期契约由 root 集成。

必要回归：一个正常 WS、一个未回 close 的 WS、在途文件写入/产品 RPC、Endpoint 不响应 shutdown；使用 fixture Endpoint/内存数据库验证有界退出且无已关闭 DB 访问。无需性能组。

### F3 · P2：分隔条取消或提交失败后，DOM preview 没有回滚

位置：`control/client/window-frame.tsx:200`、`:650`（`change`）、`:700–725`（pointer move/up/cancel）。

触发：拖动时 `onPointerMove` 直接写相邻 DOM 的 `style.flexGrow`，随后收到 pointercancel；或 pointerup 的 `window.layout` RPC 失败。

坏状态：cancel 只清 `drag.current`；RPC catch 只 report。两条路径都没有把两侧 flexGrow 恢复到 Control 的 committed weights。React 之后以相同旧 weight 重新渲染时，前后 props 相同也不能依赖它修复外部 DOM 修改。屏幕布局与 Control 保存权重不一致，刷新后又跳回。这里不是 atlas 命中坐标错误的证据：ResizeObserver 仍会报告实际尺寸。

证据级别：源码确定；未做 UI/触控运行注入。

修复要求：preview 生命周期有统一结算；取消、丢失 capture、失败、卸载都撤销 preview，成功由新 committed weights 接管。恢复时使用最新产品权重，避免回放过期 drag 快照覆盖新状态。

必要回归：pointercancel、layout RPC reject、拖动期间远端 weights 更新、成功提交；断言 DOM flexGrow 与产品状态最后一致。

### F4 · P2：Endpoint begin 回复丢失后，同一个请求没有恢复分配的通路

位置：`control/server/file-uploads.ts:33–45`（begin）；`control/server/endpoint.ts:55`（20 秒超时）；`endpoint/src/file_upload.cpp:122`（同 binding 禁止重复）；`endpoint/src/service.cpp:1604–1618`（无 uploadId 的 cancelRequest）。

触发：Endpoint 已执行 `FileUploadStore::Begin`，但 Control 的 begin request 在收到回复之前超时/回复丢失。`await endpoint.request(...)` 位于 try 之外，Control 尚未得到 uploadId，也没有建立 uploads entry。下一次 begin 找不到 previous，却在 Endpoint 因同 binding 已分配而失败。

坏状态：同一在线 Viewer 内正常“重试”不能恢复，私有暂存和配额仍占用。用户不带 uploadId 取消时可以取消原生 chooser，但 `cancelRequest` 分支没有按 binding 删除这项尚未提交分配；清理依赖后续 Viewer revoke 或 Browser 停止，不能把“取消即清理暂存”当作完整保证。

证据级别：跨组件源码确定的丢回复错误路径，未注入真实 Endpoint 延迟或真实断传。本轮没有把当前状态中的“上传断传/commit 竞态未作运行验证”误当这项证据。

修复要求：begin 的结果不明须有稳定身份以恢复或撤销已有分配；取消当前 binding 能精确回收其未提交分配；保持 submitted/selected 文件的延迟读取生命周期。不要将全 Session revoke 用于单请求恢复。新传输设计应同时解决这条错误路径。

必要回归：分配完成后丢 begin reply、cancel reply 丢失、重试 begin、按 binding 取消；断言恰一 batch/配额最终归还，且 selected 文件不被回收。

### F5 · P2：`--endpoint` 接受其他文件名，但包内 launcher 固定查标准文件名

位置：`tools/package-runtime.py:29`、`:103`；`tools/streaming-launcher.cjs:6`；demo launcher 生成位于 `package-runtime.py:143–150`。

触发：传 `--endpoint C:\somewhere\custom-service.exe`（文件存在且是所需 Endpoint）。工具原样按 `endpoint.name` 拷入 bin，但串流 launcher 只运行 `bin/endpoint_service.exe`；demo 同样只运行 `endpoint_client.exe`。

坏状态：未加 `--smoke` 时可产出完整 ZIP/manifest，但用户 run.cmd 找不到约定 exe。CLI 没有限定 basename，也没有在参数检查阶段拒绝。

证据级别：源码确定；未创建测试发布包。

修复要求：将输入统一拷为该 package kind 的标准 exe 名称，或明确校验并拒绝不匹配 basename；manifest 和 smoke 使用同一解析结果。

必要回归：标准/改名 endpoint 路径、含空格路径，分别覆盖 streaming/demo；使用文件布局单测即可，无需 GPU。

## 必须由 root 处理的架构迁移点

### A1：HTTP 文件字节与跨机绝对路径不符合新 Endpoint 边界

`control/client/file-upload.ts:8–11` 只允许同源 `/api/files/{ticket}`；`control/server/http.ts:28–35` 接收这些原始字节；`control/server/file-uploads.ts:37–39` 接收 Endpoint 绝对路径，`:67` 用 Control 本机 `fs.open(path,'r+')` 写入。

这是当前 `docs/audio-and-files.zh-CN.md` 明确写出的同机实现，不能回溯称为旧契约下的隐藏 bug。但 Endpoint 部署在独立机器后，Control 打开的是自己机器上的绝对路径；“只把文件路径加机器前缀/共享目录”也没有满足用户新要求的 Client↔Endpoint 唯一 WebRTC 数据通路。

待 root 定义：Control 继续签发/撤销与请求绑定的有限产品授权；字节接收、配额、落盘、seal、Browser FileSelectListener 的生命周期留在 Endpoint；Client 的事务状态仅内存。需要明确可靠有序传输、chunk/backpressure/上限、取消、断线、begin/commit 结果不明恢复与 receipt 的契约。本文只指出必须满足的边界，不替 root 决定 channel/消息结构。

### A2：包是同机组合包，尚不是可选择远程算力 Endpoint 的部署入口

`tools/streaming-launcher.cjs:6–13` 无条件设置包内 Endpoint exe、browser/data-path 与本地 DB/metrics；`server/main.ts:13` 使用父子进程 JSONL；README 的环境变量也只有 executable/args。现阶段无法凭配置让 Endpoint 位于另一台机器。

root 确定连接/鉴权、Endpoint 身份与恢复契约后，runtime 配置、组合/独立角色启动、manifest 与 smoke 范围需要一起更新。当前包的默认本地启动本身不是 bug。

## 证据与验证口径差距

### V1：源码打包没有执行 ZIP 解压/CRC/manifest 复核

`tools/package-runtime.py:240–254` 创建 ZIP 后只算整包 SHA-256，未执行 `7z t`/`ZipFile.testzip()`，也未对归档内文件重读并比对 manifest。`docs/current-state.zh-CN.md` 的“打包执行…ZIP校验”不是这份工具自身的能力证据；本次发行代理可能独立做过校验，本代理没有读取/替代那份交付证据。建议工具直接承担校验或把文档明确为发布阶段独立步骤。

### V2：manifest 记录的是打包时源码 HEAD，不能证明所有已有二进制来自该 HEAD

`package-runtime.py:223–237` 获取当前 repo/Chromium HEAD、args.gn hash 与文件 hash；没有二进制 build provenance 对照。接受现有增量构建工作流时应由发布构建记录提供来源证据，不能仅凭 `remotekit_revision` 宣称 Browser/Endpoint/Control 均已重新构建该版本。这是验证能力边界，未发现刚上传包实际混入旧产物的证据。

### V3：剩余验证维持原口径

没有新增 autoplay 拒绝、真正网络音频 gap、实体摄像头、旧能力 fallback 性能结果。本轮阅读到的 audio generation、bitmap 迟到清理、候选/在途预算、ticket tenant/lease/auth、Browser incarnation/document binding 均有具体保护；不把需要扩大测试的场景直接登记为已发生漏洞。现有 CPU tests 不覆盖 React 文件 dialog 的 abort→cancel 与 divider DOM 回滚，应按 F1/F3 新增有意义的组合回归。

## 交付边界

本代理仅提交此审阅文档给 root；严重 runtime 与跨机上传边界已即时上报。修复取舍、接口设计、跨模块集成、current-state/问题清单更新、构建发布与 commit/push 均由 root 统一安排。
