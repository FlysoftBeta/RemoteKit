# Chrome89 客户端约32Hz节拍定位

## 结论

32Hz来自Chrome89客户端GPU的VSync等待。无视频、无RemoteKit绘制负载时也能复现；trace中GPU VSync、Viz BeginFrame、renderer compositor BeginFrame逐级保持约31.4ms。正常Control与最小页面结果一致，主线程没有长任务。

当前会话的可见Chrome窗口属于名为`WinDisc`的断开会话显示器；硬件D3D11初始化成功，但原生探针找不到任何DXGI output。结合官方Chrome89源码，最符合证据的具体机制是：GPU VSync找不到primary output，退回`Sleep(ceil(16.6666ms))`，即`Sleep(17)`，在该进程的粗计时粒度下实际睡约31.4ms。DWM声明60Hz并不能让这条fallback按60Hz唤醒。

本轮没有改生产源码、系统电源/计时设置、用户会话或Chromium输出目录，没有向Chrome注入代码。运行了两个短采样组，另启动一次短暂Chrome89窗口补齐窗口归属。源码阅读与trace都是89.0.4389.90，未使用157源码推测旧客户端。

## 两组测量

使用host-managed Playwright启动现有Chrome89 headed实例，viewport1440×1000；flags与上一轮吞吐测试一致，无额外VSync、帧率或软件GPU实验flags。实际完整commandline保存在原始JSON，其中也包含宿主注入的默认参数；这里的“默认客户端”沿用现有harness配置，不代表没有automation参数的手工Chrome。

每阶段10秒。setTimeout阶段同时运行递归`setTimeout(4)`；它用于区分主线程timer与GPU VSync。纯页面只有一个移动的80×80 DIV；Control使用当前生产bundle、正常后端和新数据库，不建立RTC、没有视频和页面tab。

| 页面/阶段 | RAF Hz | RAF间隔p50/p95 ms | setTimeout Hz / 间隔p50/p95 ms | longtask |
|---|---:|---:|---:|---:|
| 最小页面，只有RAF | 29.66 | 33.55 / 41.75 | — | 0 |
| 最小页面，RAF+timer | 31.98 | 31.24 / 32.09 | 214.11 / 4.45 / 5.99 | 0 |
| 正常Control，只有RAF | 31.81 | 31.50 / 32.26 | — | 0 |
| 正常Control，RAF+timer | 31.95 | 31.28 / 32.07 | 213.53 / 4.46 / 5.98 | 0 |

所有阶段document visible且hasFocus=true。页面JS的screen尺寸由Playwright viewport模拟，不能用于真实monitor归属；真实归属用Win32枚举窗口确认。

Control同时录制了20秒Chrome trace，因此该组用于定位调度，不混入正式FPS/延迟验收。最小页面没有trace。两组均没有串流marker，意在证明客户端限制独立于产品视频负载，而非替换原有marker验收。

## trace直接证据

| 环节 | 样本 | p50 / p95 ms |
|---|---:|---:|
| GPU `GpuVSyncThread`，`WaitForVSync`任务wall time | 638 | 31.361 / 32.063 |
| 同任务CPU time | 638 | 0.103 / 0.142 |
| GPU VSync任务相邻起点 | 637 | 31.382 / 32.093 |
| VizCompositor `ExternalBeginFrameSource::OnBeginFrame`相邻起点 | 638 | 31.389 / 32.088 |
| renderer Compositor同事件相邻起点 | 639 | 31.370 / 32.106 |
| renderer主线程RunTask wall time | 3023 | 0.205 / 0.611 |

主线程任务最大10.96ms。VSync线程约31ms wall time却只使用约0.1ms CPU；限制出现在GPU等待及其BeginFrame源头，不能归因于React、marker同步读回或rVFC注册顺序。trace的任务来源明确是`../../ui/gl/vsync_thread_win.cc`的`WaitForVSync`。

## Windows、显示与timer证据

- Chrome89实际ANGLE backend为Intel UHD Graphics630/D3D11，驱动30.0.100.9805。
- Win32窗口探针记录root PID10484的可见工作台窗口，rect为(10,10)–(1466,1023)，monitor handle65537，显示器名称`WinDisc`，monitor rect1707×996、work rect1707×948。root父进程为本agent所属MCP23012，Chrome进程均在session2。
- session2为Disconnected，SM_REMOTESESSION=1；DWM refresh/compose60.00024Hz，period16.6666ms，但refresh/frame计数仍为2/1，displayed为0。
- AC供电、没有电池，电源方案为平衡；处理器最小5%、最大100%。不是电池电源触发Chrome89禁用最高timer精度。
- Chrome root与全部7个子进程的只读`GetProcessInformation(ProcessPowerThrottling)`均成功，controlMask/stateMask均0。未调用SetProcessInformation；这份读取本身不能证明Windows向GPU进程兑现1ms唤醒。
- native硬件D3D11CreateDevice成功，`EnumOutputs(0)`即结束，没有可用输出；primary HMONITOR仍为65537。这与`WinDisc`窗口归属相吻合。
- 无Chrome时NtQueryTimerResolution为15.625ms，native `Sleep(17)` p50为31.497ms。Control运行时全局查询变为1ms，但独立native进程的Sleep17仍p50为31.552ms、p95为32.214ms。全局查询值不能证明另一个进程的有效timer精度。

Microsoft说明Windows10 2004起timeBeginPeriod按进程生效，没有调用的进程不保证获得提高后的精度；Windows11还可能不为不可见/不可听的窗口进程提供高精度。该行为解释了为何renderer的4ms timer可以正常工作，而GPU VSync仍约31ms；本轮没有动态hook去读取GPU进程的timeBeginPeriod调用，因此未把具体哪条Windows策略写作已直接观测。[官方timer说明](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod)。

## 官方89源码与机制

本地原始源码副本在证据目录，来自下列固定tag。

1. [`VSyncThreadWin::WaitForVSync`](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/ui/gl/vsync_thread_win.cc)：按primary monitor枚举硬件adapter的DXGI output，output不存在、WaitForVBlank失败或耗时不足1ms时，执行`Sleep(vsync_interval.InMillisecondsRoundedUp())`。该函数没有自行请求高分辨率timer。
2. [`VSyncProviderWin`](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/ui/gl/vsync_provider_win.cc)：优先从DWM取得timebase/interval，当前16.6666ms被上一步向上取整为17ms。
3. [`DirectCompositionChildSurfaceWin`](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/ui/gl/direct_composition_child_surface_win.cc)：支持GPU VSync，注册VSyncThread observer，再将OnVSync喂入compositor callback。
4. [`HighResolutionTimerManager`](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/base/timer/hi_res_timer_manager_win.cc)只按AC/DC允许高精度；[`ThreadControllerWithMessagePumpImpl`](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/base/task/sequence_manager/thread_controller_with_message_pump_impl.cc)按pending高精度任务临时激活；[`time_win.cc`](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/base/time/time_win.cc)实际成对timeBeginPeriod/timeEndPeriod。允许高精度不等于GPU VSync线程持续拥有高精度请求。

trace已直接定位31ms等待所在函数。`WinDisc`+硬件probe零输出+Sleep17分布则把函数内的fallback具体解释闭合；没有调用栈hook或注入去直接截获Chrome的Sleep参数。

## 最小可执行的下一步

不改客户端代码的首选是**在已经存在、正常连接物理60Hz显示输出的console会话或另一台本地测试机运行同一Chrome89客户端**，先运行最小RAF探针，再复跑相同1/4租户、1080、marker、RTT10ms与24/48Mbps组。成功判别标准是DXGI能枚举并匹配窗口primary output，GpuVSync wait/BeginFrame恢复约16.7ms、无视频RAF≥50；随后仍要同时验证视频实际canvas≥50及marker p95≤100ms。

另一台本地客户端可直接消费完整测试包，不影响开发机当前桌面。服务器GPU的四租户满载问题仍要独立解决；恢复客户端60Hz不能推导四租户立即达标。

如果选择在本开发机恢复物理/console显示上下文，`tscon`、切换用户会话、重连/断开RDP、连接或启停显示器/虚拟显示驱动都可能改变用户桌面、显示尺寸和进程可见性，不是无感测量动作。本轮未执行这些动作；执行前应由主Agent选择明确方案并安排时机。RDP重新连接只能提供另一个诊断环境，不能预先视为真实物理显示验收。

不建议继续用禁用VSync/无限帧率flags、关闭marker或renderer setTimeout忙轮询来修目标数字。给GPU进程注入timeBeginPeriod、修改系统timer策略也不在本轮方案内。即便另做timer精度诊断，也应只标为诊断，不作为默认Chrome89达标。

## 证据与清理

目录：`develop/tmp/client-cadence-next/`。

- `plain-and-timer.json`、`control-and-timer.json`：raw RAF/timer/longtask、真实commandline、SystemInfo、版本和页面环境。
- `control-trace.json`（约12.6MB）、`trace-summary.json`：Chrome原始trace和上述分位数。
- `window-attribution.json`、`timer-policy-readonly.json`、`windows-display-final.json`：窗口/monitor、Chrome只读power-throttling状态及DWM/session。
- `native-probe.cpp/.exe`、`native-before.txt`、`native-during-control.txt`：不修改设置的Sleep/DXGI探针及结果。
- `sample-driver.js`、`control-driver.js`、`window-probe.ps1`：有界实验入口；文件均为临时材料，不作为正式构建依赖。

两个采样driver均在finally中browser.close。补窗口归属的独立Chrome未能跨host调用保留global引用，因此以已记录并校验executable/profile的自建root10484定点清理整个进程树；没有结束未知窗口。Control root24212及其已枚举后代已清理，默认host页面也已通过所属browser_close关闭。最终检查无Chrome89/RemoteKit进程、3001无监听。未提交或推送；未触碰并行任务的生产文件。
