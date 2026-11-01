# FIFO2剩余间隔与CRC同步工作重叠

2026-11-01。只读既有latest1/FIFO2正式raw并离线计算；没有改源码、构建、启动浏览器或GPU。**FIFO2中的同步CRC有可见成本和部分长paint间隔重叠，但不足以将46/42次overflow归因成每秒一次CRC。大部分>40ms paint间隔不落在两路CRC工作及其后一帧窗口内。** 把已绘制canvas的同帧marker裁剪后转Worker读回是有明确待检验收益的局部候选；收益仍需真实paint/CRC同端点对照。

## 数据与边界

读取 `develop/tmp/client-latest1-fixed52-t2` 和 `client-fifo2-fixed52-t2`：现有loader重组的 `metrics/client-metrics.jsonl`、`presentation-raw-0.json`、`presentation-raw-1.json`、`segments.json`，未改写case文件。两组同binary/bundle，source52、CRC1Hz、原1936×1088 atlas、fake60，ProcessorProfile=false。

对每个正式窗口内相邻成功paint定义半开间隔 `G=[paint_i.observedAt, paint_(i+1).observedAt)`。同步测量区间分为：

- 精确readback区间 `R=[markerReadback.at, at+durationMs)`，仅getImageData调用。
- 完整marker工作 `W=[markerDraw.at, markerDecode.at+durationMs)`，含裁剪draw/getImageData/decode。45次工作都在同步presented listener中，始于对应成功paint之后。本组R和W重叠到的paint gap集合相同。
- 两路合并工作 `U=W_peer0 ∪ W_peer1`。以各记录的 `startedWall-startedAt` 将另一页时钟转换到本页；它与timeOrigin的偏差为0–0.8ms，跨页归类精度约1ms。
- 较宽相关窗 `U+`：每个W的右边界再延长 `1000/60=16.667ms`，用来覆盖紧随读回的一个刷新恢复周期。没有前置扩大。

只有 `G.start < W.end && G.end > W.start` 才算相交，边界碰触不算；每个gap在并集中只数一次。阈值使用严格 `gap>40ms`：它高于60Hz正常一次/两次刷新间隔，用于筛出较明显停顿，并不把每个长gap当一帧drop。另给>24ms数量作为宽阈值参照。

## 完整45秒：成本与相关gap

|模式/peer|CRC readback总ms|完整marker工作总ms|本页CRC后一个paint gap均值/p95 ms|全部>40ms gap|与本页W相交|仅与另一页W相交|与U+相交|U+之外|
|---|---:|---:|---|---:|---:|---:|---:|---:|
|latest1/0|447.3|470.0|23.72 / 37.4|29|2|5|8|21|
|latest1/1|492.6|514.5|26.11 / 63.5|34|6|1|7|27|
|fifo2/0|719.9|747.4|26.60 / 49.9|65|9|2|13|52|
|fifo2/1|666.8|695.0|26.45 / 52.0|50|6|2|10|40|

FIFO2本页CRC直接重叠占全部>40ms gap的13.8%/12.0%；加另一页实际工作为16.9%/16.0%；再放宽后一帧为20.0%/20.0%。剩余80%长gap在这个相关窗之外。latest1与FIFO2两组的长gap总数和GPU负载不同，因此这些比例只能描述实际重叠，不能当作Worker收益预测。

宽阈值>24ms：latest1共575/581个，U+重叠54/48；FIFO2共391/389个，U+重叠36/40。FIFO2减少了大量约两次刷新gap，但剩余更长的尾部有所增加。FIFO2全体paint gap p50均16.8ms，p95为34.4/34.0ms，最大81.2/81.4ms；不能把>24ms全部算成CRC影响，因为52Hz源对60Hz刷新本身就会有约33ms间隔。

本次FIFO2 readback p95为41.7/36.1ms，已高于较早D2的24–27ms量级；latest1本轮为23.7/31.3ms。完整marker同步工作占各路正式窗口1.66%/1.54%，比latest1的1.04%/1.14%高。它会阻塞所在JS主线程，但百分比不等于丢帧比例，GPU依赖和任务恢复也可能跨出区间。

## FIFO2分段：把上游与接收尾部拆开

下表decode来自原segments中同段RTC快照首尾差，paint为完整15秒成功paint数/15；快照没有精确覆盖整15秒，差额是阶段量级，不能伪装成逐帧对账。

|peer/秒段|source FPS|decode FPS|paint FPS|source−decode / decode−paint FPS|本页marker工作总ms|本页CRC重叠>40ms gap / 其它>40ms gap|
|---|---:|---:|---:|---|---:|---|
|0 / 0–15|52|51.99|51.27|0.01 / 0.72|173.2|2 / 8|
|0 / 15–30|52|50.85|49.67|1.15 / 1.18|287.9|4 / 19|
|0 / 30–45|52|50.50|48.00|1.50 / 2.50|286.3|3 / 29|
|1 / 0–15|52|51.99|51.40|0.01 / 0.59|173.4|1 / 8|
|1 / 15–30|52|51.49|50.00|0.51 / 1.49|252.6|2 / 16|
|1 / 30–45|52|50.50|48.60|1.50 / 1.90|269.0|3 / 20|

后段source一直52，但decode已经降到约50.50；这个上游缺口必须与read→pending→paint分开。与此同时，CRC工作从前段约173ms增到后段约269–286ms，接收差额和非CRC重叠的长gap也在增加。第三段不能只用一个“CRC更慢”解释。资源报告同期Intel3D从71.37%升到87.67%，接收端与上游共同变慢的负载机制仍需实测区分。

latest1第三段CRC工作反而只有91.3/101.7ms，仍有9/10个不与本页CRC相交的>40ms gap，paint47.00/46.73。它支持原latest1合并损失分布于全窗，不是FIFO2只把每秒CRC问题暴露出来。

秒级processor快照可见FIFO2满队列替换在后段增加（每段仅用本段快照首尾差，未覆盖段边界）：peer0为7/10/26，peer1为7/12/18。它与后段成本上升一致，但**无法将任何一个overflow分配给具体CRC区间**，不应将其直接与表中长gap数配对。

## 能支持的下一步与不能下的结论

已证明同步readback/marker工作真实存在，部分较长paint gap穿过它；把这项同步工作移出呈现主线程值得做单变量实验。候选必须仍从实际成功绘制的plane canvas截取marker，保存该次paint的RTP/epoch/paintedAt；CRC完成时刻另报，不能用后来canvas或decoder帧配给旧paint时间。

当前没有read与overflow逐事件，无法判断46/42次overflow有多少发生在CRC期间，也无法量化因CRC引发但延续到下一帧以后的GPU/任务等待。本报告的13/10个U+重叠长gap既不是“CRC导致13/10次drop”，也不是CRC影响的严格上限。Worker还可能保留GPU读回/裁剪的真实成本，不能预先承诺它补足FPS或p95。

比较时保留现有paint时间、CRC频率和有效样本数、source52及原尺寸，只替换测量工作执行位置；应分别报告裁剪/bitmap创建入口同步耗时、异步完成/Worker读回耗时，以及真实paint、CRC端到端p95、read/overflow和decode差额。先看与本报告同样定义的相关窗是否缩短，再看整45秒两路是否同时达标；不要只凭CRC耗时下降宣布目标完成。
