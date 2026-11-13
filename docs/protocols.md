# 协议参考

各边界的消息一览。语义与设计理由见各子系统文档；类型的权威定义在代码里（`control/shared/*.ts`、`protocol/*.h`、`sdk/include/*.h`）。所有 64 位 ID、代次和序号在 JSON 里都用十进制字符串，避免精度丢失。错误统一使用[错误码](architecture.md#错误模型)。

## Viewer ↔ Control

**HTTP**

| 路由 | 说明 |
|---|---|
| `GET /api/auth/setup` | 公开：setupRequired（还没有任何账户） |
| `GET /api/auth/me` | 当前账户 |
| `POST /api/auth/setup` | 仅在没有账户时：创建管理员账户，签发 token 与一次性首租约许可 |
| `POST /api/auth/login` / `logout` | 登录签发 token 并记录最近登录（停用账户返回 forbidden）；注销只撤销当前 token |
| `GET /api/admin/diagnostics/<票据>` | 管理员 cookie + `admin.downloadDiagnostic` 签发的一次性票据；下载诊断包 |
| `GET /api/socket` | WebSocket upgrade |
| `GET /api/node` | 远端节点的集群通道（WebSocket 二进制帧，Noise 握手；Endpoint 与 updater） |
| 其他 GET | Viewer 静态资源 |

POST 与 upgrade 检查 Origin；JSON body 不允许携带 tenant/user 身份字段。

**WebSocket `/api/socket`**：普通请求上限 1MiB，`clipboard.set` 允许 1MiB UTF-8 文本的 JSON 转义（传输上限 6MiB+64KiB），每连接最多 32 个在途请求，请求 ID ≤128 字符。

```
请求  {id, method, params}
成功  {type:"result", id, result}
失败  {type:"error", id, error:{code, message, retryAfterMs?}}
推送  {type:"state", revision, state}       产品快照（锁定时不推送）
      {type:"clipboard", revision, text}     当前应用剪贴板（仅已授权 Viewer）
      {type:"auth", auth}                   锁定状态
      {type:"rtc.signal", connectionId, attemptId, signal}
      {type:"lease", status:"revoked", reason:"another-viewer"|"logout"}
```

| 方法 | 用途 |
|---|---|
| `viewport` | devicePixelRatio、refreshHz?、windows（最多 16 项，每项 windowId、稳定 width/height、visible、occludedBottom、occlusionRevision）；遮挡不进入 atlas 计划 |
| `rtc.offer` / `rtc.ice` / `rtc.close` | Session peer 信令（trickle） |
| `service.offer` / `service.ice` / `service.close` | service peer 信令（只有 DataChannel；Control 选节点，见[Control · 连接](control-plane.md#连接)） |
| `operation.submit` | 产品操作 `{operationId, operationGeneration, action}`，回复收据（见[Control · 操作](control-plane.md#操作)） |
| `clock.ping` | Control 时钟（产品新鲜度） |
| `operation.status` | 查询操作收据 |
| `feedback` | 诊断用媒体反馈 |
| `auth.get/lock/verify/settings/password`、`auth.face.begin/cancel/remove` | 锁屏与凭据 |
| `admin.overview/users/storage/nodes/diagnostics/announcements` | 管理员：各分区数据 |
| `admin.createUser/resetPassword/clearSecondFactors/signOut/setDisabled/transferAdmin/stop/transfer/resetSession/deleteUser` | 管理员：按 `username` 操作用户，返回新的用户列表；`transfer` 可带目标 `nodeId` |
| `admin.removeNode/readdNode` | 管理员：按 `nodeId` |
| `admin.deleteDiagnostic/downloadDiagnostic` | 管理员：按诊断 `id`；下载返回一次性 URL |
| `admin.publishAnnouncement/updateAnnouncement/deleteAnnouncement` | 管理员：发布 `{title, body}`、按 `id` 编辑（`republish` 清空已读）或删除，返回新的公告列表 |
| `announcement.read` | 当前用户把公告 `id` 标为已读（幂等） |
| `library.get/import/replace/basket/group/move/delete/prepare/finish` | 文件目录与选择事务；条目 kind 为 file 或 snippet |
| `library.snippet` / `library.copySnippet` | `{id}` → `{text}` / `{revision,text}`；取片段全文或复制回应用剪贴板 |
| `clipboard.get` / `clipboard.set` | `{}` → `{revision,text}` / `{text}` → `{revision}`，当前用户剪贴板 |
| `diagnostics.start/sample/stop/status` | 诊断收集 |

产品操作只有 `operation.submit` 一条路径（设置、窗口视图状态也是）；DataChannel 上没有产品动作。

## Viewer ↔ Endpoint（WebRTC）

两条 PeerConnection（职责见[Control · 连接](control-plane.md#连接)）：

- **Session peer**：H.264 视频 track（atlas）、Opus 立体声音频 track（客户端 recvonly）、可靠有序 DataChannel `remotekit`（JSON）。
- **service peer**：没有媒体；DataChannel `remotekit`（JSON，文件服务）与 `remotekit-auth`（人脸图像）。

消息双向附带该 peer 的 `authEpoch`，接收和执行时都拒绝旧代次，重试保留原代次。下表除 `files.request/result` 外都在 Session peer 上。

DataChannel 上的失败都是 `error:{code, message, reason?, retryAfterMs?}`；通用失败为 `{type:"error", error:{…}}`，auth 通道相同。

**Endpoint → Viewer**

| type | 内容 |
|---|---|
| `presentation.mode` | `{version:1, backend:"video"}` |
| `layout` | generation/epoch、编码尺寸、views（身份、atlas 矩形、DPR、mediaScaleX/Y）、`clientGestures` |
| `presentation.prepare` | `{version:1, barrierId, outputGeneration, layoutEpoch}` |
| `frame` | 可选 viewports:[{viewId,pageHeight,occlusionRevision}]、实际 wire RTP、layoutEpoch、编码信息；有有效源完成时间时附 captureWallTimeMs 等 |
| `focus` | 焦点请求结果与新 token |
| `input.result` | clientSequence、browserSequence、ok/error；触控使用普通有序输入结果 |
| `input.editable` | revision、页面编辑身份、type/flags/selection/composition/caret、`editable.target`、`focusSource:pointer/keyboard/script/other`、`focusRevision` |
| `input.selection` | revision、页面身份（session/id/instance/document）或 null；outputGeneration/layoutEpoch；handles:{start,end,insertion}（各为 null 或根 DIP 的 {x,y,lineHeight}）；`menu`：null 或 {id、根 DIP 锚点 x/y/width/height、handleHeight、commands（cut/copy/paste/selectAll 中可用者，固定顺序）、more} |
| `view.viewport` | viewId、session/instance/document、outputGeneration、pageHeight（DIP）、occlusionRevision；可靠去重反馈，不改变呈现 ready |
| `input.contextMenu` | revision、页面身份或 null；`menu`：null 或 {id、根 DIP 按下点 x/y、source mouse/touch/keyboard、link {url,text}?、image {src}?、selection?、editable {undo,redo,cut,copy,paste,selectAll}?} |
| `files.result` | 文件 RPC 结果 |
| `clock.pong` | serverTimeMs、serverMonotonicMs |
| `stats` | 服务端测量 |

**Viewer → Endpoint**

| type | 内容 |
|---|---|
| `media.presentation` | `{version:1, backend:"video", restart?}` |
| `presentation.ready` | 完整屏障 Key |
| `media.refresh` | 请求补帧（限频 1/秒） |
| `media.feedback` | 约 1.5 秒一次的诊断反馈（不驱动码率/DPR） |
| `focus` | focusRequestId、页面完整身份、layoutEpoch、focused |
| `input` | 完整身份、outputGeneration、layoutEpoch、sequence、event |
| `editing.dismiss` | 完整 InputTarget、outputGeneration/layoutEpoch、sequence、target、revision；与 input 共享顺序，用户收起时 blur 远端元素 |
| `keyboard.layout` | Session 级 `entries: [[code,key], ...]`，最多 256 项，由当前已授权连接提供 |
| `files.request` | `{version:1, requestId, method, params}`。service peer：asset.begin/chunk/seal/cancel/describe/read、document.open{requestId, assetId, type}/document.resource{documentId, contentId, offset}（见[文件与相机 · 文档预览](files-and-camera.md#文档预览)）、photo.burst.begin/sample/end/cancel、photo.thumbnail/process。Session peer：只有 selection.commit/cancel（把文件交给页面） |
| `clock.ping` | requestId |

**input.event**

| type | 字段 |
|---|---|
| `mouse` | action move/down/up/leave、x/y（DIP）、button 0–5、modifiers、click_count |
| `wheel` | x/y、dx/dy（DIP，方向同 Blink）、modifiers |
| `key` | action down/up/char、physical_code、windows_key_code、dom_code、dom_key、modifiers、repeat、text、unmodified_text |
| `ime_set` / `ime_commit` / `ime_cancel` / `ime_finish` | text、selection_start/end（UTF-16）；附 `editableTarget` |
| `touch` | action start/move/end/cancel、points（≤16）、gestureMode `client-v1`、sequenceId、clockMode、sampleElapsedUs、startServerWallUs、samples（≤32）、gestures（≤8） |
| `gesture` | action momentum/momentumEnd/cancel、sequenceId、sampleElapsedUs、cumulativeX/Y；action longPress、sequenceId、sampleElapsedUs、x/y（根 DIP） |
| `selection_command` | menu（菜单 ID）、command cut/copy/paste/selectAll/contextMenu/dismiss；非 dismiss 需要焦点，过期菜单返回 `conflict`；dismiss 可用 menu:"0" 清理手柄 |
| `selection.extent` | which start/end/insertion、x/y（根 DIP），完整有序输入门禁 |
| `context_command` | menu（菜单 ID）、command undo/redo/cut/copy/paste/selectAll/copyLinkAddress/copyImage/copyImageAddress/dismiss；非 dismiss 需要焦点，过期执行返回 `conflict`，旧 dismiss 成功但不操作 |

**`remotekit-auth`**（service peer）：`auth.camera.ready/config/accept/frame` JSON 消息，加 68 字节头的 RGB24 二进制块，见[认证](auth.md#人脸验证)。

## Control ↔ Endpoint

集群通道（本地 stdio 或远端 WebSocket，握手与加密见[多节点 · 集群通道](cluster.md#集群通道)）上的 JSON 消息。协调模型见[多节点 · 协调协议](cluster.md#协调协议)；契约在 `control/server/endpoint/coordination.ts` 与 Endpoint 的对应解码器，两侧对同一份 `protocol/coordination.fixture.json` 校验。

```
握手      node.hello{role, nodeId, buildId, incarnation}
          → node.ready{connectionEpoch, buildId, config, configHash, objectKey, objectIdKey, peers} | node.release{release} | node.reject{code, buildId}
期望状态  node.desired{connectionEpoch, revision, sessions:[{tenantId, sessionId, placementEpoch, dataState}]}
          session.clipboard{tenantId, sessionId, placementEpoch, connectionEpoch, revision, value:{text, html}}
          session.desired{tenantId, sessionId, placementEpoch, connectionEpoch, revision, run, commit, profileKey, checkpoint,
                          sitePreferences, mediaPolicy, quality, clipboard, views, authorization, lock, library}
观察状态  {event:"session.observed", tenantId, sessionId, placementEpoch, endpointIncarnation, nodeRevision, seq, observedRevision,
           converged, browser, browserIncarnation, browserRestart, data, checkpoint, applied, authorization, lock, views,
           pendingPopups, recovery, rtc, blockers, library, events, stats, lastError}
事件流    {event:"session.event", tenantId, sessionId, placementEpoch, streamId, seq, eventId, browserIncarnation, type, body}
          session.events.ack{tenantId, sessionId, placementEpoch, streamId, upTo}
一次性    {id, method, opId, replay, endpointIncarnation, tenantId, sessionId, placementEpoch, params}
回复      {id, ok:true, result} | {id, ok:false, error:{code, message, reason?, retryAfterMs?, errorId?}}
其他事件  {event:"rtc.signal" | "node.metrics", ...}（rtc.signal 同时用于两种 peer）
service peer service.offer/ice/close/authorize{connectionId, leaseId, epoch?, unlocked?}、service.asset.describe、
          service.face.capabilities/begin/cancel/status（不打开 Session、不启动 Browser）
反向请求  {id, request:"object.committed" | "object.committed.batch" | "object.locate" | "object.claims.refresh", ...}（Endpoint → Control，回复形状相同）
Control 写入 object.put.begin{putId, tenantId, sizeHint?} → BINARY {putId, offset}+≤1MiB … object.put.end{putId}
          → {objectId, size, storedSize, storedSha256}；object.put.cancel{putId}
节点集合  node.peers{peers}
保活      {type:"node.ping"} / {type:"node.pong"}
更新包    package.get{buildId, offset} → BINARY package.chunk{offset} … package.end{size}（role updater）
```

**期望状态的字段**（`session.desired`，整份文档，`revision` 单调递增并由 Control 持久化）：

| 字段 | 内容 |
|---|---|
| `run` / `commit` | `running` 或 `stopped`；`commit` 为提交请求 ID 或 null（`running` 带 commit 是 `invalid_request`） |
| `profileKey` / `checkpoint` | Profile 密钥；打开时要恢复的已提交 checkpoint |
| `sitePreferences` / `mediaPolicy` / `quality` | 完整站点规则表；`{degradationPreference, maxFps, audio}`；有效 DPR |
| `clipboard` | `{revision}`（`"0"` 为空）；内容由 `session.clipboard` 单独送达，在任何 view 之前写入 Browser |
| `views` | 按产品顺序的期望 view：`viewId`、`presence`（`ensure` 或 `ifPresent`）、URL、尺寸、visible、device、occludedBottom/occlusionRevision、可选 `signIn`（`changyan`/`xinjiaoyu`）与 `adopt`（收养弹窗） |
| `authorization` / `lock` | RTC 授权（connectionId、epoch、unlocked、文件授权）与锁定状态；先于其他字段生效 |
| `library.describe` | 需要 Endpoint 描述的资产 |

**事件类型**：`view.closed`、`download.imported`、`download.failed`、`clipboard.changed`（带 `baseRevision`，超限时只带大小）、`view.signIn`。

**一次性方法**（都带 `opId`，见[协调协议](cluster.md#协调协议)）：

| 方法 | 说明 |
|---|---|
| `view.navigate` / `view.command` / `view.navigation.ack` | 导航与 history 命令（带 operationId/Generation/Sequence）；终态确认 |
| `view.lifecycle` | freeze/discard/unload/restore；不确定恢复带 browserIncarnation、lifecycleGeneration |
| `view.close` / `view.close.reply` | 关闭；对 beforeunload 的回复带完整身份 |
| `view.page.reply` / `view.page.exitFullscreen` | 对话框回复、退出网页全屏（精确绑定运行实例与文档） |
| `view.appInfo` | 读取页面的 App 信息（安装网页为 App） |
| `session.identity` | Browser 的 UA 与 Client Hints 元数据 |
| `session.snapshot` | 只读诊断快照；`outputDiagnostics:true` 附输出状态 |
| `session.logs.read` | 诊断用原始日志窗口：`{log: browser | endpoint | endpoint.1, end?, maxBytes ≤ 512 KiB}` → `{exists, size, start, end, data(base64)}`；`browser` 是节点 `logs/browser/<sessionId>.log`，`crashes`/`dump/<name>` 来自节点 `logs/crashes/<sessionId>/` |
| `session.library.prepare/selectionStatus` | 文件选择事务 |
| `session.storage.import/importStatus` | 会话导入写入 |
| `rtc.offer` / `rtc.ice` / `rtc.close` / `rtc.actionResult` | 信令（`rtc.offer` 必带 `avSync`）；产品动作的收据回传 |
| `auth.face.capabilities/begin/status/cancel` | 人脸挑战 |
| `object.derivation` / `object.render` / `object.fetch` / `object.delete` / `object.inventory` | 节点级：文档渲染结果、拉取副本、删除、分页列出对象 |
| `node.logs.search` | 节点级：`{errorId}` → `{lines}`，最多 50 行，按时间从旧到新 |
| `session.cold.delete` / `session.delete` / `shutdown` | 节点级：删除冷副本；删除一个 Session 的全部本地数据；优雅关闭 Endpoint |

观察状态中 view 的 `actual/desired`：0 live、1 frozen、2 discarded、3 unloaded；`blockers` 是停止阻塞项（未确认事件、未决原生选择、上传中、页面请求、下载中与未交接的下载导入的计数，以及 RTC 是否连接、生命周期是否不确定）。

**Endpoint ↔ Endpoint**：TCP，u32le 长度帧，同一个 Noise 握手（role `peer`，buildId 必须相同）。`object.get{id, offset}` → BINARY `object.chunk{offset}`（≤1MiB 存储文件字节）… `object.end{size, sha256}`，或 `object.error{code, message, retryAfterMs?}`。

## Endpoint ↔ Browser

**控制**：`--control-channel=remotekit-<随机>` 的 Windows NamedPlatformChannel，SDK 用 `IsolatedConnection` 连接（两侧各自保持 Mojo 进程图）。一次一个请求在途，消息上限 1MiB，严格 UTF-8 JSON，JSON 深度 32。Browser 只接受一个控制客户端，重启使用新的随机通道名。

```
请求  {version:1, id, method, ...}
回复  {version:1, id, ok:true, ...} | {version:1, id, ok:false, error:{code, message, reason?, retryAfterMs?}}
```

`code` 是 `protocol/errors.h` 中错误码的名称。方法包括 `snapshot`、`shutdown`、`session.sitePreferences`、`view.create/adopt/configure/recreate/close/closed.ack`、`focus`、`visible`、`navigate`、`lifecycle`、`input`、`page.requests/reply/fileStatus/command/exitFullscreen/contextMenu`、`clipboard.read/write`、`profile.downloads`、`navigation.ack`、`navigation.export.begin/chunk`、`navigation.import.begin/chunk/commit`、`navigation.transfer.cancel`、`output.open/describe/configure/status/close`、`audio.open/close`。`profile.downloads` 把参数放在 `command` 对象里，避免与 envelope 的 `id` 冲突。

`input` 中的键盘布局以 `{session, event:{type:"keyboard.layout", entries}}` 更新 Session，不携带 view token。其余输入保留原 view token 与顺序门禁。`mouse.pen` 可携带 `{id,pressure,tiltX,tiltY,twist,eraser}`，触点及其历史采样可携带 DIP 单位的 `width`、`height`。

`output.configure`：width/height（DIP）、device_scale（0.5–4）、enabled、viewConfigs；尺寸/scale/viewConfigs 变化前须先关闭输出。实际物理尺寸 = `ceil(DIP × scale)` 向上取偶，单轴 ≤8192、面积 ≤16,777,216，超出返回资源预算错误。`output.describe` 返回映射、4 个 Slot 纹理、4 个 ready Fence、4 个 consumed Fence 的句柄（复制进调用方进程），并一次性移交渲染管道。

**渲染管道**：48 字节定长消息 Begin/Reject/Stop/Stopped/Wake，见[渲染](rendering.md#渲染管道协议)。

**共享内存**：`SharedRenderMapping` v5（布局与每 Slot 帧快照）、`SharedAudio` v1（8 槽 10ms PCM 块）。

## SDK C ABI

控制/渲染 ABI 2、RTC ABI 5、SharedRenderMapping v5——三者与 Browser、Endpoint 必须同时更新，不能混用旧版本。跨 DLL 只传 C 类型、整数句柄、显式长度的缓冲、定长结构（带 `struct_size`）和回调指针。

| 族 | 函数 |
|---|---|
| 运行时 | `remotekit_sdk_abi_version`、`initialize`、`shutdown`（幂等初始化；关闭是终态，要求先关闭所有 peer 与渲染通道） |
| 控制 | `remotekit_sdk_control_connect/request/close`、`control_command`、`control_command_token`、`control_open_render` |
| 渲染 | `remotekit_sdk_render_connect/begin/observe_signal/stop/close` |
| 键码 | `remotekit_sdk_windows_dom_code/dom_key` |
| RTC | `remotekit_rtc_create/close/sample_clock`、`create_offer/set_remote_description/add_ice/get_receive_level`、`set_media_authorized/set_audio_enabled/set_av_sync/set_degradation_preference/set_source_max_fps/set_playout_delay`、`adapt_frame/submit_texture`、`submit_audio`、`send_data/send_auth_data`、`request_stats`、`encoded/encoder_drop` |

要点：
- 控制请求从工作线程调用；超时、输出缓冲不足、传输失败会关闭并作废该句柄（防止后续请求收到旧回复）。Browser 的应用拒绝（`ok:false`）是一次成功的传输，不作废句柄。
- `submit_texture` 成功时把一份释放义务转给 SDK；硬件编码器需在 encode 回调返回前持有自己的租约，硬件完成后释放。只持有 COM 引用不能阻止纹理池覆盖内容。
- 每个被接受的编码时间戳恰有一次 `encoded` 或 `encoder_drop`；encoder ID 不复用，销毁后的迟到完成被拒绝。`encoded` 的第三个参数返回实际发出的 RTP 时间戳（WebRTC 会加随机偏移），接收端关联用它。
- peer 关闭与 `render_close` 是回调屏障，不是 GPU 完成证明。
- `set_playout_delay` 两个值都是 10ms 的倍数，`0 ≤ min ≤ max ≤ 40950`；已安装后不能取消（需重建 peer）。
- `set_av_sync` 只能在 `set_remote_description` 之前调用，决定音频发送器的 stream id（与视频相同即接收端唇音同步），之后返回 INVALID_STATE。`set_audio_enabled` 运行期生效：音频发送器只在"媒体已授权且音频启用"时活动，禁用期间 `submit_audio` 接受并丢弃 PCM。

## 编辑、选择与遮挡的 Browser 边界

Endpoint 的 `clipboard.changed` 管理事件保留 Tenant/Session/browserSequence，增加写入 `viewId?` 与 `excludeFromHistory`。Browser `clipboard.read` 返回 sequence/viewId/excludeFromHistory/text/html；正文只在剪贴板与片段链路传递。

Endpoint 把 DC `editing.dismiss` 转为 Browser `input` 请求的 `event:{type:editing.dismiss,target,revision}`，保留完整身份并分配 browser sequence。Session 收尾使用 `input {session,event:{type:menus.close}}`，不携带 view 或 output_generation。

Browser 原地 `view.configure` 使用 `occludedBottom / occlusionRevision / outputGeneration`，稳定尺寸变化走完整 `output.configure.viewConfigs` 并携带相同遮挡字段；过期代次/revision 返回 ignored。共享映射 ABI 为 v8：focus 来源和观测、水滴几何、page_height_dip 与 occlusion_revision 与帧快照一起发布。Viz 配置 `target_size` 是稳定纹理尺寸，Begin token 的 `page_height_pixels` 是当前页面范围，二者不能互换。

## 身份、代次与序号

协议里的计数器各有唯一所有者和明确的作用范围。"相等"类只比较是否相同；"单调"类只在所列范围内比较大小，越过范围必须换一个上层身份（例如 Endpoint 换了进程，`seq` 才可以重新开始）。每个"单调跨某个生命周期事件"的假设都有一个跨越该事件的测试（执行器重建、管理重连、Endpoint 进程替换、Browser 重启、Viewer 重连、RTC peer 替换、Control 重启）。

| 名称 | 所有者 | 范围与递增 | 使用方的假设 | 持久化 |
|---|---|---|---|---|
| `endpointIncarnation` | Endpoint 进程 | 每次启动随机 | 相等；它变了，`seq` 才可以重新开始 | 否 |
| `connectionEpoch` | Control（`node-link.ts`） | 每次管理连接握手新生成 | 相等；旧连接的回复、观察与授权全部作废 | 否 |
| `node.desired.revision` | Control | 管理连接内，fencing 清单变化时加一 | 同一连接内单调 | 否 |
| `placementEpoch` | Control（`placement.ts`） | 每次重新放置或转移加一；同节点继续 dirty 副本时不变 | 跨 Control 重启单调；Endpoint 用它隔离旧副本与旧执行器 | 是 |
| `session.desired.revision` | Control | 期望文档内容或放置变化时加一 | 跨 Control 重启单调 | 是 |
| `session.observed.seq` | Endpoint（`Service`） | 整个 Endpoint 进程共享，每次发送观察加一 | 同一进程内跨执行器重建单调 | 否 |
| 事件 `seq` / `upTo` / `streamId` / `eventId` | Endpoint `session.db` | 流内连续递增；恢复或新放置时换流并重新编号，`eventId` 不变 | 流内连续；`eventId` 跨流去重 | 是 |
| `browserIncarnation` | Endpoint（`browser.cpp`） | 每个 Browser 进程随机 | 相等；Browser 内部的各种代次只在同一 incarnation 内比较 | 否 |
| 运行代次（版本） | `SessionExecution` | 运行时创建、启动、成功停止、退役时加一 | 版本的 C 段要求与 A 段一致 | 否 |
| peer 授权代次 `authEpoch` | Control（每条 peer） | 授权变化时加一；新 peer 从零开始 | 同一 `connectionId` 内单调 | 否 |
| 锁定代次 `AuthState.epoch` | Control（Viewer 租约） | 锁定或解锁时加一；新租约从一开始 | 同一租约内单调 | 否 |
| `outputGeneration` | Endpoint 渲染输出 | 重新打开输出时换新 | 相等；Browser 重启后可以更小 | 否 |
| `layoutEpoch` | Endpoint 呈现控制 | 几何真正变化或显式作废时加一；相同布局不变，跨 peer 重绑保持 | 输入、帧、选择与反馈要求当前值 | 否 |
| 呈现屏障 `barrierId` | Endpoint | 输出、布局或视频重启时新建 | Viewer 必须原样回传 | 否 |
| `occlusionRevision` | Viewer 视口请求 | 每窗口几何或遮挡变化时加一，以时间为种子 | 同一租约内单调 | 否 |
| `workspace.revision` | Control | 产品状态有实际变化时加一 | 跨 Control 重启单调；Viewer 据此撤掉乐观投影 | 是 |
| `operationGeneration` / `operationSequence` | Control | 收据账本轮换时换代；每次受理操作序号加一 | 代相等；序号跨重启单调 | 是 |
| `snapshotSequence` / `serverIncarnation` | Control | 快照内容变化时加一；每次启动换 incarnation | 同一 Control 进程内单调 | 否 |
| `library.revision` | Control | 目录、文件篮或可用性变化时加一 | 跨 Control 重启单调 | 是 |
| 剪贴板 `revision` / `baseRevision` | Control | 每次接受写入加一；清除时重置 | 同一账户内单调 | 是 |
| 客户端输入 `sequence` | Viewer 输入管线 | 每次提交加一；Endpoint 在 peer 替换时重置高水位 | 同一 peer 内单调 | 否 |
| Noise 发送与接收 nonce | 集群通道两端 | 每条传输消息加一；用尽即断开 | 同一密钥内单调；重连先协商新密钥 | 否 |

完整清单（含媒体、诊断、会话导入与时钟相关的计数器）在代码旁的注释与对应测试里；新增计数器时在此表登记所有者、范围与假设，并补跨生命周期的测试。
