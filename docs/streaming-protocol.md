# 串流管理与客户端接口

## Control↔Endpoint

本地模式由Control启动endpoint_service，以stdin/stdout UTF-8 JSONL管理；stdout只输出协议，日志走stderr。远端模式由Endpoint主动连接Control的`/api/endpoint`认证WSS，配置固定nodeId与环境Bearer，握手带版本及connectionEpoch。消息沿用请求{id,method,tenantId,...}、回复{id,ok,result}或{id,ok:false,error}及异步事件，上限1MiB。Tenant身份由已认证用户映射产生，客户端不能指定。旧管理socket不能完成新代请求，断线不销毁已有RTC，也不盲目重放变更命令；本机明文开发例外及代理约束见[Control入口](../control/README.md)。

`node.hello.endpointIncarnation`是Endpoint进程启动时生成、跨socket重连保持的随机身份；`node.ready.connectionEpoch`只表示一次管理连接。Control同进程重连保留Viewer、RTC lease与媒体generation并做snapshot对账；只有真正进程替换才整体失效。Session snapshot的`rtc.active`表示peer对象存在，不能当ICE connected；同进程中只有某个Session实际peer丢失时，单独推进该Tenant媒体generation，其它租户不重连。

| method | 主要语义 |
|---|---|
| session.ensure | 显式启动/取得Session，幂等；accepted不等待导航恢复完成，返回browserIncarnation/recovery |
| session.snapshot | 只读运行状态、live views、stats、pendingPopups和未确认events；不启动Browser |
| session.sitePreferences | 完整origin规则表；未启动时缓存，启动前应用；返回accepted/applied |
| session.mediaPolicy | degradationPreference/maxFps；三档仅映射WebRTC偏好，每Session独立缓存，requested与实际applied分开 |
| session.events.ack | eventIds；自然关闭事件在产品状态持久化后确认 |
| view.ensure / view.configure | 稳定viewId、URL/viewport/device/visible；configure可带requireRunning防离线维护拉起Browser |
| view.lifecycle | viewId、freeze/discard/restore；uncertain恢复使用guarded unload/restore；accepted/pending/completed分开 |
| view.navigate / view.command | 地址或back/forward/reload/stop |
| view.close / view.close.reply | 正常关闭/确认；回复带browserIncarnation、instance、document和原requestId，只能命中原beforeunload；force用于明确清理 |
| view.adopt | provisionalId、产品分配的viewId及配置；收养真实WebContents，重复同绑定幂等 |
| view.page.reply | viewId/requestId/browserIncarnation/instance/document/accept/text；仅同一运行实例标准dialog，过期拒绝且不启动Browser |
| view.page.exitFullscreen | viewId/browserIncarnation/instance/document；退出当前文档内部全屏，精确绑定运行实例，过期拒绝且不启动Browser |
| rtc.offer / rtc.ice / rtc.close | 当前Session与connectionId下的媒体协商/清理 |
| rtc.authorize | connectionId/epoch/unlocked；锁定保留peer，清退旧权限，恢复必须通过新代门禁 |
| auth.face.capabilities / begin / status / cancel | Control建立并核对短期人脸挑战；模板仅经管理通道，图像走直接RTC |
| shutdown | 正常清理资源与子进程 |

内部诊断可在`session.snapshot`显式传`outputDiagnostics:true`，取得Browser现有`output.status`的本代捕获、发布、租约与Fence状态；普通snapshot不增加该RPC。查询失败只在诊断字段返回`output_status_unavailable`，不把健康Session误报为退出。

snapshot view的actual/desired为0 live、1 frozen、2 discarded、3 unloaded；包含pending、lifecycle_generation、last_lifecycle、lifecycle_uncertain、canDiscard/discardBlockReason。不能从accepted推断renderer已完成。异步恢复时recovery={pending,phase,error}记录Endpoint任务；browserPending/browserDesired保留Browser观察值，投影pending不会把中间空页当作恢复完成。

uncertain恢复的`view.lifecycle`要求`requireRunning:true`、当前`browserIncarnation`及字符串`lifecycleGeneration`。unload仅在无pending、未关闭、精确代次且有可自动恢复checkpoint时执行；restore只接受同实例下确证unloaded的新代次。Control发送前持久记录阶段，回执丢失只从精确快照收敛，不重发未知mutation。

## Client↔Control

正常入口为注册/登录后的用户工作区。公开GET /api/auth/registration返回hasAdmin/credentialRequired/registrationOpen。认证HTTP接口为GET /api/auth/me及POST /api/auth/register、login、logout；register增加serverCredential注册口令，首个正式账号免口令成为管理员，其他注册须已配置的当前口令；使用HttpOnly、SameSite=Strict token cookie，HTTPS加Secure。写请求及WS upgrade检查Origin。

WebSocket `/api/socket`：

```text
请求    {id,method,params}
成功    {type:"result",id,result}
失败    {type:"error",id,error:{code,message}}
状态    {type:"state",revision,state}
锁态    {type:"auth",auth}
接管    {type:"lease",status:"revoked",reason}
```

method包括viewport、feedback、rtc.offer/ice/close、clock.ping、operation.status及产品管理配置；常规浏览器action经下述DC，不以WS暗中回退。完整类型以[product.ts](../control/shared/product.ts)为准。state包含user/workspace、页面请求、quality、Viewer连接、Endpoint状态及有限操作收据，带serverIncarnation/snapshotSequence以保护同workspace revision的运行态更新。产品关系与设置只存服务端，Client仅持内存pending投影；操作结果不直接覆盖较新的权威snapshot。

高级认证方法为auth.get/lock/verify/settings/password、auth.face.begin/cancel/remove，类型见[security.ts](../control/shared/security.ts)。锁态不推送完整产品state，只保留auth及必要信令；新Viewer默认锁定，账密登录的一次性首租约许可例外。AuthState.epoch是Viewer验证代次，peerEpoch是Endpoint已确认的连接权限代次，不能混用。完整生命周期与存储见[高级认证](authentication.zh-CN.md)。

每用户单Viewer租约。旧端被接管后停止媒体，不能自动重连争抢。端点重建与Socket恢复使用新连接身份；过期操作和页面dialog不能复用到新文档。

`POST /api/metrics`保留HTTP上传，支持工具的完整/分块报告。legacy `/api/state/actions/rtc/*`仅供服务端显式开启的诊断实例和隔离legacy用户；query/header不能开启诊断。普通Viewer不轮询这些接口。

## Client↔Endpoint

视频为每Session一个H264 atlas track。DataChannel `remotekit`为ordered/reliable，64位ID和代次用十进制字符串：

正常已鉴权Viewer的产品消息双向附加`authEpoch`（JS安全整数范围内的peer授权代次）。接收和实际执行均拒绝旧代，文件/操作重试保留原代次。锁定保留通道对象；解锁的media.presentation可带restart:true重发布局/首帧屏障，处理RTC与WS到达顺序不同。隔离诊断仅在明确authRequired=false的peer保持旧格式。

- layout：generation/epoch、编码尺寸及views的身份、矩形、DPR/mediaScale。
- frame：实际wire RTP、layoutEpoch、编码信息；可附captureWallTimeMs、captureMonotonicMs、captureClockUncertaintyMs、sourceCaptureId。无有效采集时间则省略。
- focus：请求ID、页面完整身份和布局代次；确认必须匹配当前请求后才能放行排队输入。
- input：完整Session/view/instance/document/focus、outputGeneration/layoutEpoch、连接内sequence及事件。Endpoint先拒绝旧peer和连接内重复/倒退，再分配Session持续递增的Browser sequence；回执区分clientSequence/browserSequence，重登录无需客户端持久化计数。
- media.feedback：布局绑定的显示/解码/丢帧诊断，不独立决定网络码率、DPR或分辨率。
- media.presentation：`{version:1,backend:"video"}`协商呈现后端；Endpoint建立发送屏障后回复同版本的`presentation.mode`。不接受canvas模式，未完成video协商与当前布局确认时不发布视频码流。
- presentation.prepare：`{version:1,barrierId,outputGeneration,layoutEpoch}`，三个身份均为十进制字符串，紧随对应layout。Client隐藏所有video、撤销输入ready，跨两次前台rAF后以`presentation.ready`返回同一完整key；旧peer/旧key不能放行。
- product.action/result：version=1，operationId、operationGeneration与action/receipt。Endpoint校验当前peer后经管理连接交Control唯一产品提交器；收据区分accepted/applying/committed/rejected/unknown/expired。Control分配内部单调operationSequence给Native执行去重，不把UUID generation当数值。超时已转发的操作返回unknown并查询，不能改ID重做。导航终态见[导航操作](navigation-operations.zh-CN.md)。
- clock.ping/pong：当前peer的requestId、Endpoint serverTimeMs/serverMonotonicMs，不经Control时钟；见[时钟域](media-feedback.md)。
- input.editable：独立revision、完整页面编辑身份及type/flags/selection/composition/caret，不传正文，也不触发布局换代。`editable.target`是非零十进制编辑目标身份；真实失焦时为`"0"`。target随实际输入节点、frame/document或活动焦点变化，单纯布局租约轮换不改变它。Client-v1 raw/候选与momentum、terminal确认见[Client手势](client-gestures.zh-CN.md)。
- files.request/result：begin/chunk/commit/cancel/status，当前请求及peer授权、有限字节块与真实offset，见[文件生命周期](audio-and-files.zh-CN.md)。
- stats：实际测量和状态；未知项保持缺失，不以零冒充。

音频为同一PeerConnection上的Session级Opus输出track；客户端offer音频方向为recvonly或inactive，不接受客户端上行音频。video-only旧offer继续兼容。正式文件字节同样经DataChannel，Control不读写Endpoint磁盘路径。layout/prepare及结果回执有有界重试；可合并媒体统计不能饿死关键控制消息。

人脸图像使用同peer的第二条可靠有序DataChannel `remotekit-auth`，不加摄像头RTP track。auth.camera.ready/config/accept协商实际尺寸、RGB24与5fps；Endpoint以auth.camera.frame逐帧grant，单个未完成许可、1000ms超时。二进制块包含68字节little-endian头（RKAF/version/headerBytes/authEpoch/captureId/byteOffset/totalBytes/width/height/36字节UUID challengeId）及最多16KiB RGB24。每项均核对当前挑战和授权，按连续offset组装，最多640×480/等面积竖屏，一帧组装及一帧最新推理队列。原始图像不经Control、不压缩、不落盘。

客户端只在匹配真实wire RTP与当前layout epoch后呈现/授权输入。空layout、故障、暂停或重建立即撤销旧ready；有新layout但没有匹配帧时不能点击旧画面。重绘同一帧不增加FPS。

正式Viewer只使用video，每个可见平面使用共享同一接收track的独立video。目标位置与大小来自客户端内容bounds，atlas矩形仅用于源裁剪；输入层使用相同bounds。video静音、内联，无原生controls、画中画、远程播放和媒体交互；声音由独立Viewer音频管线播放。MSTP、共享WebGL及2D串流绘制后端已经移除，能力/协议失败明确提示，不自动切换呈现架构。

video模式中的透明canvas只承载既有鼠标、键盘/IME与触控入口（`data-video-input=true`），其DOM存在不表示canvas绘制后端运行。呈现注册以稳定的viewId绑定；focus、同view文档更新或布局代次改变只更新现有renderer的身份与门禁，不因React surface对象变化拆除video。真正移除viewport或接收track/peer变化才更换对应媒体资源。

同一接收track的多个video不是多条H264接收链。固定Chromium157源码中，`VideoReceiveStream2`解码后经`VideoRtpTrackSource`/`VideoBroadcaster`和Blink `MediaStreamVideoTrack`分发同一已解码帧；每个video另有`WebMediaPlayerMS` compositor/sink，并可能执行自己的GPU帧格式转换。精确Chrome89.0.4389.90及其WebRTC revision也确认相同的解码后fanout，见[89源码证据](../develop/docs/chrome89-decode-fanout-20261103.md)。增加平面仍增加呈现资源，不能声称总开销不变，也不能把各元素decoded计数相加当作物理解码次数；源码边界、运行兼容和硬件占用采样是不同证据。

Endpoint在实际`remotekit_rtc_encoded`发送边界串行化屏障与布局更新，覆盖已进入编码器的旧结果。当前peer完整最新ACK只解除等待，当前布局首个成功发送仍须为关键帧。旧epoch结果丢弃并正常结束编码/纹理/尾帧租约；静态重发保留实际纹理身份，不给旧纹理重贴新布局。隐藏页可持续等待，不通过超时或切换后端放行。未协商的客户端不能接收视频，旧canvas客户端需要更新。

每个video自身首次真实RTP/epoch匹配后才恢复该平面的显示和输入。布局换代、隐藏、重连立即撤销ready；同一已确认布局内晚到的逐帧元数据不改变裁剪关系，不凭未知RTP生成延迟或Marker样本。rVFC是compositor提交观察，不是逐帧拒绝API，也不证明物理屏幕点亮。

静态首帧metadata晚到可匹配同元素自己的最新观察，但必须保持相同已确认屏障、track、attempt和文档身份；恢复布局资格不能假称当前像素仍是该RTP，也不能增加呈现计数。文档前台、当前完整布局屏障已ACK、平面current/nonstale且客户端bounds为正时，未取得安全匹配继续限频请求`media.refresh`并保持Video及输入门禁，不因等待超时改走另一后端。隐藏或布局过渡撤销旧观察；恢复后重新等待本元素新帧，不复用旧ready。

尺寸过渡在内容bounds变化或Transport撤销旧呈现之前保留一次旧ROI快照，最多4Mi像素，不赋予媒体或输入ready。软键盘遮挡/恢复使用顶部锚定、保持比例并裁剪的peek；普通窗口/分栏布局变化使用最后帧的模糊拉伸动画。过渡原因保留到事务完成，不依赖VV和ResizeObserver同时到达。快照裁剪在对应Window内容区内，新布局真实ready且匹配最终desired DIP后移除，不再按1.8秒超时删除；文档/连接变化立即作废。普通resize不显示页面恢复提示。这种一次copy与稳态video逐帧呈现分开计数。详见[移动输入状态机](mobile-input-state.zh-CN.md)。

产品Viewer外壳固定在visualViewport内，宽高决定真实布局，offsetTop/Left只移动外壳。远端DIP取Window内容区实际大小；可视区域平移不提交resize、不启动新的输入屏障。输入代理锚在内容区顶部，标签切换只滚动本地标签条。独立自动化入口没有产品外壳时仍使用显式可视裁剪。

站点`manualKeyboard`控制是否自动聚焦本地软键盘代理，不改变远端编辑目标。当前有效Window有编辑目标时提供“显示键盘／隐藏键盘”悬浮按钮；键盘开合意图以当前文档为边界，与严格的`editableTarget`分开。新文档、直接用户激活或显式恢复自动策略可以授予一次自动打开；目标替换、focus token/布局轮换和状态重发不能重新授权，也不能撤销手动隐藏。手动隐藏优先采用本地compositionend，未收到时以同目标最后组合文本完成一次提交；目标/文档失效则取消旧输入。站点偏好存Control。

同文档active A→B保持本地代理焦点，但不转移A的composition、按键或暂存文本。NONE立即撤销编辑资格，本地键盘外观最多等待200ms确认持续失焦；其间不向未知目标发文本，也不为未来目标暂存。确认失焦后收起，后续无用户激活的active不能自行重弹。文档/连接/锁定/Window失活立即撤销。视口几何仅观测键盘遮挡和恢复，不直接blur或完成IME；小幅尺寸噪音、offset平移、旋转和缩放不用于重新授权键盘。

`generation:"0", views:[]`统一表示媒体输出屏障，不能作为编辑文档销毁证据；`reconfiguring`只是原因提示。Client独立保存最后确认的文档目录，暂停严格输入但保留同文档本地键盘与合法composition。非零generation中实际移除view、锁定、断链和文档替换仍硬撤销。Browser保留单纯布局变化下合法目标的composition，同时轮换原focus输入租约并终止旧pointer/held keys。Endpoint从权威latest-layout读取编辑状态：无有效元数据表示未知，不发送假失焦；像素stale不等于编辑目标失效，真实inactive仍即时发布。窗口blur且DOM代理仍聚焦不结束IME，页面真正hidden/DOM blur仍处理失焦。

Client暂存编辑事件绑定attempt/session/view/instance/document/target，只有新layout、准确focus token、同target权威editable和新画面屏障都满足后才发送。早于focus ACK的新target候选只维持键盘UI，不获得编辑资格；原已确认target可在同文档布局屏障期间有界暂存。事件附`editableTarget`，Browser在最终派发前再次检查当前编辑目标；旧节点晚到的commit/cancel不能落到新输入框。真实失焦或target变化清除composition和暂存，旧本地composition结束及其附随文本仍被隔离。该编辑连续性不放宽旧layout坐标门禁，也不重建RTC、DataChannel或video。

Source atlas由WebRTC原生AdaptFrame决定采样，并满足接收H264硬上限；NV12转换缩放完整atlas，mediaScaleX/Y分别用于布局、ROI及输入。Chrome89继续使用Video，其rVFC与测试用drawImage不是原子frame handle，不能宣称为不可变帧验证。

普通产品按接收能力选择H264 level5.2、5.1、4.2或native；探测并行、有总超时且页面内缓存，Chrome89保留4.2兼容路径。编码协商失败可降档，网络超时不会永久降低解码能力。优先高画质以viewport×ClientScale为目标；完整尺寸满足单帧上限、但超过像素速率预算时先降低帧率，自动与流畅档保持帧率优先。实际源/编码尺寸、有效帧率及限制原因由stats报告。

video统计使用各平面`presentedFrames`增量，rVFC回调次数不当作显示FPS。Marker像素读取仅用于显式测量，正常video不做逐帧copy。尺寸过渡保留最后一帧的有界模糊快照；该快照、摄像头处理和测试像素读回不属于已移除的Canvas串流后端。

产品信令采用trickle ICE：Endpoint接受offer后异步发`rtc.signal`，Control按Tenant、Viewer租约、connectionId与attemptId路由answer/candidate。早到候选有界排队，取消或接管撤销旧绑定。现有UDP网络模拟和旧诊断接口保留完整ICE收集路径，避免候选旁路网络模拟。连接阶段耗时使用各进程本地单调时钟。

管理员通过已鉴权WS的admin.get取得registrationCredentialConfigured，通过admin.setRegistrationCredential {serverCredential}替换注册口令。两者服务端检查管理员身份与当前lease；配置仅返回是否设置。口令8–256字符，角色与口令不允许由注册请求指定或覆盖；ProductUser.isAdmin表示服务端确定的身份。
