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
| lifecycle | session、view、action | accepted 区分受理；snapshot 观察实际完成 |
| page.requests / page.reply / page.command | session、view，加 request/accept 或 action | 页面 pending/events、回复与编辑/导航/find/zoom 命令 |
| profile.permissions / profile.downloads | session、view、command 对象 | Profile 权限规则或下载状态/操作 |
| output.open / output.describe | consumer_pid，open 加 fps | accepted 后 describe 取得本代六个共享句柄 |
| output.configure / output.status / output.close | width、height（DIP）、device_scale、enabled、fps，可选 | 配置、状态或关闭；尺寸/scale变化需关闭并重建输出 |
| navigation.export.begin / navigation.import.begin | session、view；import 加 size | 创建导航状态分块传输 |
| navigation.export.chunk / navigation.import.chunk / navigation.import.commit / navigation.transfer.cancel | session、view、transfer，加 offset/length/data | 导航 opaque 状态分块传输 |
| shutdown | 无 | 受理正常退出 |

`actual/desired` 数值：0 live、1 frozen、2 discarded、3 unloaded。snapshot 包含 lifecycle_generation、last_lifecycle(succeeded/detail)、lifecycle_uncertain、touch_code/touch_detail，以及加载、发声、采集、renderer PID 和页面请求数。PID 可能被多个 WebView 共享，不能作为单页资源用量。unload/restore 保持 WebView ID，执行实例代次会改变。

输入示例：

```json
{"version":1,"id":3,"method":"input","session":"1","view":"1","instance":"1","document":"2","focus":"2","sequence":"1","event":{"type":"ime_set","text":"拼音","selection_start":0,"selection_end":2}}
```

`ime_commit` 携带 text；`ime_cancel` 和 `ime_finish` 不携带文本。选区按 UTF-16 code unit 计算，不能切开代理对。`mouse` 携带 action(move/down/up)、x/y、button(0无/1左/2中/3右/4后退/5前进)、modifiers。`wheel` 携带 x/y/dx/dy，方向沿 Blink，坐标与 delta 为 viewport DIP。

`key` 携带 action(down/up/char)、physical_code、windows_key_code、dom_code、dom_key(十进制字符串)、modifiers、repeat、text、unmodified_text。char 只投递字符事件；旧 down 携带 text 的形式仍会随后产生字符事件，两种入口不能重复使用。文本最大四个 UTF-16 code unit，也不能与 IME commit 重复提交。mouse 可加 click_count(1..3，move 可0)。

`touch` 携带 action(start/move/end/cancel) 和 points，每点包括 id/x/y/pressure。points 是本次改变的 contacts，最多16点。adapter 使用官方 TouchEmulator、首次 start 的异步 OOPIF hit-test 与最终 ACK，生成滚动/缩放 gesture。解析目标或取消收尾期间，所有输入在 AcceptInput 前返回 busy(code=6)；SDK helper 映射为 BUSY(8)，可在原 token/sequence 下有界重试，token 变化则丢弃。受理后的异步失败不允许重放，读取 snapshot 的 touch 状态。CDP 附加期间远程 touch 拒绝，native/injected touch 按官方规则互斥。

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
