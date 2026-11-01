# 单plane直接发布实播与同版本对照

## 结论

新路径功能通过。真实change-stop尾帧成功后只确认一次尾IDR；第二轮源内容停止后再确认一次。单↔双plane、桌面↔平板、关闭再订阅、stale输入拒绝均正常。Feature保持默认关闭。

同binary四1080、精准render16下，Feature off→on后canvas由15.65–15.83升至15.93–16.00FPS，marker p95由130–197降至90–149ms；物理3D引擎均值87.84→79.78%，browser桥部分11.00→6.35%。本轮单次配对显示收益，没有达到50FPS及全部Peer p95≤100ms。

旧on30已确认被CPU probe构建污染（14:36:43.6–14:37:13.9覆盖采样），排除性能结论。隔离无构建窗口后唯一一次同binary干净on30重跑仍GPU99.78%、canvas7.16–7.30FPS、marker p95为679–774ms，未达到目标。

## 同版本与运行条件

- browser SHA256：`309A535CB8E8520953D5F213A9201A4073FA78EFF017520D463628EDB2E7DEAB`。
- Endpoint SHA256：`923777FCC27F095DBF2F0E505ED503885E9A25BD516DCC10309D6C8F3A19C337`。
- 四个性能case（含被排除的旧on30）的全部fingerprints键逐项相同，包括Client assets、SDK DLL、fixture及正式工具；只有运行配置Feature和render预算变化。没有重建、修改生产源码、默认或正式工具。
- Chrome89.0.4389.90 headed，通过host-managed Playwright运行；Client为snapshot，未添加额外呈现实验flag。DPR1、viewport1920×1080、媒体1928×1088；QSV d1/TU1/VBR、名义60fps、RTP请求0/0。
- 每Peer独立下行24Mbps、每向5ms整形，marker1Hz；暖机5秒+采样30秒。正式性能组全部media/server/copy/official profile关闭，GPU/CPU资源采样开启。

## 功能实播

case：`develop/tmp/single-plane-functional`。功能组开启现有browser trace，使用1280×720桌面与820×1180/DPR2平板；仅其临时fixture移除textarea autofocus，避免光标闪烁成为新的真实源捕获。性能fixture没有这项修改。

| 检查 | 真实结果 |
|---|---|
| 第一轮change-stop | 最终CRC marker frame81；tailIdrCompletions=1，随后4.5秒仍1，marker保持同帧 |
| 新内容再次停止 | 导航到第二轮change-stop；tailIdrCompletions=2，随后4.5秒仍2，最终marker保持同帧 |
| 关闭再订阅 | generation1→2，同一静态marker重新呈现 |
| 单→双→单 | 双desktop、双tablet、单tablet、关闭另一tab、单desktop恢复，全部有真实marker |
| stale输入保护 | 2次stale layout观测均canInput=false，stale/错误epoch呈现违例0 |
| 旧代输入 | 实际DataChannel旧layoutEpoch mouse move收到`stale_layout_epoch`拒绝 |
| Sol视觉 | 静态最终背景、marker、双平板及回到单桌面均正常，无黑帧/错位/旧页面残留 |

单plane的5个输出代次全部source_stage_copies=stage_slot_copies=0、source_slot_copies>0；首代161次，重新订阅2次，其余1/2/2次。168次direct_source_copy均在trace中关联到同serial的source_read_done，顺序正确。双plane代次source_slot=0，回到stage copy；单平板代次另出现一次direct_metadata_copies，metadata-only克隆路径有实播证据。各代clear次数包含文档/几何重置，不解释成逐帧clear。

Endpoint Snapshot目前没有透传browser output.status计数，所以功能计数取自每次输出关闭后的browser trace摘要。完整汇总：`develop/tmp/single-plane-result/functional-trace-check.json`。

没有稳定触发真实SDK pause、编码硬件busy、三个shared槽全忙或设备故障；本轮不把CPU状态机检查当作这些硬件恢复已通过。新布局已重新fresh且marker实际显示；未单独保存fresh后的canInput读回，没有重跑整套IME/触控回归。

## 性能配对

case为`single-plane-perf-off16`与`single-plane-perf-on16-valid`。

| 同30秒窗口 | off16 | on16 |
|---|---:|---:|
| source实际render FPS | 16.00 | 16.00 |
| Endpoint atlas copy FPS | 16.00–16.03 | 16.00–16.03 |
| encode FPS | 15.99–16.06 | 16.00–16.03 |
| decode FPS | 15.99–16.03 | 16.00 |
| 实际canvas FPS | 15.65–15.83 | 15.93–16.00 |
| Peer0/1/2/3 marker p95 | 153/130/197/157ms | 149/90/116/144ms |
| 有效marker数/Peer | 30 | 29–30 |
| 同步marker读回p95 | 79.88–90.92ms | 35.06–41.14ms |
| native receive→presentation p95 | 4.90–7.68ms | 4.02–6.09ms |
| 采样lastEncodeMs p95 | 14.42–21.24ms | 14.05–16.33ms |
| 采样private copy p95 | 16.13–25.66ms | 8.02–14.34ms |
| 采样capture→ready p95 | 19.52–28.05ms | 11.38–17.07ms |
| 实际wire video Mbps/Peer | 1.38–1.53 | 1.42–1.48 |
| encoder drop增量/Peer | 0–1 | 0 |
| tail submissions/completions增量 | 全0 | 全0 |
| receiver loss/PLI/NACK增量 | 全0 | 全0 |
| relay丢包 | 全0 | 全0 |

source为真实fixture render计数，capture回调FPS在profile-off组缺测，不用copy FPS替代。lastEncode/private-copy/capture→ready是每秒最新值的采样分布，不是全部请求耗时分布。canvas直接读取metrics.displayFps，通用matrix的paint字段仍missing。

同一Intel物理engine的角色均值如下；独立engine不相加：

| GPU busy均值 | off16 | on16 |
|---|---:|---:|
| 物理3D总量 | 87.84% | 79.78% |
| source GPU/3D | 28.49% | 26.80% |
| source browser桥/3D | 11.00% | 6.35% |
| Endpoint/3D | 21.93% | 21.10% |
| receiver GPU/3D | 26.41% | 25.53% |
| 物理VideoDecode总量 | 22.48% | 20.37% |
| 物理VideoProcessing总量 | 9.59% | 8.83% |

VideoDecode包含Endpoint与receiver实例，VideoProcessing非零部分属于Endpoint，不能按驱动标签推断纯编解码时间。两组sender RTT p95分别12–14ms、13–14ms，基础整形RTT10ms不变。

## 旧on30：CPU编译污染，排除性能结论

case：`single-plane-perf-on30`；窗口为2026-11-01 14:36:40–14:37:10（本地UTC+8）。source28.87–29.97、copy20.13–23.23、encode11.80–12.11、decode11.86–12.24、canvas6.00–6.43FPS，marker p95为897/842/865/924ms；GPU3D99.76%，source GPU54.80%、browser桥10.07%、Endpoint22.17%、receiver12.69%。

Peer1 loss+30、NACK+1，其他Peer为0，PLI全0、relay全0；sender RTT p95为20–38ms。encoder drop为257–330次/Peer，tail提交2–7次、当前源周期确认成功0–2次。重负载下源持续变化和丢帧使尾提交与成功数不同，不能据此判定静态单次尾IDR回归。

清理时发现非本任务启动的`ninja -j16 endpoint_qsv_vpp_probe`，随后结束。主Agent已核对该编译发生在14:36:43.6–14:37:13.9，与14:36:40–14:37:10采样重叠。因此排除该组全部性能结论，保留原始数据与loss观测作审计，不与干净组混合。

## 干净on30重跑

主Agent协调所有其他Agent只编辑、不测试或构建后，唯一重跑case：`single-plane-perf-on30-clean`。正式采样窗口为本地UTC+8的14:40:47.504–14:41:17.540（wall毫秒1793515247504–1793515277540.105）。准备前和清理后没有编译器、Ninja、probe或其他RemoteKit实验进程；采样中的一次只读process检查同样为空，保存在`build-overlap-check.json`。同干净off16/on16的全部fingerprints逐项相同，条件仍四1080、30Hz source、RTP0/0、snapshot、marker1Hz、每Peer24Mbps/基础RTT10ms，5秒暖机+30秒采样。

| 干净on30 | 实际结果 |
|---|---:|
| source实际render FPS | 29.47–29.97 |
| Endpoint atlas copy FPS | 26.59–27.48 |
| encode / decode FPS | 13.69–14.33 / 13.75–14.33 |
| 实际canvas FPS | 7.16–7.30 |
| Peer0/1/2/3 marker p95 | 679/749/774/727ms |
| marker数/Peer | 27 |
| GPU3D均值 | 99.78% |
| source GPU / browser桥 / Endpoint / receiver GPU的3D | 52.63 / 10.81 / 23.59 / 12.74% |
| 实际wire video Mbps/Peer | 1.17–1.37 |
| 同步marker读回p95 | 278.67–349.82ms |
| native receive→presentation p95 | 174.89–218.63ms |
| 采样lastEncodeMs p95 | 53.76–77.73ms |
| 采样private copy p95 | 55.88–73.30ms |
| 采样capture→ready p95 | 71.23–91.37ms |
| encoder drop增量/Peer | 384–413 |
| tail提交 / 当前源周期完成增量 | 1–2 / 0–2 |
| receiver loss / PLI / NACK，relay drop | 全0 |
| sender RTT p95 | 13–18ms |

该组证实direct开启后30Hz仍进入GPU满载区，不能靠这一次少copy便达到目标。旧污染组的loss+30/NACK+1不适用于本组；也不把两组拼成一个分布。干净原始metrics和资源未覆盖旧组，汇总在`develop/tmp/single-plane-result/clean/feedback.json`及`clean/compact.json`。

## Padding既有右缘着色

on16采样结束后读取完整decoded atlas，左角近白，但右侧最外列偏绿。随后两组独立短静态功能对照`single-plane-padding-off/on`均复现；两次从各自同一帧PNG提取右16列×1088行RGBA，**逐字节一致**：CRC32均`c0b1af58`，SHA256均`0e4d4aadcf81740c1501c74d26db787c6ab810ec2889e5c6f6e7b93c50587aff`，差异0字节。10行×14列采样也全部一致；右上角均[182,255,190,255]。

读取坐标来自videoWidth=1928，而非1936：x=1912..1927，y=0..1087。layout atlas也是1928×1088，页面矩形x=4..1923、y=4..1083。VPP分配1936×1088，输出target rect为1928×1088；QSV FrameInfo.Width按16对齐1936，CropW配置1928，驱动GetVideoParam日志确认CropW/CropH为1928×1088，实际receiver video尺寸同样1928×1088。

这些case没有保存完整H.264 SPS NAL，不能声称已解析实际SPS frame_crop_right_offset。日志只含SPS profile前三字节。已确认右缘现象不是direct新增；具体发生在VPP、编码裁剪、解码或采样的哪一段仍待定位，不能把padding全白写作通过。

原始PNG、右16列PNG与RGBA bytes在两个padding case的source-trace，CRC复算结果在`develop/tmp/single-plane-result/padding-crc.json`。读取均发生在性能计时窗口外或独立功能组。

## 产物与清理

功能报告、screenshots和trace在`develop/tmp/single-plane-functional`；四个性能case包含原始metrics、presentation chunks、source探针、Endpoint响应和GPU/CPU计数。`develop/tmp/single-plane-result/feedback.json`保存逐Peer分段及完整资源，`compact.json`为紧凑摘要。

两次早期on16启动失败源于临时padding脚本使用Windows PowerShell默认编码读UTF-8 driver，损坏中文按钮选择器；均未创建view/RTC，不计性能样本。已修正临时脚本为ReadAllText，保留失败case供审计，正式工具未改。

所有自建Chrome89/RTC、Control/source/resource进程均清理，默认managed host也通过browser_close正式关闭。3001/3013无监听；没有停止其他Agent的CPU构建。GPU和managed浏览器窗口已向主Agent释放。
