# Viewer 与网页全屏运行验收

运行器为 [test-fullscreen.mjs](../../tools/test-fullscreen.mjs)。使用独立的 loopback Control、Endpoint 数据目录、账户和 Viewer Profile。以 Chromium 157.0.8103.15、Google Chrome 89.0.4389.90 顺序运行两组。fixture 持续改变 24×24 画面标记，避开 Chrome 89 的已知 QSV 静态 1 FPS 路径。测试证据放在 `develop/tmp/`。

- 网页全屏覆盖双窗模式、真实 H.264、可信点击与远页激活、标准 Fullscreen API 与退出、跨文档导航清理、Viewer 悬浮退出按钮。记录内容 bounds、导航栏和其他窗口可见性、远页点击坐标以及原生 Viewer 全屏调用次数。
- Viewer 全屏覆盖设置开关、Control 收据和重载读回。使用无手势的 CDP 观测，分别记录无 transient activation 时的原生 API 拒绝、合成指针无重试及可信输入后的成功请求。恢复激活场景由合成 blur/focus 驱动，单独记录其覆盖边界。
- 每个文档内核对 peer、接收 track 与 DataChannel 对象保持。Viewer 重载新建文档，按重载前后分开取样。验收过程不计性能。

## 运行结果

2026-11-04 20:27:27（Asia/Singapore）的 Control 生产构建通过 TypeScript、Vite、bundle 验证和生产启动 smoke。该构建早于工作区后续媒体诊断文件的变更。配套使用 `C:/src/chromium/src/out/dev/remotekit_browser.exe` 与 `build/endpoint-package/endpoint/endpoint_service.exe`。

- **Chrome 89 完整组 `fullscreen-89-3` 通过。** 真实 H.264 双窗各有画面。页面的可信按钮令远页 `MAIN` 进入全屏，Viewer 与远页内容均为 1152×820，标签栏和导航栏消失，只剩当前窗，外层未调用原生全屏 API。右下角真实点击到达远页 (1018, 723)。网页 API 退出、跨文档导航恢复双窗、悬浮按钮退出均通过，peer、两个 DataChannel 和接收 track 保持。外层设置重载读回为 true，启动原生请求无激活遭拒，可信输入进入浏览器原生全屏。原生退出后，以合成 blur/focus 驱动恢复，原生 API 再次拒绝无激活的请求，随后可信点击成功，同一文档内保持媒体连接。
- **Chromium 157 内层通过。** `fullscreen-157-1` 与 `fullscreen-157-2` 通过初版客户端内层完整组，证据包括全屏内容与外壳几何、可信右下点击、网页 API 退出、跨文档导航与悬浮按钮。终版客户端窄组 `fullscreen-157-final-5` 再次通过全屏内容和点击，Escape 退出恢复双窗，媒体连接保持。
- **Chromium 157 外层在原生授权处未通过。** 终版单窗诊断 `fullscreen-157-outer-final` 通过 Control 保存、重载读回及启动尝试。记录显示页面 visible、focused、fullscreenEnabled=true。无激活启动请求被原生 API 拒绝，错误为 `TypeError: Permissions check failed`。随后四次可信 pointerup 均有 transient activation，实际调用原生 API 后返回 `TypeError: not granted`。因此该环境验证了重试，未获得原生全屏。使用 `C:/src/chromium/src/out/rel/chrome.exe`（157.0.8103.15），headed，1152×820、DPR 1，隔离 Profile；启动附加参数为 `--no-first-run`、`--no-default-browser-check`、`--autoplay-policy=no-user-gesture-required`。Chrome 89 同一运行方式使用 `C:/src/tmp/chrome89-google/app/chrome.exe`（89.0.4389.90）。

Chrome 89 的已通过组早于合成 pointerup 断言与普通点击不重新进入的断言。终版运行器包含这两条断言，本轮实际运行未到达，仍待验证。恢复激活由确定性的合成 blur/focus 驱动，未实测切到其他应用再返回。选定的测试端口均已关闭。

此前未通过的试验保留在临时目录。89 首次受 Playwright 新版 locator 调用 `checkVisibility()` 限制，另一次在登录监听安装前发送了解锁序列，调整运行器后通过。157 初期遇到设置开关的受控回执和认证重附着时序问题。后续窄组 `final-3/4` 的左窗截图和 Control 操作收据确认菜单关闭过渡中 Enter 意外创建三张起始页，导致双窗画面条件未满足。修复等待菜单卸载和确认地址栏仍拥有焦点后，终版窄组通过内层。未重复性能或静态 QSV 验收。
