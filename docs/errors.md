# 错误模型

错误模型规定每一种失败**怎样被正确处理**：生产方按调用方该做什么选择错误码，各层原样转发，消费方只按错误码决定下一步；同时，失败发生在任何一步，系统都只能停在成功路径也会到达、或者模型明确定义的状态里，不能留下非法的状态组合。定义错误码只是一半；另一半是消费方真的按它处理，并且有测试强制。

## 错误码就是处理指令

所有组件使用同一组错误码（`control/shared/errors.ts`、`endpoint/src/util/error.hpp`、`protocol/control.h` 中的 `ErrorCode`）。**错误码就是处理指令**：调用方只按 code 决定重试、对账、刷新、重新认证或放弃；`message` 只是给人看的文字（用户提示或运维诊断），任何代码都不按 message、`reason` 或 HTTP 状态文字分支。

| code | 调用方怎么做 | 可能已执行 |
|---|---|---|
| `busy` | 短退避（抖动，秒级以内）后原样重试，次数有上限 | 否 |
| `rate_limited` | 等 `retryAfterMs`（缺省用生产方默认值）后重试 | 否 |
| `unavailable` | 指数退避，或等对端/能力恢复的事件后重试 | 否（未送达） |
| `outcome_unknown` | 不重做；用同一操作身份查询或对账。只读请求重新读取即是查询；幂等请求可以用**同一身份**重新提交 | **可能** |
| `conflict` | 刷新状态后重新决定 | 否 |
| `not_found` | 刷新状态，放弃这个请求 | 否 |
| `locked` | 等用户解锁后重试 | 否 |
| `unauthenticated` | 重新登录 | 否 |
| `forbidden` | 显示无权限，不重试 | 否 |
| `limit_exceeded` | 需要用户释放空间/配额或缩小输入；不自动重试 | 否 |
| `invalid_request` | 调用方缺陷：记录，不重试 | 否 |
| `rejected` | 对这个输入、这个构建是最终结果；不重试 | 否 |
| `canceled` | 调用方自己取消；不重试、不提示 | 否 |
| `internal` | 记录并报告，不自动重试；带操作身份的变更按 `outcome_unknown` 对账 | — |

## 生产方怎样选 code

- 暂时饱和（在途槽位、队列、KDF 并发、发送缓冲）是 `busy`；容量被别的租户占满、节点或工具缺失、IO 失败是 `unavailable`；只有用户能自己释放的配额和输入本身超出上限才是 `limit_exceeded`。
- 输入本身无法处理（不支持的格式、损坏、加密文档、转换器在该输入上失败或超出计算预算）是 `rejected`；我们自己的协议/状态不变量被破坏是 `internal`；调用方请求的格式错误才是 `invalid_request`。
- 过期的身份、代次、授权 epoch 是 `conflict`；被替换的授权要求解锁时是 `locked`，要求登录时是 `unauthenticated`。
- **送达证据决定 `unavailable` 与 `outcome_unknown`**：每条传输记录请求是否已写出。写出前失败（连接已关、写失败、本地排队超时）是 `unavailable`；写出后超时、断开、回复格式错误或过大是 `outcome_unknown`。服务端处理已经执行后才发现回复无法编码，同样是 `outcome_unknown`。执行后才发现授权或目标已变化，结果是 `outcome_unknown`，披露另由授权门禁控制。健康探测超时不会成为被阻塞动作的结果：那个动作没有发出，是 `unavailable`。
- 外部服务与工具在边界处按其类型化证据分类一次：HTTP 401 → `unauthenticated`，403 → `forbidden`，404 → `not_found`，429 → `rate_limited`（读取 Retry-After），408/5xx 与读请求的传输失败 → `unavailable`，变更请求发出后的传输失败 → `outcome_unknown`，无法归类的上游失败 → `internal`。

## 线上形状与展示边界

**线上形状**：Native（Endpoint、Browser）与管理通道是 `error:{code, message, reason?, retryAfterMs?, errorId?}`；Control → Viewer 是 `error:{code, message, reason?, retryAfterMs?, errorId?}`（`reason` 只取协议里封闭的 Native 原因枚举，供 Viewer 区分例如 `browser_restarting` 与最终失败）。产品状态里的 Endpoint 错误、学习与会话导入的失败记录同样是带 code/reason/errorId 的结构，不是字符串。
- `retryAfterMs` 只随 `busy`、`rate_limited`、`unavailable` 出现（0…86 400 000 的整数）；其他 code 带上它会在校验时被丢弃。提示只调整允许重试时的等待，永远不会让不可重试的 code 变得可以重试。HTTP 同时设置 `Retry-After` 头，但客户端只读 JSON。
- Native（Endpoint、Browser）的 `message` 是英文运维诊断；需要向用户区分的情形（如加密文档与损坏文档、单文件过大与配额已满）带一个 `reason`，取自协议里封闭的枚举，只用于选择展示文字。Control 是展示边界：把 Native 错误转换成 Viewer 用的中文 `message`（按 `reason`，否则按 code 的通用句），原始诊断进日志和诊断包。Viewer 直接显示 `message`；code 的通用句只有 `shared/errors.ts` 一张表。Endpoint 经 DataChannel 直接回复 Viewer 的请求（文件服务、文档阅读）不经过 Control，回复里同样带 Native 的错误形状；这条路径的展示边界是 Viewer 的 DataChannel 解码处。两处用同一个转换（`control/shared/errors.ts` 的 `nativeError` 与原因文字表），英文诊断进 `detail`。
- Browser 控制回复：`{version:1, id, ok:false, error:{code, message, reason?, retryAfterMs?}}`，code 用名称字符串。SDK 的类型化调用把 Browser 的应用错误原样交给调用方，不折叠成传输状态；SDK 传输状态区分"未发出"（通道已关、写失败）与"已发出、结果未知"（超时、发出后断开、回复无效）。
- 操作收据的失败是 `status:'failed'` 加结构化 `error:{code, message}`；`expired`（generation 已轮换）是 `failed` + `conflict`。Viewer 按收据里的 code 处理，与直接回复的错误走同一套处理。
- 每个边界只转换一次；中途转发保留 code、`reason`、`retryAfterMs` 与 `errorId`，包装时原始异常放进 `cause`，不替换。

## 错误 ID

`internal`、`outcome_unknown`、`unavailable` 在第一次离开产生它的进程时获得一个 ID（Control `c-`、Endpoint `e-`、Viewer `v-`，后接 10 位十六进制），同时写一条带完整诊断（code、reason、英文诊断、OS 错误码、cause 链与栈）的结构化日志；之后各层原样转发，不再生成新 ID。Control 转发 Endpoint 错误时沿用 `e-` ID，并在自己的日志里记一条同 ID 的记录。只在浏览器里发生的失败（解码、页面挂载、摄像头、呈现协议）由 Viewer 自己生成 `v-` ID 并立即显示，再经 WS `client.error{errorId, context, error}` 报给 Control（内存队列最多 50 条，在线时发送），Control 用同一 ID 记一条 `viewer.error`。管理 App → 诊断按 ID 查找：`c-`/`v-` 查 Control 日志，`e-` 经 `node.logs.search` 查各节点的 `endpoint.log`。其余 code 是调用方能自己处理的结果，不分配 ID。

## 消费方契约

**处理策略只有一份**：`control/shared/error-policy.ts` 与 `endpoint/src/util/error_policy.hpp` 把 code 映射为处理方式和默认等待（`busy` 250ms 起翻倍、上限 5 秒；`unavailable` 1 秒起翻倍、上限 5 分钟；`rate_limited` 无提示时 30 秒）。任何代码都不自己判断"这个错误能不能重试"。

**重试单元**：凡是会再次尝试的地方——协调循环（期望文档发布、`node.desired`）、对账、后台任务、对象维护、调度器、更新器——都以"单元"为粒度（一个 Tenant 的发布、一个节点的会话清单、一个后台作业、一个对象）用同一个原语记账：Control 是 `control/shared/retry-unit.ts` 的 `RetryUnit`，Native 是 `endpoint/src/util/retry_unit.hpp`。它是一个显式状态机：

| 状态 | 进入 | 离开 |
|---|---|---|
| `idle` | 成功；输入变化 | 一次失败 |
| `waiting{attempt, until}` | `busy`、`rate_limited`、`unavailable`、`conflict`、`outcome_unknown` | 到期再试；成功回 `idle` 并重置 attempt |
| `faulted{code, errorId, input}` | `invalid_request`、`internal`、`rejected`、`limit_exceeded`、`forbidden`、`locked`、`unauthenticated` | 只有输入变化（新的期望 revision、节点重连、用户操作、构建或配额变化）才回到 `idle` |
| `dropped` | `not_found` | 输入变化 |

每种 code 在循环里的含义：
- `busy` / `rate_limited` / `unavailable`：按 `retryDelay(error, attempt)` 等待后原样再试；attempt 按单元计数，成功清零。`busy` 连续 8 次后单元转为 faulted，等输入变化。
- `outcome_unknown`：不换身份重做，用**同一**操作身份或同一 revision 重发或查询（`node.desired`、`session.desired` 按 revision 幂等），按 `unavailable` 的节奏退避。没有操作身份、无法对账的不确定变更，以"结果未知"结束并如实呈现，不重做。
- `conflict`：重新计算要发送的内容再发；按 `unavailable` 的节奏退避，持续冲突不能空转。
- `not_found`：放弃这个单元的工作，直到输入变化。
- 最终类 code：不进入循环；记一次带错误 ID 的日志，把单元标记为 faulted 并经它的所有者暴露（Session 的发布按[故障只隔离一个 Session](cluster.md#集群通道)处理，节点的协调标记节点故障）。
- 持久化的单元（文档转换、学习附件下载、会话导入、下载导入、更新器等后台作业）把状态与 code、诊断、`retry_at`、构建 ID 一起存下（Control 的单元记录在 `control/server/persistence/retry-units.ts`）；`rejected`、`internal` 只对产生它的构建有效，构建变化即视为输入变化。
- 日志：单元进入失败时记一条（code、错误 ID、单元），恢复时记一条 `*_recovered`；不按尝试次数刷屏。
- 单线：同一个单元同一时刻只有一次尝试在途；定时器到期与调用方同时唤醒时不会启动两份工作。单元的所有者关闭时取消它的定时器，之后不再有任何尝试。

**不允许的写法**：对任何错误都"标记待重试、定时器再来一次"；空的 `catch`、`.catch(() => {})`、忽略的 `Result`；把 `outcome_unknown` 当成成功或确定的失败；按 `message`、`reason` 文本、异常类型或 HTTP 状态文字分支；转发时丢掉 code、`reason`、`retryAfterMs`、`errorId`，或在中途再转换一次。

## 错误路径上的状态

失败可以发生在任何一步。规则是：**失败之后的状态，必须是成功路径也会产生的状态，或者是模型里明确定义的失败/未知状态**。
- **先确认、后生效**：可能失败的一步成功之后，状态才改变；做不到时，先把状态推进到显式的"进行中"或"未知"值，失败把它推进到失败值，而不是留在半途。长生命周期对象用状态枚举表达，失败只能走向枚举里定义的状态，不能用几个布尔量拼出新组合。
- **批处理逐项成败**：一批里的每一项独立成功或失败，结果按项记录（日志与所属对象的错误状态）；一项失败不中止其他项，也不留下"前面已经改了、后面没改、没有记录"的状态。例如一份 `node.desired` 里某个放置处理失败，只让那个 Session 出错，其余照常收敛。
- **内存与持久化不分家**：先持久化再发布到内存，或在同一事务里；失败时两边都不变。读不到的持久状态不当作"不存在"。
- **资源只有一个释放点**：槽位、许可、句柄、租约、文件、排队中的工作在成功与失败路径上走同一个释放点（RAII、`finally`）；不重复释放。证明不了已完成的 GPU、编码或外部工作，资源保留到有证据为止，而不是按超时放弃。
- **所有者释放自己的东西**：一个对象退役（Session 被 fencing、peer 关闭、生成换代）时，它持有的文件、句柄与后台工作在退役返回之前全部释放，后来的接替者不会碰到前任留下的锁。
- **不确定的结果单独记录**：`outcome_unknown` 记成"未知"，由对账收敛；不记成已提交，也不记成失败后再做一遍。

## 执法

规则靠测试强制，不靠约定：
- **生产方契约**：`control/test/error-contract.test.ts` 与 Endpoint 的对应测试检查每个边界选对 code、转换只做一次、重试提示只随允许的 code 出现、送达证据区分 `unavailable` 与 `outcome_unknown`。
- **消费方行为矩阵**：每个重试循环都登记在一张清单里（Control `control/test/retry-loops.test.ts` 及其驱动，Endpoint `endpoint/tests/retry_loop_tests.cpp`）。每个条目构造真实的所有者，只在它的依赖边界放假实现（假节点链路、假 Browser/SDK RPC、假邮箱、假文件系统、假存储……），从那里逐一注入每种 code，用模拟时钟观察所有者的下一次尝试与对外状态，断言上表：等待增长与清零、最终 code 不循环且输入变化后恢复、`outcome_unknown` 用同一身份重发、`conflict` 重新计算、每次失败只记一条日志。直接驱动 `RetryUnit` 的条目不算数，测试会拒绝；源码里每个 `RetryUnit` 实例都必须有对应条目，漏登记即失败。
- **静态守卫**：测试扫描 Control 服务端源码，`catch` 后用 `setTimeout`/`setInterval` 安排重试、或空的 `catch`/`.catch(() => {})` 出现在 `RetryUnit` 之外即失败；确实需要吞掉的错误（例如关闭时的清理）必须写明原因并登记在守卫的允许清单里。
- **错误路径状态测试**：会改变状态的多步操作，测试在每一步注入失败，断言失败后的状态属于"成功也会到达的状态 ∪ 定义的失败/未知状态"（Control `control/test/error-path-state.test.ts`，Endpoint `endpoint/tests/error_path_state_tests.cpp`）。
- **存储格式**：改变落盘格式时，迁移步骤与"读取上一版本的记录"测试一起提交；只改新建代码、让旧记录在严格解码下变成 `corrupt_record`/`corrupt_state` 是缺陷。

## 其他规则

- Endpoint 的 Session 状态错误用 `reason` 说明原因：`browser_crashed`（Browser 非正常退出）、`browser_restarting`（替换中）、`output_failed`（GPU 输出无法继续），错误码为 `unavailable`；在途操作仍按 `outcome_unknown` 处理。内部原因（例如 render generation 未决的 GPU 工作）只进日志和诊断。
- 本地持久状态损坏（读得到但解不开）与读不到（IO 失败）是两件事：前者是 `internal` + `reason: corrupt_state`（Endpoint Session 数据）或 `corrupt_record`（Control 存储文档），不自动重试、不改写数据；后者是 `unavailable`，数据原样保留。"读不到"从不当作"不存在"。
- 意外异常在请求边界和线程入口被捕获：请求返回 `internal`，线程入口把所属组件标记为失败，而不是终止进程。只在校验调用方请求时才把解析异常归为 `invalid_request`；解析对端回复或本地存储时的异常是 `internal`（已送达的请求则是 `outcome_unknown`）。
- 不确定的 GPU 工作、编码任务和原生回调不靠超时"放弃"：资源保留到有证据为止，必要时保留到进程结束。
- 健康探测只判断对端是否在应答：对端带应用错误码的回复（例如输出尚未打开时 `output.status` 的 `conflict`）证明它活着；只有探测本身结果未知（`outcome_unknown`）或通道不可用（`unavailable`）才是健康失败。被探测对象的故障经成功回复里的状态字段报告，不靠错误码猜。
- 控制 RPC 超时只使本次结果成为 `outcome_unknown`，不关闭 SDK 通道、不清除 Endpoint 的控制句柄。SDK 使用每通道请求 ID 匹配回复，丢弃迟到回复并释放其 Mojo 附件与本地资源句柄；后续健康检查有界等待。只有管道确实断开或进程退出才允许替换 Browser，连续失败最多启动三次，按 1/2/4 秒退避，健康运行一分钟后恢复额度。拒绝重启的错误附带最近一次真实失败（进程退出码及其含义、控制管道超时或 `output.status` 错误）和 Session 目录下 `browser.log` 的路径；Endpoint 自己终止的进程（退出码 0）不算失败。GPU 输出启动失败通过现有 Session 错误投影显示在标签页/工作区。

## Viewer 怎样呈现失败

按"谁能处理"而不是按错误码堆横幅，规则只在 `control/client/failures/` 一处（`presentFailure(error, context)`）：

| 类 | 谁处理 | 典型 code / reason | 呈现 |
|---|---|---|---|
| 正在恢复 | 系统 | `busy`、`rate_limited`、`unavailable`、确认中的 `outcome_unknown`、`browser_restarting`/`browser_crashed`、连接中断 | 受影响的东西上显示进行中的状态（"正在重新连接…"），没有错误措辞、没有重试按钮；重试在后台自动进行，预算用完后放慢但不停止。1.5 秒内恢复的不显示；20 秒后改用"仍在…/暂时无法…，恢复后自动继续"；连接类 30 秒后进入平静的持续状态 |
| 用户能处理 | 用户 | `unauthenticated`、`locked`、容量与输入超限、带文档/照片原因的 `rejected`、用户输入导致的 `invalid_request`、自己操作的目标已变化（`conflict`/`not_found`，先静默刷新） | 只给一个具体动作（登录、解锁、管理窗口、换一个文件、重新拍摄……）。"空间不足 / 打开我的文件"只用于真正的存储、目录与文件篮容量 |
| 谁都处理不了 | 管理员 | `internal`、`forbidden`、`corrupt_record`/`corrupt_state`、非输入导致的 `invalid_request` | 说明什么没有发生、东西现在是什么状态，另起一行显示可复制的错误 ID；没有重试 |
| 静默 | — | `canceled` | 不显示 |

位置按作用域：输入框下（field）、出问题的那个条目上（item：文件卡、上传/拍照任务、附件行、标签页）、所在的窗口/面板（surface：活动内容上是顶部居中的浮动小条，只覆盖、不挤压——挤压会改变远端视口尺寸）、全局通知（只放不属于任何可见界面的事：Control 连接、窗口已关闭的后台任务；右下角，按 key 去重，最多 3 条）、全屏（登录、锁定、连接被接管）。错误一路保持类型化直到呈现处，只有 `presentFailure` 生成文字。

