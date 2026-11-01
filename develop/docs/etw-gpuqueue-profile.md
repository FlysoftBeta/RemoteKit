# GPUView ETW 短诊断

本次样本记录到较长的 GPU 提交等待，显式 CPU Ready→Run 配对没有显示 source GPU 进程发生 runnable starvation。这里分析的是 **250ms 选取片段**，不是整个串流窗口的分布，也没有获得每条 D3D11 copy 的纯硬件执行时间。

## 场景与采集

证据目录：`develop/tmp/etw-gpuqueue1080x4/`。使用已有冻结二进制：Endpoint `1ff67332346267a3e4dbb1f4ccec0050347cdeaac9945d9a83cb188d4f4202b6`，Client `index-CTjYS6kC.js`。四个 1920×1080/DPR1 页面，QSV d1/TU1/VBR，cap/gate off、snapshot；每 peer 配置独立 24Mbps 下行及双向各5ms基础延迟。Marker 采样关闭，保留 server/browser trace。Chrome89 四个 context 保持 visible，5s warmup 后开始。

实际使用 `tools/prepare-streaming-case.ps1`：

```powershell
./tools/prepare-streaming-case.ps1 -Name etw-gpuqueue1080x4 `
  -Width 1920 -Height 1080 -Tenants 4 -MarkerHz 0 `
  -AsyncDepth 1 -TargetUsage 1 -RateControl vbr -DownlinkMbps 24 `
  -ServerTrace -ResourceProfile -PresentationMode snapshot
```

临时 `run.js` 在既有 benchmark 的全部 peers warmup 完成后，通过 `/api/metrics` 写入 `{kind:'etw-ready'}`，由 `tools/streaming-etw.ps1` 触发采集。每次必须使用本次 prepare 新建的 case，ready 标记必须来自本次 benchmark。工具在启动前拒绝已有 `gpu.etl` 的目录，避免覆盖证据；它先确认 WPR 没有录制，只停止自己成功启动的会话，从不 cancel 其他会话。

本机 SDK WPR/GPUView/xperf 为 10.0.28000.2526；WPA/WpaExporter 为 11.8.423.12582。当前普通 token 未提升，`sudo` 已启用内联模式。实际采集调用如下，没有打开 GPUView/WPA 桌面：

```powershell
$wpt='C:/Program Files (x86)/Windows Kits/10/Windows Performance Toolkit'
& "$wpt/wpr.exe" -status
sudo "$wpt/wpr.exe" -start "$wpt/gpuview/log.wprp!GPUView" -filemode
# 本次等待11s，另有1.75s进程快照开销
sudo "$wpt/wpr.exe" -stop "$case/gpu.etl" -skipPdbGen
```

安装的 GPUView profile 包含 CSwitch、ReadyThread、ProcessThread/Loader 和 DxgKrnl/D3D11/DXGI，并用独立 SCHLOG collector 开启 `0x04000000`。该 profile 明确说明这个 scheduler keyword 不能与其他 DxgKrnl keyword 混在同一 collector。系统内置 GPU profile 的 `0x277` 不能直接当作这个完整 profile。

`start-after→stop-before` 实测12.75s。合并 ETL 总时长25.119s，包括开始/停止阶段；不能把整个 ETL 都标成稳定负载。文件 `gpu.etl` 为658,505,728字节，时钟 PerfCounter，lost events=0、lost buffers=0，统计见 `etl-stats.txt`。ETW明显扰动负载，本组 FPS 不用于声称性能改善。

采集后 WPR 状态为 not recording；30个自建 case 进程已清理，host 返回 No open tabs。工具后来把快照时间计入11s总期限，避免未来重复这1.75s额外开销；没有为这个收口重新采集。

## 导出与选择范围

实际命令（`$case` 为证据目录的绝对路径）：

```powershell
& "$wpt/xperf.exe" -i "$case/gpu.etl" -o "$case/etl-stats.txt" -a tracestats
& "$wpt/xperf.exe" -i "$case/gpu.etl" -o "$case/events-3s.csv" `
  -a dumper -range 3000000 3250000 -add_rawdata -add_fieldnames
& "$wpt/xperf.exe" -i "$case/gpu.etl" -o "$case/dxg-events.csv" `
  -a dumper -provider '{802ec45a-1e99-4b83-9920-87c98277ba9d}' -add_fieldnames
```

完整 DxgKrnl 导出约2.32GB，仅抽取 Device/Context 创建与 rundown 为 `context-device.csv`；不继续扩展全窗分析。临时 `analyze-export.py` 使用标准 CSV reader 解析 xperf 导出，不直接实现 ETW 解码。结果为 `queue-evidence.json`。

统计选取 ETL 相对 **3.0–3.25s**。GPU 包必须在窗口内具有完整 QueuePacket.Start→DmaPacket.Start→DmaPacket.Stop 三元组，按 `hContext + SubmitSequence` 精确连接，且 PacketType=0、bPreempted=false。窗口边界会排除开始较早或结束较晚的长包，因此这个完整包筛选**偏向较短包**。以下分位不能代表全窗，也不能用于估计总体尾部。

## 归属与实际样本

归属由 Context.hDevice→Device payload 的 hProcessId 连接，保留 context/device/node ordinal，结合当时的进程路径和 `--type=gpu-process` 确认角色。没有按事件 header PID 或时间重叠猜归属。例如 Endpoint17360 的 DMA 结束事件 header PID 可以是 source GPU24888、System 或其他当时执行驱动代码的进程。

| 角色/PID | 窗口内有完整包的contexts | 完整包数 | submit→DMA start p50/p95 ms | DMA start→stop p50/p95 ms |
|---|---:|---:|---:|---:|
| Endpoint17360 | 16 | 75 | 5.734 / 55.798 | 1.906 / 3.699 |
| receiver GPU5740 | 2 | 14 | 62.862 / 167.207 | 1.856 / 4.370 |

四个 source GPU 分别为24888、31704、24788、4624，各有一个 context 在该片段形成4/3/3/3个完整包。具体完整包示例的 submit→DMA start 为195.806、125.164、225.438、145.744ms，对应 DMA start→stop 为4.293、3.042、2.736、3.109ms。每个示例的 context、device、submission sequence 及原始时间都存于 JSON。

这里的 DMA start→stop 是 DxgKrnl 事件跨度。它不是单条 CopySubresource/转换调用的硬件 timestamp query；一个 DMA 包可以包含多条命令，硬件队列内部等待、驱动通知等也不能凭这个跨度自动拆开。当前结果证明该诊断片段存在较长的提交等待，不把它改称纯 copy 耗时。

## CPU Ready→Run 覆盖

只配对实际 ReadyThread 与随后相同 TID 的 CSwitch switch-in，不把没有 Ready 事件的睡眠或其他间隔记为0或排队。

| 角色/PID | 显式Ready配对 / switch-ins | Ready→Run p95 / max ms |
|---|---:|---:|
| Endpoint17360 | 1376 / 1772 | 1.268 / 7.116 |
| source GPU24888 | 98 / 124 | 0.077 / 0.376 |
| source GPU31704 | 96 / 108 | 0.077 / 0.214 |
| source GPU24788 | 90 / 121 | 0.111 / 0.439 |
| source GPU4624 | 101 / 112 | 0.164 / 0.376 |
| receiver GPU5740 | 330 / 340 | 0.057 / 0.683 |

四个 source GPU 共385个显式配对的最大 Ready→Run 为0.439ms，未显示这些观测线程发生 CPU runnable starvation。没有配对的 switch-in 可能在窗口开始前已 Ready，窗口结束仍等待的线程也不形成完整配对；不据此证明其余区间没有等待。

本次稳定串流后才启动 ETW，选取导出没有 source `CrGpuMain` 的 ThreadName，**尚未定向识别 GPU 主线程**，因此表中是各 GPU 进程内已观测线程统计。后续若需要主线程结论，可在活体进程快照同时调用 GetThreadDescription，保存 PID/TID/name；本轮不再补采。

## QPC 与 request/profile 关联

`etw-anchors.json` 保存 start/stop 前后 QPC、频率与 wall clock 夹测；`etw-processes.json` 保存当时的 PID、父 PID、创建时间、路径及命令行。server/SDK trace 保留 tenant/session/peer/frame/request 的 QPC，供后续细粒度 profile 连接。

一个可复核锚是 `events-3s.csv` 第10864行：QueuePacket submit 的原始 QPC=`6084718695747`，相对时间=`3008147800ns`，QPC频率10MHz，推得 ETL起点 QPC=`6084688614269`。使用 raw timestamp 可以避免 CSV 显示为微秒时的取整。Chromium TimeTicks 则通过现有 clock_sdk 前后夹测映射，保留半夹测宽度作为误差；官方 trace 还须确认自身 origin/offset，不能把首个事件当作零点。

本轮没有将某个 DMA 包按时间接近就标成某个 frame/request，没有把这250ms样本外推成12.75s分布。

官方语义参考：[GPUView](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/using-gpuview)、[Context CPU Queue](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/context-cpu-queue)、[ETW原始时间戳](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_logfilew)。
