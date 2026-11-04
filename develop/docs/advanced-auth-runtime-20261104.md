# 高级认证真实运行验收（2026-11-04）

修后隔离组已通过 Chrome157 与 Chrome89 的同连接锁定、PIN/密码解锁和锁下数据面门禁。Chrome89 的页面闲置和重附着默认锁已通过。Chrome157 的 T1 合成摄像头组通过录入、加密持久化、锁下人脸验证和离开锁定。真实后台、系统/物理关屏与真实摄像头仍未验收。

## 环境和隔离

- 浏览器使用 browser-use / QA 技能及 host-managed Playwright。磁盘文件版本已核对为 Google Chrome 89.0.4389.90 和本机构建 Chromium 157.0.8103.15。按顺序运行两个独立 headed profile，触控由 Playwright 注入可信事件。每版一个主组，最长180秒，确切失败才重试。关闭自己的 context。
- 使用现有隔离 supervisor 和动态网页 fixture。GO 后由 repo 根目录启动 `develop/tmp/comp-rend-runtime-20261103/server.mjs`，明确设置 `COMP_REND_QA_GO=1`、`COMP_REND_QA_ENDPOINT`、`COMP_REND_QA_BROWSER`、`COMP_REND_QA_RUN`、`COMP_REND_QA_PORT`；这次计划 33713/33714。显式配置本批人脸模型路径和测试用模板密钥（如果实现支持或要求），密钥仅进程环境。每组使用新的 DB、Endpoint data 和 profile，测试密码随机生成且只保留在 host 内存。
- 启动前记录路径、hash、mtime、进程和监听端口基线。结束时调用自有 fixture 的 `/shutdown`，检查自有 PID 和端口都退出。出现 FATAL/CHECK/GPU 退出即保留首个失败现场并停止。CPU 构建与 GPU 验收错开。
- 临时驱动 `develop/tmp/advanced-auth-qa/browser.js` 通过 `node --check`。从 host-managed `browser_run_code_unsafe` 加载，取得 `host._advancedAuthQA`。启动参数 `{version,run,port,fakeCamera}`。鼠标、键盘与触控经实际 Playwright 输入。Chrome89 DOM 定位使用页面 world 的元素命中测试，以兼容旧浏览器。监听记录筛除认证 secret 和完整产品数据，临时 Profile/数据库/日志只留在 develop/tmp。

## 功能顺序和证据

1. 首次打开先核对空白。三角区域坐标按 viewport 归一化，中点分别为上(0.5,0.1)、下(0.5,0.9)、左(0.1,0.5)、右(0.9,0.5)。空白期间错序及有效序列前七步均保持空白，末步才揭示表单。分别用方向键、鼠标、触控在首开和后续手动锁时覆盖。视觉截图由本地 view_image 检查；锁屏样本核对无文本、可见交互控件与光标，并对比错序前后 PNG 字节。首次未获得账户 auth 时单独取 sample 与截图。可信触控点选由 pointerType 和 isTrusted 证明，不外推到实体设备。
2. 未登录显示账户密码和现有注册入口。通过可见流程注册测试账户、退出、重新登录，创建窗口并用地址栏导航隔离 fixture。先用可信点击并核对 fixture nonce/点击数，再通过更多→设置，用当前密码设置 PIN，检查密码/PIN 按钮及错误凭据时继续锁定。
3. 手动锁后尝试输入，监测 Client DC 是否发送。另用 `replayLocked` 发送实际旧布局输入与有效新 window.create，确认远端点击/窗数无变化。旧输入重放同时受布局及序列门禁；单独据此不能归因于授权层。对照锁定前、锁定后、PIN/密码解锁后的 PC/track/DC 对象与媒体计数；锁定期间不出现新全量 state，解锁重新取得完整 state 后恢复画面与输入。锁定后检查帧计数待在途尾包排尽后停止。安全探针仅针对隔离测试账户。
4. 有 Cookie 时页面 reload，等待 auth，初次授权默认锁定。独立比较新文档中 WS 顺序，确认锁状态先于任何可用产品快照。
5. 真正的后台测试用自有第二 tab 并记录可信 visibilitychange/hidden，返回后核对锁定。若该 host 不产生真实 hidden，单独注明。157 在浏览器 IdleDetector 获准后可尝试 CDP `Emulation.setIdleOverride` 检查系统锁定分支，标注模拟。89 优先实等产品允许的最短页面闲置阈值，不改计时 API；预算不足就保留该项。物理关屏独立留作硬件验收。
6. 在可见设置启动人脸录入，使用 Chrome 假摄像头。确认现有 PC、H264 接收 track、产品 DC 身份保持，同一 PC 只有一个可靠有序 remotekit-auth DC，没有新增 RTP 摄像头发送 track。抓取 ready/config/accept 同尺寸 RGB24、Endpoint 明确协商 5fps 和 16384 字节分块，以及单 grant 的 captureId/epoch/challengeId 与 Control 活动挑战一致。短时观察多个完整 RGB 帧，验证 68 字节头、连续 offset、每帧 width×height×3、总帧数/分块数/RGB payload 字节数。记录授权间隔与观测速率，浏览器接收时钟受调度影响，区分端侧观测与服务端精确节拍。取消挑战后确认帧与 grant 停止，且假摄像头未录入模板。只保留头部与计数，不记录图像内容。该组验证 raw 传输，不证明真人解锁、离开检测或活体效果。

每个版本报告写明已通过、失败、未覆盖与证据路径。保留一批必要的截图、精简 WS/DC 和 getStats 序列及 fixture 观察，无旧性能矩阵。



## 首轮实际结果（当地 07:43–07:49）

Root 在 SDK GPU smoke 结束后给 GO。配套运行文件为生产 Control、`build/endpoint-package/endpoint/endpoint_service.exe`、其相邻 `face-models` 和 Chromium out/dev。Control 自动使用隔离数据库旁的模板密钥。host-managed Playwright 两次初始化都因既有 Edge MCP profile 被占用而拒绝；没有关闭该进程。根据仓库允许的独立 headed 自动化，改用宿主已安装 Playwright runtime 直接启动核对过的两版浏览器，每次使用自己的新 profile。没有下载工具、使用 Computer Use 或借用用户 Profile。

| 组别 | 已观察 | 失败与限制 |
| --- | --- | --- |
| 157 首轮 | 打开时黑屏，前七步保持空白，末步显示仅有账户密码的登录表单，正常注册后服务端发 auth unlocked。 | 首登 UI 已显示新建窗口，DC 尚未 ready，首次可信点击报“浏览器已锁定”，无 product.action 发送。目视核对 `run157/157-failure.png`。 |
| 157 已连接后定向组 | 等待真实连接和两个 DC open 后建窗，实际 H264 解码，发送可信远端输入，PIN 设置成功。手动锁进入全黑、无可见元素和光标，错序截图字节相同。 | auth locked epoch2 后约126ms 客户端发送 rtc.close。PC id1 和产品/认证 DC ids4/5 已关闭，锁定重放探针因无通道停止。原生 stderr 有 Browser 进程和 incarnation 替换及 stale_rtc_connection。 |
| 89 主组 | 首开键盘揭示及注册、H264、可信输入、PIN 设置、手动空白和错序不变、鼠标序列揭示、PIN 解锁恢复 H264、八次 isTrusted=true 的 touch pointerdown 揭示验证并提交密码。 | 第一次锁后 PC id1/DC ids4/5 关闭。PIN 解锁后的 H264 由 PC id6/DC ids9/10 恢复。第二次锁后，密码验证期间返回 WS error 并留在 locked epoch5，等待解锁超时。原生记录三个 Browser PID、两次 stale_rtc_connection。 |

89 人脸录入单项在手动锁前完成。PC id1 保持 connected，原产品 DC4 与认证 DC5 都可靠有序，H264/Opus 的两个接收 track 保持 id2/3，没有摄像头 RTP sender。Control 活动 challengeId 与 ready/config/accept、grant 及 binary header 一致。Endpoint 选择 320×240 RGB24、5fps 和 16384 字节分块。观察到 6 个 grant、5 个完整帧、75 块、1,152,000 RGB payload bytes；最短浏览器观测 grant 间隔 203.245ms，探针无分块错误。取消后挑战消失，500ms 复查无新增 grant 或帧，face 方法仍为 false。该短组观测的是协商与实际 RGB 传输，帧处理、真人身份、活体和离开检测各有独立证据要求。

89 锁定后探针短暂仍可发送旧输入和新建窗请求，随即通道关闭。未能把请求拒绝归因于正确的 Endpoint 锁定门禁。两版没有在可持续的既有连接上完成锁下无新快照、媒体停止和重放门禁证明。真实后台、页面闲置、密码解锁、默认锁重附着以及 157 人脸 RGB 仍待复测。未检出 FATAL、CHECK failed、GPU process exited 文本；Browser 实际替换已经记录，原因待调查。

目视核对锁屏、账户登录和 PIN 验证截图。锁屏纯黑，登录与验证表单分别只显示各自适用的入口。首轮整体验收 2/5，核心锁定连接保留与密码恢复仍失败。所有新日志、截图、hash 与 WS/DC 记录保存在 `develop/tmp/advanced-auth-qa/run157`、`run157-connected` 和 `run89`。已关闭自有 browser context 并正常停止三个自有 supervisor，最终自有 PID 与33713/33714 listener 为空。GPU 资源已交还 root。

## 157 首登门禁及手动锁诊断（当地 07:52）

使用增量 Control production 和新增进程/RPC 诊断的 Endpoint。首登后采样时 PC 为 new，两个 DC 为 connecting，“新建窗口”尚未出现。两条 DC open 后建窗成功，获得 H264 和远程输入，PIN 设置成功。该项验证首登操作门禁。

发出 auth.lock 后，Control 先发 locked=true、epoch2 / peerEpoch1，再发已应用的 peerEpoch2。Endpoint 日志紧接记录 Browser 的 page.requests RPC 传输状态7、PID30376、退出码 0xC0000409。采样时进程等待对象尚未 signal，不能把 process=running 解读成正常运行。Endpoint 以 control=0 / peer=1 执行替换，Browser PID30376/incarnation dd9a601568947c41b555d7152c7bd1f2 改为 PID36852/incarnation eac8e2f0429eac4bb08bed9a22f674f8。Endpoint PID26028 未更换。page.requests 是观测到传输失败的 RPC，单凭日志不能确认它触发了 fail-fast。

客户端 auth DC5 首先在 3147.8ms 收到 close，产品 DC4 在 3148.4ms close，随后才发 rtc.close 并关闭 PC1。实际 JS 堆栈为产品通道 onclose → connectionFailed → closeLocal → RTCPeerConnection.close。该链路将前端关闭定位为通道丢失后的反应。锁下探针没有可持续的现有通道，仍不能给数据面门禁验收结论。

PIN 提交后 Control 已发 unlocked / epoch3 / peerEpoch0，重建 PC6，DC9/10 open，Opus 收到443包。等待10秒无可用 H264 帧，恢复画面失败。Browser log 保留两次启动，未出现 FATAL/CHECK 文本或堆栈；Windows Application 1000/1001 的该时间窗口无匹配 RemoteKit Browser 事件。进程 fail-fast 的精确位置待定位。

证据目录 develop/tmp/advanced-auth-qa/run157-lock-diagnostic，含产物 hash、PC close 堆栈、浏览器截图、Endpoint stderr 与 Browser log。隔离组已正常关闭，cleanup.json 记录自有 PID 与33713/33714 listener 均为空，GPU 已释放。

## CDB 定向复现与修后准备

独立短组 run157-lock-cdb、run157-lock-cdb2、run157-lock-cdb3 与 Endpoint owner 协作，CDB 仅附着本任务 Browser。第一组抓到 ucrtbase abort，第二组附着扰动首帧，仅作诊断，第三组先完成 H264/PIN 再附着并捕获堆栈。第三组原 Browser PID31232 以 0xC0000409 退出，替换为 PID20832。堆栈显示 OSR renderer State 最后引用释放时销毁 RenderChannel，析构断开回调重入 State::Disconnected，shared_from_this 抛 bad_weak_ptr。重建 PC 后 PIN 解锁曾恢复画面，锁定保持连接仍失败。三个组自有进程均已清理。

修后待跑一组独立的合成人脸数据。源为现有 MiniFAS 官方 T1 样本，转换为 320×240 / 5fps Y4M，循环 12 秒脸与 7 秒无脸，角落微小变化供不同采样识别。T1 SHA256 为 F4455149F488F76205FDEE5499EC5261D08EF6279A1CFF7B778EA85405331E94，Y4M SHA256 为 714D143E972DAF4ECD56102B4F5931A9AAC70F3142698B4FBA4C27AA731041DF。离线 I420 往返抽样的 YuNet、V1SE、V2 分数为 0.92497、1.0、1.0，属于准备证据。计划通过正常设置录入、以独立密钥对测试 SQLite 密文验证 AES-GCM 标签及归一化128维形状，随后在同一 peer 锁定下显式验证，再启用离开锁定观察无脸段。证据只保存状态和计数。该样本用于验证端到端接线，不代表真人、真实摄像头或抗伪造效果。


## RenderChannel 修后最终组

使用正式增量构建的 Browser/SDK、诊断版 Endpoint 和 Control production。按顺序独占资源运行 run157-final、run89-final、run157-t1-final。未运行历史性能矩阵。

- Chrome157 和 Chrome89 核心各 7/7 断言通过。键盘、鼠标和 Playwright 可信触控可以揭示对应表单。锁屏纯黑、无可见控制或光标，错序前后截图字节一致。锁定、PIN 解锁及下一次密码解锁均保留同一个 PC id1、两个接收 track id2/3、产品 DC4 和认证 DC5；两次解锁均重新取得工作区并恢复视频。
- 锁下对比期间无新全量 state。稳定后 Chrome157 的 H264 174 帧 / 2020 包、Opus 182 包，Chrome89 的 H264 245 帧 / 2819 包、Opus 250 包，均在后续500ms内保持原计数。复用打开的产品 DC 发送旧 epoch 输入、用当前 peerEpoch 标记的输入与新建窗请求；远端 fixture 仍只报告同一个有效 pointer/corner，解锁后窗数不变。WS operation.status 返回错误且无结果，工作区完整快照在解锁后恢复。
- 两版假摄像头各完成5个 320×240 RGB24 帧、75块、1,152,000 payload bytes。157/89 的最短端侧 grant 间隔分别为211.40/215.31ms，分块无错误。取消后观察500ms，grant 和帧计数均不变，未录入模板。
- Chrome89 在实际页面活动计时下以15秒设置触发锁定，IdleDetector 不存在，触发时页面仍 visible。带账户 Cookie 的 reload 收到 locked epoch1，首张新文档样本 stateCount=0。两版第二 tab 测试均未取得可信 visibilitychange，后台行为留待实际浏览环境验证。Chrome157 主组在此探针后结束，页面闲置证据来自 Chrome89。系统检测和物理关屏未验证。
- Chrome157 T1 合成摄像头组通过。Enrollment 在 peerEpoch1 用3个 RGB24 帧完成。隔离 SQLite 持久化2671 bytes AES-GCM 记录及独立32 bytes 密钥，验证标签并读取到有限、归一化128维模板，输出只有长度和验证结果。手动锁后用 peerEpoch2 的新挑战再发3帧，服务端先发 matched 且仍锁定，Endpoint 确认 epoch3 后解锁恢复 H264。随后开启离开检测，空帧段触发 presence absent/no-matching-face，进入 epoch4 的纯黑锁屏。登记、验证、离开锁定始终保留同一 PC、track 和双 DC。结果限定于已知合成输入，不外推真实摄像头、真人或活体抗伪。
- 目视核对157纯黑锁、触控揭示的解锁表单、H264实际画面，以及89重附着和T1离开后的纯黑截图。三组分别只有一个原生 Browser PID，未见替换、FATAL、CHECK 或 GPU 退出。隔离服务/客户端按组退出，三个 cleanup.json 均无自有 PID 或监听端口。核心和合成组的体验评分 4/5，保留真实后台和实体设备覆盖缺口。
