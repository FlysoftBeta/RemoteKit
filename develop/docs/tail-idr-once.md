# 停止源活动后的单次尾 IDR

本轮已实现：每轮源活动停止后，空闲阈值到时请求一个尾 IDR；只有硬件实际输出 keyframe 且 `remotekit_rtc_encoded` 接受该结果，才结束该轮尾请求。成功前允许有节拍地重试，成功后不会因为自己的尾帧再次启动一轮。

## 原问题与改动

原代码已有源捕获身份去重和低帧率阈值，但 repeat 提交无论成功失败都设置 `idle_sent=true`；阈值前的独立恢复刷新也会提前消耗尾请求。SDK 的 texture submit 返回成功又只代表送入 WebRTC source，不能证明尾 IDR 已编码。

- `IdleIdrPolicy` 持有尾请求成功门闩；新源身份重启一轮。仍保留正常 150ms、源间隔三倍、上限 1000ms 的自适应阈值，配置 0 仍关闭自动尾请求。
- `TailIdrAttempt` 使用原子状态区分 source 等待、encoder 在途、成功、失败和已取消。单次 source 等待超过 250ms 可以取消并重试；与 Encode 抢占通过同一个 CAS 决定，旧 token 晚到时会在入 encoder/GPU 前被拒绝。encoder 已接收时不以超时重投。
- `TailRefreshLease` 是 Endpoint 本地的 lease 包装，保留原 frame ID、capture QPC、内容 epoch，把每次 retain/release 转发给原 AtlasPool cookie。它只携带本次 attempt，不改变 SDK ABI、共享内存或 GPU 完成语义。
- `Session::Encode` 对有效尾 token 强制 keyframe，并拒绝失效 token。`EncoderWorker` 在正常完成、入队替换、busy 后被替换、转换失败、提交失败、关闭清理处报告终态。硬件 busy 且原 job 留在队列时仍等待该 job。
- 保留 `tailIdrSubmissions` 为 SDK 接受提交的计数，新增 `tailIdrCompletions` 为当前源周期确认成功的计数；`lastTailAfterSourceMs` 随成功确认更新。

## 身份和独立恢复

源身份沿用 `(generation, capture_time_us)`；捕获时间不可用时退回 `(generation, frame_id)`。同一捕获时间下仅 atlas frame ID 变化不会重启尾周期。generation 变化代表资源的新一轮生命周期，可以重启。

`IdleIdrPolicy::Observe` 只接收 `AtlasPool::Poll` 的 browser 元数据。尾 repeat 只把 Endpoint 的 latest cache 送入 SDK，不调用 browser capture，不把 SDK 给 repeat 重新映射的 capture/media 时间写回源观察。因此编码重试、自己的尾帧和 WebRTC source 刷新不能自行 rearm。这里观察的是 browser 的新捕获活动；没有通过像素比较判断两次独立捕获是否字节相同。browser 的资源清空、真实捕获回调和几何恢复仍可形成新源活动。

PLI/用户 keyframe 请求继续经过现有 worker Keyframe 路径。WebRTC `REFRESH_REQUEST`、RTC connected 和 DataChannel open 继续发起独立缓存刷新，不受尾成功门闩屏蔽。阈值前的刷新不会消耗尾请求；到期且没有尾请求在途时，该次刷新可带尾 token，实际 keyframe 成功后合并满足尾请求。SDK 提交失败会恢复原有独立刷新标志。拒绝旧尾 token 不清除 worker 上已经保存的独立 keyframe 请求。

新的源活动使尚未进入 encoder 的旧 token 失效，已经进入 encoder 的旧 job 等自身真实完成/丢弃；旧结果不会满足新源周期。关闭/资源重建结束 MediaLoop 时同样取消 source 等待，encoder 与 GPU lease 按现有 drain/cancel 流程清理。

## 重试和恢复边界

SDK 拒绝、source 释放而没有 Encode、Encode 拒绝、worker 丢弃、非 keyframe 输出或 encoded 回传失败，都不记为尾成功。自动尾尝试最多每 250ms 一次；旧的 source 等待 token 失效后不能再被晚到回调编码。已入 encoder 的队列/硬件请求没有超时重投，避免同一轮多发。

码率暂停时 Enqueue 会拒绝，尾请求保留并在下一次节拍尝试；恢复码率后可继续。硬件/转换致命错误仍使 worker failed，现有 PLI 不会修复这个 worker；要等既有 Configure/新连接恢复后才能真正编码。这次没有增加自动硬件重建。永久 failed 时可以从 stats.error 看见具体原因，尾请求不会被伪记为成功。

## 验证

2026-11-01，隔离输出目录 `develop/tmp/tail-idr-once-cpu`，通过 VS 18 MSVC：

- `core.cpp + core_tests.cpp` 编译链接，`endpoint core tests passed`。
- `service.cpp`、`encoder_worker.cpp` 单独 `/c` 编译通过。出现原有 shared mapping padding、getenv 和 u8path 警告，无新增编译错误。
- `git diff --check` 通过。

CPU 测试覆盖：无源/关闭尾请求、到期边界、失败保留、成功后停止、相同捕获去重、新源与 generation rearm、低 FPS 阈值、无捕获时钟回退、source 超时与晚到拒绝、encoder 在途不可超时重投、成功状态不被后续 release 覆盖，以及真实 lease 包装的 SDK 拒绝/未入 Encode 即 release、取消、worker drop/close、成功输出和原 cookie 引用归还。

主 Agent 结束客户端采样并授权正式构建后，另已执行 `tools/build-endpoint.cmd`：Debug Endpoint 所有默认目标编译链接通过，CTest `endpoint_core` 1/1 通过。随后 `tools/build-endpoint.cmd package` 的 Release `endpoint_service` 编译链接通过，产物分别位于 `build/endpoint/endpoint/endpoint_service.exe` 和 `build/endpoint-package/endpoint/endpoint_service.exe`。未启动 GPU/服务/Chrome，没有构建 Chromium。实际静态收尾、暂停恢复与真实编码背压由下一轮 GPU 实验核查；FPS/延迟总目标未在本子任务中测定。

新增 counter 的源码通路已核对：Endpoint `Stats()` 包含 `tailIdrSubmissions`、`tailIdrCompletions`，MediaLoop 每秒把完整对象通过 DataChannel 发出；客户端 `transport.ts` 对 stats 消息整体保存为 `diagnostics.endpoint`，MarkerTools 上传整体 `diagnostics`，服务器 `/api/metrics` 原样写入 JSONL。因此上传记录字段为 `metrics.rtc.endpoint.tailIdrCompletions`，不需要更改 Control 类型或增加字段白名单。

后续正式功能实播已验证：change-stop后tailIdrCompletions为1，静态持续4.5秒不增长；新一轮动画停止后为2并保持，marker帧81稳定。独立审阅未发现lease、旧token晚到、busy或关闭终态缺陷。实际暂停恢复与真实编码背压故障仍需专项验证，不能由上述静态成功覆盖；总体FPS/延迟目标继续推进。
