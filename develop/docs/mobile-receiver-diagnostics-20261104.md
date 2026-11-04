# UD710 惯性滚动卡顿与诊断收集

## 现场与判断

用户设备为 UD710，Brave 138；截图发生于惯性滚动。现场显示 RTT 15 ms、接收码率 18.34 Mbps、发送端带宽估计 41.29 Mbps，解码和 video 元素收帧均为 45.2 FPS，video compositor 提交 29.1 FPS，rVFC 回调 19.1 FPS。接收缓冲窗口均值 303.2 ms，解码均值 12.5 ms，末包到提交 p95 335.5 ms，提交到回调 p95 20.7 ms，预计显示超期 p95 1.7 ms。

这些数值证明当前观测中接收等待较大、解码后还有丢帧，但不能单凭截图归因于网络或平板。低 RTT 不排除 RTP 到达抖动、丢包重传和帧组装等待；带宽估计也不保证每个帧及时完整到达。rVFC 回调次数并非所有 compositor 提交次数。不同分布的 p95 与均值不能直接相减或相加推导分段耗时。

本地 Chromium 157 源码核对：video 的 jitterBufferDelay 从帧首包起计到释放给解码器；totalAssemblyTime 记录成功解码的多包帧首末包间隔；totalDecodeTime 为解码工作，totalProcessingDelay 包含更早的处理等待。后者不能当纯解码耗时。源码解释不等于在 Brave 138 实测这些字段的支持和行为。

`jitterBufferTarget=0` 与 Endpoint 请求 RTP playout-delay min0/max50 ms 都不是实际缓冲或端到端延迟上限。RTP 扩展协商存在，不证明每个码流帧都携带扩展或接收端已实际采用。音频同步、帧完整性、参考帧及解码可用性仍可能带来等待。

## 新增采样口径

- 接收端：独立 video/audio 缓冲实际、目标和最小目标差分均值；组帧、处理和解码均值；包 jitter、带符号丢包变化、RTX 包/字节、NACK/PLI，以及可用的解码器实现与硬件效率标志。
- 发送端：使用 Endpoint 已有 senderRtcStats 中累计发送包、字节、重传、关键帧及 totalPacketSendDelay；只按 Endpoint 自身递增采样时钟计算窗口。重复缓存报告不生成新的速率。
- 重传包占比为同一窗口 `ΔretransmittedPackets / Δpackets`，分母包含重传包；字节占比同理。NACK 次数不是重传包数。未提供字段、零分母、计数回退不填成 0。
- 解码、元素收帧/丢帧、compositor 提交与 rVFC 保留不同口径。相关帧时戳仅在各自时钟域比较；没有有效时钟校准和源完成时戳时不报告伪造的 input-to-present 或单向网络耗时。

用户指定诊断交互为设置内开始、悬浮按钮停止、服务端保存 `.tar.zst` 并向客户端返回 ID；已实现该流程，移除 Stats 下载 JSON 的临时入口。每次最多十分钟/约32MiB，Client复用现有RTC采样，服务端独立请求本租户Endpoint/Browser状态；保留最近限量逐帧RTP/接收/提交/回调时戳和输入回执序号。具体存储、授权、字段及中断边界见[正式契约](../../docs/diagnostic-collection.md)。

## 验证

接收采样/授权换代、客户端停止与中断状态机、服务端隔离/重启读回/失败处理、实际Zstandard解压与USTAR校验等定向测试通过。Control生产构建、bundle验证和启动smoke通过，日志在 `develop/tmp/diagnostic-control-production-20261104.log`。

157/89真实H.264中经正常设置入口开始、悬浮停止，归档完成后显示ID；同一peer、track与DataChannel保持。两个归档均有真实入站、发送、编码、Browser输出及逐帧RTP对应记录；157另验证Control重启后同账户查询完成ID。使用桌面无头隔离浏览器与活跃小标记fixture，没有进行性能benchmark，也不替代UD710/Brave138。完整结果见[运行记录](mobile-diagnostic-runtime-20261104.md)。本轮仅构建本地Control产物，没有打包上传。

## 尚未解决

尚无该实体设备的连续诊断包，未排除网络，也未证明解码器或 compositor 是唯一根因。本批诊断设施不等于卡顿优化完成；不据此改变质量三档、GCC 或增加自主降 DPR/码率控制器。没有重跑既有双租户性能矩阵。
