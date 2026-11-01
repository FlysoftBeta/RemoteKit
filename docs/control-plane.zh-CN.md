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

SQLite迁移保留旧Tab/WebView引用及token。旧匿名身份仍标为legacy，专用自动化使用隔离legacy会话；正常新用户通过注册/登录获得独立工作区。当前每用户单活跃Viewer，新连接接管旧连接，旧端停止媒体且不自动争夺。

## 操作、对账与恢复

每Tenant操作串行。Control先保存产品意图，再调用Endpoint，实际状态通过快照和WS更新；接受导航或恢复不等于页面已完成。周期对账只在值变化时配置页面，避免周期性打断输出和输入。

在线恢复顺序是下发完整站点规则和媒体策略、确保Session、再恢复/创建所需WebView。Endpoint优先使用内部导航恢复数据；没有可用数据时才使用Control持有的有限地址信息。Control不保存或解释PageState。

离线维护不启动Browser，也不补建缺失WebView。session.snapshot是观察；Browser退出时返回running:false。对仍运行的页做隐藏/回收时带requireRunning，避免快照之后进程退出又被维护请求拉起。自然关闭与崩溃丢对象用不同证据处理。

## 可见性与Memory Saver

产品visible由活跃Viewer连接、实际显示Window及其中activeTab决定。Viewer断线设false。RTC状态只控制渲染/编码需求；不能把hidden页面反向WasShown。设置Dialog覆盖显示，不改变远程viewport。

默认对隐藏120秒且Browser canDiscard允许的页发discard。Browser检查媒体、设备、导航、关联页面、输入锁、beforeunload等实时条件，执行时再次检查。恢复等待actual=live且pending=false再显示；状态不确定或失败保留原因，不伪装完成。恢复数据不经过Client。

## 新窗口与页面请求

window.open产生的真实WebContents先进入pending容器，不进入普通orphan集合。Control先持久化产品Window/Tab与viewId，再adopt该对象，保留opener和sessionStorage。前台/后台Tab进入opener的Window；new window/popup产生独立Window，尺寸由Viewer真实布局决定。

pending上限16、30秒超时；关闭/过期对象不会按URL伪装为成功收养。自然window.close产生持久view.closed事件，Control先删除产品关联再ACK；重放幂等。未确认事件达到256时拒绝新增view，不静默丢事件。

alert/confirm/prompt和导航beforeunload是临时pageDialogs。对话身份绑定Browser进程、view、instance、document和request；回复前刷新检查，Browser执行点再次校验。后台页显示待处理标记，可见activeTab的请求用MUI Dialog处理。关Tab的beforeunload由pendingClose流程处理，避免重复对话；取消不删Tab。

## 站点身份与画质

tablet UA按HTTP(S) origin保存。首次导航、redirect、history、reload和restore选择UA/Client Hints；子frame继承所在页面身份。它不改变viewport、touch或pointer特征。保存规则后先确认Browser已应用再刷新当前页，其他同站点页下次导航生效；用户可取消导航beforeunload。

质量只有三档，初始策略如下；这些是实现选择，不是固定用户要求：

| 偏好 | 可见源像素预算 | FPS上限 | 目标/上限码率 |
|---|---:|---:|---:|
| 优先高画质 | 3840×2160 | 50 | 44/48Mbps |
| 自动 | 1920×1080 | 52 | 36/44Mbps |
| 优先流畅 | 1600×900 | 60 | 24/36Mbps |

实际帧率受显示/网络反馈，编码尺寸与码率还受接收端H264能力和WebRTC拥塞控制。根据可见CSS面积与ClientScale计算统一缩放因子，Browser DPR在0.5–4内；viewport DIP不因质量档改变。连续3个有效反馈窗口估算延迟>300ms降至当前倍率的0.8，调整冷却5秒；<150ms健康30秒后逐级恢复。静态重复、隐藏、无效/过期时钟不触发。

生产估算的终点是canvas提交，起点是源采集完成；它不是Pixel marker E2E。具体映射、置信度和独立媒体反馈见[媒体反馈](media-feedback.md)。受控自动化采用manual模式，显式配置，不运行产品自动质量策略。

## 代码入口与验证

状态/请求类型：[shared/product.ts](../control/shared/product.ts)；数据库：[store.ts](../control/server/store.ts)；产品对账：[control.ts](../control/server/control.ts)；HTTP/WS：[http.ts](../control/server/http.ts)；媒体接收：[transport.ts](../control/client/transport.ts)。运行方式见[Control入口](../control/README.md)，接口见[串流协议](streaming-protocol.md)。实际验收及已知限制集中在[当前状态](current-state.zh-CN.md)。
