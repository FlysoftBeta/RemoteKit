# 无显示器 Chromium 接收端：官方模拟刷新可直接试用

2026-11-01。第一阶段完成只读调查；第二阶段取得唯一GPU窗口后，通过官方host-managed Playwright进行了既有binary能力预检。没有构建、修改Chromium或运行完整串流。已读 AGENTS、current-state 与 client-cadence-next。

## 已运行：既有 binary 模拟刷新预检

官方 `--fake-vsync-rate=60` 在本机有效。首组空页RAF56.89Hz，简单1280×720动态canvas提交57.36FPS；另两次canvas确认57.30、57.33FPS。连续10秒的各秒计数为56–58，所有组零longtask，document均visible、hasFocus=true。

| 既有157客户端 / 10秒阶段 | RAF Hz | canvas提交FPS | 相邻canvas提交p95 ms |
| --- | ---: | ---: | ---: |
| synthetic60，空页RAF | 56.89 | — | — |
| synthetic60，动态canvas | 57.35 | 57.36 | 18.20 |
| 无fake开关，空页RAF | 51.07 | — | — |
| 无fake开关，动态canvas | 52.12 | 52.12 | 20.90 |
| synthetic60，再次确认1 | 57.06 | 57.30 | 18.30 |
| synthetic60，再次确认2 | 57.18 | 57.33 | 18.10 |

157无fake组也比此前89的32Hz快，符合157在fallback中已请求高精度timer的源码差异；本轮没有取trace直接测其默认fallback内部，所以不把具体默认等待分支写作新实测事实。

Browser.getVersion为 `Chrome/157.0.8103.15`，revision为全0，ANGLE_D3D11 / Intel UHD630 / 驱动30.0.100.9805，directComposition=true、GPU compositing及2d_canvas enabled。CIM捕获GPU PID4836、父PID10448、session2的实际命令行，明确含 `--type=gpu-process --fake-vsync-rate=60`。窗口1440×1000 viewport，DPR约1。

本轮复用既有能力预检产物，**不算干净当前源码验收**。所有组使用host-managed Playwright的新临时Profile；harness自身默认参数及沿用的可见性/自动播放参数完整记录在raw JSON，没有增加unlimited、disable-vsync或软件GPU强制开关。GPU实际仍为Intel硬件。canvas统计是实际绘图调用完成后的提交时间，不是物理scanout，也没有运行视频/marker延迟验收。

证据目录：`develop/tmp/chromium157-synthetic-vsync/`。`synthetic.json`、`default.json`、`synthetic-confirm.json`、`synthetic-final.json`有逐帧时间、summary、Browser.getVersion、SystemInfo和完整浏览器命令行；`synthetic-processes.json`是实际Win32进程命令行。driver文件保存了host入口。初次尝试用同轮短延迟CIM没有撞到launch窗口；之后先启动有界CIM观察再launch成功，不影响所报告组。另一次尝试从host VM动态import读取CIM被VM拒绝，finally已关闭该browser，没有绕过宿主限制。

所有自建browser均在finally中关闭，host `browser_close`也已执行；最后Win32进程枚举无chrome.exe。GPU窗口已交还主 Agent，未启动其他服务。

## 结论与下一步

当前 Chromium 157.0.8103.15 基线已经有 Windows 专用 `--fake-vsync-rate=60`。它绕过硬件 VBlank/compositor-clock 等待，按指定周期走相同的 VSync observer、Viz BeginFrame、renderer BeginFrame 通路；不是无限帧率开关。无需为这项能力添加新补丁。

后续CPU窗口已完成当前源码的out/rel增量chrome构建，ProductName及生成header恢复为Chromium，详见[配套构建记录](receiver-incremental-build.md)。上面的57.3FPS数据仍属于之前旧binary预检，新binary需由后续runtime实测，不混用。

`C:/src/chromium/src/out/rel/chrome.exe` 已存在，版本资源为157.0.8103.15，chrome.dll与资源齐全。最小实验可直接指定该 executable，在独立新 Profile 的 headed 客户端上增加这一项开关，先做空页 RAF，再测同分辨率、marker、RTT/带宽和1/4租户。等待主 Agent 从 runtime Agent 交接 GPU 窗口之后运行。

现有二进制 ProductName 为旧构建留下的 `PRTS`，不是当前 RemoteKit 新编译产物。这里只确认它是可尝试启动的完整既有 Chromium 布局，不把资源版本当成已完成当前源码与二进制逐字对应验证。已有小型 GL object 含 `fake-vsync-rate` 与 `GetFakeVsyncIntervalFromCommandLine`，表明这项能力在增量产物中已编译；正式运行时仍需记录实际 Browser.getVersion、GPU commandline 与节拍。

## 代码通路与作用范围

所有源码路径以下相对 `C:/src/chromium/src`。

| 位置 | 行为 |
| --- | --- |
| `ui/gl/gl_switches.cc:217,238`、`.h:107` | 开关接受正数 Hz；列入从 GPU host 复制到 GPU 进程的 GL switch 清单 |
| `ui/gl/vsync_thread_win.cc:113` | 先检查 fake interval；存在则跳过 DXGI/DComp `WaitForVSyncImpl`，进入有等待的 Sleep 分支 |
| 同文件 `:155` | Sleep 周围成对 `ActivateHighResolutionTimer(true/false)`；157已具备89缺少的这一请求 |
| 同文件 `:170` | 用实际 `TimeTicks::Now()` 和指定 interval 通知同一 observer 集合 |
| `components/viz/service/frame_sinks/external_begin_frame_source_win.cc:37` | VSync跨任务投递到Viz序列，生成 BeginFrameArgs，经 `ExternalBeginFrameSource::OnBeginFrame` 广播 |
| `root_compositor_frame_sink_impl.cc:207,249,657` | 支持DComp时选择这个外部源；同一源交给 DisplayScheduler 并注册到 FrameSinkManager |
| `compositor_frame_sink_support.cc:1254` | 把调整后的 BeginFrame 发送给 renderer compositor client，继续驱动页面动画/RAF |
| `ui/gl/dcomp_presenter.cc:291,332` | 同一个VSync线程也驱动 pending frame 的 presentation feedback，时间戳/interval用于反馈 |

这覆盖正常 headed Windows DComp 客户端的 Viz显示调度及renderer帧生产，rVFC仍是实际视频呈现回调。它没有保证每个输入视频帧都被绘制；解码/GPU负载、frame-interval决策、可见性仍会影响真实吞吐。因此要同时记录 RAF、rVFC、canvas提交和marker p95。

需要保留正常DComp/GPU路径。若主动禁用DComp或GPU，RootCompositorFrameSinkImpl可能选择 DelayBasedBeginFrameSource，便不是上述VSync observer通路。不要加 `--disable-frame-rate-limit`；该开关走 BackToBackBeginFrameSource，并隐含禁用GPU VSync。也不要加 `--disable-gpu-vsync`。

当前Windows feature `UseCompositorClockVSyncInterval` 默认关闭，而且要求WIN11_24H2；默认仍为DXGI VSync线程。fake分支位于这两个派生实现之外，所以两者均可绕过。无需切换该feature。

## 与真实显示输出的共存

开关按进程启动参数生效，未带开关的浏览器继续真实VBlank/compositor-clock路径，不修改桌面模式、显示驱动或系统永久timer策略。带开关的GPU进程内所有相关窗口共享同一VSync singleton，因此它是客户端实例级选择，不能在同一实例中逐窗口选择模拟/真实刷新。

真实显示器存在时它仍会强制模拟，实际物理scanout继续由系统显示管线决定。无屏服务器验收应标记为“Chromium157 / synthetic60”，报告实际canvas与marker结果，不把软件presentation feedback描述为物理屏幕亮起的时间。

官方实现目前是每次 `Sleep(ceil(interval_ms))` 再发送实际唤醒时间，60Hz即Sleep17。它没有绝对deadline补偿，因此实际常见上限接近58.8Hz，再加调度开销；这仍可能足够≥50FPS。源码不能证明本机会稳定达到该值，必须先测。现阶段不要求改成精确60.000Hz。

## 既有 rel 增量状态

`out/rel/args.gn`：release、非component、非official、symbols0、use_siso=true；H.264/proprietary_codecs已启用，ffmpeg_branding=Chrome；还保留既有Widevine配置。不要为了这次探针改args或生成新out目录。

| 产物 | 大小/状态 |
| --- | --- |
| chrome.exe | 3,104,256字节；2026-10-30 |
| chrome.dll | 340,948,992字节；2026-10-30 |
| chrome_elf.dll | 1,592,832字节；存在 |
| resources.pak / icudtl.dat / v8_context_snapshot.bin | 均存在 |
| locales/en-US.pak | 603,563字节；存在 |
| obj/ui/gl/gl/vsync_thread_win.obj | 65,267字节；2026-10-28；含fake interval helper引用 |
| obj/ui/gl/gl/gl_switches.obj | 26,154字节；2026-10-26；含开关字符串及helper符号 |
| content_shell.exe | 不存在；build.ninja有content_shell目标，但没必要新补这个客户端 |

预检已直接用既有chrome，无构建。现有Playwright harness的 `executablePath` 改为上述chrome.exe，保留其headed和正常参数，仅追加 `--fake-vsync-rate=60`，使用新的测试Profile。可人工启动的等价入口如下；自动化时用harness管理生命周期，不把旧Profile带入。

```powershell
& C:/src/chromium/src/out/rel/chrome.exe --user-data-dir=C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/chromium157-synthetic60-profile --no-first-run --no-default-browser-check --fake-vsync-rate=60 http://127.0.0.1:3001
```

需要重编现有客户端时，主 Agent 安排无采样窗口后，保持args不变，在源码根运行下列增量目标即可；不clean、不全量、不与另一gen/build共用out/rel。

```powershell
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:vs2026_install = 'C:/Program Files/Microsoft Visual Studio/18/Community'
& C:/src/depot_tools/autoninja.bat -C out/rel chrome
```

不建议为独立Chrome接收端调用 `tools/chromium.py build --target chrome`：该工具同时stage RemoteKit overlay并补充root_extra_deps，给纯客户端构建增加无关变动。现有out/rel的build.ninja已有chrome目标，GL静态库是 `obj/ui/gl/gl_wrapper.lib`，涉及代码变化时正常增量最终链接chrome.dll。

## 精准模拟刷新补丁（精度请求修正已编译）

后续runtime测得已有fake60的RAF约56.5、video counter约55而canvas约47；fake120可使canvas约51.98/p95约76ms，上游约54.3不变。主 Agent因此选择先把模拟60Hz本身改为准确phase，不改rVFC或renderer算法。这里的后续数值来自主 Agent交接摘要，不混入上表空页预检。

已在Chromium `ui/gl/vsync_thread_win.cc/.h`实现fake-only等待，生成 `patches/0005-synthetic-vsync-deadline.patch`，当前SHA256 `f90452cb86b58970f4162a1eb8c350f99f0d33f28c45b1992c3a099f8e345ebd`，追加为manifest第五项，原四项内容/hash/顺序保留。

- 首次、observer集合清空、suspend或任务长闲置（至少四周期）后，从当前单调时间+interval建立phase。
- 以绝对deadline计算每次剩余时间，懒创建带 `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION` 的auto-reset一次性timer；创建失败尝试普通timer，arm/wait失败回到原Sleep机制。
- 每次真实醒来后按整数interval跳过过期槽，下一deadline严格在未来；任务进来时已经迟到也跳过过期槽，不burst、不把每轮Sleep向上取整累计进phase。
- WaitForSingleObject超时限于当前剩余周期的毫秒向上取整；不使用INFINITE，不引入超出原Sleep周期的固定长等待。整个fake等待期间保留旧Sleep路径成对 `ActivateHighResolutionTimer(true/false)` 请求，不论采用waitable timer或Sleep；Sleep降级内部不再嵌套请求。
- 保留原WaitForVSync尾部的实际TimeTicks::Now()通知、PostTaskIfNeeded/observer停等逻辑。timer周期参数为0，idle没有新增循环唤醒。handle仅在VSync线程访问，由ScopedHandle持有，声明在Thread之前，保证比线程存活更久。

源码自审确认：真实DXGI/DComp等待分支及其Sleep fallback没有变；保护phase重置位的锁不跨等待持有。fake分支将interval统一限制为至少1ms，同一个值用于等待与Notify；60/120Hz不变，极高Hz也不会因取整为0而空转，helper以DCHECK检查正值。SetWaitableTimer使用负100ns相对时间，phase仍由单调TimeTicks决定，不依赖墙钟。高精度timer创建失败会尝试普通timer；Set/Wait运行期失败则直接使用Sleep降级。

正式 `tools/patchset.py record`新增显式id/file生成入口，只接受root内tracked文件，拒绝与前序patch文件重叠，使用literal pathspec限定diff，并原子更新manifest。6项工具测试通过（含新patch顺序/roundtrip与重叠/未跟踪拒绝），patchset status五项全部applied；Chromium clang-format与diff check通过。

主 Agent接受独立审阅与1ms边界修复后，已在唯一CPU窗口执行 `autoninja -C out/rel chrome -j 16`：56步/43.77秒成功，skip97,677；未修改args、gen或clean。新chrome.dll SHA256为 `a0f2e596eb42fed41ccc69faa53a97db195e5ed971d04862cee8f3002cbe6637`，exe壳hash仍为 `f833f59831e7d428e1527bf1e12c0d4a2b338a0cbd4239a050f280c1c62ea62a`，均Chromium157.0.8103.15。out/dev与SDK未动；未启动浏览器/GPU，真实节拍与串流交由runtime后续检查。记录位于 `develop/tmp/receiver-incremental-build/synthetic-deadline-*`。

该次构建对应旧0005 hash `9215c41dddf06248a5b743a57c7c7777e0b2f18b9a09c4981d7a05a85002239a`。后续源码审阅发现它除改cadence外，还取消了旧Sleep等待期间的进程高精度timer请求；当前修正版把请求移到整个fake等待循环之外，保留旧语义。循环内只有continue或break，没有提前return；所有break到达唯一false配对，Sleep没有第二次请求，方法返回前恢复。它是否影响同GPU进程延迟任务或解释实测延迟，需要后续A/B，尚未确定根因。

当前f90452修正版已在唯一CPU窗口增量编译：48步/33.56秒，skip97,685，外层34.711秒；没有gen、clean、改args或out/dev/SDK变化。最新chrome.dll SHA256 `5809b86306592699ceb34aa75546411c77782550cd8800b75eca153ab1dc3332`，exe壳hash仍为上面的f833f598；未启动GPU/浏览器，不预称性能改善。记录位于 `develop/tmp/receiver-incremental-build/synthetic-paired-timer-*`。

## 清除旧产物来源的增量方案与成本

当前tracked `chrome/app/theme/chromium/BRANDING` 已是官方Chromium，`build/config/chrome_build.gni`也是基线、无本地diff。当前args没有PRTS自定义GN项；旧项目注释不是编译开关。`is_chrome_branded=false`、H.264 codec、release/O2、非component及symbols0都可保留。Widevine/CDM几项来自既有配置，串流接收页不需要，后续宜删除这些显式启用项并采用官方默认；变动涉及CDM边界，不应为改产品名而翻转整个branding编译flag。

首次调查直接发现陈旧生成输入：`out/rel/gen/base/version_info/version_info_values.h` 的PRODUCT_NAME及 `out/rel/gen/chrome/common/chrome_version.h` 的产品名为PRTS，而源BRANDING为Chromium。后续正常增量已把这些header及产物恢复为Chromium，详情见配套构建报告；旧binary预检结果仍单独保留。

建议在主 Agent 分配的无采样构建窗口，备份args后移除不需要的CDM业务配置，保留影响绝大多数编译命令的release/optimization/compiler参数，正常 `gn gen out/rel` 再单次 `autoninja -C out/rel chrome`。GN与Ninja应按当前依赖更新品牌生成header、版本资源、受旧tracked代码恢复影响的对象及chrome.dll/exe最终链接。不要clean整个out，不删对象，不用 `is_chrome_branded=true`。

若官方BRANDING生成规则因时间戳没有重跑，需要先看图/dirty原因，再定点触发该规则的官方输入；不能把手改gen header当修复。gen header依赖面比单纯资源更广，可能重编版本信息消费者；当前大量已有对象仍能复用。此次没有gen、Ninja或dry-run，也没有读取deps数据库做数量估算，因此不承诺分钟数或“只重链”。准确任务数量在无采样窗口用允许的dry-run确认，若出现大范围全量迹象应先检查参数/依赖原因，不执行全量替代。
