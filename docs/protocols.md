# 协议参考

各边界的消息一览。语义与设计理由见各子系统文档；类型的权威定义在代码里（`control/shared/*.ts`、`protocol/*.h`、`sdk/include/*.h`）。所有 64 位 ID、代次和序号在 JSON 里都用十进制字符串，避免精度丢失。错误统一使用[错误码](architecture.md#错误模型)。

## Viewer ↔ Control

**HTTP**

| 路由 | 说明 |
|---|---|
| `GET /api/auth/registration` | 公开：hasAdmin、credentialRequired、registrationOpen |
| `GET /api/auth/me` | 当前账户 |
| `POST /api/auth/register` | 账号、密码、注册口令（首个账号免口令）；签发 token 与一次性首租约许可 |
| `POST /api/auth/login` / `logout` | 登录签发 token；注销只撤销当前 token |
| `GET /api/socket` | WebSocket upgrade |
| `GET /api/endpoint` | 远端 Endpoint 管理连接（Bearer） |
| 其他 GET | Viewer 静态资源 |

POST 与 upgrade 检查 Origin；JSON body 不允许携带 tenant/user 身份字段。

**WebSocket `/api/socket`**：上限 1MiB，每连接最多 32 个在途请求，请求 ID ≤128 字符。

```
请求  {id, method, params}
成功  {type:"result", id, result}
失败  {type:"error", id, error:{code, message}}
推送  {type:"state", revision, state}       产品快照（锁定时不推送）
      {type:"auth", auth}                   锁定状态
      {type:"rtc.signal", connectionId, attemptId, signal}
      {type:"lease", status:"revoked", reason:"another-viewer"|"logout"}
```

| 方法 | 用途 |
|---|---|
| `viewport` | 各 Window 内容区的实际尺寸与 DPR |
| `rtc.offer` / `rtc.ice` / `rtc.close` | 信令（trickle） |
| `clock.ping` | Control 时钟（产品新鲜度） |
| `operation.status` | 查询操作收据 |
| `settings.update` | 保存设置 |
| `feedback` | 诊断用媒体反馈 |
| `auth.get/lock/verify/settings/password`、`auth.face.begin/cancel/remove` | 锁屏与凭据 |
| `admin.get` / `admin.setRegistrationCredential` | 管理员 |
| `library.get/import/replace/basket/group/move/delete/prepare/finish` | 文件目录与选择事务 |
| `diagnostics.start/sample/stop/status` | 诊断收集 |

其余产品动作只走 DataChannel，WS 不提供旁路。

## Viewer ↔ Endpoint（WebRTC）

一个 PeerConnection：H.264 视频 track（atlas）、Opus 立体声音频 track（客户端 recvonly），以及两条可靠有序 DataChannel：`remotekit`（JSON）与 `remotekit-auth`（人脸图像）。产品消息双向附带 `authEpoch`，接收和执行时都拒绝旧代次，重试保留原代次。

DataChannel failures carry `error:{code:ErrorCode,message:string}`; generic failures use `{type:"error",error:{code,message}}`, including the auth channel. Operation receipt `status` / `error` descriptions keep their domain format.

**Endpoint → Viewer**

| type | 内容 |
|---|---|
| `presentation.mode` | `{version:1, backend:"video"}` |
| `layout` | generation/epoch、编码尺寸、views（身份、atlas 矩形、DPR、mediaScaleX/Y）、`clientGestures` |
| `presentation.prepare` | `{version:1, barrierId, outputGeneration, layoutEpoch}` |
| `frame` | 实际 wire RTP、layoutEpoch、编码信息；有有效源完成时间时附 captureWallTimeMs 等 |
| `focus` | 焦点请求结果与新 token |
| `input.result` | clientSequence、browserSequence、ok/error；触控使用普通有序输入结果 |
| `input.editable` | revision、页面编辑身份、type/flags/selection/composition/caret、`editable.target` |
| `product.result` | 操作收据 |
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
| `product.action` | `{version:1, operationId, operationGeneration, action}` |
| `files.request` | `{version:1, requestId, method, params}`：asset.begin/chunk/seal/cancel/describe/read、selection.commit、photo.burst.begin/sample/end/cancel、photo.thumbnail/process |
| `clock.ping` | requestId |

**input.event**

| type | 字段 |
|---|---|
| `mouse` | action move/down/up/leave、x/y（DIP）、button 0–5、modifiers、click_count |
| `wheel` | x/y、dx/dy（DIP，方向同 Blink）、modifiers |
| `key` | action down/up/char、physical_code、windows_key_code、dom_code、dom_key、modifiers、repeat、text、unmodified_text |
| `ime_set` / `ime_commit` / `ime_cancel` / `ime_finish` | text、selection_start/end（UTF-16）；附 `editableTarget` |
| `touch` | action start/move/end/cancel、points（≤16）、gestureMode `client-v1`、sequenceId、clockMode、sampleElapsedUs、startServerWallUs、samples（≤32）、gestures（≤8） |
| `gesture` | action momentum/momentumEnd/cancel、sequenceId、sampleElapsedUs、cumulativeX/Y |

**`remotekit-auth`**：`auth.camera.ready/config/accept/frame` JSON 消息，加 68 字节头的 RGB24 二进制块，见[认证](auth.md#人脸验证)。

## Control ↔ Endpoint

本地 JSONL（stdin/stdout）或远端 WSS，消息相同：

```
请求  {id, method, tenantId, ...参数}
回复  {id, ok:true, result} | {id, ok:false, error:{code, message}}
事件  {event:"rtc.signal" | "client.action", ...}
远端握手  node.hello{version, nodeId, endpointIncarnation} → node.ready{version, connectionEpoch}
```

| 方法 | 说明 |
|---|---|
| `session.ensure` | 启动/取得 Session，幂等；返回 browserIncarnation 与恢复状态，不等导航 |
| `session.snapshot` | 只读：views、stats、pendingPopups、未确认事件、导航操作；不启动 Browser；`outputDiagnostics:true` 附输出状态 |
| `session.sitePreferences` | 完整 origin→UA 规则表 |
| `session.mediaPolicy` | `{degradationPreference, maxFps, audio}`；`audio` 为 false 时音频发送器停用、PCM 不进编码器 |
| `session.events.ack` | 确认已持久化的自然关闭事件 |
| `session.files.authorize` | 授权原生选择器与文件库的 DC 文件操作 |
| `session.library.describe/retain/references/prepare/selectionStatus` | 文件资产与选择事务 |
| `view.ensure` / `view.configure` | 稳定 viewId、URL、viewport、device、visible；`requireRunning` 防止维护请求拉起 Browser |
| `view.navigate` / `view.command` / `view.navigation.ack` | 导航与 history 命令（带 operationId/Generation/Sequence）；终态确认 |
| `view.lifecycle` | freeze/discard/unload/restore；不确定恢复带 requireRunning、browserIncarnation、lifecycleGeneration |
| `view.close` / `view.close.reply` | 关闭；对 beforeunload 的回复带完整身份 |
| `view.adopt` | 收养弹窗：provisionalId + 产品分配的 viewId |
| `view.page.reply` / `view.page.exitFullscreen` | 对话框回复、退出网页全屏（精确绑定运行实例与文档） |
| `rtc.offer` / `rtc.ice` / `rtc.close` | 信令；`rtc.offer` 必带 `avSync`，应答回显该 peer 实际采用的值 |
| `rtc.authorize` | connectionId、epoch、unlocked |
| `rtc.actionResult` | 产品动作的收据回传 |
| `auth.face.capabilities/begin/status/cancel` | 人脸挑战 |
| `shutdown` | 仅本地模式 |

快照中 view 的 `actual/desired`：0 live、1 frozen、2 discarded、3 unloaded。

## Endpoint ↔ Browser

**控制**：`--control-channel=remotekit-<随机>` 的 Windows NamedPlatformChannel，SDK 用 `IsolatedConnection` 连接（两侧各自保持 Mojo 进程图）。一次一个请求在途，消息上限 1MiB，严格 UTF-8 JSON，JSON 深度 32。Browser 只接受一个控制客户端，重启使用新的随机通道名。

```
请求  {version:1, id, method, ...}
回复  {version:1, id, ok:true, ...} | {version:1, id, ok:false, code, error, detail}
```

`code` 是 `protocol/control.h` 中的 Browser 错误码（busy=6 等）。方法：`snapshot`、`shutdown`、`session.sitePreferences`、`view.create/adopt/configure/recreate/close/closed.ack`、`focus`、`visible`、`navigate`、`lifecycle`、`input`、`page.requests/reply/fileStatus/command/exitFullscreen`、`profile.permissions/downloads`（参数放在 `command` 对象里，避免与 envelope 的 id 冲突）、`navigation.ack`、`navigation.export.begin/chunk`、`navigation.import.begin/chunk/commit`、`navigation.transfer.cancel`、`output.open/describe/configure/status/close`、`audio.open/close`。

`output.configure`：width/height（DIP）、device_scale（0.5–4）、enabled、viewConfigs；尺寸/scale/viewConfigs 变化前须先关闭输出。实际物理尺寸 = `ceil(DIP × scale)` 向上取偶，单轴 ≤8192、面积 ≤16,777,216，超出返回资源预算错误。`output.describe` 返回映射、4 个 Slot 纹理、4 个 ready Fence、4 个 consumed Fence 的句柄（复制进调用方进程），并一次性移交渲染管道。

**渲染管道**：48 字节定长消息 Begin/Reject/Stop/Stopped/Wake，见[渲染](rendering.md#渲染管道协议)。

**共享内存**：`SharedRenderMapping` v2（布局与每 Slot 帧快照）、`SharedAudio` v1（8 槽 10ms PCM 块）。

## SDK C ABI

控制/渲染 ABI 2、RTC ABI 5、SharedRenderMapping v2——三者与 Browser、Endpoint 必须同时更新，不能混用旧版本。跨 DLL 只传 C 类型、整数句柄、显式长度的缓冲、定长结构（带 `struct_size`）和回调指针。

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
