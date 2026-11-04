# 文件验收期间 Chrome 157 解锁白屏

两次文件验收运行都完成授权换代并收到新布局，随后 QSV encoder 3 报 `MFX rate Reset (MFX -14)`，在发送该 encoder 的首个 SPS 前停止工作。Endpoint 的 worker 对速率更新失败会退出，后续补帧请求仍到达同一个 peer，但无法产生可发送的帧。89 最终组的 encoder 3 正常发送 SPS 并恢复画面，同一组稍后的 encoder 5 也记录了这个错误。问题由编码参数触发。文件传输、授权 epoch 和 Viewer 版本影响了复现条件，独立 QSV 调用可重现错误。

在 UHD630、legacy Media SDK 1.35、LowPower、VBR、H.264 level 5.2、1168×752 下，初始 60 FPS 编码器分配的 VBV 为 6000 KB。按 157 第 9 次的速率序列更新到 2 FPS 成功，随后以 38,171,667 bps 更新到 1 FPS 得到 `MFX_ERR_INCOMPATIBLE_VIDEO_PARAM`。使用同一速率重新 Query/Init 成功，驱动分配 9543 KB VBV。仓库使用的 oneVPL 头文件也将此 Reset 状态定义为需要额外分配，要求应用关闭并重新初始化该组件。[独立复现](../tmp/file-unlock-hw/baseline.log) · [原始 157 运行](../tmp/file-library-qa-157-9/control.stderr.log)

QSV 仅在这个 Reset 状态下重建编码组件。worker 已排空编码任务，QSV 确认 VPP 无待处理输出后，关闭当前 encode component，在同一个 oneVPL session 和 D3D11 device 上按原请求重新 Query/Init。检查几何、帧率、LowPower、色彩与协商 level，按需扩充 async VPP 输出池并请求新 IDR。真实失败继续报告。Peer、track、DataChannel、授权和布局门禁均走现有路径。

## 验证

- Endpoint Release 的 `endpoint_service` 和 `endpoint_encoder_smoke` 增量构建完成。新增 `endpoint_encoder_smoke.exe qsv 1 qsv-low-fps` 硬件回归。60→2→1→60 FPS 完成 5 个真实 access unit，检查各新序列的 IDR。1 FPS 路径确实得到 -14，随后同 session 分配 9543 KB，回升 60 FPS 成功。另以临时探针改走 async VPP，完成相同序列和断言。[构建](../tmp/file-unlock-hw/endpoint-test-build.log) · [外部转换](../tmp/file-unlock-hw/smoke.log) · [async VPP](../tmp/file-unlock-hw/vpp-smoke.log)
- Chrome 157 短组在静态页等待 9.5 秒，再锁定 1.8 秒并通过密码解锁。旧 Endpoint 在授权 epoch 3 收到布局 15 和 prepare，12 秒内无新画面，encoder 3 记录 -14。新 Endpoint 的 encoder 3 同样触发 -14，重新初始化后发送 SPS。解锁后 1.19 秒收到布局 15、授权 epoch 3 的关键帧并解除 no-frame，接收端解码帧及关键帧计数超过锁定期间读数。Peer 1、track 2/3 和 DataChannel 4/5 持续相同。[旧版探针](../tmp/file-unlock-viewer-baseline/file-library-results.jsonl) · [新版探针](../tmp/file-unlock-viewer-fixed/file-library-results.jsonl) · [新版编码日志](../tmp/file-unlock-viewer-fixed/control.stderr.log)
- 新版短组的最后一条断言错误地要求锁屏前后的 DOM video 与本地 MediaStream wrapper 对象相同。现有 RevealScreen 会卸载产品 UI，前后两个版本均观察到对象 ID 6/7→8/9，RTC 接收轨道身份保持。以上新版画面和解码断言在该条之前已通过。
