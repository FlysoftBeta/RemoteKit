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

同一 Feature 还记录 Viz child 的第一处 paint flush 和 root 的现有
`SkiaOutputDevice::Flush` GPU elapsed、实际 SkSurface 尺寸/色型/sample count，
以及 output/context、本地 frame 序号和 child mailbox。原第二次 child
cleanup/semaphore flush 保持原样，root callback 在已有 cleanup 组合后转发；
不增加 flush、submit 或同步等待。Graphite paint 与 Vulkan secondary-CB
明确记录不支持该测点。`tools/analyze-viz-gpu-profile.py --case CASE`
分别统计两个 scope，不把它们和 renderer/CopyOutput 重叠区间相加。

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

`0005-synthetic-vsync-deadline.patch` 只增强Windows已有
`--fake-vsync-rate=60`（或其他正数Hz）的等待：使用单调绝对deadline维持
phase，优先一次性高精度waitable timer，创建失败尝试普通timer，Set/Wait
运行期失败直接Sleep回退。fake interval统一至少1ms，等待与Notify使用同值。
迟到跳过过期tick，不补发burst；idle与suspend后重建phase。真实DXGI/DComp
等待、renderer/rVFC与呈现反馈通路保持原样。out/rel增量chrome已编译通过，
当前后续修正版保留整个fake等待期间旧有成对高精度timer请求，不永久开启、
Sleep降级不重复嵌套；修正版out/rel增量chrome已编译通过，待A/B运行验证。

后续修改 Chromium tracked 源码时，将补丁加入 `manifest.json` 的有序清单，
填写 SHA-256，并用 `tools/patchset.py` 管理检查、应用和逆序撤回。
Chromium overlay `//remotekit` 由 `tools/chromium.py` 维护，不属于 tracked patch。

`0007-capture-to-atlas.patch` 同时维护捕获交付的Oracle结算：每次已记录的
capture在成功、读回失败、目标换代或进入GPU前取消时均恰好CompleteCapture一次。
失败不发布像素，也不替代GPU Fence；这避免静态resize取消后pending计数阻止
后续refresh。小目标`capture_to_atlas_pool_unittests`包含直接走真实交付/Oracle的
取消恢复、成功结算与Oracle拒绝回归，运行结果见本批默认video QA与当前状态。

`0008-touch-injection-dispatch-result.patch` 保留 TouchEmulatorImpl 原有void
InjectTouchEvent，增加兼容的bool InjectTouchEventWithResult。返回值仅表示事件
经官方ForwardEmulatedTouchEvent接受派发；原生流排他、无有效start或gesture
provider拒绝仍返回false。canonical ACK可能同步到达，完成时机不能视为失败，
派发接受也不等于页面消费。补丁不改变touch-action、preventDefault、gesture策略
或ACK路由；含同步ACK、native排他与缺失start的官方unit分支测试。

`0009-headless-fling-physical-metrics.patch` 使FlingScheduler在服务内部marker
`remotekit-service-input`下固定使用官方kDefaultPixelsPerInch(96)逻辑PPI，
不读取宿主物理屏幕PPI。marker由服务构建自动附加，非UI或可调数值设置；
native demo不附加marker，Windows正常物理PPI保持原值，仅无效轴回退96。
这避免离屏Screen缺物理尺寸时默认惯性曲线使用0 PPI，也使服务输入不随主机
监视器变化；不把96改写页面DPR、不全局关闭新曲线。配套服务WebView选固定
GENERIC_DESKTOP触摸配置，demo仍CURRENT_PLATFORM。含服务固定逻辑PPI、
正常物理PPI保留、逐轴零/负值及NaN/Inf回退的官方unit用例。

新补丁可用正式工具生成，例如：

```
python3 tools/patchset.py --chromium-root C:/src/chromium/src record --id synthetic-vsync-deadline --file ui/gl/vsync_thread_win.cc --file ui/gl/vsync_thread_win.h
```

`record`按显式文件生成HEAD diff并追加清单/hash，不修改Chromium源码。
它只接受tracked路径，并拒绝前序patch已经包含的文件，避免把旧patch累计
收录到新patch中；已有文件的后续叠加修改需要另行维护有序diff，不能用此命令。
