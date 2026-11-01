# Capture render admission：已实现，未运行性能组

用户转向CEF式OSR渲染目标后，本轮停止30/20fps性能计划。没有启动任何新GPU/浏览器case，没有采用该策略作为生产默认。

`0004-capture-render-rate.patch`提供默认关闭的 `RemoteKitCaptureRenderRate`，参数max_fps默认30、限制1–60。prepare的 `-CaptureRenderFps 0`关闭；非零值仅给source Session browser组合Feature。native demo、接收端Chrome89和未捕获FrameSink规则保持原样。

实现位于GPU侧FrameSinkManagerImpl既有capture子树规则，复用现有BeginFrame admission、递归和FrameSinkThrottler。独立capture_render_interval默认0；仅大于0时取max（explicit interval、当前有效cadence interval、capture interval），避免放宽已有更严格规则。零值保留Chromium原先cadence优先语义。所有全量/子树重算入口先清旧capture输入，当前捕获子树再设置；停止捕获、late child注册和层级变化沿既有规则重算。没有Host端ID缓存，没有新增逐帧IPC，也未修改GPU完成/Fence/lease。

增加独立输入的原因是现有SetThrottleInterval会替换原间隔，且FrameSinkThrottler的simple cadence原本能覆盖更严格explicit interval；直接覆盖参数不能实现主Agent要求的保留更严格规则。

正式聚焦probe为 `browser/capture_render_rate_probe.cc`，GN目标 `remotekit_capture_render_rate_probe`。它直接使用真实FrameSinkThrottler和FrameSinkManagerImpl，在无GPU条件下检查explicit/cadence/global优先级、停止捕获恢复、late child、unparent/reparent，以及Feature关闭的捕获豁免。不构建整套viz_unittests。运行方式为默认Feature on与 `--off` 两次。

统一browser/browser_demo/SDK/probe增量构建通过（15steps）。probe完成必要的FieldTrialList/FeatureList初始化，使用既有GetThrottlerForTesting与CommandLine接口；Feature on/off两次实际运行均退出0，explicit/cadence/global、capture stop、late child与unparent/reparent检查通过。测试日志为 `develop/tmp/capture-render-rate-probe-on.log` 和 `capture-render-rate-probe-off.log`。

原计划的窗口baseline/offscreen+30/window+30及可选offscreen+20全部未运行。没有RAF/CSS节拍、真实GPU捕获或最终FPS/p95的该Feature实测证据，不能将30fps admission写成达到50FPS目标。

prepare同时修正BrowserDirectComposition和BrowserHostScale大小写：ValidateSet接受的值先ToLowerInvariant，再形成严格小写Endpoint参数。使用真实paramblock与赋值AST完成无GPU构造检查，OFF/AUTO与AUTO/1均生成正确参数，记录在 `develop/tmp/prepare-browser-option-normalization.json`。
