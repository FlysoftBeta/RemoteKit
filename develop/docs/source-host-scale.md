# Source host scale 与无框客户区验证

**source无框修复消除了真实客户区尺寸差额，desktop/tablet完整边缘与右下输入通过；host scale=1没有改善最终吞吐，默认仍auto。** 三个性能变量没有混用：DComp保持auto，OffscreenRoot关闭，接收端Chrome89不加新flag。

## 实现与几何根因

Endpoint新增 `--browser-host-scale=auto|1`，默认auto，其他值立即报错退出1；1仅给Session source browser追加标准 `--force-device-scale-factor=1`。prepare对应 `-BrowserHostScale`记录配置与实际参数，service日志记录完整启动命令。它规范的是宿主root scale，不改变Control网页viewport/DPR。

首个host1诊断发现root全区1906×1032，dirty1902×1028，而网页renderer确实提交1920×1080。根因是source没有parent-window，创建时仍TYPE_WINDOW；初始bounds补过边框，但ConfigureOutput之后把atlas尺寸直接传Widget::SetSize作为outer size，客户区扣除了frame。native demo与source的需求被混在了一条窗口创建路径。

修复在 `browser/harness.cc`：`frame_less = embedded || !state_->demo`，使source从创建时选择TYPE_WINDOW_FRAMELESS、remove_standard_frame与size-controls一致，source初始bounds直接使用width/height。原生demo的窗口类型、初始边框补偿与嵌入选择保持原样。没有隐藏Compositor或改变输入token/epoch规则。

## 完整几何验收

`host1-frameless-edges-v2/v3`使用当前修复browser，source host1，真实Chrome89/H264/QSV。临时fixture在右上/左下/右下绘制红/绿/蓝方块，左上仍为CRC marker；在页面右下48 DIP内的真实pointer/touch事件才把marker变为65400、右下变青。所有颜色从当前同RTP plane source读出，允许H264压缩误差。

| 检查 | Desktop | Tablet |
|---|---|---|
| Control网页viewport / DPR | 1920×1080 / 1 | 820×1180 / 2 |
| 实际LastRenderFrameMetadata提交尺寸 / DSF | 1920×1080 / 1 | 1640×2360 / 2 |
| requestedRendererDevicePixels | 1920×1080 | 1640×2360 |
| compositorViewportPixels | 1920×1080 | 1640×2360 |
| hostDisplayDeviceScaleFactor | 1 | 1 |
| 真实输入 | mouse(1904,1064) | touch(803.936,1164.167) |
| 右下输入marker / 像素 | 65400 / 青色 | 65400 / 青色 |
| 后续IME / reload | 92 / 重置0 | 92 / 重置0 |

这些提交尺寸来自已有 `session.snapshot → views[].compositor.lastSubmittedFrame`，即browser已收到的RenderFrameMetadata，不是JS DPR推断，也不是capture coded_size反推；没有开启额外逐帧元数据IPC。记录为 `submitted-geometry.json` 和原始endpoint responses。

v2官方trace中root全区为 **1928×1088**，页面damage为 **4,4 1920×1080**，吻合atlas padding，不再扣非客户区。tablet源提交1640×2360，协商接收level后视频平面为1220×1756、mediaScale≈0.744；它是媒体下采样，网页实际backing未缩小。

v3记录了点击时CSS框、canvas bitmap、object-fit和elementFromPoint：两次都命中目标CANVAS，无HUD/letterbox；object-fit=fill。desktop CSS框为x64/y348/1295.33×727.75，tablet当时为x64/y348/1295.33×746；坐标按各自实际框映射。source用实际事件clientX/Y更新document.title，Control快照记录了表中的坐标。inputTrace/results随metrics保留，原焦点/文档/epoch校验没有放宽。

最初临时工具的tablet右下验收失败，是未将portrait画布下边滚入viewport，以及fixture原touchstart在pointerdown之后覆盖了测试stimulus。desktop本来已通过。工具显式scrollIntoView并在原touchstart之后采集边缘事件后，v2/v3均通过；不据此修改产品坐标逻辑或放宽命中条件。

Sol检查desktop/tablet截图：三处彩色边缘和左上marker完整，静态reload后画面保留，无错误横幅。测试fixture的指纹保留修改前值，并记录实际边缘instrumentation后的hash；served HTML/hash亦保留。

`host1-frameless-mixed`复用了既有测试专用第二view设备适配器，验证同Session中desktop1920×1080@1与tablet1640×2360@2同时真实提交。tablet真实touch marker32769、IME composition提交91，desktop保持原marker，H264正常；截图经Sol检查。该adapter只改测试JSONL中的第二view配置，不用于任何性能组；Control产品设备配置仍是tenant级。

## 性能首对

之前 `hostscale-auto1080x4-a` / `hostscale1-1080x4-a` 发生在无框修复前，保留为几何调查证据，不用来决定默认。

有效新首对是修复后同一service/browser二进制的 `frameless-hostauto1080x4-a` → `frameless-host1-1080x4-a`。4×1920×1080/DPR1，d1/TU1/VBR、snapshot、cap/gate off，各peer24Mbps/双向5ms，profile关闭、marker1Hz，5秒暖机+20秒采样。DComp auto、OffscreenRoot关闭，默认client flags。以下为租户范围：

| 阶段 | host auto | host1 |
|---|---:|---:|
| Source renderer render/s | 20.3–20.6 | 24.9–25.6 |
| Browser capture callbacks/s | 20.0–21.6 | 24.9–27.6 |
| Atlas copies/s | 20.3–20.6 | 23.0–25.0 |
| Encode/s | 12.4–13.1 | 11.7–11.9 |
| Decode/s | 12.5–13.0 | 11.7–12.0 |
| 实际canvas绘制提交/s | 8.29–8.69 | 6.74–7.54 |
| 同RTP marker p95 ms | 989–1127 | 987–1027 |
| 整机CPU p50 / p95 | 54.1% / 64.6% | 70.5% / 89.3% |
| source GPU进程CPU核数mean | 1.620 | 2.025 |
| 物理3D engine busy mean | 99.21% | 99.14% |

host1源提交/捕获更快，但编码/解码/最终canvas更慢，仍没有端到端收益。没有把root减少像素直接称为性能达成；GPU仍近满负载，源加快后共享资源竞争可能改变，单组CPU波动也不能外推为恒定开销。

按首对停止条件，未继续反序或单720性能组。host scale默认auto，OffscreenRoot默认关闭，DComp默认auto；无框客户区修复作为正确性改动独立保留。

## 构建与证据

Endpoint Release增量编译通过，非法host-scale实测退出1；browser/browser_demo/SDK统一增量4steps通过并导出。新service SHA256为 `6b4302fc458ce8b6a3789f8f1479f83cf2f938b8b347006219d534d1ef2f3fde`；有效性能组browser为 `170bfe41cdd440e5840fa49067adf07beb549d04a910406d5511fda624fa5c40`，其余运行时指纹见各case。后续仅patch可复现重应用的重建不替换已有证据指纹。

原始metrics、source/browser/server traces、资源与分析JSON均在上述develop/tmp新目录。`frameless-hostscale-summary`为分层汇总；旧matrix工具未填paintFps时，本文直接使用原benchmark.displayFps。client与server分位算法不同，marker p95采用原client报告。最后不完整服务日志行只在派生分析时跳过，记录在 `frameless-hostscale-discarded-tails.json`，原文件未改。
