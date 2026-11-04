# 移动键盘与 viewport 运行回归（2026-11-04）

使用隔离生产 Control、Endpoint 与 Browser，通过 H264 默认 video 路径验证。Viewer 使用已安装 Playwright 启动独立 headed Chrome，测试注册凭据在进程内生成，测试数据库与浏览器 profile 留在临时目录。桌面测试用真实 visualViewport 对象的 height getter 和合成 resize 模拟键盘遮挡，触控与文本输入使用浏览器自动化。实体 Android/iOS 软键盘、系统候选和真实 OS 事件顺序需设备验收。

## 修复前复现

Chrome 157.0.8103.15，Viewer 初始 1152×820，DPR1。可信触控聚焦远端 fixture 文本框，远端收到 `before`。模拟 visualViewport 高度 820→625→520 后，早期媒体屏障仍维持本地 textarea 焦点，随后发生可信 focusout 2823.4ms 和 focusin 2887.3ms。屏障期间注入的 `during` 未送达，远端文本仍为 `before`。PC、两个 DC、video 与 srcObject 的对象身份未变。

证据见 `develop/tmp/keyboard-viewport-qa/baseline157c/keyboard-results.jsonl`、`fixture-events.jsonl` 和 `keyboard-peek.png`。前两次启动因测试驱动错误或初次点击时序中止，无结论。基线隔离服务结束后端口 33781/33782 均未监听。

## 修复后运行

正式入口为`tools/test-keyboard-viewport.mjs`及同目录HTML fixture，参数为Playwright模块目录、Viewer exe、Endpoint exe、Browser exe、全新证据目录和可选端口。工具独立启动loopback Control/测试页并清理自有进程，不依赖develop脚本。

隔离 H264 回环组 `final157-run4` 和 `final89-run4` 均通过：两次键盘视口变化期间本地焦点与远端 composition 保持；peek 顶部锚定并保持比例；一次 `ime_commit` 和一次远端 compositionend，最终文本 `beforeduringafter`；恢复视口、切换 target、拒绝旧 target、真实失焦、普通 resize 模糊拉伸，以及 peer、两个 DC、video、stream和接收track身份保持均通过。

Sol6.1另行读取157与89截图：输入框和斜纹保持比例、顶部y=88不变，内容区底边依次缩至y=625、520，无内容区外残影；普通resize最后帧模糊，工具栏清晰。CSS/几何记录确认160ms的拉伸目标为900×602、新画面ready后移除快照。截图取自过渡中，未单独确认动画终点填满；本轮仅单Window视觉检查。

157 使用 CDP 注入本地 composition。89 的 CDP 缺少 `Input.imeSetComposition`，脚本仅在该方法缺失时在本地 textarea 合成 CompositionEvent；远端仍使用 Native IME。普通文本通过真实自动化键盘输入。桌面模拟不能替代实体移动设备与系统输入法验收。

失败及测试修正保留：`final157`、`final157-run2` 误把 composition 更新和提交时同值替换计作重复提交；均仅一次 compositionend，最终值正确。脚本改为检查发送的 commit、远端 end 和最终值，`final157-run3` 后续阶段通过。`final89-run1` 因缺少 CDP IME 方法中止。`final89-run2`、`final89-run3` 第二框未收到 B：脚本误把历史 inactive target `0` 当作新 target，过早发送；改为等待点击后新收到的非零活动 target 及本地输入焦点，run4 通过。全部结果、fixture 事件和截图保存在 `develop/tmp/keyboard-viewport-qa/` 对应目录。
