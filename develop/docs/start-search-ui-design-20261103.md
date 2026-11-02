# 简易起始页与搜索引擎设置 UI 建议

日期：2026-11-03。状态：设计交接，未实现、未运行验证。root 决定产品状态与历史契约；本文只约定建议的可见行为和组件布局。

## 结论与现状

建议使用 Viewer 原生 React/MUI 起始页，放在各自 Window 的内容区内；起始页身份由 Control 明确提供。新标签的搜索与网址输入复用地址栏导航语义。搜索引擎只在“更多 → 设置”选择，设置即时保存到 Control。

现有 `WindowFrame` 已有 40px 标签栏、48px导航栏、以 `.window-content` 测量的实际内容区；桌面并排最小窗宽约360px，窄屏聚焦一个真实 Window。保留全部外壳尺寸。现有设置是桌面520px弹窗、600px以下全屏覆盖，直接扩展，无须另开设置页面。

代码核对：`ProductSettings` 尚无搜索字段；`control/server/control.ts` 的 `url()` 只接受 `about:blank` 或补全 HTTP(S) 地址，未见现有默认搜索引擎。root 所述“保持现有搜索引擎”需要确认来源；本文不擅自指定默认商家。

## 起始页承载方式：建议与边界

| 方式 | 可见收益 | 必须解决的条件 |
| --- | --- | --- |
| Viewer 客户端产品页（建议） | 初次显示无需等视频；输入法、可访问性与设置风格一致；390px和split自然适配；无外部起始页请求 | Control明确标识；离开/返回起始页的历史语义；本地输入不能穿透给远程；切换不重建Session RTC |
| 远程 WebView 内置页面 | 可沿用远程导航历史与输入 | 需要可恢复且可信的内置URL和资源；搜索设置桥接；起始页本身依赖媒体到帧，配置与呈现跨层增加工作 |

不要用 `tab.url === 'about:blank'` 作为唯一判断。真实 popup 也可能是 about:blank，随后由 opener 写入页面；直接盖上起始页会遮蔽真实网页。应由 root 确定专用身份/URL契约，明确区分“产品新标签”和“网页空白文档”。前端不得单独持久化或自行推断该身份。

推荐保留现有产品Tab与稳定ID；打开起始页只改变此Tab的内容呈现，不把它变为整个Viewer首页，不因打开它调用 transport.disconnect/connect，不卸载其他窗口的video。远程页是否保留WebView、如何表示历史由root定。需要验证同一Tab离开/返回时无旧画面闪现和旧输入穿透；不能靠渲染层假造 canGoBack/canGoForward。

## 布局与视觉

内容只保留一组：小号“RemoteKit”标题、一行搜索/地址输入、当前引擎说明。没有新闻、广告、推荐站点、装饰插画、天气、背景图或第二套导航按钮。

- 背景沿用 `#F2F4F7`，输入为白色；标题28px/600、正文14px、说明12px。标题与输入间24px，输入与说明间10px。
- 内容组最大宽520px，水平居中，常态处于内容区上半部；上下使用自动空白分配而非绝对居中裁切。
- 页面左右padding 24px；360/390px窗宽也保持24px，表单宽312/342px，无多列元素。只依赖所在Window宽度，不靠整个Viewer的媒体查询来推断split窗宽。
- 搜索框48px高，圆角12px、1px divider边框；focus边框/外轮廓使用现有primary。左边MUI `Search`，中间 `InputBase`，右边44×44px的提交IconButton（`ArrowForward`，可访问名称“搜索或打开”）。触控目标不缩到图标本体大小。
- 输入placeholder“搜索或输入网址”；`aria-label`同文案。地址栏同步改为相同占位文案与名称。
- 说明文案“使用 {引擎名称} 搜索 · 可在更多 → 设置中更改”。仅说明，不放第二个引擎选择器，也不增加直接设置入口。
- 起始页标签标题“新标签页”，使用已有Language图标即可。地址栏展示空字符串；内部身份不展示成可编辑技术URL。

建议新增 `StartPage`（放独立 `start-page.tsx`），输入由组件本地内存保存，接收 `engineLabel`、`online`、`busy`、`error`、`onSubmit(value)`。不获取独立设置、不操作transport、不持久化。

```css
.start-page {
  position: absolute;
  inset: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 24px;
  background: #f2f4f7;
}
.start-page::before { content: ""; flex: 1 0 16px; }
.start-page::after { content: ""; flex: 2 0 32px; }
.start-page-body { width: 100%; max-width: 520px; flex: 0 0 auto; }
.start-page-form {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 48px;
  padding-left: 14px;
  border: 1px solid #dde2e8;
  border-radius: 12px;
  background: #fff;
}
.start-page-form:focus-within {
  border-color: #245db5;
  box-shadow: 0 0 0 1px #245db5;
}
.start-page-form .MuiInputBase-root { flex: 1; min-width: 0; margin-left: 10px; }
.start-page-form .MuiIconButton-root { width: 44px; height: 44px; flex-shrink: 0; }
```

不依赖CSS container queries、`:has`、`dvh`或新浏览器专属功能。软键盘缩小内容区时允许起始页自己纵向滚动；不改变`.window-content`尺寸来源、不为起始页增加viewport模拟参数。

## 操作、焦点与导航

| 场景 | 建议行为 |
| --- | --- |
| 点击“+”或更多→新建标签页 | 经Control创建并激活起始Tab；桌面将焦点给该Window地址栏，避免地址栏和中央框双重autofocus；移动端不主动弹软键盘，点输入框后正常聚焦 |
| 新建窗口 | 新Window含一个起始Tab；窄屏切至新Window；桌面仍是独立Window，不把当前窗的Tab伪装成新Window |
| Window内无Tab | 直接用同款起始页；提交时 `tab.create`，不额外要求先点一次“新建标签页” |
| 没有任何Window | 保留现有“开始浏览 / 新建窗口”入口；不要在组件render或重连时偷偷重建Window |
| 搜索框/地址栏提交 | trim后为空不动作；地址直接导航，其他文本交所选引擎；交给同一个服务端解析契约，避免两个输入框行为分叉 |
| 提交成功 | 在当前Tab打开结果，不跳出Viewer、不默认开新Tab；请求受理后转远程加载态，等待当前布局/画面ready，不露出旧帧 |
| 请求失败 | 保留输入与起始页；框下显示“未能打开，请重试”及可读原因；不把用户输入清成空串；重新聚焦原提交框 |
| 浏览器后退/前进 | 若root采用带历史的起始页，网页后退应回到起始页，前进回到网页；受Control/history状态驱动。不得只做一次客户端cover从而吞掉远程历史 |
| 起始页刷新 | 幂等保持起始页；不把刷新当重连RTC；不清除当前正在编辑的搜索文字 |
| 用户显式输入about:blank | 保留真实空白页语义，不替换为产品起始页 |
| 恢复登录/重连 | 从Control恢复Tab身份及已保存引擎；不自动抢输入焦点；草稿无持久化保证 |

焦点细节：只在用户明确新建时自动聚焦桌面地址栏，现有“active.id改变且about:blank就focus”的effect应改为明确创建/聚焦意图，避免split后台Tab抢焦点。`Ctrl/Cmd+L`沿用现有当前Window地址栏行为；中央表单的Enter提交要防IME composition（`isComposing`及兼容keyCode229），拼音确认不得触发导航。Escape在地址栏恢复当前显示值；在中央框可清空当前草稿并保持focus。Tab顺序按DOM自然走输入→提交，图标不独立进入tab序列。

起始页区域的键鼠/触控不传RemoteViewport，远程隐藏input不能再接焦点。提交后只有当前epoch画面ready才允许远程输入；客户端加载态使用现有页面/标签spinner，不制造新的“RTC正在连接”提示。

## 搜索引擎设置

在现有 `SettingsDialog` 顶部加入“搜索”小节，然后Divider及原画面质量/其他设置。这样常用浏览设置靠前；现有520px弹窗和窄屏全屏布局不变，也不改变底下内容bounds。

推荐 MUI `FormControl fullWidth size="small"` + `InputLabel`“默认搜索引擎” + `Select` + `MenuItem`。候选建议Google、Bing、百度、DuckDuckGo，最终名单/默认值由root定；只显示文字，不拉外部logo或favicon。设置说明“用于地址栏和起始页中的搜索”。本批不增加自定义URL模板编辑器。

Select受Control已确认值控制。用户选中即提交，只更新该字段；保存中禁用此Select并在下方固定高度状态行显示“正在保存…”，成功显示“已保存”。失败保持原引擎并显示“未保存，请重试”，避免UI看起来已经切换但实际搜索仍走旧引擎。现有`save(key, partialSettings)`与`note(key)`可复用，补足保存中状态和online禁用。

保存等待期间允许关闭设置；请求由已有action生命周期完成。再次打开显示Control值，不缓存“用户曾选过”的值。换引擎不重载当前网页、不修改已有搜索结果或历史记录；只有保存成功后的新搜索采用新值。起始页说明随state更新；保存尚未成功时一直显示旧引擎。

离线时可展示已收到的设置和起始页草稿，禁用保存/提交；沿用Viewer已有断线提示，避免每个Window重复大块警告。首次尚未拿到state仍保留现有“正在准备浏览器…”而不是猜测引擎。引擎结果网站不可达属于远程网页加载失败，允许刷新/后退/改地址，不静默切换服务商。产品起始页本身没有外部资源加载失败依赖。

## 实施后的必要检查范围

1. Chrome89与新版：390px聚焦、桌面双Window、360px左右split，无横向溢出；设置覆盖前中后内容bounds不变。
2. 中英文文本、完整URL、裸域名、带端口本地地址、空白、IME回车；地址栏与中央框结果一致。
3. 设置成功/失败/断线/重载后的引擎值；换引擎不影响已打开页；客户端不新增设置持久化。
4. 起始页→网页→后退→前进；显式about:blank与opener写入的popup不被遮挡；恢复/丢弃后身份不漂移。
5. 一个Window打开起始页时另一个Window视频和RTC身份稳定；起始页输入不穿透，提交后无旧帧或旧epoch输入放行。

这些是本批功能检查，不重新运行既有性能矩阵。历史方案若本批无法实现，需要root在范围上明确决策并同步可见行为说明，不能由UI假造完成。
