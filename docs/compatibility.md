# 浏览器兼容性

两个方向：服务端 Browser 对网页表现为 Google Chrome；Viewer 端支持到 Chrome 89。

## 对网页：Chrome 身份

**UA 与 Client Hints**：复用当前 Chromium 版本的 `embedder_support` 生成 UA、版本、平台，保留官方的 GREASE 排列、Windows 平台探测和命令行覆盖语义，只把品牌设为 Google Chrome。不手工维护固定的版本字符串。Client Hints 的 opt-in 按 origin 写入 Profile 目录，Browser 重启后仍然有效，与 Chrome 的内容设置一致。

**语言**：Browser 按简体中文版 Chrome 构建：界面 locale `zh-CN`，`locales/zh-CN.pak` 缺失的字符串回退到 `locales/en-US.pak`（ResourceBundle 次要 locale），两个 pak 缺一即启动失败、打包失败。Blink 自带文字（表单校验气泡、文件输入框、日期控件）、`Intl` 默认 locale 与错误页都是中文。语言偏好只有一份（`chrome_parity.h` 的 `zh-CN,zh,en-US,en`）：`Accept-Language` 用 Chrome 同样的展开与 q 值生成（`zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7`），页面和所有 worker 的 `navigator.languages` 是同一列表。

**Chrome 默认偏好**（`chrome_parity.cc`，`OverrideWebPreferences`）：按 Windows 中文版 Chrome 的默认值硬编码——各书写系统的字体族（取自 Chrome 的 `prefs_tab_helper` 与 `locale_settings_win` zh-CN）、默认编码 GBK、最小逻辑字号 12px、Windows 焦点环颜色。输入能力不读服务器硬件：两种身份都表现为 Windows 触屏笔记本（10 触点、`ontouchstart` 存在、主指针 fine、可用指针 fine+coarse、hover），与 Viewer 实际注入的触控一致。配色固定为 light、无对比度偏好、无强制颜色，服务器的 Windows 主题不会泄露给页面。

**屏幕**：每个视图一块虚拟显示器，尺寸等于视图 viewport、DSF 等于视图 DPR；Screen 按 Aura 根窗口返回所属视图的显示器，跨进程 iframe 与主 frame 看到相同的 `screen`，尺寸变化触发屏幕变更事件。不再对主 widget 做设备模拟。桌面身份按普通显示器上报方向：横屏 `landscape-primary` 0°，竖屏按 Windows 旋转显示器的约定 270°；平板身份沿用竖屏为自然方向的约定（横屏 90°、竖屏 0°），与下文的 `window.orientation` 一致。

**平板版网站**：按 origin 选择平板身份（Android 平板，mobile=false），在首次导航、redirect、history、reload、restore 的请求之前决定；子 frame 继承页面身份。只改 UA/CH，不改 viewport、DPR、触控或指针特征——早期的"平板设备模式"把 UA、viewport meta、移动指标、touch/coarse/no-hover、navigator.platform 绑在一起，导致一个兼容性偏好悄悄改变布局和输入能力，现已拆开。

Worker 跟随自己的 origin 选择身份，而不是创建它的页面：service worker 可以在没有任何页面时启动。补丁 `0017-origin-worker-identity` 给 content 增加 `ContentBrowserClient::OverrideWorkerIdentity(context, origin, prefs)`，dedicated/shared/service worker 启动、主脚本请求和 worker 发出的 fetch 都经过它；RemoteKit 在其中按 `TabletUaFor(origin)` 写入 UA、UA metadata 与新增的 `RendererPreferences::navigator_platform_override`（`WorkerNavigator.platform`）。页面一侧的 `navigator.platform` 仍由 WebView 设置 `navigatorPlatformOverride` 提供。

平板身份同时提供 Android 才有的 `window.orientation` 与 `onorientationchange`：看到移动 UA 的站点（如网易云游戏）只按 `window.orientation` 判断横竖屏，缺失即视为竖屏，横版画面会被页面自己旋转 90°。Blink 用进程全局的 OrientationEvent 开关控制这两个属性（DevTools 移动模拟就是翻转它），会波及同进程的桌面身份页面，所以改由 `CompatRendererClient` 在平板身份文档的主 world 里按 context 安装原生 accessor：

- `orientation` 取 frame widget 的屏幕角度（来自视图的虚拟显示器），换算到 WebKit 的 [-90, 180]，与 `screen.orientation.angle` 一致：横屏 90、竖屏 0。
- `onorientationchange` 按 EventHandler 语义保存对象、其他值变为 null；`screen.orientation` 的 change 来自同一次 widget 方向更新，据此在 window 上派发 `orientationchange`。Event 构造器和 `dispatchEvent` 在页面脚本运行前取得。与原生实现的差别：事件 `isTrusted` 为 false，handler 的监听位置固定在页面所有监听器之前。
- 桌面身份不暴露这两个属性，与桌面 Chrome 一致。

**没有后端的服务**：Chrome 由产品层提供、而本服务没有对应后端的接口，页面看到的是 Chrome 在"没有该设备/账户/应用"或"用户取消"时的结果，不能是 renderer 被杀、挂起或错误的异常。依据 Chrome `chrome_browser_interface_binders` 的清单逐项补齐 content 没有绑定的接口（缺少 binder 会以坏消息终止 renderer，例如 `navigator.setAppBadge()`），实现在 `browser/services_*.cc`：

| 接口 | 页面看到的结果 |
|---|---|
| Badging | set/clear 正常 resolve，不显示（未安装的网站在 Chrome 里同样被忽略） |
| Payment Request | `canMakePayment`/`hasEnrolledInstrument` 为 false，`show()` 以 `NotSupportedError` 拒绝；Secure Payment Confirmation 不可用 |
| Credential Management（密码） | `get()` 返回 null，`store()`、`preventSilentAccess()` resolve |
| Web Share | 以 `AbortError`（取消分享）结束 |
| 语音识别 | 没有麦克风：`audio-capture` 错误后 `end` |
| Push | `AbortError`，"Registration failed - push service error" |
| Background Sync | 一次性同步在页面 renderer 存活时触发；周期同步不可用 |
| 画中画 | 按策略关闭：`pictureInPictureEnabled === false`，请求以 `NotSupportedError` 拒绝，Document PiP 不存在 |

**宿主设备隔离**：服务器自身的摄像头、麦克风、USB、HID、串口、蓝牙、Windows Hello/平台验证器和 Windows 定位属于宿主，不属于租户。补丁 `0018-host-device-isolation` 给 content 增加 `ContentBrowserClient::AllowHostDeviceAccess()`，RemoteKit 返回 false，content 在媒体设备枚举、蓝牙、WebAuthn 发现与语音识别入口处直接走"没有设备"的路径。页面结果：`enumerateDevices()` 为空、`getUserMedia` 为 `NotFoundError`、`getDisplayMedia` 为 `NotAllowedError`；USB/串口/蓝牙的选择以 `NotFoundError` 结束、HID 返回空列表；`isUserVerifyingPlatformAuthenticatorAvailable()` 为 false，`create/get` 在超时内以 `NotAllowedError` 拒绝，服务器桌面上不会出现 Windows Hello；地理位置在获准后报告 `POSITION_UNAVAILABLE`。媒体设备 ID 的 salt 按 Profile 持久化。客户端证书：空证书库，TLS 在没有客户端证书的情况下继续。

**其他 Chrome 行为**：Ctrl/中键点击与带修饰键的打开经 `OpenURLFromTab` 走与 popup 相同的产品 Tab 路径；service worker 的 `clients.openWindow` 经 `ContentBrowserClient::OpenURL` 打开产品 Tab。全屏时 `display-mode: fullscreen` 成立并触发 change；启用 back/forward cache；安装 Chrome 的 origin trial 策略；随包提供断字词典，`hyphens: auto` 生效；旧的 YouTube/Dailymotion/Vimeo Flash 嵌入按 Chrome 规则改写为 HTML 播放器。平板身份额外提供 Android 的 `navigator.connection.type`（`wifi`）/`downlinkMax`/`ontypechange`；`screen.orientation.lock()` 在全屏且方向已匹配时成功，否则以不支持拒绝（无法旋转 Viewer），桌面身份按 Windows Chrome 拒绝。

**`window.chrome`**：通过 renderer 原生绑定建立（`CompatRendererClient`），不注入页面脚本——注入的 JS 对象无法得到正确的绑定寿命和 world 控制。

| 接口 | 行为 |
|---|---|
| `loadTimes` / `csi` | 编译官方 `loadtimes_bindings`，每个 frame world 安装 |
| `app.isInstalled` / `getIsInstalled()` | false；isInstalled 是原生 getter 加空 setter |
| `app.getDetails()` | null |
| `app.runningState()` | `cannot_run` |
| `app.installState(callback)` | 在后续 renderer 任务里回调 `not_installed`；文档被替换或 context 分离后丢弃回调 |
| `app.InstallState` / `RunningState` | 官方 schema 的枚举成员与值 |
| `runtime` | 不装配扩展框架，普通页面上不存在 |

`app` 只装在主 world，是"没有已安装 hosted app 的普通网页"的 stub：同步方法校验零参数，函数不能作为构造器，`installState` 只支持回调形式。扩展、扩展 worker、app registry 与安装服务均未装配。

## Viewer：Chrome 89

Viewer 仍支持 Chrome 89（89.0.4389.90），因此：

- 布局用 flex/grid/ResizeObserver 和特性检测，不依赖 container query、`:has`、`dvh`、OffscreenCanvas 或新的 viewport API。
- 89 的 `outline` 不跟随 `border-radius`（94 起才跟随），圆角元素的描边/选中环用 `box-shadow`；会被子内容盖住的（窗口卡片、磁贴）用绝对定位的伪元素边框。
- 89 计算 flex 容器的固有宽度时只看项目内容宽度，忽略 `flex-basis`：滚动的标签条若靠 `flex-basis` 定宽，会被压到内容宽度并滚动。需要参与固有尺寸的定宽用 `width`。
- 接收能力：89 没有 WebCodecs，它的 MediaCapabilities 对 `type:'webrtc'` 抛 TypeError，所以探测总是没有结论，按物理屏幕声明所需 level（见[编码 · H.264 level](encoding.md#h264-level)）。它的 SDP factory 默认（640×480@30）不是解码上限，实测能接受 level 4.2 的 SPS。
- 没有 `jitterBufferTarget`，使用 `playoutDelayHint = 0`。
- 没有 `getCoalescedEvents` 时触控只发单采样。
- 没有 `beforeinput` 时 IME 依赖 `input` 事件；89 的软键盘同时缩小 layout 与 visual viewport。
- 把同一个 video 元素复用到新 peer 时可能出现只解码不回调 rVFC，所以新 peer/track 总是新建元素。
- 89 的解码分发与 157 相同：一条远端 track 解码一次，分发给多个播放器。

API 存在或 SDP 被接受都不能证明硬件解码；要看实际的解码器实现和流是否正常播放。
