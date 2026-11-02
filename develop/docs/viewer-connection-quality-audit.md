# Viewer连接与画面质量链只读调查

日期：2026-11-02。范围：当前工作区源码；未启动Browser、GPU实验、构建或桌面操作，未改实现。下面“确定”指源码行为；实际用户机器的耗时与画质收益仍须运行验证。

## 结论

1. **高画质的8.29MP预算与实际接收level4.2上限不一致。** Control可生成高DPR atlas，但产品接收探测只升级至4.2，Endpoint再把编码采样限制在8704 macroblocks（约2.23MP）。大显示区域/DPR2时，auto与quality会被相同接收上限压回约1080p，单纯增加画质档码率不能补回像素。
2. **连接有两个串行完整ICE gathering屏障**：Viewer先等自己的complete才发offer；Endpoint收到后等自己的complete才返回answer。Endpoint这一等待还阻塞全服务JSONL控制命令与恢复维护。源码不足以断言这是用户当前最长的一段，须加分段时间证实。
3. **静态页面只改码率不会主动重绘**。显式质量变更在没有DPR变化时，可能停留在旧编码画面，直到页面下一次变化；普通BWE码率变化不应因此都变成IDR。
4. Viewer没有通过stats假装满分辨率：canvas backing确实使用已采样的layout view尺寸，显示放大由CSS填充内容区域。问题发生在真实编码采样之前。

## 质量链与具体证据

|阶段|源码位置|实际行为|
|---|---|---|
|产品选择|`control/server/quality.ts:3,36-49`|quality预算3840×2160、50FPS、44/48Mbps；auto预算1920×1080、52FPS、36/44Mbps；smooth预算1600×900、60FPS、24/36Mbps。Client Scale取override或Viewer DPR。面积预算先降低base，atlas资源限制与高延迟反馈再降低DPR。|
|真实视口|`control/client/main.tsx:79-126`；`control/server/control.ts:247-260`|DOM量测后100ms合并发送viewport；Server检查实际DIP、DPR与可容纳性，保存最近viewport。|
|Browser配置|`control/server/control.ts:417-447`|对活动可见页下发实际width/height与`deviceScaleFactor=quality.effectiveDpr`，不改变页面DIP来冒充高分辨率。|
|atlas规划|`control/server/atlas-plan.ts:23-65`|按DPR生成16对齐atlas；8192轴长、16Mi像素限制会独立下降DPR，包含每平面8DIP间隔。|
|接收能力|`control/client/receive-profile.ts:60-72`|产品非Chrome89最多探测`avc1.42e02a / 1936×1088`，成功就把offer constrained-baseline/mode1提升到level4.2。Chrome89只在固定验证版本自动4.2，其他回native；没有产品level5.1/5.2能力选择。|
|协商上限|`browser/sdk/remotekit_rtc.cc:288-292,317-327,747-787`|SDK声明level5.1，但遵守remote offer所声明的更低level；getter硬`min(51,remoteLevel)`；不是把answer声明高就能提高receiver能力。|
|真实编码采样|`endpoint/include/remotekit/sampling.hpp:20-49`；`endpoint/src/service.cpp:913,1159,1180-1182`|按H264 FS、MBPS、4096编码轴长计算fit，改变实际submit frame的width/height；全部使用启动`options.encoding.fps`，没有使用产品policy_fps，默认60。|
|坐标和尺寸|`endpoint/src/service.cpp:912-927`|layout width/height及各plane矩形均按fit.scale缩小，`mediaScale`单独携带；input DIP路径能够保留原逻辑页面尺寸。|
|真实canvas|`control/client/transport.ts:499-513`|检验decoded图像边界，canvas width/height=采样后view尺寸，按矩形裁切，`pixelsPerDip=deviceScaleFactor*mediaScale`。|
|质量设置生效|`control/server/control.ts:302-320,484-490`；`endpoint/src/service.cpp:1313-1331`|settings落库→applyMedia→RTC bitrate/FPS+worker Policy；未要求显式静态refresh。|

### 可复算的采样例子

下表用与FitH264Sampling相同算法的纯CPU计算复算，**不是硬件测试**。3856×2176是单个1920×1080/DPR2视口加atlas边距/16对齐的示例。

|atlas|level|sampling调用FPS|实际采样|比例|
|---|---:|---:|---|---:|
|1936×1088|4.2|60|1936×1088|1.000|
|3856×2176|4.2|60|1974×1114|0.512|
|3856×2176|5.1|60|2712×1530|0.703|
|3856×2176|5.1|50|2970×1676|0.770|
|3856×2176|5.2|50|3856×2176|1.000|

只把探测由4.2改为5.1仍不能保证4K50。5.1的FS36864可容纳4K单帧，但MBPS983040在50/60FPS限制了动态总像素；5.2的MBPS2073600才足够该示例50/60FPS。硬件/decoder实际支持必须验证，不能只改SDP、getter或stats。

另：quality仍有固定4K像素预算，所以更大显示区域/多窗总面积/DPR更高时，也不会绝对保留原DPR；这属于产品取舍，root决定。小视口中三个档都保留完整分辨率是正常行为，区别主要在目标码率/FPS；不能要求无意义地强制缩小某档来制造区别。

### 静态质量变更

- `EncoderWorker::Policy`（`endpoint/src/media/encoder_worker.cpp:121-123`）只更新策略并沿用cc_bitrate调用Rates。
- `service.cpp:1313-1331`没有设置`refresh_connected`，也没有通知MediaLoop对当前静态帧重新提交。
- MediaLoop仅在新帧、尚未启动、refresh或单次idle尾IDR到期时submit（`service.cpp:1150-1197`）；已有尾IDR完成的静态页面不会因码率变化再编码。
- QSV普通码率Reset明确`StartNewSequence=OFF`（`qsv_encoder.cpp:518-557`），这是已有性能行为，不能改成每次BWE都IDR。
- 建议显式用户quality动作携带一次refresh意图（或独立已有控制路径上的刷新请求），media线程安全地在Rates应用后重新提交当前内容并请求一次IDR；普通网络码率更新不触发。若DPR/atlas已经变化，现有reconfigure会请求关键帧，避免重复。

## 连接链与确定延迟屏障

1. `control/client/main.tsx:382-391`：App先等`/api/auth/me`再mount Workspace，随后开WS。这一HTTP往返可量测但无需先改鉴权语义。
2. `http.ts:69-84`：完成cookie校验/WS upgrade后，`attachViewer`的ready promise阻挡所有该WS RPC。`control.ts:191-198`先closeMedia，再reconcileProduct，最后返回state。Workspace收到首state才启动media.connect；cold Browser启动/重建因此在RTC能力探测、offer之前。
3. `control.ts:370-447`：reconcile依次applySites/applyMedia/session.ensure/snapshot/页面ensure或configure。无viewport时默认1440×900并隐藏；首state渲染后100ms发真实viewport，可能与offer排队争用同tenant serial。offer在`control.ts:152`再次完整reconcile，之后又由viewport reconcile；这些开销可能主要是毫秒，也可能遇到Browser RPC/恢复，尚待测。
4. `transport.ts:230-251`：先await VideoDecoder探测，再createOffer、setLocalDescription，然后等待**完整**ICE gathering（最多12秒）才发offer。没有onicecandidate生产发送路径，尽管协议已有rtc.ice入口。
5. `endpoint/src/service.cpp:1230-1264`：创建peer、setRemoteOffer，**等待完整answer gathering最多20秒**才回answer。SDK已分别发ANSWER、ICE、ICE_COMPLETE事件（`browser/sdk/remotekit_rtc.cc:386-399,543-566`），但service对外只采用最终complete SDP。
6. **全服务阻塞**：`service.cpp:1490-1515`主循环同步`Session::Command`，Offer的gather wait期间其他tenant的viewport/snapshot/rtc.offer亦不能处理，恢复维护`MaintainRecovery`也等至1517以后。不能仅在TS层放开tenant serial来解决。
7. `ControlConnection.request`、`EndpointProcess.request`均20秒超时，与Endpoint gathering20秒相等，未给排队/Browser RPC/序列化留余量。超时被transport笼统视为level4.2失败，下一次直接回native（`transport.ts:264-266`），可能把网络/启动慢误当codec不支持并降低画面分辨率。
8. answer setRemote之后还需ICE connected→DTLS/datachannel→Endpoint OpenOutput→共享atlas首帧/编码→DC layout+frame metadata与decoded RTP匹配→canvas提交。`service.cpp:1047-1072`只在真实connected时开输出；`transport.ts:535-549`与`frame-epoch.ts`保证新布局/帧身份门禁，不能为提速取消。
9. Control 1500ms tick（`control/server/main.ts:23`）负责后续状态对账，memory-saver discard恢复完成到重新visible可能落在下一tick（`control.ts:425-432`；现有test亦明确view.pending解除后tick才能visible）。不是每次连接固定增加1.5秒，需分cold/warm/discard场景量测。
10. Browser冷启动control IPC连接用50ms轮询（`service.cpp:349-357`），最大量化等待约50ms；这不是目前足以解释“很慢”的主根因。

## 建议的最小可评估改动范围（root定接口/优先级）

### A. 先让真实限制可见并改进能力选择

- 能力探测输入应覆盖本次所需atlas尺寸和目标FPS，优先可信高level，失败逐级回退4.2/native；保留Chrome89已验证兼容路径，不把WebCodecs API存在当成所有Chrome89支持。
- 接收level→编码level→FS/MBPS采样必须一致；提升到5.2需同时更改SDK声明/getter硬51及相关测试，确认QSV/接收端真能工作。若只验证5.1，明确其分辨率与FPS边界，不宣称4K满分辨率。
- Fit函数应使用安全的实际发送FPS上限（产品policy与启动编码上限一致的单一采样参数）；不能拿瞬时低FPS放大然后动态内容超level。改变采样参数时layout与实际submit必须原子一致并更新epoch，静态保留latest帧也必须使用当前epoch/新尺寸。
- 提供结构化分辨率归因：requested client DPR、product area factor、adaptive factor、resource factor、source atlas、negotiated receive level、sampling FPS budget、level FS/MBPS cap、max encoder axis、encoded atlas、decoded实际尺寸、各plane canvas及CSS×viewer DPR。只作为诊断数据/现有stats，不加新设置或实验面板。

### B. 连接先计时，再改gather策略

- 推荐真正trickle或异步pending-offer结果，利用SDK现有ANSWER/ICE事件，把gather从Endpoint主循环移开；early answer与后续candidates需要经Control鉴权绑定connectionId/租约。此项牵涉生命周期/跨租户边界，由root定契约。
- 不建议随意100ms截断candidate收集：多网卡/VPN/IPv6等可能丢失唯一可达候选。若阶段性只并行gather，应保留候选完整传递以及关闭/超时清理。
- 只对明确SDP/codec协商错误降级；网络gather timeout、Control断线、Endpoint忙或启动失败不应永久缓存native。
- attach先让UI有产品state、Browser/RTC准备重叠可节省冷启动串行时间，但必须防旧租约media关闭/初始可见性竞态。先量测，避免在没有必要时拆生命周期。

### C. 有界逐阶段计时接口

建议一个attemptId（仅诊断关联，不替代租约/权限）贯穿Viewer→Control→Endpoint，失败也保留最多最近几次（有界内存）。各进程只使用自己的monotonic elapsed；跨进程只能关联，未校准不能直接相减。

Viewer记录：auth.me start/end，WS construct/open/首state，first measured viewport sent/ack，receive probe start/end，offer start/end，setLocal start/end，firstCandidate/gatherComplete，offer RPC send/answer receive，setRemote end，ice connected/connection connected，track/datachannel open，首layout/首frame metadata，首decoded frame，首authorized，首plane canvas paint（按view）。

Control记录：WS upgrade→attach排队开始/执行开始，closeMedia，attach reconcile、ensure/snapshot/configure分段，offer排队/执行/Endpoint RPC返回。Endpoint记录：peer create、setRemote、answer-ready、firstCandidate/gatherComplete、connected、output open、first source frame、first submitted/encoded。输出耗时与状态，不记录凭据、cookie或完整敏感URL/SDP到发布包。

连接完成指标应区分产品state ready、媒体connected、输入datachannel ready、实际首canvas。首canvas是用户可见画面终点；connectionState connected不等同可用画面。

## 建议验证（未执行）

- 模型/CPU：4.2/5.1/5.2的FS+MBPS采样、policy FPS变更与epoch；明确codec错误才降级；纯静态quality切换恰有一次刷新；旧lease/attempt不接收ICE或answer。
- 功能：warm reload、cold Browser、discard恢复，各收分段timings；Chrome89与157实际decoded/canvas/CSS尺寸，高DPR与两Window。不要用stats文字代替decoded帧尺寸或真实细节采样。
- 不追加已取消的性能矩阵/重复基线。高分辨率吞吐/硬件支持只做与最终改动必要的有界功能验证。
