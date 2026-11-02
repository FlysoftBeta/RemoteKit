# 同一解码流的2D/WebGL候选对照

2026-11-02，Sol。四个12秒case已完成，隔离接收context/Control/Endpoint/Browser正常关闭，GPU已释放。没有修改产品默认或transport/window-frame源码；没有构建。

## 结论

单WebGL纹理、多个viewport/scissor能降低本机多plane客户端开销，四plane收益明显，但没有解释数量级的decode→paint FPS落差。四plane 2D→WebGL：unique paint **58.60→59.97FPS**，CPU绘制提交p95 **4.3→0.9ms**，receiver CPU **1.217→0.418 core**，receiver 3D **25.94→10.59%**。双plane两者均约59.6FPS，CPU/3D也下降。

没有为追FPS放宽metadata匹配：仍由原生产MSTP/fifo2的RTP/epoch/尺寸授权后同步调用候选renderer。双plane解码帧读取时metadata已到；四plane2D只有1次读取时未知，WebGL为0。主要等待是帧读取到RAF授权的约28–30ms，本次不能把这段命名为“等待DC metadata”。没有证据支持metadata gate是本机这一组的主要丢帧原因。

可保留WebGL原型作为后续集成候选；本轮尚不足以直接改产品默认。产品实际用户环境仍可能是video回退、软件渲染、不同DPR或headed/RDP显示链；应先带可观测字段复现其落差。

## 对照方法与边界

- 与[生产基线](viewer-presentation-baseline.md)相同独立canvas fixture/真实服务。157.0.8103.15 headless、fake60、DPR1接收context，viewport1920×1168、内容1080px高；没有RDP可见接收窗口，也未触碰桌面。
- 每对在**同一RTC peer、同一MSTP、同一编码尺寸与布局epoch/generation**中只切renderer。第一对2planes/ClientScale1；第二对4planes/ClientScale1.5。两对之间改变plane与scale是扩大场景，不能当单变量性能差。
- 原生产canvas保留DOM/几何并隐藏；候选2D以N个同backing尺寸canvas绘制，候选WebGL以单canvas绘制，每帧一次`texImage2D(VideoFrame)`、每plane一个viewport/scissor+draw。原生产多canvas draw回调被实验页替换，没有同时叠加两组渲染工作。
- 保留生产MSTP不可变owner的生命周期与frameGate，绘制提交后沿原`reportPresented`记录每plane RTP/epoch。输入未发送；候选没有维护生产`paintedPlanes`/readback API，因此不是可直接发布的完整呈现实现，不能据此声称输入/Marker已验收。
- 三质量档生产自适应没有关闭，这是沿用生产源路径的有界renderer对照；每对quality均为quality、两端采样均requested50FPS/44–48Mbps、applied44–48Mbps、分辨率稳定、feedback healthy。实际多源atlas约60FPS。没有固定源52或假装这是历史受控性能验收。
- 计数终点为draw提交，未等待GPU fence/物理显示。CPU提交时间不能当GPU执行耗时；PDH引擎占用用于资源归因，没有采集GPU pass ETW。
- 每模式只跑一次，不重复凑达标。资源探针与浏览器工具调度导致每组实际窗口内PDH有效样本5/5/9/9个；统计按getStats绝对wall timestamp裁到case窗口，短样本占用率仅作本组证据。

## 实际像素与结果

2planes源/编码atlas均976×2176，mediaScale1；每plane958×1080，约1080p总内容。4planes请求ClientScale1.5，源atlas2912×1632，受实际编码接收约束变为1980×1110，mediaScale0.679945；每plane486/485×1102，实际总接收内容仍约2.14M像素。**4planes两种renderer使用完全相同的降采样帧**，不能把这一对叫“完整DPR1.5客户端性能”。WebGL输出backing含分隔空白，2planes1921×1081，4planes1959×1102。

| 场景/renderer | 时间 | decode FPS | 每plane unique paint FPS | 提交p50/p95 ms | 上传p95 ms | 读取→提交p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| 2planes，N个2D | 12.014s | 59.678 | 59.595 | 0.6 / 1.5 | 无显式tex上传 | 29.4 |
| 2planes，单WebGL | 12.018s | 59.746 | 59.663 | 0.3 / 0.8 | 0.6 | 29.4 |
| 4planes/1.5，N个2D | 12.048s | 59.928 | 58.600 | 2.4 / 4.3 | 无显式tex上传 | 30.3 |
| 4planes/1.5，单WebGL | 12.024s | 59.965 | 59.965 | 0.4 / 0.9 | 0.6 | 30.1 |

| 场景/renderer | receiver CPU core | receiver 3D % | receiver VideoDecode % | processor read/authorize | discarded/replaced | 读取时metadata未知 |
|---|---:|---:|---:|---:|---:|---:|
| 2planes，2D | 0.414 | 21.76 | 10.72 | 716 / 716 | 0 / 0 | 0 |
| 2planes，WebGL | 0.293 | 14.83 | 11.16 | 717 / 717 | 1 / 0 | 0 |
| 4planes，2D | 1.217 | 25.94 | 8.69 | 718 / 706 | 4 / 10 | 1 |
| 4planes，WebGL | 0.418 | 10.59 | 7.19 | 721 / 721 | 0 / 0 | 0 |

所有candidate draw异常/重复RTP/identity拒绝为0、processor invalid为0；四plane2D的replaced10来自有界FIFO满替换，无法从本次聚合精确拆出每次GPU/CPU阻塞触发原因，未将其归咎DC。`discarded`是MSTP源计数，`replaced`是JS FIFO层，不相加假装端到端独立丢帧数。717/718等读取次数与before/after统计存在1帧采样边界差，按原值保留。

4plane2D源侧CPU3.29core/3D68.54%，WebGL源侧2.11core/3D58.60%；同GPU共享资源的源侧也改变。没有随机顺序/重复对照，因此不能把整机总下降都唯一归因于省一次上传。可确认的是客户端工作更轻、相同输入尺寸下paint更接近decode，且没有出现新的metadata失配。

Sol实际查看四plane两模式截图，文字方向、plane裁剪与左右位置正确、四页均有真实更新帧。WebGL分隔空白为黑色，候选未实现产品背景/控件融合；不是产品UI交付。没有做Marker CRC或物理屏幕刷新验证。未追加单video对照：已有原型显示提交成本收益，继续增加不同帧获取路径会超出当前4短case边界且不帮助归因本对照。

## 工具与重现

服务：`node --import ./control/node_modules/tsx/dist/loader.mjs tools/viewer-presentation-baseline-server.mts develop/tmp/viewer-presentation-candidate`。独占33271/33272与该目录；停止访问fixture的`/shutdown`，只结束自己的接收context。

宿主Playwright依次执行`tools/viewer-presentation-baseline-browser.js`（hostPage._baselineRoot设为本case目录、_baselineVersion=157）、`tools/viewer-presentation-candidate-browser.js`；`prepareCandidate(2,1)`，同连接先2d再webgl各12秒；`prepareCandidate(4,1.5)`后同样两次。计时同时运行资源工具`viewer-presentation-baseline-resources.ps1 -Seconds 15 -RunDirectory develop/tmp/viewer-presentation-candidate -OutputName <对应名称>`。

`tools/viewer-presentation-candidate.js`是纯实验renderer helper；`tools/summarize-viewer-presentation.mjs <case目录>`验证完整chunk index、拒绝重复/缺失，重组每case JSON，生成`summary.json`。本轮全部分块已成功落盘，四个完整JSON、紧凑summary、四截图与资源样本在`develop/tmp/viewer-presentation-candidate/`。初版baseline丢raw的问题没有在候选重复。

运行后对独立helper补强了显式epoch/generation/session快照检查与WebGL资源释放，未再跑性能case；这些是工具guard/清理改动，本文性能数值对应其前一版、同样由原生产gate授权。所有JS语法检查通过。产品文件由root/其他agent并行实施，本实验不覆盖其修改后的真实验证。
