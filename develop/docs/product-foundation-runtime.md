# 产品化基础实现与验证

2026-11-02。本批已实现；质量自适应、普通页面dialog的产品展示与最终真实Viewer联调仍在继续。它不是最终发布完成声明。

## 状态与操作

Control持久化User/workspace、Window/tab、用户设置与站点UA偏好；旧数据迁移保留tab/webview/token。每Window独立activeTab，窄屏只改变显示集合。设置只存服务端，客户端只持用户cookie token。WS鉴权、状态推送和单Viewer租约贯通，旧Viewer被接管后停止媒体，不自动抢回；匿名旧API需服务端显式开启diagnostics。

Browser恢复数据仍归Endpoint Session与Browser。Control隐藏页满120秒且Browser完整canDiscard允许时请求discard；restore等待真实完成再显示。产品visible与RTC render demand分离；断开RTC保留visible，断开Viewer由Control设hidden。输出重建/fatal/暂停先发空layout撤销旧ready，并关闭源输出需求。

站点规则先于Browser启动恢复下发。UA/CH与viewport/touch分离，导航、redirect、history、reload、restore按origin选择。规则保存不立即改变当前文档；成功应用后才reload选定页。

新窗口先保留真实pending WebContents，再由Control持久化产品归属、分配普通viewId并adopt；不复制URL替代。保留opener/sessionStorage，后台tab不抢焦点，window/popup拥有独立Window。自然close事件先删除产品关联再ack；Endpoint重放未确认事件，避免对账误重建。Pending有16个/30秒边界，closed事件256容量满时拒绝新view，确认后恢复。

## 界面与自动化

MUI外壳、独立窗口/标签/地址、窄屏切换、覆盖式设置已落地。RemoteViewport保留原输入、IME、坐标和ready门禁。普通Viewer通过WS协商媒体；独立/automation无控制面板，/diagnostics保留开发观测，配置由测试工具下放。ws runtime已外置并能随生产包复制。

## 已验证

- Control完整92项测试；类型检查、生产构建和仓库外production smoke。
- Endpoint构建与7项CPU suites；Browser out/dev增量构建，无新增Chromium tracked修改。
- 实际无窗口生命周期：可见拒绝discard、隐藏允许、实际完成、恢复前显示拒绝、restore主帧commit、beforeunload保护。RTC真实H264首帧、重配置空layout后恢复、RTC关闭保留visible。
- 实际UA首请求、双向redirect、history/restore、viewport/DPR/touch不变。
- RTC远程gesture产生popup，adopt保留opener与克隆sessionStorage；原WindowProxy可关闭child。事件跨Endpoint重启重放、重复ACK、超时与无gesture拒绝、容量边界通过。
- Endpoint标准alert/confirm/prompt Unicode及导航beforeunload取消/确认、旧document和重复回复拒绝通过；产品UI回复链尚待接入。
- 实际Control→Endpoint验证UA应用顺序、刷新与断线隐藏/保留viewport。
- Sol通过宿主Playwright mock WS验证桌面双窗、390px窄屏、设置覆盖不改viewport、失败保留服务器选项、地址草稿、新窗焦点、lease撤销与无localStorage。尚不是新UI的真实Chrome89/Endpoint全链路验收。

## 证据入口

原始证据均在develop/tmp：product-lifecycle-smoke-1793549285006292700、product-rtc-smoke-1793549287052、product-ua-smoke-1793550807894406100、product-popup-smoke-1793550710875、product-popup-gesture-smoke-1793550810359、product-event-cap-smoke-1793551080681749700、product-dialog-smoke-1793551094333778900、product-beforeunload-smoke-1793551124877、product-control-runtime-1793551119888。UI图为viewer-ui-narrow.png、viewer-ui-settings.png。

本批未重复性能组。最终发布流程仍为完成功能与文档整理→首版上传→Astra代码审查/必要改进→有变动再构建上传→最后删除goal。
