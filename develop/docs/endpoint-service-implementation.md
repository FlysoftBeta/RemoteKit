# Endpoint 媒体服务实现交接

当前服务位于 `endpoint/src/service.cpp`，独立 CMake `endpoint_service` 目标；browser/SDK 由 Chromium GN 独立导出，运行时从 browser 目录加载 SDK DLL。stdout 仅 UTF-8 JSONL，日志走 stderr。未提交代码；本文件是实施记录，正式能力由主 Agent 整理。

## 已接线行为

- 每个产品 tenant UUID 映射为 Endpoint 持久化的非零数字 Session ID；browser 每 Session 独立进程、Profile、Mojo、atlas，通过 Job Object 回收。产品配置来自 Control，恢复 blob 与映射保存在 Endpoint data。
- 动态创建/配置/导航/关闭/导航命令，稳定 ID 重试；正常关闭区分 beforeunload 待答与实际完成，force 为 orphan 清理。snapshot 传实际 URL/title/loading/history 能力。
- 单租户一个当前 WebRTC peer；完整 ICE answer 通过 SDK ICE_COMPLETE 事件返回。只在读取 SDK 的有效 H.264 receive level 后启动源提交。
- 三槽 Fence atlas -> Endpoint 有界私有 BGRA 池；GPU copy 完成后才 signal consumed，并在本地完成 Fence 后交编码。归还 SDK lease 与 COM 引用分开计数。
- D3D11 VideoProcessor与编码SPS显式同一BT709 limited色彩；QSV actual参数核验，tools/h264_sps.py强验硬件输出；NVENC VUI源码与编译通过、无本机NVIDIA运行证明。
- D3D11 VideoProcessor GPU BGRA→NV12；QSV 通过真实 oneVPL legacy API1.35 异步 Submit/Poll；NVENC 动态硬件 API 接入、异步事件与 drain。没有 CPU 像素路径或软件编码 fallback。
- 硬件 async_depth 控制在途任务；等待队列只保留最新一帧，替换经 encoder_drop 返回 SDK。速率只在有变化时应用，QSV名义fps保持Configure目标，输入估计fps只统计；关闭NAL/VUI HRD并用StartNewSequence=OFF的bitrate-only Reset，普通BWE更新不制造IDR。显式key标志与原子请求无条件合并，避免短路遗留下一帧。
- 有效 H.264 MaxFS/MaxMBPS/尺寸上限决定 NV12 等比采样，原 viewport 与源 atlas 不因编码 level 缩小。layout 用编码像素、包含 mediaScale；stats 同时给源/编码尺寸。
- presentation epoch 包含几何/资源/可见集合/文档/实例变化；frame completion 使用 SDK 返回的 wire RTP timestamp 与原 job epoch，仅入 outbound 队列，由媒体线程发送。输入验证当前 epoch。
- 发送端每秒异步SDK GetStats，真实selected-pair与outbound字段放入senderRtcStats；帧metadata另有真实encodedBytes/keyframe供分布统计。
- focus回复成功与失败都关联focusRequestId及请求epoch，支持已聚焦且token不变的明确ACK。
- 输入独立有界保序 worker；mousemove 合并，其他关键输入不越序。媒体线程无同步 browser 输入 RPC。
- 静态首次、DC open、真正 connected、SDK refresh request 会合并重交最新 cache + IDR；150ms 尾 IDR 每次源更新只补一次。
- 最近修复空订阅：最后可见页隐藏后没有首个 GPU capture，不能同步等待 OpenOutput；现保留 RTC/DC 并发布空 layout 新 epoch，下一可见页重开资源。关闭 split 页面也会主动收缩输出 extent。

## 构建与已有真实证据

- Release 编译入口 `tools/build-endpoint.cmd package`；最新服务 `build/endpoint-package/endpoint/endpoint_service.exe`，SHA256 `cb3ba5487db9a88f7f8d6f8c8864893dbcfd66b6fdd7d56f32f86c16686a293f`。Chromium browser/demo/SDK 已由 media agent 统一编译；含orientation、导航UA继承、shared metadata v2 与 RTC ABI2，已同步构建导出。
- 最新 Release CMake model CTest1/1通过；独立service/native client/encoder smoke已完整编译。正式依赖获取由 `tools/fetch-media-deps.py` 固定 URL 与 SHA，缓存放 build，不依赖 develop。
- 真 UHD630/driver30.0.100.9805，oneVPL runtime API1.35 硬件路径。1928×1088 level4.2、depth4，多在途240帧，码率2→18→0.5→18Mbps回调阶跃、名义fps保持60，连续完成1547.12ms，正式证据 `develop/tmp/encoding-smoke/1793477118212748100`（两份真实SPS均BT709 limited且NAL/VCL HRD=false）；低0.5M实际2.166M，驱动实际值有日志。此为编码器吞吐 smoke，不是网络延迟结果。
- NVENC 编译通过，本机无 NVIDIA，真实运行明确 unavailable（证据 `develop/tmp/encoding-smoke/1793473571655364500`）；没有 NVIDIA 硬件通过结果。
- 管理1/4租户 smoke：`develop/tmp/service-smoke/1793468218811143700`、`1793468224218446700`。
- 导航恢复/owned browser kill smoke：`develop/tmp/service-smoke/1793470881014334000`；等待Chrome6秒持久化后 localStorage visits1→2，blob restore成功、稳定ID保留。不是同步存储刷盘承诺。
- 原生 tablet 信息 smoke：`develop/tmp/service-smoke/1793471800280094400`，Android tablet UA/CH、不带Mobile、Linux armv81、DPR≈2、viewport/screen820×1180、coarse/nohover/touch10。没有附加CDP或JS平台伪装。
- 真实 Chrome89 attempt5：`develop/tmp/first-stream/attempt5/report.json`，持续 H264、marker CRC、IME stim42、wire RTP/epoch匹配；持续流中 rtc.close 51.97ms。
- 最新 UI 集中组静态首次与动画通过，切 tab 时发现空订阅同步等待问题；证据 `develop/tmp/control-ui-run/failure.json`。空订阅修复后 Control已继续打通tab/split/nav/tablet解码；完整新版功能组由Control单独记录；focus ACK版已真实通过touch32769、重复focus IME81→82、rtc.close29.9ms、静态endpoint kill自动恢复。最后beforeunload已真实确认requestId→取消保留→再次确认删除；服务pending_close提取一直正常，Control已修closing+pending_close映射。

## 恢复与设备的具体边界

恢复 blob 在主文档导航提交时捕获，不持续保存 scroll/pushState；跨 browser sessionStorage 未接。POST 不自动重放，失败恢复走新 execution + 产品 GET URL。Chrome原生 storage 依赖其常规延迟刷盘。

窗口 navigator.platform 使用官方 per-WebView native settings hook，worker 的 platform 仍需额外 hook。Mixed-DPR 已按主 Agent 决策完成源码：共享 metadata v2 将 atlas_pixels_per_dip 与 page_device_scale_factor 分开，per-view page_dsf 独立，demo 未指定时继承原输出/native DPI；网络 mediaScale 乘 atlas/page 比值。browser/demo/SDK/endpoint 已统一重建，真实管理smoke验证同时可见desktop网页DPR1与tablet网页DPR2、原桌面页面切tablet后显式reload的UA/CH继承，及browser kill恢复；证据 `develop/tmp/service-smoke/1793473712646507500`。

曾验证仅OFF Reset会被driver以-15拒绝，证据1793476995451638300；按主Agent有界试验关闭HRD后Reset状态0/5/0且不重init，低码率正warning的actual值照常记录。

设备丢失全链路自动重建尚未完成；正常输出资源换代已接，手动重连时会丢弃已移除的消费 device。服务不是音频实现。

## 打包

`tools/package-runtime.py --kind streaming` 已接生产 Control bundle/minimal native依赖与同ABI Node、Release runtime/libvpl/license；旧 demo 用显式 browser_demo/native target 保留。此前生成的 `RemoteKit-win-x64-streaming-qsv-nvenc-20261101-015343.zip` 是中间包，不可当最终交付；待矩阵选定默认参数后重新生成；--smoke调用正式tools/test-streaming-package.py，在压缩前验证独立Node/SQLite/UI静态资源与真实browser管理链，验收范围不包含RTC媒体。性能采样窗口内禁止构建/压缩争用CPU。
