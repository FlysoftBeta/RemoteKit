# Browser 单 Session 服务契约

默认 remotekit_browser 为单 Session 服务。启动必须提供 --control-channel、--tenant-id、--session-id（非零 uint64 十进制）、--data-path（独立绝对目录）；--atlas-width/--atlas-height 是固定 atlas DIP 尺寸，默认1920x1080。服务不建默认页。原演示仅编译显式 GN target remotekit_browser_demo，普通 remotekit_browser 拒绝 --demo-harness/--sessions/--urls/--parent-window。

JSON 沿用 version=1、正整数 id；Session/View/Profile/token 的64位字段均十进制字符串。单个 browser 只接受启动 Session；Profile 当前为字符串 "1"。

- view.create：session、view（调用方稳定ID）、url、width、height，device="desktop"或"tablet"（默认desktop）。成功返回 accepted=true/completed=true/token；同 ID 同配置重试返回同一页面，不重新导航；同 ID 不同配置返回冲突。width/height 是 viewport DIP，必须通过本 Session packing。正常关闭的ID保留墓碑，不允许重用，重建 browser 后可按原 ID 创建。
- view.configure：session、view、width、height、device；关闭中的页面拒绝变更。更新 viewport 和设备特征后重排同 Session atlas。device_scale 是 output.configure 的全 atlas 分辨率配置；tablet 使用官方 UA override 设 Android tablet Chrome（不带 Mobile），CH platform Android/mobile=false/formFactors Tablet。
- view.close：session、view、force（默认false）。返回 accepted 与 completed；正常关闭触发 beforeunload/unload，通过 page.requests/page.reply 处理确认。snapshot 页面带 close_state（open/closing/cancelled/closed），正常删除后以 closed 墓碑报告；关闭被网页取消时可再次请求。force=true 直接回收，用于 orphan，不等待网页。
- snapshot：只返回本 Session（demo模式保留原多Session行为）。其他输入、生命周期、page.*、导航转移及 output.* 沿用原协议。

服务 focus 命令必须包含当前 focus token（同时建议提供 instance/document）；重排会清理手势并提升全部页面 focus token，旧布局输入被拒绝。

仅visible页面参与atlas；后台页面保留自己的viewport但不占输出平面。output.configure增加width/height DIP，改尺寸前须output.close，随后open新资源代。Endpoint按可见页面有效尺寸重建输出，复用同D3D设备并保留旧代直到GPU及SDK/编码lease排空。

DataChannel layout.epoch按几何、资源、可见集合及instance/document变化递增；focus变化不增。每编码完成帧消息用实际wire RTP timestamp绑定job.frame.layout_epoch，回调只入队，由media线程发送。input/focus必须带layoutEpoch，拒绝旧代。

view.recreate保留逻辑ID、提升实例代并创建全新WebContents，用于导航blob不可恢复时按产品URL重新GET。Endpoint导航持久化按主帧提交保存，不持续同步滚动/history.pushState等未提交快照变化。跨browser sessionStorage仍不恢复。

已接官方 Blink device metrics、viewport、触摸能力、coarse pointer/no hover；UA/CH覆盖为Android tablet Chrome。页面navigator.platform通过public WebViewObserver/RendererPreferences + WebSettings::SetFromStrings("navigatorPlatformOverride")原生覆盖为官方Android reduced值Linux armv81，并随UA配置动态切换；不附加CDP、不注入JS。WorkerNavigator不属于WebView设置，仍需单独核对。此契约不声称具备真实Android或传感器实现。

## 编码采样边界

网页viewport/DPR与browser原atlas不因编码cap改变。Endpoint在协商ICE完成后读取SDK官方parsed SDP得到effective发送level，按H264 MaxFS/MaxMBPS、CLI目标FPS和4096硬件边长选择偶数编码尺寸；D3D11 VideoProcessor从原BGRA atlas直接缩放到NV12。SDK native frame逻辑width/height为采样尺寸，纹理保持原尺寸。layout坐标与extent为编码像素，每view.mediaScale说明采样比例，DIP换算除以deviceScaleFactor*mediaScale。stats.sourceWidth/Height与encodedWidth/Height/mediaScale/receiveLevel分别展示原输出与编码代价。此处不降低设备DPR。


## 2026-11-01 独立网页 DPR / metadata v2

browser `view.create`/`view.configure` 增加可选 `device_scale_factor` 数字（0.5..4）；缺省创建为继承 output/native DPI，缺省 configure 保留原设置。Endpoint 将 Control device.deviceScaleFactor 显式转发，不把 atlas 公共 scale 当网页 DPR。snapshot deviceScaleFactor 为有效 page DPR。

共享 metadata version2：SharedAtlasView112 字节，SharedAtlasMapping7296 字节；atlas_pixels_per_dip 保持旧坐标换算语义，page_device_scale_factor 为网页 DPR。网络 layout.deviceScaleFactor=page DPR，per-view mediaScale=atlas_pixels_per_dip/page DPR×编码等比采样；网络输入依旧除以两者乘积。native demo 输入直接除 atlas_pixels_per_dip。所有 browser/SDK/endpoint 必须同步重建。
