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

内部诊断可在`session.snapshot`显式传`outputDiagnostics:true`，取得Browser现有`output.status`的本代捕获、发布、租约与Fence状态；普通snapshot不增加该RPC。查询失败只在诊断字段返回`output_status_unavailable`，不把健康Session误报为退出。

snapshot view的actual/desired为0 live、1 frozen、2 discarded、3 unloaded；包含pending、lifecycle_generation、last_lifecycle、canDiscard/discardBlockReason。不能从accepted推断renderer已完成。异步恢复时recovery={pending,phase,error}记录Endpoint任务；browserPending/browserDesired保留Browser观察值，投影pending不会把中间空页当作恢复完成。

## Client↔Control

正常入口为注册/登录后的用户工作区。公开GET /api/auth/registration返回hasAdmin/credentialRequired/registrationOpen。认证HTTP接口为GET /api/auth/me及POST /api/auth/register、login、logout；register增加serverCredential注册口令，首个正式账号免口令成为管理员，其他注册须已配置的当前口令；使用HttpOnly、SameSite=Strict token cookie，HTTPS加Secure。写请求及WS upgrade检查Origin。

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
- media.presentation：`{version:1,backend:"video"|"canvas"}`协商呈现后端；Endpoint建立发送屏障后回复同版本的`presentation.mode`。
- presentation.prepare：`{version:1,barrierId,outputGeneration,layoutEpoch}`，三个身份均为十进制字符串，紧随对应layout。Client隐藏所有video、撤销输入ready，跨两次前台rAF后以`presentation.ready`返回同一完整key；旧peer/旧key不能放行。
- stats：实际测量和状态；未知项保持缺失，不以零冒充。

音频为同一PeerConnection上的Session级Opus输出track；客户端offer音频方向为recvonly或inactive，不接受客户端上行音频。video-only旧offer继续兼容。文件字节经Control的HTTP流式上传，不使用DataChannel；WS `files.begin/commit/cancel`及ticket/文件生命周期见[音频与文件](audio-and-files.zh-CN.md)。

客户端只在匹配真实wire RTP与当前layout epoch后呈现/授权输入。空layout、故障、暂停或重建立即撤销旧ready；有新layout但没有匹配帧时不能点击旧画面。重绘同一帧不增加FPS。

正式Viewer优先协商video，每个可见平面使用共享同一接收track的独立video。目标位置与大小来自客户端内容bounds，atlas矩形仅用于源裁剪；输入层使用相同bounds。video静音、内联，无原生controls、画中画、远程播放和媒体交互；声音由独立Viewer音频管线播放。默认路径不运行MSTP读取或canvas绘制，能力/协议失败才恢复canvas。

Endpoint在实际`remotekit_rtc_encoded`发送边界串行化屏障与布局更新，覆盖已进入编码器的旧结果。当前peer完整最新ACK只解除等待，当前布局首个成功发送仍须为关键帧。旧epoch结果丢弃并正常结束编码/纹理/尾帧租约；静态重发保留实际纹理身份，不给旧纹理重贴新布局。隐藏页可持续等待，不通过超时强行放行。切canvas解除ACK等待但保留关键帧恢复，未协商的旧canvas客户端保持原行为。

每个video自身首次真实RTP/epoch匹配后才恢复该平面的显示和输入。布局换代、隐藏、重连立即撤销ready；同一已确认布局内晚到的逐帧元数据不改变裁剪关系，不凭未知RTP生成延迟或Marker样本。rVFC是compositor提交观察，不是逐帧拒绝API，也不证明物理屏幕点亮。

Source atlas可在NV12转换时按接收H264上限等比采样；布局和输入同时带对应比例。canvas回退按能力使用不可变VideoFrame/fifo2或video快照；Chrome89保留兼容，其rVFC与drawImage不是原子frame handle，不能宣称为不可变帧验证。

普通产品按接收能力选择H264 level5.2、5.1、4.2或native；探测并行、有总超时且页面内缓存，Chrome89保留4.2兼容路径。编码协商失败可降档，网络超时不会永久降低解码能力。优先高画质以viewport×ClientScale为目标；完整尺寸满足单帧上限、但超过像素速率预算时先降低帧率，自动与流畅档保持帧率优先。实际源/编码尺寸、有效帧率及限制原因由stats报告。

canvas回退下，两个以上合格的不可变平面共用一个WebGL画布，每帧上传一次atlas并按各平面矩形绘制；单平面、Chrome89及不支持的情况使用2D路径。上下文丢失恢复2D，静态内容优先重画现有帧；没有可用帧时通过当前peer限频的`media.refresh`请求刷新。video统计使用各平面`presentedFrames`增量，canvas统计使用JS新帧绘制提交；rVFC回调次数不当作显示FPS。Marker像素读取仅用于显式测量，正常video不做逐帧copy。

产品信令采用trickle ICE：Endpoint接受offer后异步发`rtc.signal`，Control按Tenant、Viewer租约、connectionId与attemptId路由answer/candidate。早到候选有界排队，取消或接管撤销旧绑定。现有UDP网络模拟和旧诊断接口保留完整ICE收集路径，避免候选旁路网络模拟。连接阶段耗时使用各进程本地单调时钟。

管理员通过已鉴权WS的admin.get取得registrationCredentialConfigured，通过admin.setRegistrationCredential {serverCredential}替换注册口令。两者服务端检查管理员身份与当前lease；配置仅返回是否设置。口令8–256字符，角色与口令不允许由注册请求指定或覆盖；ProductUser.isAdmin表示服务端确定的身份。
