# Audio / 文件 / 摄像头运行交接

2026-11-02，Sol6.1。按 root 的新上下文隔离要求收尾，后续请由全新 Sol 接手。

## 当前边界

自有157 context、Playwright host页面、隔离Control/Endpoint/Browser已正常关闭；`/shutdown`完成，启动PTY退出，未发现命令行含audio-files-qa的剩余进程。未动用户浏览器或桌面。GPU/host已直接通知 touch_scroll_audit 释放。

客户端源码归新Sol；server/shared/store归文件后端owner（touch_scroll_audit），native/SDK归audio_output_investigation。无commit/push。

## 已通过 / 实际结果

- 全Control **168 tests**曾通过，随后生产build与smoke通过；最初新增诊断读document使纯模型失败，已改可选globalThis.document并全量通过。日志 `develop/tmp/audio-files-control-tests.log`。
- 音频真实消费修复后的定向audio测试2项、生产build/smoke通过。最终实现：**先volume=0，再挂流/play的单audio元素激活WebRTC playout时钟；实际输出仍MediaStreamAudioSource→explicit2 speakers上混→L/R独立gain→merge**。MediaElementSource不是最终实现。
- 157真实Opus stereo协商、RTP、接收samples与实际PCM闭环。L440/R880对应FFT约445.3/890.6Hz，双开RMS约0.056/0.056；关任一侧对应PCM严格0，另一侧仍0.056；不播放双0；再次开启恢复当前音调。`audio-channels-157`各结果名字受初始持久化left=false影响，**请按每项channels字段读组合**，四组合均覆盖。
- 真实“不播放”按钮清空并保存整对偏好。显式暂停元素/AudioContext后，覆盖恢复按钮把本地状态恢复playing，Control偏好不变。此次headless自动播放本身未被策略拦截，不能称已验证真实autoplay拒绝。
- 一次合成闪光/声脉冲：实际Viewer canvas白像素首见52822.6ms，WebAudio PCM脉冲首见52828.2ms，audio-canvas **+5.6ms**；仅一次功能点测，ScriptProcessor块1024带采样误差，不是AV长期同步结论。
- 网页AudioContext suspend→约413ms后resume，真实音调恢复；这是内容音频短暂停顿，**不是注入PCM/网络断流**。audioTimeline所有restart/silenceBlocks仍0。
- 最终保存时接收audio samples12,590,880；post-gate双侧RMS约0.056；Endpoint submitted26,172/gaps0/rejected0，timeline全0。元素volume0使RTC totalAudioEnergy可为0，不能再拿它替代WebAudio实际PCM是否存在。
- 真实file chooser可显示、设备文件草稿可选且**确认前无/api/files POST**；取消真正pending请求后dialog关闭。尚未完成文件上传交付。
- 首次fake-camera burst：6快照、Worker评分0.6–2.8ms、往返5.1–27.7ms、Blob异步9.2–18.8ms、逻辑峰值3,686,400 pixels、0 longtask。同步snapshot **31.2/4/11/6/2.8/3.3ms**，p95=31.2ms，超过预设20ms阈值，**摄像头负载验收未过**，未为达标重拍。结束后摄像头停止、Worker终止、pool清空；候选Blob在dialog内复核，取消后释放。
- Sol已看桌面截图：声音组紧凑、两Switch独立；照片3列、无默认勾选、按钮/页脚正常。窄屏未验证。

## 精确构建状态与待修

最新dist含最终volume0激活音频路径与stats诊断。**最新源码比dist多一项文件前端修复，尚未重build**：`file-chooser-dialog.tsx`的allFiles原来在单选且无照片时把设备files与空photos做replace，导致列表有文件而“使用文件”禁用。已改`combineSelection`，并先快照FileList再清input.value；`file-selection.test.ts`回归2项通过。下一位先定向类型检查/生产build，不能拿当前旧dist再复验此bug。

accept按最终后端契约是picker提示，不按申报MIME拒绝合法文件；前端已移除确认时MIME硬拒绝，cameraFormat仍据accept决定是否提供拍照。

未完成：真实单/多文件name/字节交付、selected后延迟读、导航失效、lease/断传与commit竞态；89所有最小音频/文件/相机组；窄屏/大字体；实际autoplay拒绝与play/resume失败；长静音再开是否始终实时；同一Viewer重连音频生命周期；真正PCM/network gap；camera超阈值后的方案决定。不要将这些标通过。

FPS用户回归仍未定。本轮只保存了新实现下source actualAppliedRenderFps52/displayLimit60/healthy_recovery，不能归因旧f1b。只读用户脚本 `tools/viewer-diagnostics-console.js` 已有白名单模型测试，不导出SDP/凭据/路径；未发用户、未构建独立热修。

## 证据与复用

- `develop/tmp/audio-files-qa/metrics/client-metrics.jsonl` 五条紧凑证据：audio-consumer-diagnosis、audio-channels-157、audio-clear-recovery-157、audio-av-gap-157、audio-camera-handoff-157。
- `develop/tmp/audio-files-qa/fixture-events.json` 证明真实按钮触发、脉冲计划与gap开始/结束。
- 截图 `157-audio-menu.png`、`157-camera-candidates.png`、`157-file-single.png`、`157-initial.png`。只有合成fake-camera图，无用户摄像头数据。
- `tools/audio-files-qa-server.mts`：`control/node_modules/.bin/tsx.cmd tools/audio-files-qa-server.mts develop/tmp/<new-run>`，33271普通Control、33272固定AV/file fixture，out/dev Browser与endpoint-package服务。`/inspect`只本地测试，`/shutdown`正常退出。
- `tools/viewer-presentation-baseline-browser.js`支持host `_baselineRoot`、`_baselineVersion`、`_baselineAutoplay=false`、`_baselineExtraArgs`、`_baselineInit`。不改产品transport/frameSource/质量。
- `tools/audio-files-qa-browser.js`在已启动的host._presentationBaseline上接post-gate analyser/ScriptProcessor和保存helper；`host._qaClick(x,y)`用真实Viewer鼠标→DC触发远端页面。ScriptProcessor输出清零。
- **静音保护初始化**：接收端不使用--mute-audio（曾使排查混淆），在init里包装AudioContext，把实际destination前插gain0后shadow实例destination，保证所有实际输出静音，仍测门控后的PCM。不要在用户扬声器播测试音。
- 当前fixture路径均返回同一固定HTML；按钮从左起130px：Start sound、Single file、Multiple files、400ms gap、AV pulse、Delayed read。y25；真实Viewer坐标通过_qaClick转换。后者只history.pushState后保留File引用延迟读取，不等于跨文档导航后保活，完整测试需要后续补。
- camera评分原型 `tools/camera-score-prototype.mjs` 与 `develop/tmp/camera-score-prototype/` 已完成固定合成素材/HTTP loopback成本，详见 `audio-upload-client-implementation.md`；不重复为跑分。

下一步：新Sol先读本交接、root当前决策和文件契约；修复后前端build，再做尚未通过的最小文件链路。camera先由root决定超阈值处理，不能直接发布为已验收；与touch的video+clip-path独占计时窗口错开。

root最后决定：20ms阈值保持，不以取消发布拍照来结束用户任务；新camera专项代理评估 **immutable ImageBitmap→Worker OffscreenCanvas**，评分与最终原图仍必须同帧。当前同步调用链在 `CameraCapture.capture`：新建full/small canvas→每快照full尺寸赋值→`full.drawImage(video)`→small尺寸赋值/`drawImage(full)`→small `getImageData`→主线程灰度转换，合计计入snapshotSyncMs；之后才并行Worker评分与`full.toBlob`。首次31.2ms可能含分配、首次视频canvas复制/读回，尚未细分，不能直接认定是某一项。建议新代理先细分该一次冷开销，再作有根据的所有权/线程转移方案，不重复原组求达标。
