# QSV 异步 VPP 集成决策

主Agent选择把已通过硬件probe的同session VPP→Encode链接入正式QSV候选路径，默认仍使用现有external converter，先同binary比较。Probe只证明能力和正确性，不代表产品吞吐达标。

## 固定边界

- 新显式选项`--qsv-vpp=external|async`，默认external；async只适用于QSV，NVENC保持原输入和同步行为。不修改SDK ABI，不向SDK传Chromium对象。
- 在内部HardwareEncoder接口明确输入格式/所需源尺寸约束。QSV async接收真实GPU-ready BGRA；现有QSV external/NVENC接收NV12。Worker在async路径跳过Nv12Converter和其CPU fence等待，但仍保持既有有界pending/async_depth、输入lease直到真实完成/安全drain。
- QSV backend在同MFX session内拥有VPP及NV12中间surface。VPP输出surface原地址直接交Encode，无中间Sync；不能复制surface结构冒充依赖。只Poll最终Encode sync，NV12及输入BGRA保持有效至实际完成/Locked安全。busy必须记住已提交的VPP阶段，不得再次转换同一job；错误和关闭不提前归还GPU仍在用的资源。
- VPP按真实BGRA texture desc初始化输入，709 full RGB→709 limited NV12，输出采用协商编码尺寸。首输入可lazy init；源尺寸改变时先排空旧VPP/Encode依赖再重配VPP，不能只看编码尺寸是否变化。普通码率Reset保持QSV名义fps与序列，不偷偷重开VPP链。
- `accepted/busy/pending/error`、MORE_DATA、输出cookie匹配、keyframe、flush和drain明确处理。暂不增加滤镜/帧率转换/降噪，保持CSC+必要等比缩放。

## 对齐与实际尺寸

选择真实atlas物理分配16像素对齐，保留网页viewport/DPR及plane矩形。新增browser配置字段`allocation_alignment`（默认1，候选16），仅输出关闭时允许改变；在计算实际GPU尺寸后向上对齐并重新校验8192/16MP限制，所有共享元数据与stats报告真实对齐尺寸。不能只把1928纹理声明为1936。

Endpoint async选项初始化/几何配置传16；另留显式对齐覆盖供external+16作为同尺寸A/B基线。运行时帧率调整仍不带该几何字段。Client从真实atlas尺寸和plane矩形裁切，不改变输入DIP。此改动不改变共享结构布局或版本。

## 实施与验证顺序

1. 先实现并独立审阅，统一增量构建；不并行正式性能采样。
2. 单plane静态/动态、颜色白边、尾IDR、普通码率变化；source/encode尺寸变化、双plane、DPR与level下采样；真实错误/关闭/drain lease。
3. 同binary、相同对齐尺寸及source budget，external/async做1/4租户profile-off对照，保持Chrome89、marker和网络条件。观测实际队列/引擎、编码完成和呈现，不能把独立probe的Sync耗时当端到端延迟。
4. 依结果选择async depth/码率/源背压下一实验，不以本候选完成结束总体目标。
