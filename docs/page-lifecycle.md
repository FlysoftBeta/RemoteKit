# 页面生命周期与自动回收

WebView 是稳定的逻辑身份；WebContents 是可以冻结、丢弃、卸载和重建的执行实例。本文描述可见性、四种生命周期动作、Control 的回收策略、状态不确定时的恢复，以及导航状态的导出与恢复。

## 四个独立的轴

| 轴 | 决定者 | 作用 |
|---|---|---|
| 产品 visible | Control：活跃 Viewer 连接 + 实际显示的 Window + 其 activeTab | Browser 调 `WasShown/WasHidden`，驱动 Blink 后台调度和 renderer 进程优先级 |
| 输入焦点 | 焦点租约 | widget Focus/Blur/SetActive；多个 Window 并排时，失焦的 Window 仍然 visible |
| 渲染需求 | RTC 状态 | 有连接、已授权才渲染和编码 |
| 驻留状态 | 生命周期动作 | live / frozen / discarded / unloaded |

Viewer 的 WebSocket 断开使 visible=false，并使页面获得回收资格；RTC 断开只停止渲染/编码，**不改变**产品 visible，也不能反过来把 hidden 页面显示出来。打开设置对话框只是覆盖层，不改变远端 viewport。进程内其他可见页面或媒体可以让共享的 renderer 保持高优先级；PID 可能被多个 WebView 共享，不能当作单页资源用量。

## 生命周期动作

| 动作 | 实际行为 |
|---|---|
| freeze | 向当前所有相关 RenderViewHost（主、OOPIF、推测）发冻结请求，等待每个请求的精确 renderer ACK |
| discard | 官方 `WebContents::Discard`，保留 WebContents 与 controller；恢复时 `LoadIfNecessary`，等待非错误的主 frame 提交 |
| unload | 保存导航关联后销毁执行实例，保留逻辑 WebView |
| restore | 为原 WebView 重建或恢复实例、应用配置，完成后才显示 |
| close | 正常的 beforeunload 确认后删除逻辑页；与回收不同 |

状态值：0 live、1 frozen、2 discarded、3 unloaded。每个 view 分别记录 desired、actual、pending、`lifecycle_generation`、`last_lifecycle{succeeded, detail}`、`lifecycle_uncertain`。actual 只在确认成功时改变；accepted 不能推断 renderer 已完成。生命周期请求使焦点失效；discard/unload 增加 instance 与 document 代次。

普通冻结、丢弃和恢复使用当前页面的生命周期接口；观察到的代次只用于 Control 重试单元的输入身份。只有不确定状态恢复中的 unload/restore 才在线上携带 `lifecycleGeneration`，由 Browser 校验恢复代次与状态。

**冻结 ACK**：每个 ACK 绑定请求序号、RVH 弱引用和 PageBroadcast 连接代次（patch 0015），旧响应不能证明新请求完成。50ms 轮询，10 秒期限。

**冻结期间的竞争**：冻结过程中发生导航或保护条件变化时，先排空已发送且仍属于当前页面的冻结请求，再逐个 RVH 发解冻并等待新的精确 ACK。这次冻结以失败结束，但页面确定是 live，JS 堆保留。解冻不受"页面必须空闲"的冻结资格限制。旧实现把所有失败都标记为 uncertain，包括这种可恢复的竞争。

**不确定**：真实的 ACK 超时、生命周期期间 renderer 退出、已冻结的 renderer 退出，都标记 uncertain。迟到的 ACK 不能追认超时的操作已完成。

## 资格

Browser 的 `CanDiscard` 暴露资格，并在执行点用 `CheckQuiescent` 再查一次，避免自动冻结取消刚到达的页面对话框。阻止条件包括：非隐藏或非 live、导航或 pending entry、音频/视频/采集/画中画/全屏、关联的活跃 WebContents、文件系统/内嵌 contents、设备使用、输入锁、页面请求、beforeunload、触控清理未决。

普通表单编辑（没有 beforeunload）目前没有单独的"脏表单"保护，这比 Chrome 的完整策略窄。没有引入 Chrome 的 Performance Manager：content 层已经提供基本的后台行为，RemoteKit 自己负责远程服务的计时与保护策略；Chrome 的 2–6 小时等待/回访豁免不适用；没有可靠的逐页 CPU/RSS 计量，所以也不打分。

## 自动回收（Control）

回收没有用户开关，由 `workspace/reclaim-policy.ts`（纯函数）根据统计与节点压力决定；`lifecycle.ts` 用 Control 本地单调时钟累计每个标签"可回收"的时长：

- **标签**：后台、不可见、没有原生保护的标签在累计可回收 F 后 freeze、累计 D 后 discard（冻结后继续计时）。基准 F = 30 秒、D = 120 秒；该用户可见停留总时长排前 20%（且总计 ≥ 5 分钟）的页面 ×4；节点持续有压力时 ÷4；下限 10 秒与 30 秒。在线页面和 Viewer 断线后的页面共用这套策略。
- **整个 Session**：Viewer 离开后，用该用户已完成的离开时长做经验生存函数 S(t)。离开了 a 时，若"接下来 5 分钟内回来"的条件概率 (S(a) − S(a+5 分钟)) / S(a) < 0.2 且 a ≥ 5 分钟，就停止并提交；节点持续有压力时阈值 0.5、a ≥ 2 分钟。离开超过历史上最长的一次时，按"不会马上回来"处理。已完成的离开少于 20 次时用固定的 10 分钟。
- **统计**：`viewer_presence(tenant, connected_at, disconnected_at)` 每次 Viewer 连接一行（保留 90 天、每用户最多 2000 行；Control 每 10 秒记一次心跳，重启时用最后一次心跳关闭未结束的行）；`page_dwell(tenant, page_key, visible_ms, visits, last_visible_at)` 在标签真正可见（Viewer 在线且已解锁、窗口可见、是活动标签、在活动 Space）时累计，每用户最多每 10 秒写一次。`page_key` 与使用记录的 URL 规范化相同。
- **挂机模式**（标签设置 `idleKeepAlive`，浏览器窗口"更多"菜单里的"挂机模式"，开启时标签上有图标）：该标签不会被 freeze/discard，所在 Session 在可回收满 30 分钟前不会被停止，不论统计结果与普通的节点压力；只有资源硬耗尽（节点可用内存 < 5%，或 Endpoint 报告分配失败）可以越过，并记录下来。每个挂机标签记录 `{开启时间, 可回收起点, 结果: 保持运行|冻结|丢弃|停止, 时间, 原因: 统计|压力|耗尽}`；用户回到这个标签时，窗口上显示一次说明（10 秒后自动消失，可关闭）：保持运行时显示离开期间运行了多久，被回收时显示时间与原因，并说明页面已重新打开、页面内未保存的状态可能丢失。普通标签被回收后照常静默恢复。
- 安全资格使用 Browser 的 canDiscard。媒体、采集、页面请求、关闭或恢复、可见、canDiscard 失败会清空计时；策略自己发起的 freeze 处于 pending 期间暂停累计而不清零。
- 计时绑定 Browser incarnation 与执行实例；对象缺失、重新显示、超过 15 秒的观察间断都清零——宿主睡眠或长时间失联不能被当成持续的安全闲置。计时不持久化，也不以绝对时间跨机器传递。
- 维护周期约 1.5 秒；生命周期请求另有 12 秒的节流。
- 重新可见时先恢复：等待 actual=live 且 pending=false 再显示。失败或不确定时保留原因显示在 Tab 上，不伪装成功。

曾经 Browser 实现了 freeze，但 Endpoint 的允许动作列表里漏了它，策略根本执行不了：辅助函数存在不代表端到端的方法被放行。

## 不确定恢复

uncertain 的页面不重复破坏性请求，而是走一个持久化的恢复流程：

```
lifecycle_uncertain
  → Control 持久化 {phase: unloading, browserIncarnation, lifecycleGeneration, submittedAt}
  → view.lifecycle{action: unload, requireRunning: true, browserIncarnation, expected generation}
     Browser 执行点要求：无 pending、未关闭、代次精确匹配、有可自动恢复的导航 checkpoint
  → 观察到确定 unloaded
  → 若该 Tab 当前应可见：持久化 {phase: restoring} → restore（只接受同实例下确证 unloaded 的新代次）
  → 观察到 live
```

- 每一步在发送前持久化阶段；回执丢失时只从精确快照收敛，不重发未知变更，也不重放旧导航。
- 15 秒内没有证据则显示 Tab 级错误，允许关闭后重新打开。
- 新的 Browser incarnation 让旧的恢复意图退役。
- 恢复期间阻止临时空白 URL/标题/历史覆盖已保存的产品状态。

## 导航状态导出与恢复

**捕获**（Browser `NavigationState`）：已提交的历史条目、选中索引、redirect 链和 renderer 报告的 PageState（用 Chromium 的序列化导航构建器），以及 view 的 sessionStorage namespace id 与 StoragePartitionConfig；外层信封绑定格式版本（2）、Chromium revision、Session 和 Profile，旧版本信封直接拒绝。只恢复导航状态和 sessionStorage，不恢复任意 DOM、JS 堆或网络连接。

**sessionStorage**：content 层只把 `SetShouldPersist(true)` 的 namespace 写入 `Session Storage/`。Browser 优雅关闭时把所有保留的 namespace 标记为持久；导入时先 `RecreateSessionStorage(id)` 再用得到的 namespace 创建 WebContents，所以跨 Browser 进程、跨节点都能恢复。被产品关闭的 view 取消持久化。一个 Browser incarnation 的全部恢复完成后，Endpoint 发一次 `storage.scavenge` 清理不再使用的 namespace；在此之前清理会删掉尚未恢复的数据。

**限制**：传输分块 256KiB，总量 64MiB；最多 1024 条历史、每条 16MiB、1024 条 redirect/扩展字段、PageState 深度 128 / frame 数 4096，在解码前检查。导入要求 view 处于 unloaded。

**新鲜度**：Browser 的 `navigationRevision` 在新文档、同文档 history（pushState/replaceState/back）和 PageState 更新时都会增加。Endpoint 按导出时的实际 revision 和 Browser incarnation 保存，不用 document 代次当脏标记；进程替换清除旧 revision 缓存。曾经每个文档只导出一次，漏掉同文档历史和后来的表单/滚动状态。

**节奏**：导出由 Endpoint 调度线程拥有，每 Session 同时一个传输，每次维护 tick 推进一块；候选最多 256 个、轮转选择；任务 60 秒期限，发布完整的替换文件之前重新校验身份。快照只观察和登记导出，不在快照里排空大导出（曾经这样做阻塞了其他工作）。pending/uncertain 的生命周期取消导出并保留上一个完整文件。

**恢复**：同样分阶段推进（load → settling → unload → begin → chunks → commit → restore → waiting → visible → complete；settling 最多等 1 秒初始加载，waiting 最多 11 秒），每个维护 tick 只推进一个 view 的一个阶段，所以收敛不需要等每个页面的网络提交。普通失败转入 fallback：用产品 URL 发一个新的 GET。曾经 4 个慢页面每个同步恢复约 11 秒，超过 Control 请求超时，并通过全局调度线程阻塞其他 Tenant——加长超时不是解法。

## Profile 持久化

- `ProfileNetworkState` 拥有 OSCryptAsync、RemoteKit 的 `ProfileKeyProvider`、cookie 加密绑定和 StoragePartition 网络路径。只有 Profile 目录并不会有持久 cookie：NetworkContext 需要显式的 cookie 数据库路径。
- 交给 renderer 的可写文件句柄（File System API 等）在 Windows 上要加禁止执行的 ACE，base 只允许在 TEMP 和嵌入方登记的一个数据根下这样做。Browser 启动时把 `--data-path` 登记为该数据根（PathService 键 16000 + `SetExtraNoExecuteAllowedPath`）；否则数据目录不在 TEMP 下时，任何用到这些 API 的页面（例如 Cloudflare 人机验证）都会让 Browser 因 CHECK 失败退出。
- Cookie 密钥由 Control 从 Tenant DEK 派生，经只继承给 Browser 的匿名管道传入（`--profile-key-handle`），Browser 在创建 BrowserContext 之前读出恰好 32 字节，只保存在内存里（`ProfileKey`，销毁时清零）。提供者标签 `rk1`、AES-256-GCM、唯一一个提供者。磁盘上没有任何密钥文件，也不依赖 DPAPI，所以 Profile 目录可以搬到另一台机器的另一个路径；单独拿到目录无法解密 Cookie。密钥不对或缺失时启动失败，不退回明文或内存存储。
- 会话 cookie 跨 Browser 重启保留（persist/restore_old 打开）：Browser 的关闭多半是回收停止而不是用户关闭浏览器。
- 优雅关闭（`browser.shutdown`）：停止接受新命令（之后一律 `unavailable`），持久化 sessionStorage namespace，直接销毁 WebContents（不运行 beforeunload），在 10 秒内等 cookie 与各 StoragePartition 的 flush 回调，退出码 0；任一步失败以退出码 70 退出并记录失败的步骤。Endpoint 只把退出码 0 且作业为空视为干净关闭；强制终止会跳过这些 flush。
- 剪贴板不用系统剪贴板（不同 Tenant 的 Browser 进程会共享同一个 Windows 剪贴板），而用 Chromium 的 headless 内存剪贴板（`ClipboardNonBacked`），UI 与 IO 线程各一个。它只是 Control 剪贴板的缓存，见 [Control · 剪贴板](control-plane.md#剪贴板)。
- 关闭顺序：`PostMainMessageLoopRun` 先关闭生产者，解绑 delegate 并取消请求，销毁 pending 弹窗和正式 contents，排空延迟的宿主删除，最后销毁 Context 与 Screen。成员声明顺序不是关闭协议（曾经 BrowserContext 先于 pending 弹窗的 WebContents 被销毁）。

## 权限、下载与页面命令

- `ProfilePermissions` 使用 Control 同步的站点规则和当前文档的临时许可。地理位置、剪贴板读取、本机字体、窗口管理、MIDI 和空闲检测可触发权限提示。活跃文档、Permissions-Policy 和 worker origin 检查仍然生效。宿主设备隔离独立于权限决定，见[兼容性 · 宿主设备隔离](compatibility.md)。
- 权限、HTTP 与代理登录、POST 重提交、协议处理器注册都走文档绑定的页面请求。权限或协议规则同步时可结清已决定的请求。重提交操作在用户决定前保持待定，取消会结清原操作。
- `ProfileDownloads` 在 `Profile/downloads` 分配唯一目标名和 `.crdownload` 中间文件。网络下载要求 HTTPS，由 HTTPS 页面生成的 `blob:`、`data:`、`filesystem:` 下载也允许。超过 256 MiB 会取消。完成事件保留至 Endpoint 确认，Endpoint 导入租户对象存储并清理 Browser 副本，Control 把条目放入「我的文件」。导入未结清期间阻止停止。
- `page.command`：back/forward/reload/stop（走导航操作账本）、find/stop_find、zoom/get_zoom、copy/paste/cut/select_all。find 在回调之前登记请求身份，因为回复可能同步；替换 find 会话会丢弃旧回复，最终回复不保证到达。

## 尚未实现

多 Profile（当前每 Session 一个 Profile，层级上保留余量）、跨 Browser 的 sessionStorage、原生 popup widget 的像素与命中、目录上传、剪贴板图片格式与跨端同步、PDF 与打印、原生长按、IPC 传输故障后同一 Browser incarnation 的重新附着。
