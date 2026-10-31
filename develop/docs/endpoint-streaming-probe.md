# Endpoint streaming 源码调查

当前管理、布局、页面执行都集中在 browser/harness.cc 的 HarnessMainParts::State。SDK 可直接传 UTF-8 JSON（remotekit_sdk_control_request）；ControlServer 是单连接 Mojo isolated pipe，不能让 Node 与 GPU consumer 各自连接同一 channel。

## 解耦点与隔离

- harness State 持有 Endpoint model、BrowserContext、WebView、PageRequests、Views wrapper 与唯一 GpuAtlas。output.open/describe/configure 不接受 Session，UpdateOutput 遍历所有 contents，snapshot 遍历所有 sessions。现有 --sessions 多租户存储隔离，输出却把全部租户页面混成一个 atlas。
- 主 Agent 已决定每 Tenant/Session 独立 browser 进程与 atlas，由独立 endpoint 统一管理；这可直接复用现有 GpuAtlas 且隔离故障。endpoint 需要持有唯一 SDK 控制连接，代理外部 Node 管理命令和远端输入，GPU handles 必须复制到 endpoint PID。
- 原 endpoint/src/client_win.cpp 已有 browser CreateProcess + kill-on-close Job，AtlasClient 有单 worker SDK 调度与重建。它们均绑定 HWND，可抽取管理与控制队列；不应让 Node 承担 GPU/Fence。

## 动态页面与回收

Endpoint::CreateWebView 已存在，当前没有 remove 或指定稳定 ID。harness 只在启动时建固定页面数组，无 view.create/view.close/view.configure。GpuAtlas::SetViews 已支持变更、删除与重排，变化时停止捕获、清理 staging 并请求刷新；StopView 应在销毁 WebContents 前调用。

WebView::RequestLifecycle(unload/restore) 已实现实际 WebContents 释放与完整 history/PageState 重建，同进程保留 sessionStorage namespace；它不是逻辑 WebView 删除。异步 freeze/discard/restore 通过模型 pending 和 last_lifecycle 分开接受与完成。PageRequests 已代理 beforeunload 弹窗，但没有 CloseContents/BeforeUnloadFired 的逻辑 close 管理。

## 编码入口

endpoint/src/atlas_consumer.cpp 的 Impl::Poll 在 ready Wait 后 CopyResource(cache, slot)，随后 Signal consumed。cache 是 endpoint 自有 BGRA8 GPU texture，适合作为编码输入。当前 cache 是单纹理且与 HWND swapchain 绘制绑在一个类；必须拆出无窗口 import/poll/copy 核心。编码器如果跨线程或异步持有 cache，需要自有纹理池和完成 Fence，不能在编码读取时覆盖同一个 cache。consumed fence 仍可在共享槽复制结束后推进，不需等编码完成。

## 接口与限制

- browser/gpu_atlas.h：SetViews、StopView、DescribeForConsumer、Stop，可原样复用。
- endpoint/include/remotekit/atlas_consumer.hpp：Open(HWND)、PollAndPresent，把资源导入/消费和可选窗口呈现分开。
- sdk/include/remotekit_sdk.h：raw control request 可代理全部管理；open_atlas 是现有无 Session 的 helper，每进程单 Session 时成立。
- shared_atlas.h：64 WebView，三槽 BGRA8，metadata 带 Session/View/instance/document/focus；固定 atlas 尺寸内可动态 packing，无需改 ABI；尺寸变化要求资源新代重导入。
- browser 服务启动须显式身份和存储根，禁止默认测试页；当前 session 数字从1重置，不能直接把重启后的自增身份用于租户目录分配。

调查仅阅读源码，未编译、未启动窗口。实现优先级与方案由主 Agent 定义。
