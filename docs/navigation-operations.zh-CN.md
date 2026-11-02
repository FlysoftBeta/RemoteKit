# 导航操作收据

Browser 的执行接受与导航完成分开：`navigate`、`view.create` 的初始 URL，以及
`page.command` 的 `back` / `forward` / `reload` / `stop`，可以携带顶层字段
`operationId`、`operationGeneration`（各为最多 128 字节的不透明非空字符串）和
`operationSequence`（非零 uint64 的十进制字符串）。内部无这些字段的导航继续可用。
创建时直接加载目标 URL，不为收据额外插入 `about:blank` 历史项。

每个 WebView snapshot 的 `navigationOperations` 数组包含身份、sequence、`state`，
以及可用时的 `navigationId`、`url`、`error`。终态另有 `documentCommitted` 和
`isErrorPage`：前者仅记录绑定主框架 handle 的真实 `HasCommitted()`，后者说明其提交
的是错误文档；仅 iframe 的历史操作和 stop 命令没有主框架提交，二者均为 false。
身份作用域是当前 Browser incarnation
内的逻辑 WebView；执行 WebContents 被 recreate 时保留账本，Browser 被替换则不能
把新 Browser 的未知状态当成旧操作完成。Control 仍需按当前 Browser incarnation
及逻辑 view 绑定检查后，再将原生终态写入持久收据。

状态为 `accepted`、`started`、`committed`、`cancelled`、`failed` 或 `superseded`。
前两者不是完成。`committed` 表示绑定导航正常提交，包括同文档导航；不表示页面所有
资源已加载。`stop` 不创建新导航，它取消旧 pending 操作并将自身命令标为 committed。
后退/前进可只影响 iframe，Browser 收集该控制器调用返回的所有 handle，等全部终态
才结算；没有主框架导航时，committed 记录可以没有 `navigationId`。

操作结果与文档是否提交相互独立。网络错误即便提交 Chromium 错误文档仍为 failed，
Control 收据仍 rejected；`documentCommitted=true` 时保留 remote 种类与真实 URL，
清除 pending 并呈现 Browser 文档，不能回退为本地起始页覆盖错误文档。只有未提交的
失败/取消才恢复 previousKind/URL。正常 committed（包括仅 iframe 历史操作）保持已有
成功语义，不因 `documentCommitted=false` 回退。终态匹配当前导航身份、逻辑 view 与
Browser incarnation；旧操作的迟到结果可结算其收据，不能重写当前导航或退休实例结果。
回退本地起始页后，Control 对 snapshot 中仍存在的对应 Native view 明确配置
`visible=false/requireRunning=true`，即使当前资源受限也隐藏；缺失 view 不创建、不恢复、
不强制关闭。snapshot 已隐藏或成功的隐藏缓存避免重复配置，失败保留重试；后续再次
导航必须重新应用完整 bounds/device/visibility，不能沿用隐藏配置跳过可见性恢复。

URL 导航绑定 `LoadURLWithParamsForResult` 返回的实际 handle；后退/前进绑定返回的
handle 集合。reload 的公开 API 返回 void，因此通过该次控制器调用创建的实际主框架
NavigationRequest 绑定 ID。当前没有 POST 重发确认产品协议，POST reload 明确失败为
`reload_post_confirmation_unsupported`。重定向只更新已绑定记录；自然 JS 导航不继承
一个等待中的产品操作身份。

`DidFinishNavigation` 先结算已提交、网络错误或中止结果，再释放绑定。Chromium 允许
beforeunload 之前的 handle 被删除而没有 finish 回调，因此 50ms UI timer 只检查已绑定
WeakPtr 的存活并将消失的 pending handle 结算 cancelled；不以 loading=false、URL 相同
或超时推断提交。用户取消 beforeunload 的公开通知也触发同一存活检查。

新命令将旧 pending 标记 superseded。终态不可被后来的回调改写。同一 generation/id
及相同 payload/sequence 的重试不再次导航；相同身份不同 payload/sequence 拒绝。
每 view 最多保留 128 条未 ACK 记录，满则拒绝新身份，既不驱逐 pending，也不静默
丢失终态。Control 持久化结果后通过 Endpoint `view.navigation.ack`，携带
`browserIncarnation`、`viewId`、`operationId`、`operationGeneration`，转发 Browser
`navigation.ack`（session/view/两项身份）。ACK 可重复，pending 不可 ACK。
回收后保留每 view 的 sequence 高水位；未知身份的 sequence 不大于高水位时拒绝 stale，
旧 cache 内的 pending 重试不受较新高水位影响。

## 验证

`stop`有自己的操作身份和收据，但不替换Tab当前导航owner，也不覆盖其previousKind/previousUrl。原导航无提交而取消时，按原owner回滚；首次网页导航回到本地start后，仅隐藏已有Native view，不重新ensure或渲染。保留的view仍可结算并ACK尚未返回的stop收据。stop自身committed不表示文档提交，迟到旧stop或旧导航不能回滚后来导航。终态持久化同时同步正在执行的操作对象，避免其finally将committed/rejected写回applying。

Browser renderer显式提供静态错误文档，显示失败URL、网络错误标识及工具栏刷新说明。动态文本HTML转义，页面无脚本、外部资源或额外重试动作；实际错误文档仍对应failed/rejected收据，不改变POST或导航策略。生产HTML helper检查由`tools/test-navigation-error-page.cmd`执行，真实呈现另验。

产品地址栏和起始页输入仍最多8192个UTF-16 code units；经URL规范化或搜索词编码后的最终URL另限8192个UTF-8字节。超限在执行导航前明确拒绝，不截断URL或降级执行部分内容。

Browser控制响应的1MiB上限仍保留；大snapshot返回同request ID的`ok:false/error:response_too_large`小回复，保持健康控制通道、Browser、RTC和导航账本。Endpoint将其作为Browser语义错误向上传递，而非transport故障。页面自身的巨型URL、标题、dialog或多项状态组合仍可能超限；当前没有长字段分页/分块同步，可由用户关闭或改变相关页面后恢复，不承诺任意大状态完整同步。

CPU：运行 `tools\test-navigation-operations.cmd`，直接编译并执行 Browser 使用的
`NavigationOperations` helper；检查重复/冲突、高水位、ACK、128 容量、实例替换转移、
同步回调收集、子框架集合终态和终态不可逆。2026-11-03 此测试已通过。
新增 CPU 回归还覆盖 error-document failed 与 provisional failed 的区别、iframe 提交不
冒充主文档，以及失败后迟到提交不可逆；Control 定向测试覆盖起始页/remote 错误提交、
未提交取消/失败回退、迟到终态与 Browser incarnation 隔离。89/157真实失败错误页、
start首导航stop回滚/Native隐藏及后续恢复均通过；最后补验确认loading清零和刷新按钮恢复。
完整运行边界见[Viewer记录](../develop/docs/robust-viewer-runtime-qa.md)。

以下是可复用的 Browser 功能 QA 清单；实际执行范围以对应运行报告为准，不表示每次构建全部重跑：

1. 用隔离 tenant/view，向带可控延迟的本地 HTTP URL 发送产品导航 A；记录 snapshot
   accepted/started。重发同一身份，确认服务端请求次数和 history entry 不增加。
   改 URL 重发，确认 conflict 且原始导航继续。
2. 本地 redirect 链最终跳到一个可识别标题的页面，确认 A 的 navigationId 不变、url
   更新、最后 committed。DNS/连接失败确认 failed，不能以错误页提交判 committed。
3. 先真实用户激活页面，再安装 beforeunload，导航 B，向实际 beforeunload request
   回复取消；确认 B cancelled、原页面与 history 保持。再次导航并允许，确认新操作
   committed。取消后的自然 JS 导航不得改写 B。
4. 在延迟导航 C 未完成时发送 D，确认 C superseded、D 使用自己的 navigationId；
   C 的迟到 finish 不得提交 D。再 stop 延迟导航，确认旧操作 cancelled、stop committed
   且 stop 没有伪造 navigationId。
5. 后退、前进、reload、fragment/hash 同文档导航分别检查结果；构造 iframe 独立历史，
   确认仅 iframe 后退也能 committed，且没有伪造主框架 navigationId。POST reload 应
   明确返回当前 unsupported，不能丢失 POST 数据或永久留 pending。
6. 对首次 view.ensure 使用 A 身份，确认只加载一次真实 URL、没有额外 about:blank
   history。对 view.recreate 的相同身份重发，不再次销毁实例；不同新身份重建后旧
   pending superseded，已完成旧身份仍去重，sequence 高水位保留。
7. 先持久化终态再 ACK，确认 Browser snapshot 回收该记录、重复 ACK 成功；重发已 ACK
   原始身份得到 stale 且不执行。Browser incarnation 替换后，Control 不能拿新 Browser
   的不相关 URL/loading 状态完成旧收据。
