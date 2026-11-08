# 浏览器兼容性

两个方向：服务端 Browser 对网页表现为 Google Chrome；Viewer 端支持到 Chrome 89。

## 对网页：Chrome 身份

**UA 与 Client Hints**：复用当前 Chromium 版本的 `embedder_support` 生成 UA、版本、平台，保留官方的 GREASE 排列、Windows 平台探测和命令行覆盖语义，只把品牌设为 Google Chrome。不手工维护固定的版本字符串。Client Hints 的 opt-in 按 BrowserContext 和 origin 保存在内存中（`MemoryClientHintsDelegate`），Context 重启后不保留。

**平板版网站**：按 origin 选择平板身份（Android 平板，mobile=false），在首次导航、redirect、history、reload、restore 的请求之前决定；子 frame 继承页面身份。只改 UA/CH，不改 viewport、DPR、触控或指针特征——早期的"平板设备模式"把 UA、viewport meta、移动指标、touch/coarse/no-hover、navigator.platform 绑在一起，导致一个兼容性偏好悄悄改变布局和输入能力，现已拆开。

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
