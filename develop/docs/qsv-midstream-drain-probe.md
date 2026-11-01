# 中途NULL drain后继续输入的独立probe

2026-11-01，独占CPU构建后独占运行一组，已完成并释放窗口。本机legacy1.35接受第30帧同步完成后NULL drain到MORE_DATA，再不Close/Reset继续31–120：**120帧全部完成，恢复90帧全部成功，颜色/cookie/Locked检查通过。** 默认关闭选项为`--midstream-drain-at=30`，未改生产qsv_encoder。

## 本机结果

正式构建脚本`tools/build-qsv-vpp-probe.cmd`成功增量编译和链接，随后执行下文唯一noscale组。GPU组约3.610秒，产物写完于本地2026-11-01 16:34:09，进程PID21868已退出；未并行其他构建，也未扩展组数。编译有一项局部变量status遮蔽警告C4456，不影响本次链接或运行。

原始结果：[report.json](../tmp/qsv-midstream-drain-1/report.json)，汇总：[summary.json](../tmp/qsv-midstream-drain-1/summary.json)。Probe exe SHA256 `ffd170af931702507c7d0f6881c27f0d4c910b693b74b0298bb486f65834f9eb`；源码SHA256 `647e25d89ec19cfe5d7963f9c21d58bb65946c35b4601e5790b62feded86b8ea`。

| 检查 | 实测 |
|---|---|
| 环境/模式 | Intel UHD630，runtime API1.35，同session VPP→Encode，d1，无B帧，逐帧最终Encode Sync后NV12读回 |
| 输入/输出 | 实际texture1936×1088、Crop1928×1088；RGB4 BGRA→NV12无缩放；VPP/Encode Query和Init均0 |
| 第30帧后NULL | 仅一次调用，status=-10（MORE_DATA），无sync、DataOffset/Length=0、无输出packet，约0.0103ms |
| drain时Locked | 输入/输出总剩余0 |
| 继续输入 | 未Close/Reset；首个恢复Encode返回0；31–120共90帧完成 |
| 所有最终Encode接受状态 | 120次均0；VPP busy=0，Encode busy=0 |
| 颜色/顺序 | 120/120验证成功，BT709 limited最大误差1，像素cookie及bitstream timestamp均与1–120一致 |
| 最终Locked | 每帧最终Sync后输入/输出均0 |
| 边缘 | 每帧有效右16列白色YUV=[235,128,128]，coded额外8列=[16,128,128]；这是编码前NV12读回 |

首帧最初8MiB bitstream调用返回NOT_ENOUGH_BUFFER(-5)，扩容16MiB后成功；实际GetVideoParam BufferSizeInKB=9375、BRCParamMultiplier=1，延续已有probe缓冲机制，并未出现到64MiB上限失败。

完整H264为34,826字节、120个AUD和120个slice NAL（1个IDR、119个非IDR）；before片段13,952字节/30个slice，after片段20,874字节/90个slice，两段字节拼接与完整文件完全相同。第31帧FrameType=66，为P参考帧，没有强制新IDR；after片段无独立SPS，不能当独立文件播放要求。现有环境PATH无ffmpeg/ffprobe，本轮没有下载安装；已核对NAL结构和编码timestamp，**尚未软件解码完整H264验证恢复边界的最终图像**。

本组没有非NULL Encode MORE_DATA、held输入、busy错位或B帧；中途NULL发生前所有30帧都已经最终Sync。因此结论是该runtime接受这个已清空边界后的恢复输入，不是实际混合pending/held或任意NULL/nonNULL交错的完整验证，也不将本组带CPU读回的耗时用于生产吞吐结论。

## 试验回答的问题

在本机legacy1.35、d1、无B帧的固定同session VPP→Encode链，前30帧全部最终Encode Sync及像素验证完成后，调用Encode(NULL)直到MORE_DATA，再不Close/Reset地继续第31–120帧：runtime能否接受，实际颜色/cookie/Locked与输出H264是否连续？

本probe在drain前已经没有未完成输入，因此**不覆盖**实际Encode MORE_DATA持有旧输入、Encode busy、pending混合或B帧错位；即使成功也不将它推广为任意阶段NULL/nonNULL交错的合同保证。官方将NULL定义为结束编码序列，这是本次需要用实际目标runtime核查的边界。[官方接口定义](https://intel.github.io/libvpl/latest/API_ref/VPL_func_vid_encode.html)

## 实现边界

默认未传选项时，原noscale/full/scale三组行为保持；只有显式指定时启用。参数限制为一个chain case、开启原NV12验证、drain位置小于总帧数，不能与`--case=all`、`--stage=vpp`或`--verify=none`组合。

第30帧最终同步、cookie/色值/Locked验证完成后，最多64次/5秒调用NULL drain。逐调用记录status、sync存在、MaxLength/DataOffset/DataLength、timestamp；有packet则只Sync该Encode packet后记录实际timestamp/frameType及字节并保存。MORE_DATA且无sync才完成drain；任何不接受状态、超时、仍Locked都停止并记录，保留资源到组件/session Close。缓冲扩容上限继续64MiB，没有新状态机或B帧。

drain后不重配Encode/VPP、不修改帧号、不强制新IDR，按原流程处理31–120。每帧保存afterMidstreamDrain、最终FrameType/TimeStamp、颜色/8bit cookie、Locked，另记录firstResumedEncodeStatus与resumedFramesCompleted。结果success仍要求整120帧通过。

H264输出保留完整`noscale-qsv-vpp.h264`，额外保存`noscale-before-drain.h264`与`noscale-after-drain.h264`；NULL drain产生的packet归到before片段。after片段可能引用before中的帧和SPS/PPS，不能把“不能单独打开after文件”直接判为坏流；完整文件才是连续解码核查入口。默认probe依然只核验编码前NV12和编码timestamp，不冒称已完成H264软件解码。

## 已运行的一组命令

```powershell
tools/build-qsv-vpp-probe.cmd
build/qsv-vpp-probe/endpoint/endpoint_qsv_vpp_probe.exe --output=develop/tmp/qsv-midstream-drain-1/report.json --case=noscale --frames=120 --midstream-drain-at=30
```

复现时先独占CPU完成build并记录hash，再运行这一组；不与正式采样或其他GPU任务重叠，输出目录必须全新。本轮已按此顺序完成，完整H264软件解码仍待有工具的独立验证。
