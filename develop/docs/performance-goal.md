# 性能阶段结果与后续工作

双租户同组45秒达到实际canvas **51.6926/51.7349FPS、Pixel marker p95 76/79ms**。用户随后明确停止额外稳定复验和单租户重复复验；当前工作进入产品功能及发布阶段，不再为重复确认结果追加跑分。

## 验收条件与证据

- Chrome89继续支持；用户允许修改版Chromium模拟刷新验收。最新组用Chromium157 headless、Intel UHD630硬件H264和GPU canvas、fake60；没有改用软件解码。
- 原1920×1080/DPR1、atlas/编码1936×1088、RTT10ms、每peer48Mbps；QSV TU7、LowPower ON、VBR、depth1、external VPP，目标36/max44Mbps；源固定52，自动预算关闭。
- CaptureToAtlas/shared BGRA、immutable VideoFrame/fifo2、Worker CRC。每路45有效CRC，成功paint2327/2329，无RTP+epoch重复或缺失paint快照。Marker终点是canvas提交，Worker完成时间另记。
- Headed配对48.9560/37.3554FPS、p95 90/108ms；headless 51.6926/51.7349FPS、p95 76/79ms；Intel3D 93.55%→64.33%。条件仅改变接收端headed/headless，完整指纹及原始产物见[报告](headless-receiver-runtime.md)。
- `headless-worker-fixed52-t2-stable120`已取消，没有最终report，不能列为通过。没有新增单租户组。

## 改进链条与历史

- 三租户全ON最快预设12.46–12.68FPS、p95 852–921ms，混跑无额外收益；按用户授权转两租户。[三租户](three-tenant-fast-mixed-runtime.md)
- 自适应源准入：两租户35.11/31.33FPS、p95 91/99ms。[源预算](source-budget-runtime.md)
- GPU细分确认child与root各一pass；root捕获合并重复合成。[计时](viz-gpu-timing.md)、[root捕获](root-capture-runtime.md)
- 不可变VideoFrame减少客户端整atlas快照，原输入就绪错误也已修复。[客户端](immutable-frame-runtime.md)
- shared BGRA旧对照40.20/40.51→46.86/48.26FPS，p95 128/126→83/94ms。[共享输入](shared-atlas-input.md)
- CaptureToAtlas同binary组46.92/46.99FPS、p95 85/89ms，源Browser复制归零。[直写](capture-to-atlas-runtime.md)
- FIFO减少rAF前覆盖，达到49.632/49.988FPS，但p95 94/103ms；此历史组未同时达标。[FIFO](client-fifo2-runtime.md)
- Worker CRC保留已绘制身份，将主线程截图p95降至约1ms；RDP额外显示负载经配对定位，最终headless组同时达标。[Worker](async-marker-runtime.md)、[环境](gpu-environment-audit.md)

## 生命周期与保留事项

正常导航、尺寸/DPR/多plane fallback、Chrome89、正常关闭、源GPU同RTC自动重建已验证。Endpoint等值历史GPU证明与独立generation退役修复通过GPU/Browser退出硬件回归；未知更高终点不放行。[退役](endpoint-retirement-runtime.md)

空内容/故障立即撤销旧ready、Control恢复与产品生命周期等问题随产品功能继续处理，见[任务](productization-next.md)、[契约](productization-contract.md)与[问题清单](open-issues.md)。多Profile、真实NVENC硬件和既有其它缺口仍按当前状态记录，不因性能阶段结束而宣称完成。

最终先完成产品功能和文档逻辑整理并上传第一版，再由Astra审查代码库、实施必要改进；有变动再构建上传。完成后才删除goal。
