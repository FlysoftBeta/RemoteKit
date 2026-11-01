# 自适应源帧预算：首个受控候选

主 Agent 决策，2026-11-01。目标是减少过载时的过时帧和排队，同时兑现显示/网络反馈闭环；降低预算不能作为达到50FPS目标的证明。先以 `--adaptive-fps=off|on` 显式开关接入，默认off。

## 边界

- 每Session一个控制器。只通过低频 `output.configure {render_fps}` 调整本地源pacer，不改共享ABI、不添加browser↔endpoint逐帧消息、不改Fence/lease，也不改变编码器名义fps或重开编码序列。
- 最大预算为用户指定browser_render_fps，未指定则encoding.fps；仍受有效接收显示反馈约束。最小预算为min(10,最大预算)。保持配置的分辨率与码率策略。
- 每500ms最多决策/发送一次，只发送变化值；连接/输出代次重建重置统计。调用失败保持旧有效预算、报告失败，不谎报已生效。
- 应用不依赖session.snapshot。仅on开启Session级控制worker，CV等待一个可覆盖latest请求；MediaLoop不等待RPC。Pause/Resume用独立control互斥和eligibility epoch使旧请求失效，worker校验epoch后才串行RPC。RPC期间不持policy锁；不在持control锁时join媒体线程；析构先停止该worker再关闭control资源。
- browser现有render_fps上限60。adaptive on的有效请求上限超过60时明确拒绝，要求指定受支持的browser_render_fps；off沿用现有行为。

## 输入与首版规则

使用真实新源活动（generation/capture_time身份，尾重复不计）、atlas交付、编码完成/替换计数、queueWait累计值和已校准captureToReadyMs。无新源样本时不因旧延迟值降速，也不因静态低FPS推断过载。最近2秒至少3个新源样本才做负载自适应。

接收反馈必须通过现有peer/epoch/generation校验且receipt age不超过5秒。可见且有效的displayHzEstimate取ceil后作为上限；未知/过期时退回请求上限。接收端RTP/plane计数不混加，显示反馈不是物理屏幕刷新率证明。

网络仅在新的反馈序号上判断：本连接有效RTT的最低观测作为基线；RTT同时高于基线+20ms和基线1.5倍、且同窗口packetsLost>0，才作为网络压力。不得单凭静态低码率或一个丢包降速。缺任一字段则不判网络压力。

网络压力独立按连续两份有效新seq反馈计数；两次反馈之间没有新seq不清零也不重复计，新的健康反馈才清零，反馈过期则失效。不能要求1500ms反馈在相邻500ms控制窗连续出现。

活动样本中，下列任一成立视为压力：captureToReady超过40ms；pendingReplaced占该窗源交付超过5%；存在替换且平均queueWait超过8ms；或上述网络压力。连续两个决策窗有压力时预算乘0.8向下取整；captureToReady超过100ms可当窗降低。无新源样本不累积压力次数。

连续三个有活动的健康窗、且距最近降速至少2秒后，每决策最多恢复2FPS，直到当前有效上限。健康要求captureToReady已知时低于25ms、queueWait低于5ms、无替换和新网络压力。恢复速度/阈值是首版实验选择，需依据1/4租户动态→静止→恢复实验调整，不称为最终最优算法。

## 验证和可观测性

Stats明确报告enabled、请求/显示上限、目标与实际应用render_fps、最后原因、控制调用错误及反馈年龄；不会把目标FPS当实测FPS。纯策略测试覆盖静态、计数重置、过期反馈、压力迟滞、恢复和边界。集成先验证changed-only配置与静止不刷RPC，再比较同负载off/on的延迟、掉帧、实际FPS和画质。GPU满载问题仍需减少复制/绘制开销，本控制器不能代替吞吐优化。
