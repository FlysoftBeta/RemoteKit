# UD710后续实验准备：音频同步与单帧突发

状态：已完成首对及反序无像素读回复核，结果见[实际记录](ud710-av-results-20261104.md)。本地包仍是`d275b28`，其上传已按用户要求终止；本次新增音频统计和实验工具不混入该成品，也不沿用旧marker结果作为新探针验收。

## 第一组：真正移除音频流

媒体基线保留QSV时基去抖、VBR、WebRTC超发保护、BALANCED、60FPS上限、48Mbps编码能力上限。Viewer157、1920×888/DPR1；relay双向基础5ms、下行24Mbps、队列100ms。两组分别协商audio `recvonly`和`inactive`，均使用同一个RTCPeerConnection、H264和两条DataChannel。普通“不播放”只是播放设置，不能充当无音频条件。

一组保持原30秒静止→22秒滚动→5秒静止→13秒滚动，不加入真实触摸输入。顺序为audio-on、audio-off，首次仅一对，不自动重复/扩大矩阵。每组运行器有150秒总超时。准备命令不启动浏览器；执行命令才串行运行。计时期间不得同时上传、编译或运行其他GPU实验。

脚本从协商方向和归档验证分组：on必须同时有发送/接收音频RTP包及字节；off必须没有发送/接收音频RTP，且视频统计正常。SDK此前只导出video outbound，准备工作补入audio outbound，继续优先选择视频transport作为链路统计来源。这是诊断扩展，不改变音频、编码或拥塞策略；旧SDK不能用于新组的on验证。

## 新marker及拒绝规则

`tools/ud710-marker.mjs`提供两端相同的80bit格式：16bit魔数、32bit墙钟毫秒、16bit源序号、CRC16/CCITT-FALSE。224×80像素覆盖层比旧224×32大，所以新旧实验不是相同画面，不能直接把差值归因于本次分组。两组都使用新格式。

每4次rVFC冻结一个`VideoFrame(video)`快照，使用真实快照timestamp与rVFC mediaTime核对（误差≤1ms），再按已确认单平面、单位采样比例和atlas实际偏移读像素；不给快照强行赋回调时间。魔数/CRC、灰色不确定单元、布局、时间范围或帧时间不符一律拒绝，不回退到无校验读数。VideoFrame立即close。记录拒绝原因与读回耗时，至少100个有效样本且覆盖≥80%才允许该组以marker为依据。

这仍是稀疏的页面出图到compositor提交估计，不是触摸到物理scanout；CRC并不能消除本机墙钟变化、探针对负载的影响或所有浏览器时序误差。首尾记录Viewer墙钟差，分析时检查时钟稳定性、探针耗时和两组覆盖率。探针只面向本次157实验，Chrome89产品支持没有改变。

## 准备与执行

```powershell
node tools/ud710-av-experiment.mjs prepare <playwright-index.js> <viewer.exe> <endpoint.exe> <browser.exe> <新输出目录> 33991
# 上传/构建等活动结束后，才执行：
node tools/ud710-av-experiment.mjs run <新输出目录>/plan.json
```

prepare锁定Viewer、Endpoint、Browser、SDK、Control构建文件及实验脚本的SHA256。每组开始前重新核对，不覆盖旧输出；运行器使用独占实验锁并等待上一组完全退出。异常立即停止，不把下一组补跑成完整配对。输出包含原始tar.zst、逐帧探针、每组comparison.json及配对汇总。这里的锁只约束本运行器，不能自动排除其他人工启动的负载。

prepare时可设置`REMOTEKIT_QA_UD710_PROBE=metadata-only`及`REMOTEKIT_QA_UD710_ORDER=off,on`，将反序及不读像素条件锁入计划；默认checked和on,off。无读回组保持同一远端CRC图案，只关闭Viewer像素读回，不生成marker延迟结论。

判别时同时比较发送排队/编码量/源FPS/RTT和接收的组帧、处理、解码、音视频实际/目标/最低缓冲、末包到提交、冻结及marker分布。发送条件不相当不能归因为音频同步。若on/off差异明显且发送条件相当，再做针对性反序复核；一次固定顺序对照只作为筛查。无改善则转查视频接收/解码调度与呈现等待，不删除产品音频能力。

## 第二组候选：硬件单帧预算

已有独立Query/Init/GetVideoParam探针及实际六组合结果：60FPS保留150KB/100KB限制，2FPS清零，因此固定限制候选暂不进入产品。尚未进行实际AU与画质测量；API存在不代表该驱动在所有配置接受。后续采用与基线相同WebRTC码率目标，候选只改变硬件帧大小约束，保留现有时基策略。至少同时检查关键帧突发、编码耗时和2/15Hz停稳细字，避免用画质退化换出漂亮的延迟数字。

## 已做检查的范围

marker标准CRC向量、每个单bit损坏、灰色单元拒绝、音频条件与缺测拒绝、旧/新fixture脚本编译共4项CPU检查通过。Control服务端tar.zst保留音频计数且继续清理非诊断字段的2项测试通过。SDK已增量编译并导出；音频SDP/ABI/timeline和真实纹理RTC smoke通过。没有以这些检查替代真实音频A/B、VideoFrame时间关联或硬件单帧预算验收。

本机首对计划为`develop/tmp/ud710-av-prepared-v2/plan.json`，现已完成运行；SDK SHA256 `289e6e3a3ae774994d27599eec756f1fc4c08e0e81f33e94ac30ecd530186026`；Endpoint保持已测`eababcfe52eac4b0d15e003be4d8ff808df5d20dfc7ca6c1fa6d1108519d2e67`。首份plan因分析器增加冻结计数而过期，保留并由hash检查拒绝，不使用。旧最终组归档经扩展分析器重算成功，仅验证兼容性，没有重跑旧性能组。
