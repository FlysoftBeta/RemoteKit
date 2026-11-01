# GPU环境归因：RDP重连与接收端桌面显示

2026-11-01，只读调查。**额外13.7–13.9%系统3D不是独立常驻背景负载：两次实验结束后DWM/WUDF同时降到0，空闲采样也没有持续该负载。两批之间发生RDP会话重连，新WUDFHost恰在重连时创建；最有证据的解释是重连后的远程显示链参与了动态接收内容的合成。** 该解释仍需受控接收端对照确认，不能把unowned归属直接解释成与实验无关。

本调查不启动接收端、不修改显示/电源/系统、不停止任何进程、不操作桌面、不构建。所有时间为开发机UTC+8。

## 空闲采样

自有source/receiver/case已关闭。23:14:31.660–23:14:44.768取得14条JSONL记录，采样器运行15秒。复用 `tools/watch-streaming-resources.ps1` 默认PDH设施，`gpuError`全空。

|Intel引擎/进程|均值 %|最大 %|
|---|---:|---:|
|Intel 3D总计|1.129|8.229|
|DWM PID8756|0.389|3.218|
|WUDFHost PID8732|0.358|2.719|
|VideoDecode / VideoProcessing / Copy|0|0|

3D为LUID `0x0000EAB0` 的eng0；其他引擎分开统计。短时桌面更新仍有波动，空闲均值低不排除动态实验受到RDP影响。

## 重连证据和历史对比

系统LocalSessionManager事件：22:40:24.970，Session2断开（事件40，reason5）；22:40:25.469，Session2重新连接成功（事件25）。WUDFHost8732创建于22:40:25.467，与重连相差约2ms。

|对象|当前事实|
|---|---|
|DWM8756|Session2，10:58:03创建；parent8632为Session2的winlogon|
|WUDFHost8732|Session0，22:40:25创建；parent1452为services|
|当前会话|RDP Session2 Active；console Session1 Conn|
|远程显示|Microsoft Remote Display Adapter，Session2设备，2560×1494，WMI报告32Hz|
|远程显示驱动|Microsoft 10.0.26100.9711，rdpidd.inf，PnP服务WUDFRd|
|Intel|UHD630，30.0.100.9805；WMI另报告1024×768@60|

WMI设备模式不是客户端canvas节拍或物理扫描证明。WUDFHost受保护，普通只读查询未取得command line；UMDF Operational日志未开启。因此PID8732与rdpidd的对应具有时间和驱动框架证据，但没有获得进程内已加载驱动的直接映射。没有为此提权或开启日志。

旧case没有保存完整显示拓扑/远程连接状态，不能追认其具体尺寸或连接方式。已确认两批之间发生实际重连，而不是接收端launch参数改了。

|case及整个资源采集窗口|同PID8756|PID8732|
|---|---|---|
|latest1，22:35:10–22:36:26|75条存在，3D全0|不存在|
|fifo2，22:36:29–22:37:47|76条存在，3D全0|不存在，尚未创建|
|async sync，23:05:37–23:06:49|71条，均值8.924%|71条，均值2.208%|
|async worker，23:06:52–23:08:07|72条，均值8.561%|72条，均值2.115%|

上表包含启动/暖机/退出，口径不同于正式测量窗；正式45秒窗的DWM约10.83/11.06%、WUDF约2.72/2.73%，仍以async-marker-runtime.md为准。

原始边界进一步显示共同起落：sync的23:05:37两者0；23:05:39自有3D28.44%时DWM7.84%、WUDF2.48%。23:06:46自有3D已0，DWM0.034%、WUDF0.013%，此后三秒均0。worker从23:06:52的0升至23:06:54的DWM9.21%、WUDF3.13%；23:08:04–07自有3D及两者连续0。该行为支持实验动态内容触发显示链成本，不支持独立外部GPU程序常驻占用的说法。

## 接收端参数与最小下一步

两批保存的run.js具有相同launch和context创建代码：同一out/rel/chrome.exe、`headless:false`、两个context、接收viewport1440×1000、`--fake-vsync-rate=60`。两者均禁用native window occlusion、background timer throttling、renderer backgrounding、occluded window backgrounding，未请求use-angle/use-gl。没有新增窗口位置/显示器参数。原1920×1080/DPR1源及1936×1088媒体保持；async只在既有FIFO基础上加入marker读回选项及对应测量。

建议主Agent安排**同一当前RDP环境下，headed与headless的有界对照**，先做backend与功能门，再决定正式组。headless可以没有用户可见窗口，保留原像素、fake60、真实canvas和CRC。它不是零HWND方案：本地157的 `ui/views/win/hwnd_message_handler_headless.cc` 创建HWND后设 `DWMWA_CLOAK=TRUE`，避免显示在桌面。

Windows `chrome/browser/headless/headless_mode_init.cc` 没有Linux headless的强制SwiftShader分支，故硬件GPU可行；不能预先宣称backend相同。另有 `gpu/ipc/service/gpu_init.cc` 的headless关闭GPU watchdog差异。下一步须保存实际进程args及CDP `SystemInfo.getInfo` 的devices、GL/ANGLE renderer、featureStatus，结合VideoDecode引擎验证硬件解码，拒绝把SwiftShader/软件解码切换当作同backend优化。继续记录fake60实际rAF、原媒体/plane像素、paint RTP/epoch与CRC，不把headless启动成功当作验收通过。

如有backend变化，先报告主Agent决定；不自行添加ANGLE覆盖、断RDP、最小化用户窗口或扩矩阵。本调查没有启动该对照。

## 可复现材料

目录 `develop/tmp/gpu-environment-idle-20261101/` 保存resource-samples、idle-summary、target-processes、environment-state、pid-comparison、collection-boundaries；environment-state只保留必要事件时间/ID，没有保存远程用户或来源地址。

已有config/pids的该目录可再次运行：

```powershell
./tools/watch-streaming-resources.ps1 -Name gpu-environment-idle-20261101 -DurationSeconds 15
C:/src/depot_tools/python3.bat develop/tmp/gpu-environment-idle-20261101/compare.py
```

第一条会覆盖同名采样文件，正式复采应换新目录/Name并复制最小config/pids。历史PID比较脚本只读四个case原始JSONL，输出整个采集窗口的比较，不冒充正式45秒窗统计。
