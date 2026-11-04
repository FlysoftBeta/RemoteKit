# QSV 随名义时基变化的 I/P 帧预算实验

2026-11-05。第二候选使用 VBR `I=5T`、`P=2T`，`T=TargetKbps*1000/(8*FPS)`；15Hz 停稳画质退化，候选已撤回。没有继续滚动 A/B，没有上传，没有引入产品开关。当前 `qsv_encoder.cpp` 已逐字节恢复实验前遥测版本，其余原生源码未由本实验修改。

## 候选范围

保持 LowDelayBRC UNKNOWN（本机读回 OFF=32）、既有 cadence/时间戳/level/HRD/fence/WebRTC 网络码率职责。根据当前参数中的名义有理数 FPS 与有效 TargetKbps（含 BRCParamMultiplier）计算预算；向上取整到字节。Query 前、Query 归一化后 Init 前、使用 next 参数 Reset 前均先清除旧驱动读回再计算。CBR 不请求显式限制。

计算用带溢出检查的 uint64，结果不能表示为 uint32 或时基无效则省略整对限制；oneVPL 要求有 P 时必须有 I。Query 与 Init/Reset 的 GetVideoParam 对请求非零值严格核对，变化即候选失败，不声称驱动已应用。参考本地 `build/dependencies/libvpl-2.17.0/api/vpl/mfxstructures.h` 的 MaxFrameSize 推荐区间与 I/P 字段约束。没有修改 QP、winBRC 或自建网络控制器。

## 构建与实际硬件

使用既有 `develop/tmp/ud710-cadence-build.cmd` 增量构建 service/smoke，cadence/stats CPU 测试 2/2 通过。UHD630、API1.35 硬件 `qsv 2 qsv-low-fps` 七 AU、60→2→60 与码率变化通过；`qsv 2 steps 1936 816 52 off 7 vbr` 及 cbr 各240 AU、退出0。

驱动保留请求的 I/P。例如 38.015Mbps/2FPS 为 11879688/4751875 字节，没有像旧固定150KB/100KB那样被清零；CBR实际 I/P 为0。支持读回不代表画质或时延已改善。

## 实际页面画质门槛

复用 [LowDelayBRC 实验](ud710-lowdelay-20261105.md) 的最终遥测基线 `develop/tmp/ud710-lowdelay/low-telemetry`，本轮仅运行新候选一组。Chromium157 无头 Viewer，1920×888/DPR1，atlas1936×816，24Mbps/基础RTT10ms，双声道接收开启，既有接收端默认参数。未采用同日已拒绝的10ms接收预算候选。

`tools/test-diagnostic-collection.mjs` 使用 `tools/ud710-low-fps-scenario.mjs`，2/15Hz各更新10秒、停稳4秒；ROI640×320、atlas偏移4/4。环境为 `REMOTEKIT_QA_HEADLESS=1`、`REMOTEKIT_QA_UD710_AUDIO=on`、`REMOTEKIT_QA_UD710_RATE_CONTROL=vbr`、`REMOTEKIT_QA_DIAGNOSTICS_RESTART=0`，端口33981。结果用 `tools/analyze-ud710-lag.mjs` 分析。

| 指标：遥测基线 → 帧预算候选 | 2Hz | 15Hz |
| --- | ---: | ---: |
| 停稳 RGB MAE | 2.470 → 2.505 | 2.009 → 3.461 |
| RGB RMSE | 4.494 → 4.524 | 3.880 → 5.412 |
| RGB绝对误差p95 | 10 → 10 | 7 → 11 |

两阶段20/150源帧、最终marker均匹配；同RTC peer/track/channel保持，真实诊断归档完成。候选全组45次Reset、8次新序列、1次正非零状态，尾IDR5次提交/5次完成。15Hz MAE增加约72%、RMSE增加约39%，不通过画质门槛。没有以低码率或少排队换取的结果声称优化成功；没有运行后续动态矩阵。

## 撤回与证据

临时目录 `develop/tmp/ud710-frame-budget/` 保存精确原源码 `qsv_encoder.telemetry.cpp`、原源码相对Git的 `telemetry-source.patch`、候选独立 `candidate-only.patch`、原/候选二进制、build/smoke日志、实际页面PNG及原始诊断/comparison.json。未提交这些二进制或运行数据。

| 产物 | SHA256 |
| --- | --- |
| 冻结遥测基线 endpoint-telemetry.exe | 1dd7dc0bc99686ef363d39fda7ab0f33cdfd3a1d9eef8a6ec9593173b2e2182f |
| 已撤回 endpoint-candidate.exe | 72fe8f293bd71b46067049822dd7ef5693318665b0c051240a71e4b4254085e5 |
| 恢复源码及原快照 | c16ba7ee11f480d2afe66c9ffa2514a3d68a8f9d67b42233aea3bac1c40d3af2 |
| 恢复后重新链接的 build/endpoint-package/endpoint/endpoint_service.exe | d3ab34eecd1c9665db4aec4f10ea628ded78f6586f28ae5fdc7e3768a9b0136b |

恢复时 Copy-Item 保留旧时间戳，第一次 Ninja 判定无工作；发现后更新源码mtime并真正增量重编译/链接，避免把仍为候选的二进制误当恢复完成。恢复后 CPU2/2、真实QSV七AU smoke退出0，实际读回 I/P=0、LowDelayBRC=32。没有重复运行已通过的遥测页面画质组。GPU时段已释放给root，后续产物可能继续由其他授权工作重建，表内hash仅对应本实验交接时点。
