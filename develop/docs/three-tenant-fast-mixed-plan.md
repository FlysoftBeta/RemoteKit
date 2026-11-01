# 三租户最快预设与混跑实验

用户已将重载目标改为3租户；若有界优化仍无明显成效可转2租户。Chrome89保持支持，新Chromium模拟60Hz用于本机无显示器实验。验收仍为每个租户同组canvas实际呈现≥50FPS、Pixel marker p95≤100ms，不降低原分辨率或关闭marker。

## 固定条件

- 使用已增量构建的Chromium157接收端及精准fake-vsync=60；连续rVFC实验特性关闭，默认video呈现，MSTP关闭。保留Chrome89协商/输入/视频路径。
- 每peer 1920×1080 DIP、DPR1，实际编码1936×1088；同canvas动态fixture，源/render60；external QSV转换、atlas alignment16、source single-plane direct、snapshot/after-work、RTP playout0/0。
- QSV TU7、VBR、async depth1；目标36Mbps、上限44Mbps；每peer下行48Mbps、RTT10ms，marker每秒一次。
- adaptive-fps关闭，避免把模式比较与动态源负载调整混在一起。
- 每组5秒热身、30秒统计；独占GPU实验窗口，不并发CPU构建。记录当前Endpoint/receiver/client bundle/fixture的hash。
- 各组前记录背景CPU/GPU负载；同时收集按进程/引擎GPU占用。不得为降低噪声擅自结束用户程序。

## 有界矩阵

依次比较全OFF、全ON、on/on/off、on/off/off四组；明确记录每Session实际选择及GetVideoParam实际TU/LowPower。前两组是最快预设下的新基线，不能拿旧TU1/四租户结果直接归因混跑。可依据引擎占用和明显失败提前终止无价值的重复组，说明原因。

全OFF/ON使用既有单值参数，混跑使用 `-QsvLowPowerPattern on,on,off` 或 `on,off,off`，不同时传QsvLowPower。共用 `-Tenants 3 -TargetUsage 7 -RateControl vbr -BitrateMbps 36 -MaxBitrateMbps 44 -DownlinkMbps 48`，其余沿近期精准60Hz完整参数。Session选择按持久化数字id计算，报告实际比例而不是猜测创建顺序。

若某组接近或达到目标，重复最优组验证；若全部仍远离目标，先用同组逐环节数据判断主要瓶颈，只增加一项针对性改进。若仍无明显成效，按用户授权转2租户，不无限重复三租户参数矩阵。初轮包括工具准备与分析限90分钟。

## 输出与判读

每租户报告source/atlas/encode/decode/canvas FPS、marker p50/p95与CRC、真实码率/尺寸、丢包、排队与capture→ready/privatecopy/encode耗时；汇总source GPU、Endpoint、receiver占用和各引擎分布。保留完整metrics，分块记录须通过hash重组。

LowPower ON/OFF是配置及实际驱动模式；引擎是否能真正并行、共享资源是否饱和由测量决定。驱动可能把编码工作记入VideoDecode，不能仅凭计数器名字宣称使用了不同物理引擎。混跑收益按整条链路的呈现与延迟判断，不以单一引擎降载代替。

当前marker终点为canvas提交，读回完成耗时另列。MSTP、adaptive-fps及marker完成端点改进单独实验，不混入第一轮模式比较。
