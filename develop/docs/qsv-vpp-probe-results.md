# QSV异步VPP硬件probe结果

2026-11-01，UHD630 / 驱动30.0.100.9805 / legacy API1.35。独占硬件窗口内串行运行，组与组之间没有并行CPU构建；结束后probe、cl、ninja均已退出。主Agent给定最多三主要组，本轮未增加性能矩阵或修改生产媒体路径。

## 结果

**同session RGB4→NV12→Encode链验证成功，裁剪与缩放也通过。** 三主要组各120帧：VPP Query/Init/GetVideoParam和Encode Query/Init成功，直接将VPP输出surface原地址交Encode，未Sync中间VPP，只在最终Encode Sync后读取结果。每帧色值、连续cookie和Locked归还检查全部通过。

这证明本机可实现该MFX异步链；尚未证明替换正式converter会提高四租户端到端吞吐。本probe的source upload与逐帧验证读回均占用GPU，不能当生产FPS实验。

| 主要组 | 真实BGRA分配 / 有效crop | NV12分配 / 有效crop | 完成 | 最终Encode Sync p50/p95 ms | 最大709limited色值误差 |
|---|---|---|---:|---:|---:|
| noscale | 1936×1088 / 1928×1088 | 1936×1088 / 1928×1088 | 120/120 | 8.986 / 9.685 | 1 |
| full | 1936×1088 / 1936×1088 | 1936×1088 / 1936×1088 | 120/120 | 8.954 / 9.607 | 1 |
| scale | 1936×1088 / 1928×1088 | 1280×720 / 1280×720 | 120/120 | 6.509 / 7.014 | 1 |

三组cookie错配均0，最终Sync后input/output Locked残留均0，VPP/Encode busy均0；VPP drain和Encode drain都为MORE_DATA，没有多余输出。scale是完整输入crop到1280×720的独立能力测试；没有把它说成已验证正式等比fit、letterbox或混合DPR场景。

VPP接受输入后，input和output Locked均为1；Encode最终同步完成后均归零。该运行证据与官方同surface依赖规则一致，不依赖“同device外部写入应该安全”的假设。[官方异步管线规则](https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_transcoding.html)

当前header/legacy文档对RGB4缩放的保守限制不能代替本机结果：本机这组RGB4→NV12同时缩放，Query/Init返回0且像素marker正确。正式接入仍要保留能力Query及尺寸/crop检查，不能推广为全部硬件必支持。

## 颜色、白边与coded padding

输入是黑/白/R/G/B/灰/黄的竖条，右16有效列和顶部16行固定白色，source额外8列填品红以检测crop外像素混入。底部是每帧变化的8bit黑白cookie；120帧均与bitstream timestamp、回读marker匹配。

三组黑/白Y分别16/235，灰及各色转换符合BT709 limited，所有采样分量最大误差1。noscale的最后16个有效列NV12均为`[235,128,128]`；1936分配中超出1928crop的8列为`[16,128,128]`。本组没有额外预填NV12 padding，这个黑色是本次MFX VPP观察值；不能把它写成所有driver/配置的保证。full和scale有效右白边也通过。

此前正式串流两种browser路径都有右边偏绿，本probe在**编码前NV12**未复现该现象。H264文件已经保存，但本轮没有软件解码校验有损H264后的白边，因此还不能将正式绿边根因归给旧converter或宣布MFX路径修复了编码边缘。原始NV12、编码重建及Client解码三者仍要分别定位。

## 首轮失败和bitstream缓冲修正

首个v1 noscale组在第一帧Encode提交返回`MFX_ERR_NOT_ENOUGH_BUFFER(-5)`，没有进入最终同步/颜色检查；失败JSON保留。短3帧vpp-only归因随后成功，说明无缩放CSC本身可运行。

修正probe，使其沿用现有生产QSV的有限动态扩容：8MiB→16MiB，最多64MiB；只在Encode尚未接受输入且返回NOT_ENOUGH_BUFFER时扩容重试，不重跑VPP。三主要组在v2同binary运行。

按主Agent要求又补原始buffer字段，单独CPU编译v3后只跑3帧noscale审计，没有扩大主要矩阵：

- Encode GetVideoParam：BufferSizeInKB=9375，BRCParamMultiplier=1，TargetKbps=18000，MaxKbps=40000。
- 首次调用：MaxLength=8,388,608，DataOffset=0，DataLength=0，status=-5。
- 扩容后：MaxLength=16,777,216，DataOffset=0，DataLength=0，status=0。
- 最终Encode Sync后首AU：MaxLength=16,777,216，DataOffset=0，DataLength=8651。

实际VBV需求9,375,000B高于8MiB，已闭合首轮失败原因；没有将无法解释的失败简单归为“多给内存”。如果64MiB仍不足，probe会停止而不继续扩容。

## GPU引擎原始统计

PDH记录当前probe PID，完整保留LUID `0x00000000/0x0000EAB0`、phys0、engine index及type，不合并异构engine或截断到100%。采样200ms，包含初始化、source upload/ready fence、转换/编码、每帧NV12读回；下面是该进程整个组的均值，非纯VPP执行占用。

| 组 | 每engine采样数 | 3D eng0均值 | VideoDecode eng1均值 | VideoProcessing eng3/10 |
|---|---:|---:|---:|---:|
| noscale | 16 | 49.83% | 10.05% | 0 / 0 |
| full | 16 | 49.82% | 10.07% | 0 / 0 |
| scale | 12 | 44.61% | 6.43% | 0 / 0 |

其他engine均值为0。本机Windows驱动没有独立VideoEncode标签，不能把VideoDecode名称当作实际执行解码，也不能因为3D较高就将全部占用指定为MFX色转。**本组没有支持“改MFX后转VEBOX/VideoProcessing”的证据。** 没有增加关闭读回的吞吐组；如需生产收益判断，应接入后做相同输入、同采样尺寸的正式对照。

## 产物、指纹和下一步边界

原始及汇总：

- `develop/tmp/qsv-vpp-noscale-1/report.json`：v1首轮NOT_ENOUGH_BUFFER失败。
- `develop/tmp/qsv-vpp-noscale-vpp-only-1/report.json`：v1短CSC归因，3帧。
- `develop/tmp/qsv-vpp-noscale-2/report.json`、`qsv-vpp-full-2/report.json`、`qsv-vpp-scale-2/report.json`：v2三主要组，每组H264同目录保存。
- `develop/tmp/qsv-vpp-noscale-buffer-3/report.json`：v3短buffer审计，3帧。
- `develop/tmp/qsv-vpp-summary.json`：三主要组分位数/颜色/Locked/engine摘要；原始engine未丢弃。

v1 SHA256 `112dbb33ea060106e27b97be8b5d61fc11ed367d8082d0c195c187d052ebcb1b`；v2三主要组SHA256 `94cddcbd14770726e8a2ebda9df6a947bc6de145e890829a2b3e770c522e6d50`；v3当前源码/二进制SHA256 `4a16893fd20654cb0034e4f5c05c68080edf08f8d01812a45511d1400028bc25`。v2/v3各自CPU构建完全结束后才运行GPU组。

对主Agent下一架构选择的支持：可以进入默认关闭的QSV原生异步VPP集成；先把真实atlas allocation对齐，保留页面viewport和rectangle位置，再在内部backend契约接入BGRA输入及固定地址surface。Endpoint源ready完成边界、Browser ready/consumed fence不变；NVENC继续旧converter显式同步路径。正式变更还需处理pending/busy/held/Reset/drain及动态geometry，probe的d1单帧闭环不能替代这些服务生命周期验证。

本轮没有证明正式FPS≥50/marker p95≤100ms，没有修改任何生产converter、AtlasPool、SDK或atlas尺寸语义，没有commit。
