# 工作区：App、多任务与启动器

工作区是一个 User 的全部产品界面。它由 App 组成：内置的浏览器、我的文件、设置，以及用户把网页安装成的网页 App。屏幕上同时运行多个窗口，交互仿照平板的多任务：一个**空间**（Space）是一屏，放 1–3 个并排的窗口；其他空间在后台保持完整状态，通过切换器回到它们。新建窗口和切换 App 的入口是自动生成的**开始屏幕**。

## 对象

| 对象 | 所有者 | 说明 |
|---|---|---|
| App | Control | `appId`：`browser`、`files`、`settings`，或 `web:<id>`（已安装的网页 App） |
| Window | Control | 恰好承载一个 App 的一个实例；`appId`、`lastActiveAt`、App 视图状态 `state` |
| Tab | Control | 仍是远端页面的产品对象，只属于 browser 或 web 窗口 |
| Space | Control | 有序的 `windowIds`（1–3 个）、对应 `weights`、`focusedWindowId`、`lastActiveAt` |
| InstalledApp | Control | 名称、起始 URL、作用域、显示方式、主题色、图标（≤64KiB PNG，存 SQLite） |
| Favorite | Control | 浏览器收藏：URL、标题、创建时间，扁平列表 |
| UsageEvent | Control | 启动器 frecency 的原始记录，见[常用项](#常用项frecency) |

工作区快照 `workspace` 携带 `windows`、`tabs`、`spaces`、`activeSpaceId`、`apps`（已安装）、`favorites`、`settings`、`sites`。每个窗口只属于一个空间；空间没有窗口就删除；`activeSpaceId` 指向当前一屏。上限：窗口 12，Tab 32，每空间 3 个窗口。

### 窗口种类

- **browser**：标签栏 + 工具栏，即原来的 Window。可以有任意多个 browser 窗口。关闭最后一个 Tab 保留空窗口（显示起始页）。Tab 的 `kind` 只有 `start | remote`。
- **web:&lt;id&gt;**：恰好一个 Tab。紧凑标题栏：图标、页面标题、后退、更多（刷新、复制链接、在浏览器中打开、网页兼容性、App 设置）。离开作用域的导航留在窗口内，标题栏显示来源域名条；`display=browser` 的 App 始终显示只读地址条。关闭 Tab 即关闭窗口。同一 App 可以开多个窗口。
- **files**：本地渲染，可以开多个窗口，每个窗口有自己的视图状态。
- **settings**：本地渲染，单例；再次打开时聚焦已有窗口。

本地窗口（files、settings）不产生远端渲染需求。App 视图状态（files 的当前视图/搜索/排列，settings 的分区）是窗口的 `state`：有界 JSON（≤4KiB），客户端 500ms 去抖后经 WS `window.state` 写回，不走 DataChannel 与操作收据；重连或换设备后原样恢复。地址草稿、滚动位置不持久化。

### 弹窗与新 Tab

- browser 窗口里的弹窗、新 Tab 保持原有收养规则（进入 opener 窗口，new window/popup 产生新的 browser 窗口，放在新空间）。
- web 窗口的 `new_popup` 产生同一 App 的新窗口，放在 opener 所在空间的右侧（空间已满则新空间）；前台/后台 Tab 和 new window 进入最近使用的 browser 窗口（没有就新建），并切换到它的空间。收养仍是同一个真实 WebContents。

## 多任务

### 空间与可见性

只有当前空间的窗口可见；其余窗口 `visible=false`，交给 Memory Saver 冻结/丢弃/恢复，状态由 Control 保存，回来时恢复。宽度不足以并排（每窗口最小 360 CSS px）时，空间一次显示一个窗口，顶部居中的胶囊切换空间内的窗口；窄屏只改变显示，不改变空间结构。

### 操作

| 操作 | 结果 |
|---|---|
| `window.open{appId, url?, placement}` | `placement` 为 `{mode:'space'}`（新空间并切过去）或 `{mode:'split', besideWindowId, side}`（插入该窗口左/右侧）。settings 已存在时聚焦它 |
| `window.focus{windowId}` | 切到其空间并聚焦；更新 `lastActiveAt` |
| `window.place{windowId, placement}` | 移出到新空间、并入另一窗口旁边或在空间内换位 |
| `window.close{windowId}` | 关闭窗口及其 Tab（beforeunload 流程不变） |
| `space.activate / space.close{spaceId}` | 切换；关闭空间即关闭其中所有窗口 |
| `space.layout{spaceId, weights}` | 分隔条比例 |
| `app.install / app.update / app.uninstall` | 卸载同时关闭其窗口 |
| `favorite.add / favorite.remove` | 收藏 |

`layoutMode`、`activeWindowId`、`window.create`、`window.activate`、`window.layout`、`tab.files` 都删除。

### 交互

- **窗口把手**：每个窗口标题栏左端是一个 ⋯ 把手。点击打开菜单：单独显示（移到新空间）、左侧分屏、右侧分屏、关闭窗口；空间已满时分屏项禁用。按住把手横向拖动，在空间内换位；拖到其他窗口上半边并入其旁侧。
- **分隔条**：拖动调整比例；拖到距边缘 15% 以内松手，该侧窗口移到自己的新空间（不关闭）。
- **主页条**：Viewer 底部 16px 的外壳区域（不属于远端内容，因此不和页面触摸冲突），中间一条短横线。点按打开开始屏幕；上滑并停住打开切换器；左右滑动在最近两个空间之间切换。鼠标点击等同点按，右键打开切换器。
- **切换器**：按 `lastActiveAt` 倒序的空间卡片，横向滚动；卡片内按空间布局排列各窗口的缩略图（客户端内存中离开空间时保存的最后一帧，没有就显示 App 图标和标题）。点按进入；上滑或 × 关闭空间；把一张卡拖到另一张上合并成分屏（容量允许时）。
- **开始屏幕**有两种模式：从主页条进入是"打开"模式；从把手菜单的分屏项进入是"分屏"模式，选中的项放在指定侧。打开模式下按住磁贴拖到屏幕左/右边缘，也会在当前空间对应一侧分屏打开。Esc、点空白处或再点主页条关闭。

## 开始屏幕

全屏覆盖在当前空间上（当前空间模糊变暗）。顶部是搜索框，下面是横向滚动的分组，组内磁贴纵向填满若干行后换列，每组有标题。

### 内容

1. **常用**：App、网页、文件混合，按[常用项](#常用项frecency)得分排序，最多 12 个。
2. **App**：内置 App 在前，已安装的网页 App 按得分排序，全部列出。
3. **网页**：收藏在前（按得分），之后是非收藏的常用网页，最多 16 个。已出现在"常用"里的不重复。
4. **文件**：已整理（在分区中）的在前，之后是其他常用文件，最多 12 个。已出现在"常用"里的不重复。

搜索框输入时，分组换成一个结果组：App、收藏、网页记录、文件按名称/标题/URL 包含匹配；回车打开第一项，没有匹配时按 `resolveNavigation` 在浏览器打开。

激活：App 磁贴在打开模式下聚焦该 App 最近使用的窗口（没有就新建）；磁贴菜单（长按/右键）提供"新窗口"。网页磁贴在最近使用的 browser 窗口开新 Tab 并切过去；若某个已安装 App 的作用域覆盖该 URL，则打开该 App。文件磁贴打开 files 窗口并预览该文件。分屏模式下任何磁贴都新建窗口放在指定侧。

### 布局

磁贴尺寸单位 `u` 由视口高度决定：行数 `R` 取能放下的最大偶数（4 或 6，窄屏 4），`u = clamp(64, (可用高度 − 间隔)/R, 96)` CSS px。尺寸为小 1×1、中 2×2、宽 4×2。每组是 CSS Grid：`grid-template-rows: repeat(R, u)`、`grid-auto-flow: column dense`，由浏览器密排（Chrome 89 支持）。

尺寸规则只看组内得分比 `r = s / s_max`：

- 常用：第一项且 `r=1` 且领先第二项 1.5 倍以上 → 宽；`r ≥ 0.5` → 中；其余小。
- App：内置 App 与有使用记录的网页 App 为中，其余小。
- 网页：收藏为中，其余小；宽磁贴显示标题与域名。
- 文件：已整理的为中，图片文件为中时用缩略图铺满；其余小。

颜色：浏览器蓝、我的文件琥珀、设置石板灰；网页 App 用安装时的主题色；网页用匹配 App 的主题色，否则按 origin hash 取固定调色板；文件按类型着色（与 `FileTile` 一致）。磁贴前景统一白色，背景色在 HSL 中把亮度压到保证 4.5:1 对比度。

## 常用项（frecency）

### 记录

`usage_events(tenant, at, item, window_id, chain)`：`item` 为 `app:<appId>`、`page:<规范化 URL>`、`file:<entryId>`。

- App：窗口打开、聚焦（同一窗口 30 秒内的重复聚焦合并）。
- 网页：Tab 主 frame 提交导航（Control 结算导航收据时）。规范化去掉 fragment；跳过 about:、错误页和搜索引擎结果页（与 `resolveNavigation` 的搜索模板匹配）；同时记下最新标题。
- 文件：在 files 窗口打开预览、加入文件篮、被网页选择消费；客户端动作经 WS `usage.record{item, windowId}`，服务端校验条目存在。

`chain`：同一窗口（网页再细到同一 Tab）内相邻事件间隔小于 30 分钟属于同一条链；从开始屏幕打开的事件总是开始新链——开始屏幕本身就是用户想绕开的"中转"，不应该被算成路径。停留时间 `dwell` 是到链内下一事件的时间，最长计 10 分钟；链尾的停留按"未知"处理（视为目的地）。

每 Tenant 保留 90 天、最多 20000 条，超出删最旧的。设置提供"清除使用记录"；浏览器设置的"清除浏览记录"只删 `page:` 记录。

### 得分

时间衰减 `w(t) = 2^(−age/7天)`。访问是**中转**当且仅当它在链中有后继且 `dwell < 15s`。

对每个项 `i`：

- 访问量 `f_i = Σ w × (中转 ? 0.3 : 1)`。
- 后继分布 `c(i→j) = Σ_{i 的中转访问，后继为 j} w`，`C_i = Σ_j c(i→j)`。
- 中转率 `p_i = 中转访问权重 / 全部访问权重`，可预测度 `π_i = max_j c(i→j) / C_i`（`C_i = 0` 时为 0）。
- 折扣 `δ_i = 0.8 × f_i × p_i × π_i`，转给 i 最常去的后继 `j*`：直接得分 `D_i = f_i − δ_i + Σ_{k: k* = i} δ_k`。中转的价值在于它通向的地方，所以被扣掉的部分归那里。

用 `D` 排序，取开始屏幕"常用"容量（12）处的分数作为门槛 `τ = max(第 12 项的 D, 0.5 × 最大 D)`（不足 12 项时前者取 0）。

- 枢纽得分 `H_i = (1 − π_i²) × Σ_j c(i→j) × g_j`，其中 `g_j = 1 − min(1, D_j / τ)`。
- 最终 `s_i = D_i + H_i`；收藏网页 ×1.5、已整理文件 ×1.5。

含义：

- `A→B→C`、`A→B→D`：A 几乎总是很快跳到 B，`p_A≈1, π_A≈1`，A 自己只剩约 20%，扣掉的部分转给 B；A 的后继完全可预测，`1 − π_A² ≈ 0`，不会因为"代表 B"拿回枢纽得分。B 不会被重扣（后继分散，`π_B≈0.5`）。
- `B→C`、`B→D`、`B→E`：C/D/E 各自的直接得分低于门槛，`g` 接近 1，它们的访问折算成 B 的枢纽得分——B 作为进入这一簇的入口被抬高。若 C 本身足够常用（`D_C ≥ τ`），C 自己就有磁贴，B 不再因 C 得到加分。
- 只有中转、没有可预测后继的项（例如每次去向不同的门户首页）保留直接得分，并从低频后继那里获得枢纽得分。

计算是纯函数（`server/workspace/frecency.ts`），输入事件列表，输出每项得分；`launcher.get` 时现算（2 万条事件可在毫秒级完成），不缓存派生表。

### 接口

WS `launcher.get` 返回 `{ items: LauncherItem[] }`：每项 `{ key, kind: 'app'|'page'|'file', score, title, subtitle?, appId?, url?, entryId?, favorite?, organized? }`，已按分组规则截断但未分配尺寸；分组与尺寸由客户端纯函数 `launcher-layout.ts` 按视口决定。

## 安装网页为 App

浏览器的更多菜单 → "安装为 App…"。Control 经 Endpoint 调用 Browser 的 `view.appInfo`：返回页面标题、URL、manifest 摘要（name、short_name、start_url、scope、theme_color、display，如有）和一个图标（manifest 图标中不小于 96px 的最佳一个，否则 favicon；Browser 用 `WebContents::DownloadImage` 取回并缩放为 192px PNG，不超过 64KiB）。Control 把图标放进内存表（10 分钟，按随机 `iconToken`），把其余字段作为建议返回给 Viewer。

安装对话框只显示名称与图标；manifest 只提供默认值，不照搬 PWA 行为。"高级选项"展开：起始 URL、作用域（默认起始 URL 所在目录）、显示方式（独立窗口 / 显示地址条）、主题色、以及该 origin 的网页兼容性（平板版网站、不自动弹出键盘——与站点偏好是同一份数据）。确认后 `app.install{…, iconToken}`，Control 把图标写入 `installed_apps`。已安装 App 在设置 → App 中编辑、卸载。

## 设置拆分

- **设置 App**（工作区）：外观（界面缩放、顶部留空、打开时全屏）、画面与声音（质量、声道、统计叠层、音画同步）、安全（密码、PIN、人脸、锁屏）、App（已安装网页 App 管理）、会话导入、诊断、账户（退出；管理员入口打开管理员面板）、清除使用记录。
- **浏览器设置**（浏览器窗口更多 → 设置）：搜索引擎、Memory Saver、网页兼容性列表（所有站点偏好）、收藏管理、清除浏览记录。
- **我的文件设置**（files 窗口侧栏 → 设置）：来源（排除、清除来源中的文件）、分区管理。

`ProductSettings` 变成 `{ workspace: {...}, browser: { searchEngine, memorySaverEnabled } }`，`settings.update` 接受两层的部分更新。我的文件的设置归文件库所有，不在 `ProductSettings` 里。

## 我的文件

我的文件是工作区所有文件的聚合处，有两个用途：**聚合**（自动收集各来源的文件）与**整理**（扁平分区）。

### 模型

- 条目：`source: {app, channel} | null`、`partitionId | null`、`collected`、名称、类型、大小、资产等。`app` 是产生文件的 App（`browser`、`web:<id>`、`files`），`channel` 是该 App 自己的渠道：browser 为页面主机名（`example.com`），web App 为空串，files 为 `upload` 或 `camera`。来源由服务端从上下文推断：文件选择的导入看请求所属 Tab 的窗口 App 与 origin，files 窗口的上传看客户端声明的渠道；浏览器下载的文件（如有）记为 browser/下载页主机名。
- 引用：条目存活当且仅当在文件篮中、被未决选择持有、在某个分区中，或 `collected && source ≠ null`。字节仍按 hash 存储，由对象索引引用计数。
- 分区：扁平，`{id, name}`，一个条目最多属于一个分区。
- 来源列表由条目派生：`{app, channel, count, excluded}`；`excluded` 存在文件库的 `excludedSources`。
- 文件篮有一个"发送后整理到"分区（`basketPartitionId`，可为空）。

### 规则

- 网页选择确认（`library.finish`）时，被消费的条目：来源未排除则 `collected=true`；设置了 `basketPartitionId` 则同时放入该分区；两者都不满足的条目在选择结束后删除。
- **排除来源**：停止收集该来源的新文件，并把已有文件从"全部"、"最近"和开始屏幕中隐藏；已整理的文件仍在其分区中显示，来源视图里仍可查看并整理。可以取消排除。
- **清除来源中的文件**：该来源的所有条目去掉来源引用；不在分区中的条目删除，已整理的保留（来源显示为"已整理"）。确认对话框写明将删除与保留的数量。被未决选择持有的条目拒绝清除。
- **删除分区**：条目移出分区；没有来源引用的条目随之删除；确认对话框写明数量。
- 方法：`library.partition{id?, name}`（建/改名）、`library.partitionDelete{id}`、`library.move{ids, partitionId}`、`library.source{source, excluded}`、`library.sourcePurge{source}`、`library.basketPartition{partitionId}`，都带操作 ID 与冻结 payload 回执。`groups`/`groupId`/`archived` 删除。

### 界面

files 窗口：左侧导航为 全部、最近、分区（带计数，可新建）、来源（按 App 分组，例如 浏览器 › example.com；已排除的置灰），底部是设置；窄窗口改为顶部横向 Chip。内容区沿用按日期分节、卡片/列表视图、搜索与选择模式。来源视图的更多菜单提供排除/取消排除与清除；文件菜单提供移到分区。上传菜单（从设备、拍照）在分区视图中直接上传到该分区，其他视图上传为 files/upload 或 files/camera 来源。

文件篮的更多菜单（⋯）增加"发送后整理到"子菜单：不整理 / 各分区 / 新建分区。卡片菜单增加"整理到分区"。"从我的文件选择"的网格增加来源/分区筛选。
