# 学习与题库

两个内置 App 把学校使用的服务接进工作区：**学习**（`study`）汇总智学作业与畅言班级资料，**题库**（`questions`）浏览新教育题库。二者都是本地渲染的单例 App；服务端接口、登录态与下载都在 Control，Viewer 只拿整理好的模型。契约在 `control/shared/learning.ts`，服务端在 `control/server/learning/`，界面在 `control/client/learning/`。

## 组成

| 部分 | 位置 | 职责 |
|---|---|---|
| 服务客户端 | `server/learning/providers/` | 畅言 SSO 与 Shield 网关签名、智学 CAS、新教育 safeCode 签名与限流；把服务端字段整理成公开模型。只读：不实现交作业、点赞、学习完成写入 |
| 账户与登录 | `server/learning/accounts.ts`、`sign-in.ts` | 每 Tenant 每服务一份登录态，加密保存；登录流程与过期处理 |
| 学习 | `server/learning/study-*.ts` | 浏览接口与缓存；定时同步、附件下载进我的文件、保留天数 |
| 题库 | `server/learning/bank-service.ts` | 学科、题型、难度、教材、章节与题目查询 |
| 富文本 | `server/learning/rich-html.ts`、`media-proxy.ts` | 服务端 HTML 的媒体代理与公式渲染 |

服务客户端参考了 FlysoftBeta/study 的 `lib/changyan` 与 `lib/xinjiaoyu`，按 RemoteKit 的需要改写：不落盘、不保存会话文件、下载以流的形式交给对象存储。

## 登录

登录态（畅言 TGT/AT、畅言 token、智学 CAS JWT；新教育的 authorization/accesstoken 与浏览器标识头）以 AES-256-GCM 加密存在 `learning_accounts`，密钥由 Control 的静态密钥派生。它们从不发给 Viewer，也不进入日志与诊断包。Viewer 只看到 `LearningAccount`：未登录、登录中（凭据/验证/网页/完成）、已登录、已过期、失败。

### 登录页

两种登录都要用户在真实网页里亲自完成一步，所以 App 窗口里嵌入一个远端 WebView：**登录 Tab**。它是 Control 拥有的 Tab（`ProductTab.signIn`），属于学习或题库窗口，是该窗口的 `activeTabId`；App 把它放在自己界面里的一个盒子中，远端视口尺寸取这个盒子而不是整个窗口。登录 Tab 不出现在标签栏，用户不能导航它，不参与常用项、预览、弹窗收养与 Memory Saver 丢弃；登录完成、取消、超时（5 分钟）或窗口关闭时 Control 关闭它。

Browser 侧是**专用的登录视图**，而不是通用的脚本执行或 Cookie 读取：view 创建时带 `signIn: 'changyan' | 'xinjiaoyu'`，Browser 按用途用固定代码处理，只把约定的结果以 `view.signIn` 事件交给 Endpoint，再经 `session.events` 到 Control。结果不超过 8KiB，Browser 与 Endpoint 只记录"view N 登录完成"，不记录内容。登录视图不能打开弹窗。

- **畅言**：用户在 App 里输入账号密码，Control 查询验证策略；需要验证时，登录 Tab 打开 Browser 内置的 `remotekit-signin://changyan/verify?…` 页（自定义 standard+secure scheme，只有登录视图能加载），页面加载官方极验 v4 并立即弹出；用户完成后页面跳到 `remotekit-signin://changyan/done?…`，Browser 拦下这次导航，把 `lot_number/captcha_output/pass_token/gen_time` 作为结果上报。Control 用它完成账号登录、换取畅言 token、扩展到智学并登录智学。口令只在这次流程的内存里。
- **新教育**：登录 Tab 打开 `https://www.xinjiaoyu.com/auth/login`，用户自己登录。Browser 观察这个 WebContents 发往 `www.xinjiaoyu.com/api/v3/` 的请求，第一个同时带 `JBY` authorization 与 accesstoken 的业务请求（排除握手与登录本身）即为登录完成，上报这两个头与浏览器标识头（UA、Accept-Language、`sec-ch-ua*`）。Control 自己建立签名会话（safeCode 握手），用一次只读请求验证后保存。请求观察挂在 WebContents 级的 URLLoaderFactory 上：浏览器侧的 URLLoaderThrottle 看不到页面的 fetch/XHR。

### 过期

服务返回认证失败时先续期（畅言用 TGT 换新 token，智学用共享 SSO 续 CAS）；续不上则标记为已过期，App 顶部提示重新登录，用户名预填。退出登录删除登录态；已下载的文件留在我的文件里。

## 学习

- **作业**（智学）：进行中/已完成两个分组，按学科筛选，按布置日期分节；详情包括说明、附件、题目（服务公开答案时才显示答案与解析，有报告时显示我的答案与得分）。不提供作答与提交，也不打开智学 H5——那个页面在这里不完整。
- **班级资料**（畅言）：按学科、待学习/已学习、类型（课件、文档、视频、音频、图片、其他）筛选。畅言列表返回 `resourceId`，下载、预览与 MD5 接口却要 `resId`：公开模型只叫 `id`，只在网关边界转换。
- 浏览接口都直接透传服务端分页，Control 内存短缓存（列表 60 秒、详情 5 分钟），Viewer 不持久化。

### 附件进我的文件

- 同步在登录后、每 30 分钟（同时最多 4 个 Tenant，带抖动）和用户点同步时运行：收集布置时间在保留天数内的作业（两个分组）和分享时间在保留天数内的班级资料（所有学科、两种状态），每个附件下载一次。
- 下载由 Control 流式完成并直接写入对象存储（`object.put`，见[多节点 · 对象存储](cluster.md#对象存储)），有服务端 MD5/大小时校验；每 Tenant 最多 2 个并发，单文件 256MiB。对象按内容去重：同班同学的同一份课件在存储里只有一份，各自的条目分别引用。写入后请求预渲染文档（见[文件与相机 · 文档预览](files-and-camera.md#文档预览)），打开时不必等转换。
- 每个附件成为一个文件库条目：来源 `{app:'study', channel:<学科名>}`（我的文件显示为"学习 › 数学"），`detail` 为作业名或资料名——附带信息只用于显示和搜索，不是分类依据。
- `learning_downloads` 按服务端附件键记录状态（已保存、失败、用户已删除）。用户自己删除的条目不再自动下载；同步失败的下次重试。
- **保留天数**（1–60，默认 7，每个用户各自设置）：`max(布置/分享时间, 保存时间)` 超过保留天数的附件，若已整理进分区则只去掉学习来源（显示为"已整理"），否则删除条目。字节由对象索引按引用回收。
- 保留窗口之外的附件可在详情里按需保存，规则相同。

## 题库

- 学科来自审核配置（`audit/cfg/query`）中学段 `10000` 的科目组；难度是服务端固定的一组 id；题型含子题型；章节筛选只发送所选子树的 `{dimensionId, tagId}`（跳过 `labelStatus = 2` 的节点），"全部教材"不发 `textBookId`。没有教材类型、没有教材或目录为空的学科照样能查。分页最少 10 条；服务端区分匹配总数 `realTotal` 与可浏览数 `total`，界面两个都显示。
- 题目模型保留 HTML：复合题（阅读、完形、听力）的题干是材料，小题各有选项与答案；听力有音频与原文，古诗文有参考译文；选项自带的"A."等标号去掉，由界面统一编号。
- 缓存：学科、题型、教材、目录每 Tenant 1 小时，题目页 5 分钟；按账户限流。

## 富文本

服务端 HTML 送到 Viewer 之前统一经过 `rich-html.ts`：

- **媒体代理**：所有 http(s) 的 `src`/`href`/`poster` 与样式里的 `url()` 改写成 `/api/learning/media/<token>`。Viewer 常在内网，不能直接访问外部资源。token 是 Control 以进程级随机密钥签名的 `{tenant, url, 过期时间}`（24 小时），路由用 Viewer 的登录 Cookie 鉴权并要求 Tenant 一致；上游请求带服务对应的 Referer/UA，流式转发，单个最大 32MiB，支持 Range，内存 LRU 缓存小对象。
- **公式**：新教育的公式可能是 TeX（`\( \)`、`\[ \]`、`$$`、`data-latex`）或 MathML；Chrome 89 不渲染 MathML。Control 用 MathJax（liteAdaptor、SVG 输出）把它们渲染成内联 SVG，按源文本缓存。
- Viewer 用 DOMPurify 按白名单再净化一次（只允许代理地址的媒体）。

## 文档阅读进度

文档预览的阅读位置（页号与页内偏移）按 `(tenant, 资产 id)` 存在 Control 的 `document_progress`，每 Tenant 保留最近 500 条；跟随内容而不是条目，所以从学习和我的文件打开同一份文件位置一致。
