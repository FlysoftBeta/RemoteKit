# Control产品状态与运行逻辑

Control、Endpoint与Browser的职责分开：Control拥有产品关系与期望配置；Endpoint Session与Browser拥有执行实例、恢复状态和GPU资源。Client保存用户token，通过WS取得服务端状态，不把localStorage当配置数据库。

## 数据归属

| 所有者 | 持有的数据 |
|---|---|
| Control SQLite | 用户/口令hash/token hash、窗口与tab、active关系、地址意图、质量/ClientScale/Memory Saver/统计设置、origin→tablet UA规则、popup收养收据 |
| Control运行时 | Viewer租约、实际内容区尺寸、临时页面dialog、时钟置信度与质量策略状态、Endpoint实际状态 |
| Endpoint Session | browser进程与有限WebView配置、导航恢复文件、UA/媒体策略运行缓存、未确认自然关闭事件、媒体/输入/GPU资源 |
| Browser | Profile存储、WebContents、history/PageState、同进程sessionStorage关联、原始页面回调和执行代次 |
| Client | 当前服务端状态副本、地址草稿/交互状态、媒体缓冲及观测；持久项只有HttpOnly token |

一个User对应一个workspace及Tenant/Session；一个workspace有多个Window，每Window独立activeTab。平铺Tab通过windowId归属，关闭最后一个Tab保留空Window。布局变窄只切换可见Window，不搬动或合并Tab。

SQLite迁移保留旧Tab/WebView引用及token。旧匿名身份仍标为legacy，专用自动化使用隔离legacy会话；正常新用户通过注册/登录获得独立工作区。当前每用户单活跃Viewer，新连接接管旧连接，旧端停止媒体且不自动争夺。租约绑定token身份，注销/切换账号只撤销同token租约；旧token退出不踢另一个token的活跃Viewer。

## 媒体连接

Viewer在页面启动时预热并缓存接收能力探测，鉴权不等待探测完成。普通产品使用trickle ICE，offer不等待完整候选收集；Endpoint接受协商后异步返回answer和候选，Control按当前租约、连接及尝试标识转发。候选不排在等待answer的Tenant操作后面，其他Tenant也不等待这一协商；接管、退出或取消清除旧绑定。

客户端记录offer、answer、ICE、DataChannel、首次解码与首次呈现；video记录匹配布局后的compositor回调观察，canvas回退记录JS绘制提交，两种终点分开。Endpoint阶段使用自己的单调时钟，不将两个进程的时间戳直接相减。网络模拟使用原完整候选收集与relay路径，不能把普通产品trickle耗时套到该路径。

## 操作、对账与恢复

每Tenant产品提交串行。Client先显示内存pending投影，常规动作经RTC到Endpoint再交Control；Control校验当前connection/Viewer租约，持久化operation收据与意图，实际状态通过snapshot/WS更新。产品提交和对应收据在同一SQLite事务；重复ID返回原收据，不同payload复用ID拒绝。操作受理、Native运行、提交、拒绝、结果未知分别表示，不将导航RPC成功当页面已完成。

state带serverIncarnation与单调snapshotSequence，独立于workspace.revision；运行态变化不会被等workspace revision的旧响应覆盖。WS snapshot为产品权威，DC结果只更新相应pending资格，不直接覆盖workspace。新Viewer不继承旧端内存pending，按Control权威状态恢复；已受理旧操作可完成，但迟到结果不投新peer。

导航保存operationId/operationGeneration/内部单调operationSequence及上一确认状态，Native回报精确navigationOperations终态后才结算；beforeunload取消不靠loading=false猜测。未知执行不自动重放；目标明确关闭或Browser incarnation退役时可标记unknown已解除执行资格，仍不伪称原操作成功。收据有界、换代后旧ID明确expired；见[导航操作](navigation-operations.zh-CN.md)。周期对账只在值变化时配置页面，避免打断输出与输入；未确认导航不能被普通ensure重复执行。

在线恢复顺序是下发完整站点规则和媒体策略、确保Session、再恢复/创建所需WebView。Endpoint优先使用内部导航恢复数据；没有可用数据时才使用Control持有的有限地址信息。Control不保存或解释PageState。恢复由定时状态机分步推进，不在session.ensure逐页等待；恢复期间Control保留产品URL/导航意图，显示restoring，不把中间about:blank写回产品状态。Browser navigationRevision覆盖同文档history和PageState变化，Endpoint按导出revision更新恢复文件。

离线维护不启动Browser，也不补建缺失WebView。session.snapshot是观察；Browser退出时返回running:false。对仍运行的页做隐藏/回收时带requireRunning，避免快照之后进程退出又被维护请求拉起。自然关闭与崩溃丢对象用不同证据处理。

## 可见性与Memory Saver

产品visible由活跃Viewer连接、实际显示Window及其中activeTab决定。Viewer断线设false。RTC状态只控制渲染/编码需求；不能把hidden页面反向WasShown。设置Dialog覆盖显示，不改变远程viewport。

隐藏通过content可见性触发Blink后台调度及renderer进程优先级计算；进程内其他可见页面或媒体等可保留高优先级，焦点不作为隐藏信号。多个Window同时显示时，各自页面保持visible。

Memory Saver默认开启。在线与Viewer断线共用后台策略：持续安全隐藏30秒发freeze，累计安全隐藏120秒发discard，冻结后继续计时；重新可见先恢复。安全资格使用Browser canDiscard，媒体、采集、导航、页面请求、关闭或恢复等保护会清空计时；策略自身freeze的pending阶段暂停累计。计时使用Control本地单调时钟，绑定Browser incarnation与执行实例；缺失对象、重新显示、关闭设置及超过15秒的观察间断均清空，不把宿主休眠或长时间失联当成持续安全闲置。计时不持久化，不跨机传绝对时间。

Browser执行freeze/discard时再次检查资格，包含媒体、设备、导航、关联页面、输入锁、beforeunload和页面请求等实时条件，避免自动冻结取消新到达的页面对话。恢复等待actual=live且pending=false再显示；状态不确定或失败保留原因，不伪装完成。恢复数据不经过Client。普通无beforeunload的表单编辑尚无独立保护，不能宣称完整复制Chrome回收资格。

## 新窗口与页面请求

window.open产生的真实WebContents先进入pending容器，不进入普通orphan集合。Control先持久化产品Window/Tab与viewId，再adopt该对象，保留opener和sessionStorage。前台/后台Tab进入opener的Window；new window/popup产生独立Window，尺寸由Viewer真实布局决定。

pending上限16、30秒超时；关闭/过期对象不会按URL伪装为成功收养。自然window.close产生持久view.closed事件，Control先删除产品关联再ACK；重放幂等。Endpoint持久化关闭事件及desired移除后再ACK Browser，Browser删除完整事件墓碑，但保留本进程紧凑关闭ID集合防旧ID复活。未确认事件达到256时拒绝新增view，不静默丢事件。

alert/confirm/prompt和导航beforeunload是临时pageDialogs。对话身份绑定不可复用的browserIncarnation、view、instance、document和request；回复前刷新检查，Endpoint只向相同运行实例发送，Browser执行点再次校验。关闭确认的公共requestId为完整身份哈希，原生请求号只在服务端保存。后台页显示待处理标记，可见activeTab的请求用MUI Dialog处理。关Tab的beforeunload由pendingClose流程处理，避免重复对话；取消不删Tab；离线或Browser替换取消旧关闭意图并保留Tab。只有明确关闭响应/状态/持久事件才删除，缺页不是关闭证据。

## 站点身份与画质

tablet UA按HTTP(S) origin保存。首次导航、redirect、history、reload和restore选择UA/Client Hints；子frame继承所在页面身份。它不改变viewport、touch或pointer特征。保存规则后先确认Browser已应用再刷新当前页，其他同站点页下次导航生效；用户可取消导航beforeunload。

质量三档只选择WebRTC原生降级偏好：

| 偏好 | DegradationPreference |
|---|---|
| 优先高画质 | MAINTAIN_RESOLUTION |
| 自动 | BALANCED |
| 优先流畅 | MAINTAIN_FRAMERATE |

Control发送`{degradationPreference,maxFps}`；maxFps来自显式Viewer刷新能力，未知默认60。没有三档码率、像素预算、FPS预设，也没有基于延迟的DPR控制器。Client Scale默认Viewer DPR，可显式override；只有实际atlas可分配硬限制会约束DPR。网络缩放只改变编码采样，页面DIP与DPR保持。

反馈只保留诊断，不再触发DPR/码率对账。只有有效源完成时戳才计算呈现估算；新OSR路径未测得完成时戳时省略该样本。video终点是匹配真实RTP/epoch的compositor回调，canvas终点是JS提交，均不是物理屏幕点亮。独立时钟与置信度见[媒体反馈](media-feedback.md)。诊断manual模式不绕过WebRTC拥塞控制。

搜索引擎偏好统一保存Control，地址栏和简易起始页使用同一URL/搜索解析。显式kind=start的Tab由Viewer本地显示，不建立远程页面渲染需求；真实about:blank或popup不因此被覆盖。首个网页导航直接创建目标，不插入伪造Browser历史；空起始页仍保留RTC数据通道。

## 代码入口与验证

状态/请求类型：[shared/product.ts](../control/shared/product.ts)；数据库：[store.ts](../control/server/store.ts)；产品对账：[control.ts](../control/server/control.ts)；HTTP/WS：[http.ts](../control/server/http.ts)；媒体接收：[transport.ts](../control/client/transport.ts)。运行方式见[Control入口](../control/README.md)，接口见[串流协议](streaming-protocol.md)。实际验收及已知限制集中在[当前状态](current-state.zh-CN.md)。


几何规划同时约束面积、单轴、padding和alignment；Control与Endpoint使用共享fixture核对确定性规划。DPR可低于1，实际viewport不变。最低DPR仍无法分配时返回resourceLimitation；不可行resize保留旧有效布局并显示提示，状态查询、关窗和后续resize仍可用。输出暂停后通过Browser原子viewConfigs提交最终布局，避免横竖布局切换产生超限中间矩形。


## 管理员与注册口令

第一个正式账号免注册口令创建并成为管理员。管理员通过更多→管理员面板设置服务器级注册口令；其他用户注册必须提供当前口令，未配置时后续注册关闭。现有账号登录只验证自己的密码，不受口令轮换影响。诊断身份不取得管理员资格，旧数据库按最早正式用户记录迁移管理员。

角色与注册口令归Control SQLite所有；只保存加盐hash，界面只显示是否已配置，不回显口令。公开注册状态不包含秘密。更新接口在服务端检查当前认证身份和管理员资格；并发首注与异步校验期间的口令变化在提交时再次确认。口令不进入产品设置、客户端持久化、日志或发布包。
