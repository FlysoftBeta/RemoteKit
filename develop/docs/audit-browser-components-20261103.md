# Browser组件源码审计（2026-11-03）

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

本轮为只读源码审计；没有修改生产代码、构建、启动Browser或运行GPU/性能组。按当前新模型评估：每Tenant一个Browser进程，Browser属于Endpoint组件；Session是隔离边界，当前单Profile但不能据此固定最终层级。没有访问旧remotekit项目。

结论：发现3项P1（系统剪贴板绕过Session隔离、持久Profile的网络cookie实际仅内存、退出时pending popup晚于BrowserContext销毁），另有1项P2原子配置错误路径。不发现P0；“未发现”只指本轮审阅范围，不是全系统安全证明。下列问题均为代码推导，尚未用真实Browser重现，不能与既有运行验收混称。

## P1：默认系统剪贴板跨Tenant共享

- 位置：`browser/page_requests.cc:580`、`:582`、`:687`、`:689`；`browser/main_delegate.cc:47`的BrowserClient未覆盖剪贴板策略；整个`browser/`没有ClipboardNonBacked或SetClipboardForCurrentThread装配。
- 实际链路：页面编辑命令/键盘复制粘贴进入Chromium ClipboardHostImpl；固定基线`content/browser/renderer_host/clipboard_host_impl.cc:528`读`ui::Clipboard::GetForCurrentThread()`，`:882`走默认copy policy。默认`content/public/browser/content_browser_client.cc:1564`/`:1573`允许传递数据；`ui/base/clipboard/clipboard_win.cc:263`的Clipboard::Create返回ClipboardWin，后者`:121`使用Windows OpenClipboard、`:1405`使用SetClipboardData。
- 触发：同一Windows登录会话内，Tenant A正常复制文本，Tenant B在自己的网页正常粘贴；Browser进程不同仍共享系统clipboard。网页的真实键盘编辑路径已经足以触发，不依赖Control是否暴露page.command，也不要求启用网页异步clipboard权限。
- 坏状态：A的数据能进入B，且服务页面可能覆盖/读取宿主clipboard。“完整跨端剪贴板未装配”不能解释这个已有编辑路径的Session隔离缺陷。
- 建议：由root确定Session clipboard所有权；当前一Tenant一Browser可在服务进程UI/IO clipboard线程装配进程内clipboard后端，并在正确shutdown顺序销毁。demo如保留宿主clipboard，应显式分开。仅阻止某个page.command不足以覆盖键盘和renderer路径。未来单Browser多Profile时再明确Profile是否共享本Session剪贴板。
- 必要验证：两个真实Tenant分别复制/粘贴互不串扰；同Tenant两个Window可按产品语义共享；宿主clipboard不变；普通键盘、编辑命令、页面允许的异步clipboard、HTML/文本格式及Browser退出各覆盖一次。无需重跑性能矩阵。

## P1：Profile目录不等于持久cookie存储

- 位置：`browser/main_delegate.cc:81`的ConfigureNetworkContextParams仅设置UA、Accept-Language、zstd（至`:88`）；忽略BrowserContext、in_memory、relative_partition_path参数，没有设置NetworkContextFilePaths.data_directory、cookie_database_name或网络状态文件。
- 基线证据：`content/browser/storage_partition_impl.cc:3541`以全新NetworkContextParams调用embedder配置；其后没有替embedder设置cookie数据库。`services/network/public/mojom/network_context.mojom:282`明确cookie_database_name或data_directory为空即使用内存cookie；`services/network/network_context.cc:3386`据此决定持久cookie后端。
- 触发：网站设置带有效期的登录cookie，正常关闭/重启同Session Browser，再由Endpoint恢复同一Profile页面。DOM/导航恢复成功并不能恢复网络cookie。
- 坏状态：持久cookie丢失，用户登录会话无法跨Browser重启保留；网络服务重新建立时也没有磁盘cookie来源。不是跨租户泄漏，而是持久Profile基础能力缺口。Accept-CH当前内存策略已被文档明确标注，不能与此未标注cookie行为混淆。
- 建议：root确定持久网络状态契约后，在Profile/StoragePartition自己的路径下配置cookie及需要保留的网络状态，按官方Windows network sandbox路径迁移/权限机制接入；不要将多个Session或partition指向公共目录。普通persistent cookie与session-cookie恢复策略应分别决定。
- 必要验证：Max-Age/Expires cookie在同Profile重启后保留，另Tenant没有该cookie；显式session-cookie行为与产品策略一致；默认partition和非默认partition路径隔离；正常退出与异常Browser丢失分别验证。无需性能组。

## P1：退出时pending popup晚于BrowserContext销毁

- 位置：`browser/harness.cc:76`的State析构函数才pending_popups.clear；`:164`起PendingPopup持有真实WebContents和PageRequests。`PostMainMessageLoopRun`在`:1427`开始，先清正式page_requests/contents，再`:1440` contexts.clear，最后`:1443` state_.reset触发pending popup清理。
- 触发：有用户手势创建但尚未收养、仍在30秒期限内的popup，此时Endpoint要求正常shutdown或Browser主循环退出。控制连接关闭只取消正式page_requests，不清pending_popups；停止8ms维护timer后也不会再自然prune。
- 坏状态：BrowserContext及StoragePartition已shutdown/销毁，popup WebContents仍持有它们；后续popup析构访问已销毁上下文。固定基线`content/browser/browser_context_impl.cc:130`已对dangling RPH记录异常，WebContents持有上下文的生命周期本身也违反前提。具体表现可能是退出诊断、CHECK或悬空访问，尚未运行重现，不能断言必定某种crash。
- 建议：在正常内容与contexts销毁前，先解绑并销毁所有pending popup的delegate和WebContents，再跑必要deferred teardown。State析构兜底不能替代显式shutdown顺序；非正常启动失败路径也应共享同一资源清理顺序。
- 必要验证：一个pending popup未收养时正常shutdown；popup有导航/标准dialog时shutdown；已收养路径无回归；启动部分失败的析构顺序。CPU/mock生命周期测试可验证销毁顺序，真实Browser退出检查日志与退出码。

## P2：output.configure原子事务跳过可见性状态校验

- 位置：`browser/harness.cc:357`起viewConfigs只检验字段/geometry/closing，`:439`先提交specs；ApplyLayout在`:121`调用WebView::SetVisible却忽略Status。对照`browser/webview.cc:419`：unloaded或未完成restore的页不能显示；单独view.configure会在提交前检查SetVisible结果。
- 触发：已隐藏且unloaded/discarded的view，通过output.configure.viewConfigs把visible改true（输出已关闭、其余字段和PackAtlas合法）。
- 坏状态：命令返回ok，spec.visible/snapshot与atlas placement变为true，WebContents仍未显示或不存在；产品配置与真实执行状态不一致。该命令声称“先完整验证再一次提交”，当前只保证几何的原子性。尚未确认产品Endpoint正常路径是否会发出这种请求，因此定P2而非阻断现有首包/恢复验收。
- 建议：预检所有待显示view的生命周期资格，并在任何ConfigureDevice/specs提交前拒绝；或把“恢复后显示”建模为有完成状态的操作。不要只事后忽略失败或部分回滚几何。普通hide应继续允许不驻留view。
- 必要验证：混合live与unloaded两个view的事务拒绝后，specs、viewport、placements、可见性和输入token均不改变；恢复完成后的同一事务成功；pending/uncertain lifecycle同样拒绝显示。

## 文件与路径覆盖

| 范围 | 审阅内容与结论 |
|---|---|
| `browser/harness.cc/.h` | 启动单Session/Profile路径、并行vector归属、create/adopt、pending popup、close墓碑/ACK、recreate、page reply身份、恢复分块与配额、生命周期delegate解绑/重绑、output事务及shutdown。发现上述popup与事务问题。单Profile硬编码属当前限制；contexts按sessions索引的接口未来扩展多Profile需重构，当前不作为bug。 |
| `browser/webview.cc/.h` | contents创建/销毁、offscreen detach延迟删除、UA/device装配、owned navigation envelope、freeze/discard/restore/timeout/renderer gone、navigation revision和commit回调；输入专属由另一审计负责。Session/Profile/revision校验存在；POST自动恢复明确拒绝；失败进入uncertain不冒充live。 |
| `browser/navigation_state.cc/.h` | 全部capture/export/import/restore流程、pickle边界、PageState frame深度/计数/POST、namespace owner/context绑定。跨Browser sessionStorage无实现且已文档化，不报新bug。PageState不能恢复JS heap属机制边界。 |
| `browser/page_requests.cc/.h` | 标准dialog/beforeunload、close、frame/document取消、file异步验证及selected终态、menu、find、zoom、fullscreen、pointer/keyboard lock与popup收养委托。文件监听器按WeakDocumentPtr复验；同文档导航不误取消文件。未将允许本地管理路径视为网络任意文件API。发现剪贴板默认后端问题。 |
| `browser/browser_context.cc/.h` | Profile服务归属、上下文shutdown、site preference origin检查、首次导航/redirect UA/CH、client hints delegate。每Session独立进程/目录与当前一个Context相符；无跨Context服务单例。 |
| `browser/profile_services.cc/.h` | permission origin/embedding/feature-policy/document订阅、worker来源、grantable白名单、download HTTPS链检查、独占目录分配、异步target回调、quarantine、shutdown回调。后台服务未装配与grantable部分能力不等价，文档已说明规则不创建API后端；保留为能力差距。 |
| `browser/compat.cc/.h`、`compat_renderer.cc/.h` | Google Chrome品牌元数据、按Context的内存CH opt-in、native app stub、context替换后异步callback不重入、每world loadTimes/csi。未建立完整Chrome差分属于已知覆盖差距，未把stub当完整扩展框架。 |
| `browser/main_delegate.cc/.h`、`main.cc`、`BUILD.gn` | content embedder入口、生产/demo目标、GN依赖、AudioManager替代、网络Context、UA、服务input marker与默认capture features。没有Chrome Browser/BrowserView对象装配。发现网络cookie持久化缺口。 |
| `browser/audio_target.cc/.h` | 自有AudioOutputStream、48k stereo converter/mixer、10ms调度丢旧周期、独立共享环、mapping身份验证及audio线程attach/shutdown。音频manager为进程单例；在一Tenant一Browser生产模型下不等于跨Session混音，demo不覆盖该AudioManager。SDK/Endpoint音频消费由其他审计负责。 |
| `browser/offscreen_host.cc/.h` | 虚拟Screen/Focus/Parenting、null accelerated widget、contents销毁前host保留、generation与ACK、绝对deadline、pending BeginFrame合并、render demand。当前未发现新增明确bug；无页面HWND不等于进程零HWND。 |
| `browser/gpu_atlas.cc/.h` | capture绑定/几何门禁、单平面资格与fallback、stop/reconfigure/device-lost、source read lease/consumed lease、三槽、共享句柄、真实Fence和退役。未见用CPU发布替代GPU完成；consumer消失时未完成lease保留是保守策略，不能建议超时后直接复用。GPU writer细节与媒体SDK专项仍需对应审计/实验。 |
| `browser/control_server.cc/.h`、`devtools.cc/.h` | 单本地Mojo连接、输入/输出1MiB界限、每turn16消息、UTF8 JSON、disconnect、demo-only loopback devtools。没有发现新增网络入口；本地channel随机标识不是网络鉴权。 |
| `browser/capture_render_rate_probe.cc`、`browser/testdata/*` | 定位为测试/probe输入，非生产能力验收；未运行。`browser/sdk/*`明确不在本报告详细审阅范围。 |

## Chromium patchset核对

执行只读命令`C:/src/depot_tools/python3.bat tools/patchset.py --chromium-root C:/src/chromium/src status`：manifest中0001–0009全部显示applied。未apply/reverse、未修改tracked源码、未stage、未build；本轮status不替代历史隔离撤回/重放验收。

- 0001：审阅admission pending计数、Stop弱回调取消与有界合并refresh；Feature默认关闭。计数是capture到ordered delivery，不是GPU完成凭证。
- 0002：核对文件清单及GPU trace回调所有权意图；GPU finished/submit的设备后端逐分支不在本轮完成实测。没有把profile elapsed当纯CopyOutput成本。
- 0003：仅root widget传空handle，默认关闭；正式offscreen host本就返回null widget。未改变capture lease语义。
- 0004：审阅captured subtree throttle设置/清除和max interval组合，默认关闭；probe不等于GPU实验。
- 0005：审阅fake-vsync绝对deadline、waitable timer/Sleep fallback、高精度timer成对请求和suspend/idle重建。只影响fake-vsync分支；没有追加A/B运行。
- 0006：审阅rVFC feature门禁、stale frame计数和callback存在条件；不把callback数当真实显示FPS。
- 0007：重点审阅pool Generation强引用、三槽busy/return、unexpected disconnect封闭generation、capturer配置/换代/失败、Oracle成功失败恰一次结算和相关CPU回归代码；同时核对其Mojo、CopyOutput、Skia/Surface文件清单。外部destination GPU写入的Ganesh每条底层分支没有本轮重新做硬件实证，不能以此报告覆盖GPU专项。Surface中有大批加括号格式改动，增加patch维护噪声，建议后续维护时单独清理，未定为功能bug。
- 0008/0009：审阅dispatch返回与同步ACK区分、service固定96逻辑PPI、invalid host PPI逐轴fallback及新增官方unit用例；输入深层正确性由另一审计专项处理。

## 分界与后续

认证/证书选择、目录上传、PDF/打印、多Profile、跨Browser sessionStorage、原生popup widget像素和完整IME是现有明确保留能力，不因没实现而逐项报成新bug。当前没有证据支持跨Tenant网络/DOM存储串用；系统clipboard是独立于BrowserContext路径的真实隔离遗漏。

建议root先裁定P1隔离与持久Profile契约，再委派有界修复及必要功能测试。报告本身不阻碍4de343c已上传版本，不要求重跑用户取消的稳定性/性能组。
