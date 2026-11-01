# 串流管理与客户端接口

## Control↔Endpoint

Control启动endpoint_service，以stdin/stdout UTF-8 JSONL管理；stdout只输出协议，日志走stderr。请求{id,method,tenantId,...}，回复{id,ok,result}或{id,ok:false,error}；消息上限1MiB。Tenant身份由已认证用户映射产生，客户端不能指定。该管理通道不暴露未认证网络端口。

| method | 主要语义 |
|---|---|
| session.ensure | 显式启动/取得Session，幂等；accepted不等待导航恢复完成，返回browserIncarnation/recovery |
| session.snapshot | 只读运行状态、live views、stats、pendingPopups和未确认events；不启动Browser |
| session.sitePreferences | 完整origin规则表；未启动时缓存，启动前应用；返回accepted/applied |
| session.mediaPolicy | targetFps/bitrateKbps/maxBitrateKbps/adaptive；每Session独立缓存，requested与真实applied分开 |
| session.events.ack | eventIds；自然关闭事件在产品状态持久化后确认 |
| view.ensure / view.configure | 稳定viewId、URL/viewport/device/visible；configure可带requireRunning防离线维护拉起Browser |
| view.lifecycle | viewId、discard/restore；accepted/pending/completed分开，可带requireRunning |
| view.navigate / view.command | 地址或back/forward/reload/stop |
| view.close / view.close.reply | 正常关闭/确认；回复带browserIncarnation、instance、document和原requestId，只能命中原beforeunload；force用于明确清理 |
| view.adopt | provisionalId、产品分配的viewId及配置；收养真实WebContents，重复同绑定幂等 |
| view.page.reply | viewId/requestId/browserIncarnation/instance/document/accept/text；仅同一运行实例标准dialog，过期拒绝且不启动Browser |
| rtc.offer / rtc.ice / rtc.close | 当前Session与connectionId下的媒体协商/清理 |
| shutdown | 正常清理资源与子进程 |

snapshot view的actual/desired为0 live、1 frozen、2 discarded、3 unloaded；包含pending、lifecycle_generation、last_lifecycle、canDiscard/discardBlockReason。不能从accepted推断renderer已完成。异步恢复时recovery={pending,phase,error}记录Endpoint任务；browserPending/browserDesired保留Browser观察值，投影pending不会把中间空页当作恢复完成。

## Client↔Control

正常入口为注册/登录后的用户工作区。认证HTTP接口为GET /api/auth/me及POST /api/auth/register、login、logout；使用HttpOnly、SameSite=Strict token cookie，HTTPS加Secure。写请求及WS upgrade检查Origin。

WebSocket `/api/socket`：

```text
请求    {id,method,params}
成功    {type:"result",id,result}
失败    {type:"error",id,error:{code,message}}
状态    {type:"state",revision,state}
接管    {type:"lease",status:"revoked",reason}
```

method包括action、viewport、feedback、rtc.offer/ice/close和clock.ping。完整类型以[product.ts](../control/shared/product.ts)为准。state包含user/workspace、pageDialogs、quality、Viewer连接及Endpoint状态；产品关系与设置只存服务端。

每用户单Viewer租约。旧端被接管后停止媒体，不能自动重连争抢。端点重建与Socket恢复使用新连接身份；过期操作和页面dialog不能复用到新文档。

`POST /api/metrics`保留HTTP上传，支持工具的完整/分块报告。legacy `/api/state/actions/rtc/*`仅供服务端显式开启的诊断实例和隔离legacy用户；query/header不能开启诊断。普通Viewer不轮询这些接口。

## Client↔Endpoint

视频为每Session一个H264 atlas track。DataChannel `remotekit`为ordered/reliable，64位ID和代次用十进制字符串：

- layout：generation/epoch、编码尺寸及views的身份、矩形、DPR/mediaScale。
- frame：实际wire RTP、layoutEpoch、编码信息；可附captureWallTimeMs、captureMonotonicMs、captureClockUncertaintyMs、sourceCaptureId。无有效采集时间则省略。
- focus：请求ID、页面完整身份和布局代次；确认必须匹配当前请求后才能放行排队输入。
- input：完整Session/view/instance/document/focus、outputGeneration/layoutEpoch、连接内sequence及事件。Endpoint先拒绝旧peer和连接内重复/倒退，再分配Session持续递增的Browser sequence；回执区分clientSequence/browserSequence，重登录无需客户端持久化计数。
- media.feedback：布局绑定的显示/解码/丢帧等观察，供Endpoint源预算控制。
- stats：实际测量和状态；未知项保持缺失，不以零冒充。

客户端只在匹配真实wire RTP与当前layout epoch后呈现/授权输入。空layout、故障、暂停或重建立即撤销旧ready；有新layout但没有匹配帧时不能点击旧画面。重绘同一帧不增加FPS。

Source atlas可在NV12转换时按接收H264上限等比采样；布局和输入同时带对应比例。支持真实RTP元数据的新客户端使用不可变VideoFrame/fifo2；能力不足退回video。Chrome89保留video路径，其rVFC与drawImage不是原子frame handle；测量不得把它宣称为不可变帧验证。

普通产品探测实际解码能力后选择已验证的H264 level4.2；不支持或协商失败回native，诊断显式选择独立。接收能力上限不会因提高产品码率请求而消失。
