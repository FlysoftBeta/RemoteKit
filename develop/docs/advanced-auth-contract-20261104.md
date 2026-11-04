# 高级认证实现契约（2026-11-04）

状态：root确定边界，实施中；不代表编译、模型推理或真实摄像头已验收。

## 产品行为

- 未登录只提供账户密码登录/现有注册。已有账户会话首次重新附着Viewer默认锁定；本次账密登录/注册可消费一次服务端授权直接进入。
- 锁屏纯黑空白，无文字、光标、按钮、点击/键盘/错误/进度反馈。上上下下左右左右仅揭示验证界面；键盘方向键与屏幕归一化四向区域点击共用序列。序列不具备授权效力。
- 已登录验证界面提供密码、已配置PIN、人脸；密码始终为恢复途径。设置可更改账户密码、设置/删除6–12位数字PIN、录入/删除人脸及自动锁定策略。凭据修改须重新验证账户密码。
- 人脸启用及摄像头权限必须在可见设置中完成；锁屏中只复用已授权的摄像头，浏览器权限提示和摄像头系统指示不由网页隐藏。没有权限时留在空白锁屏，可用序列打开密码/PIN。
- 默认自动锁定启用：系统锁定、闲置60秒；页面隐藏可配置兜底（默认启用，界面准确称“切到后台时锁定”）。人脸离开检测仅在已录入并启用摄像头监测时生效，连续5秒无人/不匹配/媒体丢失锁定。Chrome89无IdleDetector时用页面交互闲置计时，不能声称检测物理关屏。

## 权限与存储

- Cookie仅证明账户身份；Control拥有当前Viewer授权代次、挑战、策略及凭据。新Viewer默认锁定，重连不能绕过；普通锁/解锁不关闭既有RTCPeerConnection。
- 密码/PIN用独立salt+scrypt；按账户跨租约限速并限制全局KDF并发。敏感修改和异步验证提交前再次校验租约/代次。禁用全部恢复方式不允许。
- 人脸特征只由Endpoint计算；128个归一化有限float的SFace模板由Control加密持久化，密钥独立于SQLite，客户端永远不收到模板/原图/embedding。Endpoint临时持有，挑战结束清除。摄像头不录像、不落盘。
- 锁定先同步关闭Control产品门禁/全量快照，再下发Endpoint门禁，清退旧代输入、操作和文件。Endpoint停止产品视频/音频发送而保留camera接收和DataChannel；SDK已排队编码完成也复查门禁。解锁在Endpoint确认后生效，恢复新布局/关键帧屏障。
- Endpoint管理连接丢失立即撤销权限，避免无Control状态继续操作；重连必须重新下发授权。每条授权绑定connectionId与递增epoch。旧epoch命令与旧挑战不能恢复权限。

## 公共接口（Control实现负责shared/security.ts）

`AuthState`：`{user,locked,epoch,peerEpoch,methods:{password:true,pin:boolean,face:boolean},settings:{lockOnHidden:boolean,lockOnIdle:boolean,idleSeconds:number,lockOnDeparture:boolean,faceEnabled:boolean},face:{available:boolean,enrolled:boolean,reason?:string,challengeId?:string,purpose?:'enroll'|'verify'|'presence',status?:string},trickleIce:boolean,endpointGeneration:number}`。`epoch`为Viewer验证代次，`peerEpoch`为Endpoint已ACK的当前连接权限代次，无peer为0；二者不得混用。

WS定向事件 `{type:'auth',auth:AuthState}`。锁定时不发送产品state；客户端保留连接并隐藏/禁用旧内容。解锁发送auth后发送完整state。

正常Viewer每条产品DataChannel请求携带`authEpoch:peerEpoch`，Endpoint入队前与当前权限代次比较，执行前仍检查内部stamp，防止锁定前网络排队消息在解锁后才到达。文件/操作重试保持原请求的代次，不能重标新代。诊断旧peer仅在明确authRequired=false时保留兼容。解锁显式请求presentation resync，处理RTC新布局先于WS解锁事件到达的跨通道顺序。

- `auth.get {}` → AuthState。
- `auth.lock {reason?:string}` → AuthState。
- `auth.verify {method:'password'|'pin',secret:string}` → AuthState。
- `auth.settings {currentPassword:string,settings?:Partial<AuthState.settings>,pin?:string|null}` → AuthState。
- `auth.password {currentPassword:string,newPassword:string}` → AuthState。
- `auth.face.begin {purpose:'enroll'|'verify'|'presence',currentPassword?:string}` → AuthState。
- `auth.face.cancel {challengeId:string}` → AuthState。
- `auth.face.remove {currentPassword:string}` → AuthState。

初次`/api/auth/me`仍只返回user；WS立即发送auth。首次登录一次性授权由服务端保存，不通过客户端参数决定。

## Control ↔ Endpoint（仅受认证管理通道）

- `rtc.offer`增加`authRequired:true`，正常Viewer peer初始产品权限关闭。隔离诊断保持明确兼容。
- `rtc.authorize {connectionId,epoch,unlocked:boolean}` → `{applied:true,epoch}`，递增或同epoch同值幂等；更旧拒绝。锁定清退旧代工作、媒体/文件发送权限。Control新连接epoch从1开始。
- `auth.face.capabilities {}` → `{available:boolean,reason?:string,modelVersion:string}`。
- `auth.face.begin {connectionId,epoch,challengeId,purpose,timeoutMs,template?:number[]}` → `{accepted:true}`。enroll最多60秒；verify最多30秒；presence最多120秒并由Control轮换。template只允许verify/presence。Endpoint只接受当前connection+epoch，单peer同时一个挑战。
- `auth.face.status {connectionId,epoch,challengeId}` → `{challengeId,status:'pending'|'matched'|'enrolled'|'absent'|'failed'|'expired',template?:number[],reason?:string}`。template仅enrolled管理响应。结果必须消费/取消，Control只有在自己持有的挑战匹配时授权。presence的absent表示持续5秒无有效匹配/丢帧，不负责自动解锁。
- `auth.face.cancel {connectionId,epoch,challengeId}` → `{cancelled:true}`。
- Control以有界低频轮询处理状态（约500ms），不用经客户端转发识别结果。锁屏自动verify到期可限速重开；失败/失联永不解锁。

## 摄像头与计算（用户追加约束后替换）

用户已明确：传输未压缩RGB，服务端协商每秒5帧，模型为V1SE+V2，可以自行导出ONNX。旧VP8/I420上行方案废止，不能拿旧编译/测试作为新路径结果。

既有peer添加独立可靠有序`remotekit-auth` DataChannel，无额外RTP摄像头track、无第二peer。SDK ABI4保留产品撤权，增加AUTH_DATA/AUTH_DATA_STATE与send_auth_data；只authRequired peer接纳认证通道，消息最大65536 bytes、发送缓冲有界。普通产品通道保持原行为。Control负责challenge，Endpoint负责图像协议及5fps节拍，不通过Control转发图像。

客户端采集建议请求320×240、最多640×480/竖屏480×640、最多5fps、无音轨。只进行Canvas同尺寸取RGBA及去Alpha打包RGB24，无JPEG/PNG/视频压缩，不缩放取样来伪称原始分辨率。以实际videoWidth/videoHeight协商；尺寸变化重新握手，不发送标错尺寸的帧。

认证通道JSON均含`version:1,authEpoch,challengeId`，Endpoint验证当前connection/挑战/peerEpoch：

1. Client `auth.camera.ready {width,height,format:'rgb24',maxFps:5}`，代表实际源尺寸。Endpoint接纳64..640×480（允许竖屏）且总像素≤307200。
2. Endpoint `auth.camera.config {width,height,format:'rgb24',fps:5,chunkBytes:16384}`，在允许范围内选择与源同尺寸，不可提高到客户端能力之外。
3. Client `auth.camera.accept {width,height,format:'rgb24',fps:5}` 确认，仅配置完全一致时成立。
4. Endpoint最多每200ms发一个`auth.camera.frame {captureId}`，captureId为当前peer不复用的uint32。只有一个未完成grant；超时1000ms撤销，不能积压，宽高/epoch/挑战改变撤销旧grant。终态/cancel/断线停止grant。
5. Client收到grant后捕获一帧，按下列binary header分块，每块payload≤16384。通道bufferedAmount超过256KiB则等低水位，超过grant预算则丢帧；仅一个capture工作，不缓存视频队列。不在客户端自行定时推帧。

二进制头68 bytes，全部整数little-endian：offset0 u32 magic=0x46414b52（RKAF）；4 u16 version=1；6 u16 headerBytes=68；8 u64 authEpoch（限定JS安全整数）；16 u32 captureId；20 u32 byteOffset；24 u32 totalBytes=width*height*3；28 u16 width；30 u16 height；32..67 ASCII canonical UUID challengeId。后接packed RGB24，stride=width*3。严格按offset连续组装，重复/超界/不一致/旧grant拒绝；最多一帧内存。Epoch/挑战/尺寸均通过才分配。完成后提交Faces::SubmitRGB24；推理仍只保留一个最新帧槽。

Endpoint原生将RGB转BGR，OpenCV YuNet单脸检测、SFace特征、ONNX V1SE/V2双模型活体；多个不同采集grant的合格帧才接受。共享模型串行执行，内部线程有界，取消/换代后旧结果丢弃。OpenCV最小模块静态链接，RemoteKit DLL边界不传STL/Chromium对象。

模型和依赖下载固定版本/hash、携带许可，正式工具不依赖develop。新增公开有身份标签的人物图像同人/异人比对评测：预先固定阈值与样本协议，报告样本数、准确率、误接受/误拒绝及限制；静态网络图片不能冒称真实摄像头活体验收。
