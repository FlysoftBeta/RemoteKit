# Browser 本地控制协议 v1

这是 Endpoint 到 browser 的本地管理接口。普通remotekit_browser只承接启动时指定的一个Session；显式构建的remotekit_browser_demo保留旧多Session测试入口。连接由Endpoint持有，Session ID用于归属验证，不是网络认证凭据。客户端鉴权由Control负责，见[串流协议](streaming-protocol.md)。

browser 参数 `--control-channel=remotekit-<随机值>` 启动 Windows NamedPlatformChannel。endpoint C ABI SDK 通过 `remotekit_sdk_control_connect/request/close` 连接；两端用 IsolatedConnection 保持各自的 Mojo 进程图。控制端每次只保留一个请求在途，一次消息最多 1 MiB。JSON 严格使用 UTF-8。

## Envelope

```json
{"version":1,"id":1,"method":"snapshot"}
```

响应保留 `version` 和 `id`，`ok` 表示该命令的结果，失败返回 `error`。模型操作还返回数值 `code`。所有 64 位 ID、代次、事件序号用十进制字符串，避免 JSON 数字精度丢失。

SDK 的同步 request 应从工作线程调用；超时、输出缓冲不足和传输失败会关闭并使连接 handle 失效，避免后续请求收到旧回复。当前 browser 只承接一个客户端连接，重启使用新的随机 channel 名。

## 命令

| method | 参数 | 结果 |
|---|---|---|
| snapshot | 无 | Session、WebView、Profile、URL/title/loading、导航可用状态、desired/actual/pending、input token及关闭状态 |
| view.create | session、view、url、width、height、device、visible | 调用方稳定ID，创建幂等；冲突配置显式拒绝 |
| view.configure | session、view及viewport/device/visible | 更新设备特征和可见平面排布 |
| view.close | session、view、force | 区分accepted/completed，普通关闭经beforeunload，force用于orphan清理 |
| focus | session、view、focused，服务模式另带instance/document/focus | 聚焦或失焦，返回新 token |
| visible | session、view、visible | 显隐意图 |
| navigate | session、view、url | 导航已发起，不等于提交成功 |
| input | 完整 token、sequence、event | 校验并投递到当前 widget |
| input.touchStatus / input.touchRetire | 原session/view/instance/document/focus、sequenceId | 查询原终止状态；retire只清理精确旧owner，不接纳新坐标 |
| lifecycle | session、view、action | accepted 区分受理；snapshot 观察实际完成 |
| page.requests / page.reply / page.command | session、view，加 request/accept 或 action | 页面 pending/events、回复与编辑/导航/find/zoom 命令 |
| profile.permissions / profile.downloads | session、view、command 对象 | Profile 权限规则或下载状态/操作 |
| output.open / output.describe | consumer_pid | accepted 后 describe 取得本代Slot纹理/Fence、映射及一次性render pipe；见Comp/Rend契约 |
| output.configure / output.status / output.close | width、height（DIP）、device_scale、allocation_alignment（1或16，默认1）、enabled、viewConfigs，可选 | 配置、状态或停止输出；尺寸/scale/alignment/viewConfigs变化需先关闭旧输出 |
| navigation.export.begin / navigation.import.begin | session、view；import 加 size | 创建导航状态分块传输 |
| navigation.export.chunk / navigation.import.chunk / navigation.import.commit / navigation.transfer.cancel | session、view、transfer，加 offset/length/data | 导航 opaque 状态分块传输 |
| shutdown | 无 | 受理正常退出 |

`allocation_alignment` 只改变 GPU atlas 的物理分配，不改变网页 viewport/DPR、DIP 排布或 plane 像素矩形。实际宽高先由 `ceil(DIP × device_scale)` 得到，再按 `max(2, allocation_alignment)` 向上对齐；默认1保留既有偶数取整，16用于QSV异步VPP。对齐后仍须满足单边8192像素、总计16777216像素上限，超出返回 `atlas_resource_budget_exceeded`。`output.configure` 返回实际 `width_pixels/height_pixels/allocation_alignment`，`output.status` 也给出 alignment；共享纹理、共享帧元数据和媒体采样使用同一实际宽高，不把padding伪装为原始尺寸。节拍由Comp的Begin与WebRTC SetRates管理，旧`fps/render_fps`控制字段不再使用。

Endpoint 参数 `--qsv-vpp=external|async` 默认 external。async 必须显式选择 `--encoder=qsv`，不进行NVENC/auto回退；`--atlas-alignment=1|16` 默认随模式为1/16，async显式选择1会报错。可用 external+16 与 async+16 做同物理尺寸对照，stats 的 `qsvVpp/atlasAllocationAlignment` 报告选项，`sourceAtlasWidth/sourceAtlasHeight` 报告实际资源尺寸。实验准备工具对应参数为 `-QsvVpp external|async -AtlasAlignment 1|16`。

`actual/desired` 数值：0 live、1 frozen、2 discarded、3 unloaded。snapshot 包含 lifecycle_generation、last_lifecycle(succeeded/detail)、lifecycle_uncertain、touch_code/touch_detail，以及加载、发声、采集、renderer PID 和页面请求数。PID 可能被多个 WebView 共享，不能作为单页资源用量。unload/restore 保持 WebView ID，执行实例代次会改变。

uncertain恢复的lifecycle请求带`expected_lifecycle_generation`，Browser执行点核对无pending、非关闭及精确代次。guarded unload先验证保存的导航checkpoint，guarded restore只接纳已unloaded状态。普通freeze竞争通过精确ACK后解冻退出，不进入此破坏性恢复路径。

输入示例：

```json
{"version":1,"id":3,"method":"input","session":"1","view":"1","instance":"1","document":"2","focus":"2","sequence":"1","event":{"type":"ime_set","text":"拼音","selection_start":0,"selection_end":2}}
```

`ime_commit` 携带 text；`ime_cancel` 和 `ime_finish` 不携带文本。选区按 UTF-16 code unit 计算，不能切开代理对。`mouse` 携带 action(move/down/up/leave)、x/y、button(0无/1左/2中/3右/4后退/5前进)、modifiers。`wheel` 携带 x/y/dx/dy，方向沿 Blink，坐标与 delta 为 viewport DIP。

modifiers 使用 Blink WebInputEvent 位：Shift=1、Ctrl=2、Alt=4、Meta=8；鼠标按住左/中/右键分别为64/128/256，后退/前进键为1048576/2097152。仅 button=0 且没有上述鼠标按住位的 move/leave 可发送给未聚焦的可见 live WebView；悬停不改变焦点，仍校验 Session、实例、文档、当前 focus generation、sequence 和输出代次。拖拽、down/up、wheel、键盘、IME、触控继续要求焦点。

Viewer在派发wheel前完成focus确认。Browser把mouse move的held modifiers转换为Blink move.button，down/up继续使用changed button；不能把wire move的button=0直接传作Blink NoButton，否则原生scrollbar会取消拖动。wheel复用现有Aura MouseWheelPhaseHandler建立begin/sequence/end，再经InputEventRouter路由；phase=None直接进入router不会完成首次hit-test。零delta不建立滚动序列。input.result成功仅表示接受派发，运行验收必须观察远端真实wheel事件与scrollY/scrollTop变化。

`key` 携带 action(down/up/char)、physical_code、windows_key_code、dom_code、dom_key(十进制字符串)、modifiers、repeat、text、unmodified_text。char 只投递字符事件；旧 down 携带 text 的形式仍会随后产生字符事件，两种入口不能重复使用。文本最大四个 UTF-16 code unit，也不能与 IME commit 重复提交。mouse 可加 click_count(1..3，move/leave 可0)。

`touch` 携带 action(start/move/end/cancel) 和 points，每点包括 id/x/y/pressure。points 是本次改变的 contacts，最多16点。adapter 使用官方 TouchEmulator、首次 start 的异步 OOPIF hit-test 与最终 ACK，生成滚动/缩放 gesture。解析目标或取消收尾期间，所有输入在 AcceptInput 前返回 busy(code=6)；SDK helper 映射为 BUSY(8)，可在原 token/sequence 下有界重试，token 变化则丢弃。受理后的异步失败不允许重放，读取 snapshot 的 touch 状态。CDP 附加期间远程 touch 拒绝，native/injected touch 按官方规则互斥。

Viewer touch 另携带 `sequenceId`、`clockMode`（`source` / `arrival-fallback`）、`sampleElapsedUs`；source模式还携带整条手势固定的 `startServerWallUs`。首down将PointerEvent.timeStamp规范化到客户端performance单调轴，以clock.ping校准的offset减uncertainty得到保守服务端wall起点；Browser仅在首down配对NowWall/NowTicks，后续严格按源采样elapsed推进，不逐包按抵达时间重锚。首down允许最多5秒年龄和1ms未来误差，elapsed非负、单调、最多24小时；同手势的时钟模式、sequenceId和起点不能变更，失效会取消已有序列。校准缺失/过期时整手势显式arrival-fallback并统计，不中途切换时钟。旧无clock协议继续兼容。

move可另带最多32条 `samples:[{sampleElapsedUs,points}]` 历史，顶层points/elapsed是最后采样；历史保序且不晚于顶层，一批累计改变触点最多64个。Viewer feature-detect getCoalescedEvents，Chrome89缺失时仍支持单采样；相邻move批量保留最近采样轨迹和最后位置，不跨start/end/cancel、手势或目标身份合并。失焦、lostpointercapture和pointercancel发送一次整序列cancel；触控序列绑定连接、Session、view、instance、document、focus及输出/layout身份。终止包可有界排队等待匹配画面，真正发送仍遵守现有旧epoch输入门禁。背压队列为终止事件保留容量。

Endpoint生产输入队列对明确 `ok=false,code=6` 的受理前busy，以同一Browser sequence串行重试，5ms间隔、最多50次/250ms预算；peer/epoch改变立即停止，不重放受理后的异步结果。服务端stats提供inputBusyRetries/inputBusyExhausted；Browser compositor diagnostics的touchTiming区分source/fallback手势、时钟拒绝、取消、采样数、dispatch wall及源采样年龄。此路径仍由Chromium决定网页touch-action/preventDefault、OOPIF目标和原生滚动/惯性，源采样时钟贯通不等于全部gesture移至客户端。

派发接受与页面消费分开：TouchEmulator兼容扩展返回值仅确认到达官方ForwardEmulatedTouchEvent，canonical ACK同步完成也可能是正常滚动优化，不能据此取消序列。原生流排他和无效序列仍拒绝。服务构建自动附加内部marker，FlingScheduler固定使用官方96逻辑PPI，TouchEmulator使用固定GENERIC_DESKTOP配置，不读取宿主显示器PPI或平台touch偏好；没有新增UI或调节参数。页面DPR仍由Client Scale/资源策略控制，刷新仍由Client及媒体策略控制，96不改写DPR。显式native demo不附加marker，保持CURRENT_PLATFORM与正常真实物理PPI（无效轴仍安全回退96）。官方injecting模式既有longpress/showpress timeout禁用不因源时钟贯通而成为完整长按实现，本轮未扩展该策略。

重复序号、旧文档/实例/焦点 token、跨 Session 的 view 都被拒绝。失焦、生命周期转换或执行实例失效后应先获取新状态。

Fence client 的 input 另外携带 output_generation，必须匹配当前输出；focus 可携带 instance/document，避免旧点击聚焦新文档。没有这些可选字段的手工管理命令仍按逻辑 WebView 操作。

## 页面、Profile 与导航

page.requests 返回 pending 和读后清空的 events。page.reply 使用 request(字符串 ID)、accept，可加 text、paths 或 choice。普通文件上传在工作线程验证绝对普通文件；validating 表示受理，后续 selected/cancelled 事件表示验证结果。目录上传明确取消。page.command 的 action 支持 back/forward/reload/stop/find/stop_find/zoom/get_zoom/copy/paste/cut/select_all；find 结果异步报告。

Profile 命令放在 command 对象内，避免与 envelope.id 冲突。例如：

```json
{"version":1,"id":9,"method":"profile.downloads","session":"1","view":"1","command":{"action":"snapshot"}}
```

权限 action 为 snapshot/set/reset/reset_all；set 指定 origin、permission、allow，embedding_origin 默认同 origin。规则在本 Profile 内存中，不创建对应 API 的后端服务。下载 action 为 snapshot/cancel/pause/resume，下载 id 放在 command.id。文件写入 Profile/downloads；HTTPS-only，不含 SafeBrowsing，完成后返回相对 file_reference。

导航 begin 返回 transfer 与 size(十进制字符串)。export.chunk 指定 offset(字符串，可0)、length(最多256KiB)，返回 base64 data；import.begin 指定总 size，chunk 按顺序追加 offset/data，最后 commit。所有传输合计最多64MiB，可显式 cancel。导入需要 unloaded WebView，并验证 Session/Profile、Chromium revision 和 PageState；不会恢复跨 browser 的 sessionStorage。POST 自动恢复明确返回 unsupported。

输出资源与完成点见 [GPU 输出](gpu-output.zh-CN.md)。describe 的 pending 使用 error=output_pending；不是逐帧状态轮询接口。稳态无 browser↔endpoint 的 ready/present/release 消息。

device_scale 支持0.5..4，fps 为1..120的发布上限，不保证内容每周期产生 damage。新 scale 需新资源代次；最大 atlas 纹理边长16384。

服务模式只将visible页面排入atlas，后台逻辑页面保留。重排提升focus token，旧坐标输入失效；Endpoint另以RTP/显示代次保护客户端的视频与布局匹配。逻辑关闭保留墓碑，正常关闭前后的page.requests/page.reply和完成状态由Endpoint适配给Control。

## 新增产品生命周期接口

session.sitePreferences下发按origin的UA/Client Hints策略；产品平板模式只改变站点身份，不改变viewport、DPR或触控能力。view.configure中的低层device配置不等同于产品站点UA设置。

snapshot同时提供pendingPopups、页面dialog及canDiscard状态。Control先持久化产品Tab与收养记录，再通过view.adopt将真实待收养WebContents绑定稳定WebView；不以重新打开URL替代popup。页面dialog回复必须带当前实例、文档和请求标识，Control额外绑定Browser进程身份；陈旧回复拒绝。具体字段以browser控制处理器及[产品协议](streaming-protocol.md)为准。

## 有界恢复与原子几何

Endpoint主dispatcher串行拥有Session控制状态；stdin reader只入队，定时维护轮转推进恢复，单步不轮询等待导航。关闭、导航、重建取消旧任务。Browser navigationRevision随导航条目和PageState改变，export.begin返回实际导出revision；Endpoint按此保存，不用document代次代替完整导航状态。

output.configure可带viewConfigs更新已存在页面的viewport/device/DPR/visible。输出须已关闭；先验证候选配置、物理资源预算和完整PackAtlas可行性，再一次提交页面与atlas几何。校验失败保持原状态；create/adopt先隐藏创建，再加入最终事务。逻辑extent允许低DPR下超过8192，物理轴仍不超过8192，面积仍不超过16Mi像素；实际viewport DIP不被夹小。

view.closed.ack仅在Endpoint持久化关闭证据后调用，按当前browserIncarnation确认。重复ACK幂等；已确认完整墓碑不再加入snapshot，紧凑closed-ID集合继续保护当前Browser中已关闭的身份。
