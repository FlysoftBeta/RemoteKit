# 连接与画面质量实现及验收

2026-11-02。只读根因调查见`viewer-connection-quality-audit.md`；本文件反映最终代码与本次实际验证。真实证据：`develop/tmp/connection-quality-final-1793604205028/metrics/client-metrics.jsonl`；真实JSONL身份回归：`develop/tmp/rtc-signaling-regression/1793604192140240800/evidence.json`。

## 结果

|功能组|实际观察|判定|
|---|---|---|
|现代自动level5.2高画质|source、encoded、接收getStats均3856×2176；实际canvas3840×2160，对应CSS1920×1080、ClientScale2；mediaScale=1|真实完整分辨率通过；不据此宣称4K50吞吐达标|
|受控level5.1高画质|同样3856×2176/实际canvas3840×2160，mediaScale=1；requested名义50，codec/sampling/worker上限29；3秒实际decode约27.55FPS、encode约27.22FPS|保留完整尺寸，帧率先降；29为预算，不能写成实测29|
|5.1实际源预算|Browser renderHost configuredFps=29、pacer≈29.0006；adaptive requested/effective/target/applied均29，healthy_recovery不抬回30；sender实际27–28FPS|源、编码和提交上限一致，无旧30FPS下限回升|
|产品auto|preferResolution=false；requested/applied codec target52，source/decoded1936×1088、plane1920×1080，ClientScale请求2经面积预算有效DPR1|保留原FPS优先与面积策略|
|静态切档|800×600静态页auto→quality，source/encoded816×608；新增2个IDR/2次真实paint，额外2秒无新增编码/paint；尾帧计数无增长|切档可见新画面，未持续重发；重复刷新是有界后续改进项|
|真实信令身份|全新Tenant UUID明确不同于内部Session数字id；真实native answer/ICE/complete均保持UUID与connectionId，另一个snapshot RPC可完成|trickle真实JSONL回归通过|

受控51先用真实VideoDecoder能力检查，再仅在隔离QA中选择51；普通生产52选择使用decoder+RTP正面能力。客户端Chromium157.0.8103.15 headless、DPR2；服务端Browser为out/dev，Endpoint为build/endpoint-package Release，UHD630。未复跑旧双租户性能矩阵，也未追加旧稳定性组。

## 连接时间

以下均是Viewer自身monotonic时钟，从本次媒体attempt起算；冷源指本轮首次Browser/媒体源启动，暖源指同一已运行Browser/页面重新建立RTC。不是旧版与新版对比。

|Viewer阶段|冷源完整4K52|已运行源4K52重连|
|---|---:|---:|
|offer发出|62.6ms|31.2ms|
|answer收到|91.6ms|78.9ms|
|ICE connected|124.2ms|85.5ms|
|DataChannel open|131.0ms|91.7ms|
|首decoded frame|1008.5ms|355.5ms|
|首authorized frame|1012.2ms|367.5ms|
|首真实canvas提交|1019.8ms|368.6ms|

冷源导航到首canvas约1340.6ms；不能把124.2ms ICE或131ms DC写成首屏。能力探测实际约0.5ms，已在鉴权前预热，重连复用页面缓存。

Endpoint阶段使用独立`endpoint-offer-monotonic` origin，只比较该进程内区间：冷源首次output-open尝试到首次成功包络约561.7ms，首source623.3ms，首submit623.5ms，encoder configure623.8→784.4ms（约160.5ms），首encoded849.1ms。暖源对应open包络约67.1ms，首source94.3ms，encoder configure约94.6ms，首encoded237.4ms。

**output-open包络含可见性/viewport准备及首次成功前的重入，不能称纯GPU初始化。** 当前SDK pending轮询为10ms，未发现足以直接解释整个包络的固定500ms sleep。没有从未校准的跨进程时间直接相减，也不提供缺少可比旧日志的“优化倍率”。

## 实现边界

- 普通产品连接启用trickle：Viewer不等gather complete；Endpoint接受offer后立即pending，由dispatcher输出非逐帧rtc.signal JSONL；SDK callback不写stdout。Control内部保留一次offer RPC，按真实Tenant、lease、connectionId、attemptId转发；早到ICE有界排队，旧身份拒绝，close/timeout取消pending。
- 网络模拟明确full-gather-simulation，保留完整SDP/relay改写并拒绝额外trickle；不宣称该路径也已提速。
- 52/51/42三级探测并行，整体最多1.5秒，缓存页面进行中/完成结果并预热。无VideoDecoder时尝试合法MediaCapabilities WebRTC H264配置（[W3C示例](https://w3c.github.io/media-capabilities/#examples)）；缺失、拒绝或超时保守保留native并记录明确原因。Safari fallback只有模型检查，本次未获得Safari硬件运行证据。Chrome89保持既有验证42并修复HeadlessChrome匹配。
- 明确codec错误才52→51→42→native；网络/ICE timeout不降档。
- quality使用真实viewport×ClientScale为目标，受atlas资源和协商/编码硬限制；MediaPolicy显式preferResolution，requested名义策略与实际codecTargetFps、fpsLimitation分开。FS/轴长能容纳原atlas但MBPS不足时先降FPS；FS/物理资源不满足时仍降分辨率，原因进入现有stats。SDK无新增C ABI。
- 合法FPS同时传既有SDK sender policy、worker初始BRC、Browser capture/render预算和提交节拍。节拍门禁保留latest待送帧，静态最后一帧不会因限流丢失；普通补送不强制每帧IDR。
- 显式切档刷新当前静态内容，普通BWE更新不重开QSV序列。renderer恢复media.refresh只允许当前peer、≤256字节、每秒限一次，不启动Browser、不改变layout或输入资格。
- 每连接有界Viewer/Control/Endpoint阶段计时；常规帧无额外QPC采样。生产指标保留真实decode与canvas尺寸，不以stats文案冒充满分辨率。

## 构建与模型验证

最终统一Browser+SDK out/dev构建通过（含0008，330实际增量步骤），SDK重新export；Endpoint Release/package通过，9项CPU suites通过（含touch_clock/core、5.1/5.2采样与29FPS ceiling模型）；Control全148项、类型检查、完整生产build/smoke通过。Marker public helper与最终dist hash一致。content_unittests未预建，本次未新建或构建该大型目标，新增官方touch unit case未执行。

verify-media原先漏构建已注册的atlas_plan测试目标，已补工具目标并通过。真实trickle首测发现Session数字id误作为Tenant UUID，已修复并重编、真实复验及独立JSONL回归通过。全套Control测试把原空candidate假成功用例修正为无效输入400、合法candidate200，保留租户隔离断言。

## 收束

所有本组自有context/host页和fixture服务已正常关闭；服务PID16448已退出，GPU/host窗口已交回触控组。未commit、push或上传。静态切档两次有界刷新保留为后续小优化，不扩大本轮实验或为此追加native改动。
