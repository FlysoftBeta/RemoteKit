# UD710 本地发送积压对照

## 运行条件

使用隔离的生产 Viewer、Control、Endpoint 和远端 Chromium。Viewer 为无头 Chromium 157，viewport 1920×888、DPR 1；网页内容区为 1920×800，实际 H.264 atlas 为 1936×816。UHD630 驱动 30.0.100.9805，Endpoint 显式使用 QSV、60 FPS 上限、48 Mbps 最大编码码率。生产默认质量档为自动（WebRTC BALANCED），双声道开启。实体诊断的质量档为 MAINTAIN_FRAMERATE，双声道播放关闭。桌面 Chromium 的浏览器、解码、合成和音频链无法覆盖 Android Brave 138。

使用 Control 内置 loopback UDP relay，单向基础延迟 5 ms、下行 24 Mbps、上行 1000 Mbps，队列上限 300000 字节或 100 ms。基础延迟是配置值，端到端实测选中候选对 RTT 另记。独立 HTML 按每段 1700 ms 的减速曲线自动滚动高对比度卡片，由同机长轮询命令触发，顺序为静止 30 秒、滚动 22 秒、静止 5 秒、滚动 13 秒。由网页驱动相同视觉刺激，无实际触摸事件。正式 Viewer 从设置开始诊断，浮动按钮停止，校验 tar.zst 及同一 H.264 peer、接收 track 和两个 DataChannel。

额外记录 video frame callback 的累积提交帧数和接收时间。每 4 次回调读取视频左上角 224×32 像素区域，解析远端页写入的同机 Date.now() 低 32 位，去重后与提交时刻求差。Marker 终点为 compositor 提交，包含页面出图及传输/接收链，不是触摸到屏幕 scanout。首个新 marker 的等待受读回抽样影响。发送排队从同一 Endpoint 出站 RTP 的相邻样本差分求包加权均值，Endpoint 窗约 2 秒，按其中点归入阶段，跨相位窗有混入。客户端 RTT 和缓冲是独立样本窗。静态期间先完成初始画面及尾 IDR，30 秒稳定静止窗无视频提交。

## 基线

端到端 H.264 和归档成功。Endpoint 来自 `build/endpoint-package/endpoint/endpoint_service.exe`，SHA256 `6897C5B82EAFDE3410BC6FFE0F71BE5CB552F318E0F0E1EF34543905E753465F`。进程模块核对实际加载 `C:/src/chromium/src/out/dev/remotekit_sdk.dll`，基线 SHA256 `12A961153C50A405C64EB2C7446A7504F7855A377780566CCDC78911FA5205EF`。远端 Browser 来自同目录的 `remotekit_browser.exe`，Viewer 为 `C:/src/chromium/src/out/rel/chrome.exe`。

| 指标 | 首段滚动 22 秒 | 第二段滚动 13 秒 |
| --- | ---: | ---: |
| 估算 compositor FPS，按完整阶段 | 44.56 | 45.11 |
| 选中候选对 RTT p50 / p95 | 14 / 57 ms | 16 / 39 ms |
| 实际视频缓冲，约 1 秒窗口均值 p95 | 22.4 ms | 29.3 ms |
| 视频末包到提交 p50 / p95 | 17.5 / 38.8 ms | 19.1 / 41.4 ms |
| Marker 到提交 p50 / p95 | 80 / 463 ms | 83 / 276 ms |
| 首个观察到的唤醒后新 marker | 301 ms | 194 ms |

静态候选对 RTT p50/p95 为 11/11 ms。首段滚动发送等待 72.0 ms/包，初次唤醒窗 269.9 ms/包，另有一个 261.2 ms/包窗口。约 2 秒窗口实际编码峰值 26.7 Mbps，GCC 两端约 22.6→14.5 Mbps。静止 30 秒期间 GCC 最后值保持 17.94 Mbps。第一次滚动结束后尾 IDR 提交与完成各 1 次。首次滚动中点归组窗口共 14 个关键帧。全运行 QSV stderr 记录 233 次 Reset，其中 17 次新序列，1 次正返回 status 5 且未开新序列。

基线在桌面复现了数百毫秒发送侧等待和明显 marker 尾延迟。实体设备诊断的秒级发送等待及数百毫秒的接收积压均未复现。原始归档、时序和分析在 `develop/tmp/ud710-lag-baseline/`，试验脚手架在 `develop/tmp/generate-ud710-run.mjs` 和 `develop/tmp/analyze-ud710-lag.mjs`。

## 可信码率控制声明对照

仅将 SDK 外部 H.264 编码器的 `has_trusted_rate_controller` 设为 false 后增量构建，复用同一 Browser、Endpoint、Control、Viewer、场景和端口。新 SDK SHA256 `15C3ACF396EAAA0376A2B4D620E5BE52B6EA0B9D2BDD48C2949045D32B06E1F8`。两个完整场景串行执行，均通过 H.264 首帧、相同连接身份和诊断归档；稳定静止窗均为 0 次视频回调，初次静止和首段停止都各提交并完成一次尾 IDR。没有触发布局切换。

| 指标 | 首段滚动，true → false | 第二段滚动，true → false |
| --- | ---: | ---: |
| 估算 compositor FPS，完整阶段 | 44.56 → 44.93 | 45.11 → 45.06 |
| 选中候选对 RTT p50 / p95 | 14 / 57 → 11 / 59 ms | 16 / 39 → 15 / 29 ms |
| 实际视频缓冲，约 1 秒窗口均值 p95 | 22.4 → 25.2 ms | 29.3 → 23.3 ms |
| 视频末包到提交 p95 | 38.8 → 37.7 ms | 41.4 → 37.9 ms |
| Marker 到提交 p95 | 463 → 425 ms | 276 → 241 ms |
| 首个观察到的唤醒后新 marker | 301 → 304 ms | 194 → 308 ms |
| 发送队列包加权均值 | 72.0 → 68.9 ms | 36.8 → 35.2 ms |

首段滚动的首个约 2 秒发送窗从 269.9 降到 119.3 ms/包，之后的最差窗从 269.9 升到 329.7 ms/包。编码峰从 26.7 降到 22.4 Mbps，但对应窗口的 GCC 两端由 22.6→14.5 Mbps 变为 14.7→13.2 Mbps，仍存在实际产出超出目标的情况。该对照中静止阶段目标均约 18 Mbps，远高于实体诊断初段的 0.5–0.6 Mbps。全运行 Reset 233→242 次，两组各 17 次新序列、1 次 OFF/status 5。结果显示启动窗口和部分 marker 分位数改善，同时最差发送窗更高，无法确认声明变更能稳定消除卡顿。

原始像素区域为编码视频左上角 x=0、y=0 的 224×32，布局在两组内固定。试验脚手架在阶段开始比较 Node 墙钟与 Viewer 的 `performance.timeOrigin + performance.now()`，两组粗略差分别为 1.2 和 1.3 ms，包含顺序跨进程调用耗时，不能作为全程同步误差上限。编码标记以整数毫秒记录，提交时间转换依赖同机时钟。正式工具会记录试验首尾 Viewer 同执行上下文的墙钟差。

修后证据位于 `develop/tmp/ud710-lag-after/`。复用原诊断运行器的正式场景用法如下，Playwright 位置依本机安装替换。两次完整 A/B 使用正式化前同配置脚手架，正式分析器可直接重算其归档。

```powershell
$env:REMOTEKIT_QA_HEADLESS='1'
node tools/test-diagnostic-collection.mjs <playwright-module> C:/src/chromium/src/out/rel/chrome.exe build/endpoint-package/endpoint/endpoint_service.exe C:/src/chromium/src/out/dev/remotekit_browser.exe develop/tmp/ud710-lag-new 33981 tools/ud710-lag-scenario.mjs
node tools/analyze-ud710-lag.mjs develop/tmp/ud710-lag-new
```

局部 marker 使用 32 位时间，无 CRC；仅接受 0–10000 ms 的合理解码值。`drawImage(video)` 读到的是元素当时的图像，可能已经比对应的 rVFC 元数据更新。该指标是稀疏近似，不能与旧实验的带校验逐帧 marker 作等口径比较。

## CBR 单变量试验

保留 `has_trusted_rate_controller=false`，仅将 Endpoint 切换为现有 `--rate-control=cbr`。正式场景设置 `REMOTEKIT_QA_UD710_RATE_CONTROL=cbr`，结果位于 `develop/tmp/ud710-lag-cbr/`。H.264 首帧、同 RTC 身份和诊断归档通过，实际 atlas 仍为 1936×816。正式工具在 Viewer 中观测到首尾墙钟差均为 −0.300 ms。

| 指标 | 首段滚动，VBR → CBR | 第二段滚动，VBR → CBR |
| --- | ---: | ---: |
| 估算 compositor FPS，完整阶段 | 44.93 → 44.49 | 45.06 → 45.34 |
| 选中候选对 RTT p50 / p95 | 11 / 59 → 15 / 27 ms | 15 / 29 → 12 / 28 ms |
| 实际视频缓冲，约 1 秒窗口均值 p95 | 25.2 → 18.8 ms | 23.3 → 18.0 ms |
| 视频末包到提交 p95 | 37.7 → 38.1 ms | 37.9 → 39.1 ms |
| Marker 到提交 p95 | 425 → 211 ms | 241 → 177 ms |
| 首个观察到的唤醒后新 marker | 304 → 535 ms | 308 → 338 ms |
| 发送队列包加权均值 | 68.9 → 61.0 ms | 35.2 → 17.9 ms |
| 发送队列约 2 秒窗口均值峰值 | 329.7 → 492.8 ms | 79.7 → 29.4 ms |
| Endpoint 编码峰值，约 2 秒窗口 | 22.41 → 15.74 Mbps | 20.60 → 21.15 Mbps |
| 关键帧数，窗口中点归组 | 13 → 16 | 10 → 8 |

QSV 初始化读回确认 1936×816 的 RC=1（CBR）为 Target/MaxKbps 2000/2000，VBR RC=2 为 2000/48000。首滚动期 CBR 实际读回 Target 和 Max 均在 11893–15401 Kbps，VBR Target 为 11881–19819 Kbps、Max 恒为 48000 Kbps。第二滚动期 CBR Target/Max 为 13161–21821 Kbps，VBR Target 为 12268–22526 Kbps、Max 恒为 48000 Kbps。

CBR 最差窗位于第一次唤醒，窗内 6 个关键帧，VBR 首次唤醒窗有 3 个。CBR stderr 记录首个 SetRates 起约 0.52 秒内连续 60→64→61→60→58→59 FPS，6 次 `newSequence=ON`。其中 61 FPS 的 165833 bps 请求由驱动应用为 1651000 bps，返回 status 5。VBR 首醒起约 0.52 秒仅 60→59 FPS 两次新序列，第 3 次 58 FPS 新序列在约 2.35 秒。说明速率反馈中的整数 FPS 波动确实触发了硬件新序列，并与首醒窗 IDR 增多同时出现。各组反馈轨迹不同，无法从此归因 CBR 必然触发更多新序列。全组 Reset 242→233 次，新序列 17→21 次，两个静止阶段和两个动态阶段中点归组关键帧为 0 / 16 / 6 / 8，VBR 为 0 / 13 / 5 / 10。两组都观察到 3 次尾 IDR 提交和完成。

CBR 压低了持续滚动期的编码突发与部分发送等待，但第一次唤醒的发送等待和 marker 出现时间反而更长。这次没有找到可单独解决启动积压的码控模式。

三组归档的帧元数据按 RTP 时间戳及 layout epoch 去重，按 Viewer DataChannel 到达时间划分。首滚动 22 秒内，可信 VBR / 非可信 VBR / 非可信 CBR 分别观察到 14 / 13 / 16 个关键帧，合计 4.88 / 4.18 / 5.15 MB。首两秒内分别为 3 / 3 / 6 个，合计 1.35 / 1.16 / 2.30 MB。首段计数和原生窗口一致；第二段与 5 秒静止窗在原生 2 秒窗口边界有混入。帧字节来自元数据，表示编码产出，包含未必已发出或已提交的帧。

## 固定 QSV 名义时基候选

保留 VBR 与 `has_trusted_rate_controller=false`。候选 Endpoint 在 Configure 确定合法名义 FPS，SetRates 继续更新目标码率，但 WebRTC 的瞬时输入 FPS 不再触发 QSV/VPP 改时基、新序列和额外 IDR。候选 Endpoint SHA256 `5B2E3C718F2BBBD0E40BE3767B523AEF4F44815FE07A84681063881A08D9CA66`。

两次初始运行在测试场景提交导航后仍停留于 Viewer 的本地新标签，两个 DataChannel 随后打开，但远端 fixture 未访问，日志只含 1280×720 硬件探测，没有真实媒体 Configure。场景入口增加新窗口先等 RTC/DC 就绪和导航后确认 fixture 已被访问。后续候选和两次低 FPS 组均通过 H.264 首帧、连接身份和诊断归档。该等待避开了测试启动竞态，不能用于判断产品竞态根因或 SetRates 回归。两次失败原始证据位于 `develop/tmp/ud710-lag-stable-cadence/` 和 `develop/tmp/ud710-lag-stable-cadence-retry/`。

| 指标 | 首段滚动，旧时基 → 固定时基 | 第二段滚动，旧时基 → 固定时基 |
| --- | ---: | ---: |
| 估算 compositor FPS，完整阶段 | 44.93 → 43.04 | 45.06 → 44.42 |
| 选中候选对 RTT p95 | 59 → 29 ms | 29 → 20 ms |
| 实际视频缓冲，约 1 秒窗口均值 p95 | 25.2 → 162.5 ms | 23.3 → 57.2 ms |
| 视频末包到提交 p95 | 37.7 → 198.8 ms | 37.9 → 64.4 ms |
| Marker 到提交 p95 | 425 → 272 ms | 241 → 196 ms |
| 首个观察到的唤醒后新 marker | 304 → 376 ms | 308 → 190 ms |
| 发送队列包加权均值 | 68.9 → 27.2 ms | 35.2 → 19.1 ms |
| 发送队列约 2 秒窗口均值峰值 | 329.7 → 56.9 ms | 79.7 → 42.8 ms |
| 元数据关键帧个数 / 字节 | 13 / 4.18 → 13 / 3.87 MB | 14 / 3.84 → 6 / 1.95 MB |

初次唤醒的发送窗由 119.3 降为 44.3 ms/包，首两秒同为 3 个关键帧、字节从 1.16 降为 0.54 MB。第二次唤醒的首两秒由 8 个、1.93 MB 降到 1 个、0.26 MB。全组 Reset 242→226 次，新序列 17→0，尾 IDR 均为 3 次提交、3 次完成。候选证据位于 `develop/tmp/ud710-lag-stable-cadence-navready/`。

候选首滚动 +5.1 至 +6.1 秒窗口内，视频出现一次冻结。同 RTP 的 DataChannel 元数据到视频末包 p50/p95 为 159.5/256.3 ms，末包到提交 p50 仍为 14.9 ms。同期 Opus 增加一次 concealment、1080 样本。随后三个客户端窗口，元数据到末包 p50 约 0 ms，末包到提交 p95 升至 201/228/236 ms，视频实际缓冲约 162/194/163 ms，目标/最小约 50/64/71 ms，解码均值 0.8/0.7/1.6 ms。音频实际缓冲约 115/114/113 ms，目标/最小均 100 ms，无新增 concealment；Endpoint 音频 gap restart 与补静音计数在首段均无增量。旧时基对照 +7.1 秒窗口的元数据到末包 p50 约 494 ms、末包到提交 p95 仅 30.2 ms；音频之后也达约 115 ms，但视频实际缓冲约 10–17 ms。音频缓冲与候选视频积压在时间上重叠，旧组反例和候选冻结后变化均表明需独立验证同步贡献。元数据是不同通道的到达时刻，不可据其推算单向网络耗时。复算窗口脚本位于 `develop/tmp/ud710-receiver-windows.mjs`。

### 低更新率与停稳图像

使用同一 SDK、VBR、relay 和 60 FPS 协商上限，串行运行原 Endpoint 与候选 Endpoint。独立图案以 2 Hz 和 15 Hz 各变化 10 秒，每段停稳后抓最终解码 ROI，并以同源时间 marker 验证。两组各实际产生 20 与 150 次源更新，最终 marker 四次均匹配。按归档实际 atlas 平面 x=4/y=4、单位缩放离线对齐同位置的重叠 ROI 636×316，复算 RGB 误差；现场最初生成的 JSON 未扣平面偏移，不用于下表。后续工具从最新布局读取平面偏移，仍需单平面、无缩放。

| 指标 | 2 Hz 旧 → 固定 60 | 15 Hz 旧 → 固定 60 |
| --- | ---: | ---: |
| 估算 compositor FPS | 1.40 → 2.20 | 14.80 → 14.99 |
| 约 2 秒编码窗口中位 | 2.88 → 0.30 Mbps | 9.17 → 4.51 Mbps |
| 按总编码字节与帧数估算每帧 | 246.0 → 27.9 kB | 81.7 → 43.0 kB |
| 发送队列包加权均值 | 67.0 → 2.1 ms | 22.8 → 11.4 ms |
| 停稳 RGB MAE / RMSE | 2.33/4.41 → 5.14/7.54 | 2.02/3.90 → 2.42/4.29 |
| 停稳 RGB 绝对误差 p95 | 10 → 16 | 7 → 8 |

2 Hz 对齐 PNG 视觉可见固定 60 候选的细线和小字边缘变软，文字仍可读。2 Hz 的目标读回中位约 18.2/18.3 Mbps，但新组实际产出显著更低，固定时基存在低更新率码控与图像质量代价。15 Hz 产出也降低，停稳误差变化较小。新序列 13→0，整个运行中尾 IDR 提交/完成 6/4→5/5，停止后的参考帧在两组都可核验。原始证据和对齐 PNG 位于 `develop/tmp/ud710-low-fps-before/` 与 `develop/tmp/ud710-low-fps-after/`。复现时将上文的场景参数换为 `tools/ud710-low-fps-scenario.mjs`，原/新 Endpoint 分别使用独立输出目录。

### 固定时基加 BRC-only 空档提示

新 Endpoint 在 1936×816 实际媒体配置的 QSV H.264 Query 和 GetVideoParam 均读回 `requested=3 actual=3 status=0`，为 `MFX_SKIPFRAME_BRC_ONLY`。实际 QSV 仍为 VBR、60 FPS 名义时基、48 Mbps 最大码率。使用更新 Control bundle `index-BzbBxo26.js` 和同一 SDK，复用同一低 FPS 场景。两段各 20/150 次源更新，最终同源 marker 均匹配，质量比较采用同位置的 636×316 ROI。

| 指标 | 2 Hz 原时基 / 固定 60 / 加 BRC-only | 15 Hz 原时基 / 固定 60 / 加 BRC-only |
| --- | ---: | ---: |
| 估算 compositor FPS | 1.40 / 2.20 / 2.20 | 14.80 / 14.99 / 15.00 |
| 约 2 秒编码窗口中位 | 2.88 / 0.30 / 0.38 Mbps | 9.17 / 4.51 / 4.61 Mbps |
| 估算每帧编码字节 | 246.0 / 27.9 / 31.1 kB | 81.7 / 43.0 / 41.3 kB |
| 停稳 RGB MAE / RMSE | 2.33/4.41 / 5.14/7.54 / 4.84/7.16 | 2.02/3.90 / 2.42/4.29 / 2.42/4.29 |
| 停稳 RGB 绝对误差 p95 | 10 / 16 / 16 | 7 / 8 / 8 |

新组 33 次 Reset、0 次新序列、1 次正 status 5，尾 IDR 5 次提交、5 次完成。BRC-only 驱动模式可用，低更新率的码率和停稳图像质量仍未恢复至原时基水平。按实验门槛未追加 70 秒滚动组。

证据在 `develop/tmp/ud710-low-fps-brc/`。Endpoint SHA256 `C8EF86CC42CCDE432C037546D4E1CD21A7F4CF468A1B0A1211D35875299CBFB7`，SDK `15C3ACF396EAAA0376A2B4D620E5BE52B6EA0B9D2BDD48C2949045D32B06E1F8`，Control bundle `0FD13B6D3E4A568550B9485C61430EBA9EF5574CFFF4AED7AABE86C8C55D4E97`。归档 ID `8a69a293-6461-4f01-a053-e56d91f807a0`，SHA256 `62AAE56F595205E64EB3460F45A635DF853123CFFF67C8D4203E993898DA8DD8`。

## 最终候选：对硬件时基变化去抖

固定时基与 BRC-only 候选因低 FPS 画质退化而撤回，相关生产字段、helper 和测试均不保留。最终保留 WebRTC 原生超发保护，并仅对 QSV 观测 FPS 去抖：小变化不重配，持续低估才降低时基，恢复时一次回到 Configure 上限。到期重放由 EncoderWorker 既有循环在编码排空后完成，即使 WebRTC 不重复相同速率也能收敛；暂停清窗。具体参数与边界见正式媒体反馈文档。没有改变 VBR、网络码率、源分辨率或 Comp 官方帧率限制。

同场景最终组 `develop/tmp/ud710-lag-cadence/` 使用 Endpoint SHA256 `EABABCFE52EAC4B0D15E003BE4D8FF808DF5D20DFC7CA6C1FA6D1108519D2E67`、SDK `15C3ACF396EAAA0376A2B4D620E5BE52B6EA0B9D2BDD48C2949045D32B06E1F8`、Control `index-BzbBxo26.js`。对照原始 trusted=true/VBR 基线：

| 指标 | 首段：原版 → 最终 | 第二段：原版 → 最终 |
| --- | ---: | ---: |
| compositor 提交 FPS | 44.56 → 44.79 | 45.11 → 43.38 |
| 发送队列包加权均值 | 72.0 → 39.2 ms | 36.8 → 19.9 ms |
| 发送队列窗口均值峰值 | 269.9 → 166.6 ms | 72.5 → 48.1 ms |
| 稀疏页面 marker→提交 p95 | 463 → 282 ms | 276 → 211 ms |
| 末包→提交 p95 | 38.8 → 79.9 ms | 41.4 → 62.4 ms |
| 选中候选对 RTT p50/p95 | 14/57 → 14/42 ms | 16/39 → 11/69 ms |

全组 QSV Reset 233→232，新序列17→4，尾 IDR 3次提交/3次完成。这个单次配对证明了本机场景中可测的发送侧改善，没有证明普遍达到100ms目标，接收等待仍有波动，第二段提交FPS也略低。尚未在 UD710/Brave138 及生产网络验证，未复现实体设备最初的1.3–1.8秒窗口。

低FPS去抖候选 `develop/tmp/ud710-low-fps-cadence/` 的2/15Hz最终源marker均匹配，RGB MAE分别2.56/2.01（原版2.33/2.02，固定时基5.14/2.42）；提交2.20/14.98FPS，编码窗口中位1.10/9.63Mbps，名义时基最终收敛2/15FPS。这是同源停稳图像的有限ROI比较，不是全场景画质验收。该组后仅补了低估窗内最高值仍高于末次观测时的下一次到期调度及CPU边界测试，最终二进制另经70秒滚动与89功能组验证。

### 定向检查与早期导航

SDK增量构建、导出及实际D3D纹理RTC smoke通过；Endpoint Release构建，QSV cadence/EncoderStats CPU检查2/2通过；实际QSV低FPS smoke按60→2→60切换只在必要时产生IDR，7个AU完成，无不合法level。Control Stats 5项和导航2项检查、生产构建与启动smoke通过。EncoderStats测试不等于worker/GPU运行。

新增标签尚在乐观占位ID时，WindowFrame可能因正式ID到达而被重建。两次失败库仅有window.create收据、无tab.navigate，截图地址已空且无警告；初始新建按钮本身要求RTC已就绪，所以先前单纯怀疑DC未打开不充分。最终在占位window/tab确认前禁用地址栏和起始页搜索，显示创建提示，不引入跨身份操作队列；SSR定向检查覆盖占位、确认、断线、空窗和文件标签。实际导航根因没有历史focus追踪，保留为与证据一致的竞态修复。

Chrome89.0.4389.90最终功能组 `develop/tmp/ud710-cadence-chrome89-functional/` 通过静态首帧、2/15Hz活动与停止、诊断归档和尺寸切换。resize后解码182→187，编码1936×816→1136×624；同peer、两条接收track和两个DataChannel保持。未使用旧全量性能矩阵。最初临时89 driver因新Playwright的checkVisibility不兼容失败，改用CDP输入后首帧通过，但带autofocus输入的旧fixture未满足严格单次idle断言；该失败不记为通过，后改用本次无交互fixture完成上述功能范围。
