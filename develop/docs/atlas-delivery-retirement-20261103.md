# Atlas delivery正常退役调查

2026-11-03。证据为`develop/tmp/client-gesture-runtime-final/endpoint/sessions/1/browser.log:95–97`：generation46于02:51:53.153配置，02:52:16.465在89 targetloss导航边界出现`external destination delivery disconnected before Done`，42ms后generation47配置。无同代host `connection_lost`记录，Browser PID34284/instance1/incarnation未变，GPU crash-count0。本日志没有记录具体delivery id，不能只凭日志断言是哪一帧。

源码有确定可触发的正常退役竞态：导航更新document/binding→`GpuAtlas::State::SetViews`→`ReconfigureNeeded`→`Capture::Stop`→`ClientFrameSinkVideoCapturer::StopAndResetConsumer`。原host异步发送Stop之后立即reset consumer receiver，丢弃已入consumer pipe而未派发的`OnFrameCaptured`及其callback remote。Viz的self-owned `InFlightFrameDelivery`因callback pipe断开而执行未知完成保护，封存该generation并报fatal。Stop与frame delivery跨pipe，发送Stop不保证它先于callback断开在Viz被处理。该错误与正常退役时机、无host错误回调及紧接新代配置一致；确定性CPU回归用于验证触发链，不能称已做真实硬件复现。

root批准的最小修复只改0007 host：正常Stop/reset和configured capturer析构将旧consumer receiver `Unbind`给独立self-owned drainer。Mojo保证Unbind保留未派发消息；接口全部one-way，无待回response。drainer消费其余通知，并对未前递帧显式Done。实际RGBA external目标请求带`populates_mappable_shared_image=true`，Skia的GPU finished回调之后才SendResult→DidCopyFrame→DeliverFrame；因此这些Done不提前归还仍在GPU写的目标。已前递lease完全不在drainer队列内，仍由GpuAtlas真实consumed Fence结算。未知断开继续fatal与池封存；0011 BeginFrame行为未改。

Stop之后Viz发送OnStopped并reset consumer remote；capturer销毁调用Stop，transport断开也关闭remote，drainer收到disconnect后自毁。无响应Viz下寿命没有墙钟上限，不靠超时Done推断完成。排空前队列保留消息与texture handle，排空后只剩pipe；drainer不持有GpuAtlas State或Endpoint。重复Stop因旧receiver已Unbind不会再次移交；析构只对仍bound的atlas consumer执行停止。

新增`browser/capture_delivery_probe.cc`以真实生产ClientFrameSinkVideoCapturer及InFlightFrameDelivery、真实Mojo pipe和假producer运行五个CPU用例：queued frame→显式Stop两次再立即析构，queued frame→直接析构，已前递frame→Stop后仍待显式Done，已前递frame→未知断开仍走unexpected回调，以及普通Stop仍前递OnStopped。队列同时包含empty/version/log通知，检查显式reset停止后不再前递。probe没有GPU，不将其作为真实Fence或硬件验收。

源码准备阶段：0007 host补丁和manifest SHA已更新；`tools/patchset.py status`在临时快照逆序撤回/正序应用全部11个补丁成功，各项applied；未stage/gen/build、未启动GPU。统一构建需包含`remotekit_browser`、`remotekit_capture_delivery_probe`（以及本批其它目标）；运行probe和现有`capture_to_atlas_pool_unittests`未知断开封存用例后，再由独占GPU的89 targetloss导航/invalidation专项验证。构建、CPU与真实运行结果待root集成记录。
