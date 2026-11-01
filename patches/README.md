# Chromium patchset

`0001-bounded-capture-pending.patch` 提供默认关闭的
`RemoteKitBoundedCapture` Feature。实验可传
`--enable-features=RemoteKitBoundedCapture:max_pending/1`（或 `/2`）。
上限从请求预留起一直计到按序交付；保留未捕获变化，名额释放时合并 refresh，
遵守最小采集周期，并由 Stop/弱引用取消旧请求。不改帧池回收或 Fence 完成语义。
参数限制为 1–10；未启用 Feature 时保留 Chromium 原行为。

`0002-copy-output-profile.patch` 增加独立、默认关闭的
`RemoteKitCopyOutputProfile` Feature。配合 `gpu.capture` trace category，
按 GPU 进程内 request 指针及 creation/capture counter 关联 dispatch、flush、
submit CPU 边界、Skia submitted/finished callback、mailbox 与 SendResult。
不改变 submit、轮询或 lease 策略。支持时请求 Skia elapsed stats；这是本次
flush 批次（可能含此前未 flush 工作）的 GPU 耗时，不是纯 CopyOutput 时间。
unsupported 和零值缺测明确记录；submitted callback 也不是 OS/GPU 开始执行。
Ganesh submitted/finished 各自拥有独立 callback context；finished 保留失败快路径
的 plain fallback 并转发原 Vulkan cleanup。Graphite 无 per-recording submitted
callback，记录该缺口。补丁按清单顺序应用，逆序撤回。

`0003-offscreen-root.patch` 提供默认关闭的 `RemoteKitOffscreenRoot`。
启用时只把发给Viz的root surface handle设为空，使GPU输出使用官方offscreen
纹理路径；浏览器Compositor的真实HWND、visible状态、尺寸与生命周期保持原样。
不改CopyOutput、GPU完成回调、capture lease或共享Fence。实验只给source
Session browser启用，native demo与接收端Chrome89保持默认。

`0004-capture-render-rate.patch` 是默认关闭的BeginFrame admission实验，
Feature为 `RemoteKitCaptureRenderRate:max_fps/30`（参数限制1–60）。
仅捕获子树设置独立render interval，保留更严格的explicit/cadence规则，
捕获停止或层级重算会清除旧输入；关闭时保留Chromium原捕获豁免行为。
聚焦GN probe验证策略与层级生命周期。用户转向OSR后，本实验未运行GPU性能组，
不作为已验证优化或生产默认。

RemoteKit SDK 通过 Chromium 官方
`//third_party/webrtc_overrides:webrtc_component` 使用 libwebrtc，
无需修改 `timeutils` 的 target visibility。

后续修改 Chromium tracked 源码时，将补丁加入 `manifest.json` 的有序清单，
填写 SHA-256，并用 `tools/patchset.py` 管理检查、应用和逆序撤回。
Chromium overlay `//remotekit` 由 `tools/chromium.py` 维护，不属于 tracked patch。
