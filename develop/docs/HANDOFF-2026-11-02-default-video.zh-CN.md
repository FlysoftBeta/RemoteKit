# RemoteKit 完整交接：默认 video 实现与本次发布

更新：2026-11-02，UTC+8。本文件是新对话的主交接入口；发生冲突时，优先采用本文记录的最新用户决定，而不是旧实施报告中的阶段性结论。

## 1. 当前结论与下一步

音频输出、文件上传、拍照选帧已实现并验证，代码已本地提交。用户在最终发布前要求**改为默认 video 呈现**，因此旧发布已停止。

**默认 video 还没有进入产品实现。新一轮 native/client 实现代理均创建失败，没有产生相关源码修改。当前产品仍是单平面 canvas2d、多合格平面 shared WebGL。** 三个独立 video 实验工具已经跑过，不是正式后端。

接续任务：确认新会话代理能力 → 实现默认 video 和布局换代保护 → 必要功能/视觉验证 → 最终构建、本地提交 → 打包上传。**本次优先上传，GitHub 推送尽力而为。** 不要直接上传当前旧行为的包结束任务。

## 2. 最新用户决定

1. 默认使用 video，即使此前实验没有呈现帧率优势，也要落实产品实现。
2. video 的目标布局来自**客户端内容区域 bounds**；服务端 atlas 矩形用于源裁剪，不决定页面中目标窗口的位置与大小。
3. 不启用原生 controls、画中画和其他多余媒体功能。
4. Chrome 89 支持保留；多 Window/split、DPR、输入、音频等既有能力应正常工作。
5. **仅本次发布**允许 GitHub 推送尽力而为、上传优先。用户说网络问题需回家修复。不要改写长期 commit/push 约定。
6. 子代理是上下文隔离 primitive：不同任务使用新代理，重要 milestone 后用简短交接开启新上下文，不把旧代理转去无关任务。
7. root 做核心架构、契约、取舍、文档和 commit/push；实现、深入调查、实验、构建和测试委派。普通任务 Sol 6.1 Medium，UI 设计 Astra 6 Medium，视觉验证 Sol 6.1；`fork_turns="none"`，给完整任务提示。
8. 用户没有批准由 root 绕过分工直接实现。面对槽位错误，用户选择调整 Codex 设置并重启 app server。

## 3. 环境、Git 与资源

- 仓库：`C:\Users\Flysoft\Desktop\remotekit2`，PowerShell，分支 `main`。
- 不读取旧 `C:\Users\Flysoft\Desktop\remotekit`。
- Chromium：`C:\src\chromium\src`，RemoteKit 基线为官方 157.0.8103.15；复用 `out/dev`、`out/rel` 增量产物，禁止全量重建、禁止并发操作同一 out。
- Chrome 89：`C:\src\tmp\chrome89-google\app`。已有 fixture 使用 89.0.4389.90 与本地 157。
- Python：`C:\src\depot_tools\python3.bat`。不要用 WindowsApps 空别名。
- Endpoint：独立 CMake/Ninja。当前 Release 服务：`build/endpoint-package/endpoint/endpoint_service.exe`。
- SDK：当前导出在 `sdk/dist/dev`；Browser/SDK 对应 `out/dev` 最新音频实现。
- 不抢用户鼠标键盘、不切桌面窗口。使用 host-managed Playwright，先读相应 browser-use 技能。
- GPU/媒体计时组独占，不与 CPU 大构建并行。此前所有自有 fixture、157/89 contexts、采样进程与默认上传 host 页已报告关闭。开始前只检查自身相关资源，不杀未知进程。
- 没有需要创建的新 goal。不要因继续工作自动创建 goal；旧性能目标已结束，工具也没有 delete_goal。

本交接写入前的提交：

| 提交 | 状态 |
| --- | --- |
| `1bc5f40` | 本地：默认 video 用户要求与实施计划，尚未推送 |
| `c379f6c9aecce0b10ea5bab42eff47fdab3e5da3` | 本地：音频、文件、拍照、诊断、video 实验，尚未推送 |
| `ba0deec` | 上一批已推送：Browser 启动失败诊断 |
| `f1b2638` | 更早已推送/发布：连接、画质、触控、共享呈现、spinner |

交接文档本身会产生后续本地文档提交，接续时用 `git log/status` 确认，不硬编码本文为最新 HEAD。写本文前工作区干净。

GitHub HTTPS push 在 schannel、openssl、HTTP/1.1 及现有代理路径均失败。系统 github.com DNS 返回 fake-IP 198.18.0.11，本地 verge-mihomo 监听 127.0.0.1:7897；只观察/尝试了单命令代理，没有改网络设置。用户已明确本次不以此阻塞上传，勿继续长时间修网络。

## 4. Codex 槽位问题与设置

当前长对话反复出现 `agent thread limit reached`；旧任务完成后出现在 `pending_init`，interrupt 未释放。对已确认完成的旧代理调用一次无工作 followup 并等待 final，曾成功创建新的发布代理；之后再次失败，不能把这种清理当可靠修复。

清理提示仅用于确认完成的旧任务：

> 原任务已结束。不要调用工具、改文件、检查或开展新工作。立即返回 final 确认结束。

不要用 queue-only `send_message` 告诉完成代理停止，可能再次留下待处理消息。不要循环复用旧代理来绕过用户要求，也不需要创建大量空代理测试容量。

用户已授权并完成配置修改：

```toml
# C:\Users\Flysoft\.codex\config.toml
[agents]
max_concurrent_threads_per_session = 128
```

- 本机 CLI 0.163.0；TOML 解析与 `codex doctor --summary --ascii --no-color` 均确认加载成功。
- 除此参数外配置未变。备份：`C:\Users\Flysoft\.codex\config.toml.backup-20261102-222327-181499`；更早 8 槽位备份为 `config.toml.backup-20261102-221849`。
- **旧对话收到的系统说明仍是 4 槽位含 root，尚未确认 128 对运行时生效。** 用户准备重启 app server，新会话先确认并创建真正需要的新实现代理。
- 参考：[官方 subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[相似问题 #49986](https://github.com/openai/codex/issues/49986)、[未回收问题 #39694](https://github.com/openai/codex/issues/39694)。旧版本 issue 的配置路径可能不同；本机 0.163.0 支持上述 agents 设置。

## 5. 默认 video：root 方案，尚未实施

详见 [default-video-plan.md](default-video-plan.md)。下述是 root 的架构选择，不是要求盲目照搬的用户原话；实现时需核实实际源码约束，发现问题由 root 调整契约。

### 客户端呈现与输入

- 每个可见平面对应自己的 video，全部共享同一接收 track，不 clone，不新增 WebRTC 视频通道。
- 从客户端实际内容 bounds 计算目标位置/宽高；结合 atlas 的源矩形计算 video 缩放、偏移和矩形裁剪。保留 DPR/mediaScale、letterbox 与输入坐标关系。不要把服务端 packing 位置当客户端窗口布局。
- `muted`、`playsInline`；无 `controls`；禁 Picture-in-Picture/remote playback、无 tab 焦点与拖动，避免原生媒体菜单和额外交互。声音继续现有独立音频输出，不让每个 video 重复播放音轨。
- 默认 video 路径停掉不参与呈现的 MSTP 读帧和 canvas draw，不能只把 video 盖到仍绘制的 canvas 上。
- canvas 留作能力/协议失败回退；不要给普通用户增加复杂后端选项。
- 输入始终通过现有产品入口与身份门禁。首个当前代次真实 RTP 匹配后才恢复 ready；隐藏、切换、重连立即撤销旧 ready。
- rVFC 回调数不等于呈现帧数；统计应区分 video compositor 提交观察和 canvas JS 提交。不要修改统计来制造 FPS 收益。正常运行不要为了 marker 加逐帧像素拷贝。

### 为什么需要布局屏障

video 会自主向 compositor 提交画面，JS/rVFC 不是逐帧拒绝 API。固定布局实验可以直接裁剪，但产品同尺寸 atlas 重排时，未知新布局视频可能先于元数据到达。只在 rVFC 发现错误后隐藏不充分。

root 选定：在 Endpoint 真正允许新布局编码结果发送前，先让客户端隐藏旧画面并 ACK。稳态不新增逐帧握手，换代才握手。

### 拟定 DataChannel 协议

```text
Client → Endpoint:
  media.presentation { version:1, backend:"video"|"canvas" }

Endpoint → Client:
  原有 layout 消息
  presentation.prepare {
    version:1, barrierId, outputGeneration, layoutEpoch
  }
  presentation.mode { version:1, backend:"video"|"canvas" }

Client → Endpoint:
  presentation.ready {
    version:1, barrierId, outputGeneration, layoutEpoch
  }
```

上述均含对应 `type` 字段；barrierId、generation、epoch 是十进制字符串。video 模式确认必须在服务端 gate 建立后发送。客户端隐藏所有 video、撤销 input ready，计划跨两次 rAF 后回完整 ACK；这部分隐藏提交时序须在实现中验证。

Endpoint 在新 peer/video 启用以及 outputGeneration/layoutEpoch 换代时建立最新屏障，仅当前 peer/完整最新 key 的 ACK 放行并请求一次关键帧。旧 ACK 拒绝；旧 source epoch 只 drop，不反向准备旧布局。隐藏页 rAF 暂停可保持 gate，不超时强行放行。切 canvas 取消 gate，旧未协商客户端保持旧行为；peer 关闭重置。

**不能只挡 Encode 入口：还要覆盖已在编码的旧结果，在调用 `sdk.encoded` 真正发送前检查。** 必须正确 drop 并释放纹理、编码和 TailRefresh 租约，且避免等待/锁顺序死锁。先核查 Session 的布局键来源、EncoderWorker 排队与发布顺序、source 帧身份；必要时增加小的 gate helper 与可安全共享 predicate。不要改音频、GPU Fence 或帧率策略。

### 建议新代理拆分

1. **Native Sol**：`endpoint/src/service.cpp`、相关 media encoder worker/helper/CPU tests。确认和实现协商、屏障、旧 in-flight 结果处置，Endpoint 增量构建。有意义的乱序 ACK/旧 peer/旧 epoch 检查。原则上不改 SDK/Browser；若确需变更先由 root 定边界。
2. **Client Sol**：`control/client/transport.ts`、`remote-viewport.tsx`、相关呈现 helper、stats/types/tests。实现客户端 bounds、video 生命周期、协商/隐藏 ACK、回退与输入集成。不要碰 native 文件。
3. **新 QA Sol**：实现 milestone 后验证 89/157、单窗/split、不同客户端 bounds/resize/DPR、同尺寸布局重排、旧 ACK、输入点击/触控、重连、无媒体原生入口、音频共存。使用隔离数据和可重复短组，截图并目视验证。
4. **新发布 Sol**：最终 build/package/upload，root 提交后再确定包 revision。不要复用旧发布代理去实现功能。

可先 native 后 client 串行，或 root 固定接口后按文件归属并行。GPU/运行 QA 与大构建串行。

## 6. 已完成的音频、文件与相机

正式说明：[audio-and-files.zh-CN.md](../../docs/audio-and-files.zh-CN.md)。无需重写这些功能。

### 音频

- Browser 自有 AudioManager/AudioOutputStream 播放 target，不 hook/录制系统声音。Session 内转为 48kHz、stereo、S16、480 帧/10ms。
- 8 槽共享 PCM 环，generation、sequence、sample index、首样本 QPC；Endpoint 独立线程 → SDK AudioSource → Opus，同一 PeerConnection。
- 短缺口最多补 80ms 静音；长缺口/新代次重建发送时间线。视频-only 老 offer 支持；没有客户端麦克风上行。
- Viewer 全局左右声道设置存 Control，“不播放”清空两者。
- 真实调试发现只连 MediaStreamAudioSource 不会激活远端拉取；当前使用 volume=0 的隐藏 audio 元素激活解码，实际声音由 MediaStreamAudioSource→L/R gains 输出。不要改成两条可听输出，静音时不要停远端时钟积攒旧声音。
- 文件入口：`browser/audio_target.*`、`browser/sdk/rtc_audio_source.h`、`remotekit_rtc.cc`、`endpoint/include/remotekit/shared_audio.h`/`audio_timeline.h`、`endpoint/src/media/audio_ring.hpp`、client `audio-output.ts`/`audio-controls.tsx`。

### 文件

- 真正 RunFileChooser/FileSelectListener，自定义 dialog。Control `fileRequests` 与内部 Session/Browser incarnation/WebView/document/request 身份绑定。
- WS files.begin → opaque ticket HTTP 原始字节流 → files.commit/status；取消 files.cancel。确认前文件/照片不离开客户端。
- cookie、Origin、当前 Viewer lease 检查；Endpoint Session 随机路径和配额，Control 同机写入内部路径。客户端不接触服务端路径，网页 File.name 保留原始名字。
- 256MiB/文件、512MiB/64 文件每批、1GiB/4096 文件每 Session。重启保留预留配额语义。
- 未提交文件可随取消/租约失效清理；已 selected/提交结果未知的文件保留到确认 Browser incarnation 退出，不能因导航/TTL删除网页可能延迟读取的文件。目录上传不支持。
- 单选 FileList 被空照片覆盖的问题已修复，且最后生产 dist 包含修复。
- 入口：`browser/page_requests.*`、`control/server/file-uploads.ts`、`endpoint/src/file_upload.cpp`、`control/client/file-chooser-dialog.tsx` 等。

### 相机

- getUserMedia，最多 6 次/约 600ms burst，Worker 一次一个任务，忙则跳帧，top3，时间去重与像素上限。曝光/噪声惩罚的清晰度评分；同一不可变帧生成评分和照片。
- 首版主线程快照首帧 31.2ms 超预算，已改 ImageBitmap → Worker OffscreenCanvas 评分/编码；保留能力不足时的同一 canvas 快照 fallback。
- 157 首次冷 burst 同步 p95 1.5ms，89 为 5.35ms；各 6 张、零 >50ms longtask，峰值逻辑 4,608,000 pixels。展示 3 张 1280×720 候选，无默认选中。
- 89 拍摄中取消后 track ended、worker/pending false、canvas/pool 清空。迟到 bitmap/generation 清理有模型覆盖。
- 最后同步 throw 进入 fallback 的微修已包含最终生产 build，不要再以旧报告说它没进 dist。
- 相机是 fake-camera 运行证据；实体设备效果、真实隐藏切换和 fallback 实机性能没有新增验证。HTTPS/localhost 要求已有 UI 提示和 TLS 文档。

## 7. 最新验证，不重复旧矩阵

- Browser/SDK 增量编译、export 完成；Endpoint **11 套 CPU** 与 SDK 音频 smoke 完成。
- 最终 Control **171/171**、tsc、Vite/server bundle 校验、production startup smoke 全通过。`camera-score.js` 源/dist SHA256 一致。
- 最终日志：`develop/tmp/audio-files-final-tests.log`、`audio-files-final-build.log`。
- 157/89 实际 PCM；157 声道组合/重连；89保存静音 3 秒后再开，PCM 恢复。
- 一次 AV 闪光/声脉冲点测 audio-canvas +5.6ms，不是长期同步结论。
- 157 单/多文件、Unicode 名称和精确字节、零字节、真实取消、导航失效、同文档 history 后 held File 延迟读；89单文件和租约旧ticket拒绝。
- 157 桌面及390px窄屏菜单/dialog由Sol检查。
- 未作运行验证：真正 PCM/network gap、真实 autoplay 拒绝、HTTP 断传/commit 竞态、跨文档旧文件延迟消费。CPU/model 覆盖与真实运行分开表述。
- 新 video 改动后做对应验证；这些旧成功不覆盖尚未实现的 video 后端。

核心报告：

- [audio-files-runtime-qa2.md](audio-files-runtime-qa2.md)
- [audio-upload-runtime-handoff.md](audio-upload-runtime-handoff.md)（旧阶段交接，未过项部分已由qa2完成）
- [camera-bitmap-worker-optimization.md](camera-bitmap-worker-optimization.md)
- [file-upload-implementation.md](file-upload-implementation.md)
- [audio-upload-ui-design.md](audio-upload-ui-design.md)（设计，不等于全部采纳）

## 8. video 对照结果与待调查问题

[video-clip-evaluation.md](video-clip-evaluation.md)：同1936×816、固定50FPS、157，四组各12秒，无补跑。实验用 native固定参数并拦截产品 mediaPolicy，真实stats确认 adaptive=false/target50；不是普通自动策略现场。

- 四组源/解码约50FPS，inbound无drop；canvas JS提交2D/WebGL约49.75/49.93FPS。
- 单/双video presentedFrames跨度约47.55/47.67FPS；rVFC回调次数更少，不能直接当显示FPS。
- WebGL/单video/双video接收CPU约0.343/0.291/0.281核；3D约11.50/0/4.12%；VideoDecode约8.71/8.70/8.84%。0%是采到的3D计数，不是GPU零工作。
- 首2D资源仅4样本/3.04秒与正式窗重合，不拿它计算严格倍率。
- 双video共享同track，未见解码负载翻倍，不能宣称证明单decoder。第四组仅同atlas两ROI重拼，不是真实双Window packing。
- 工具：`tools/viewer-video-clip-{server.mts,candidate.js,browser.js}`。证据：`develop/tmp/video-clip-20261102-1745/`。实验停止MSTP/canvas，保留RTC/DC metadata。
- 用户已在这些结果之后决定默认video；不要再次以“无FPS胜出”为理由只交比较报告。

用户Chrome138单窗口/自动/1936×816，旧decode/paint46/20→f1b约12/12，编码FPS上限50，**根因仍未确认**。单窗两版都是canvas2d，不能说WebGL降级，也不能用4K解释。f1b把policy_fps接入真实capture周期，可能放大旧低预算反馈影响；旧RAF估计缓存续期也是风险，尚未改策略。新增stats可看source target/applied/effective/feedback age/frameSource。`tools/viewer-diagnostics-console.js`只读白名单提取，不输出token/SDP/路径/URL，用户尚未运行。

Browser偶发启动错误7是SDK_CHANNEL_CLOSED，非Windows码，用户UHD630/i5-8400机器后来能启动。ba0deec诊断已发布；新源码额外修复独立的Job assignment失败后悬挂子进程清理，并补有限启动日志，但未证明是用户错误7根因。

历史双租户目标有51.69/51.73FPS、marker p95 76/79ms证据，条件见正式性能文档；用户取消重复长跑，不要重新开启历史调参矩阵，也不能把旧canvas终点直接当新video结果。

## 9. 发布流程

最终video完成后，新Sol执行 [docs/upload/README.md](../../docs/upload/README.md) 与 [packaging](../../docs/packaging.zh-CN.md)。用户已明确授权上传，无需再问。

1. 按实际修改构建。只有Endpoint/client改动就不重建Chromium；确有Browser/SDK变化才一次增量stage/build/export，按AGENTS工具流程。
2. Control最终test/build/smoke；确认相机Worker和新video资产进入dist。root检查范围并commit。本次push尽力即可。
3. root给最终HEAD后生成默认streaming包到develop/tmp，包含Node/Control、最新Browser/SDK/Endpoint；不要误用旧ba0deec诊断EXE。
4. 启动smoke、manifest、ZIP逐文件hash/CRC及禁止项核查，不携带凭据、Profile、数据、PDB和开发输入。
5. Playwright MCP打开airportal.cn，按README处理登录（需要时读取指定cred.json，禁止打印/入包）。上传后返回取件码、链接、到期/下载次数、ZIP大小/SHA256，写`develop/tmp/release-<HEAD>-delivery.json`。
6. 关闭自己的浏览器/默认host。若出现默认profile占用，先通过自己的browser_close清理，不杀用户进程。
7. 最终给用户取件码和几张Viewer效果图；此前截图可作功能证据，但默认video改造后应提供对应新截图。

已有截图：`develop/tmp/audio-files-qa2/{157-single,157-narrow-menu,157-narrow-file}.png`、`develop/tmp/camera-bitmap-qa/{157-camera-bitmap,89-camera-bitmap}.png`。

历史交付f1b的609418、ba0deec诊断342375都不是本批发布；不要复用取件码。c379f6c没有最终包/上传。

## 10. 可直接复制的新对话提示词

见同目录 [NEXT-SESSION-PROMPT.zh-CN.md](NEXT-SESSION-PROMPT.zh-CN.md)。从读取本文和确认实际工作区开始，不重启已完成的音频/文件开发，不接管旧代理上下文。
