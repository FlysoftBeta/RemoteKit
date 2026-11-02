# 2026-11-03 集成审阅

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

审阅基线 `4de343c` 到当前工作区；只审本批已交出的 Control 产品操作/收据、Endpoint 管理传输与 DC 服务/文件 worker、SDK control registry/channel lease。没有修改产品代码，没有运行 GPU、性能组或长构建；不审仍在实现的 gesture/mobile 路径。以下是已证实问题，未将源码推导称为真实运行验收。

## P1：完整 ICE 收集连接没有产品操作 lease，全部 DC 产品操作被丢弃

- 位置：`control/server/control.ts:206`、`:223`、`:356`。
- `offer()` 仅在 trickle 分支登记 `connectionLeases`。full-gather-compatibility/full-gather-simulation 成功分支登记了 `connections`，没有登记对应 Viewer lease。`handleEndpointAction()` 要求两者都匹配，否则直接返回。
- 触发：有合法 Viewer lease，`offer({type:'offer',sdp:'v=0\r\n'})` 成功；同一 `connectionId` 上发送 `window.create`。媒体连接可以成功，但创建、导航、激活等动作全部无法进入 durable operation 路径，没有收据，也不回复明确错误。
- CPU 实证：使用实际 `Store(':memory:')`、实际 `Control` 和只模拟 Endpoint RPC 的实例，注册/attach、完整收集 offer、调用实际 `handleEndpointAction()` 后输出：`{"mode":"full-gather-compatibility","receipt":"unknown","windows":0}`。
- 建议：在共同成功路径校验当前 Viewer 后登记 `connectionLeases`，使产品鉴权独立于信令模式；失败/替换继续清理旧连接。完整收集在等待 RPC 期间发生 Viewer 接管也须拒绝发布旧连接。
- 必要回归：合法 full-gather Viewer 创建窗口得到 committed 且仅创建一次；相同连接旧 lease、接管期间迟到 offer、无产品 lease 的诊断连接仍不能提交产品操作。兼容与模拟网络配置都应覆盖。

## P2：Endpoint 的不确定超时被客户端转成明确 rejected，停止查账

- 位置：`endpoint/include/remotekit/dc_services.hpp:49`、`:69`；`control/client/transport.ts:1004`（本轮工作区行号）；`control/client/main.tsx:208-224`。
- `DirectServices::DispatchPending()` 在已经 dispatch 的操作等待 15 秒后输出 `ok:false,error:'control_result_unknown'`，没有正式 receipt/result。实际 `RemoteTransport` 将所有无 result 的 `product.result` 直接 resolve 为 `status:'rejected'`。`main` 仅在 Promise reject 时主动查 `operation.status`，而该路径 Promise 已 resolve；随后显示明确失败，rejected 条目也退出周期查账并被移除。
- 触发：Control 排队/执行超过 15 秒，或者原生管理结果丢失且工作区快照尚未覆盖该操作。操作可能仍在执行或已完成，却被 UI 声称拒绝，用户重新点击会产生不同 ID 的第二次创建/关闭等操作。即使并发快照已先确认，迟到 action Promise 仍能制造错误提示。
- CPU 实证：绑定实际 `RemoteTransport` 到模拟 open DC，调用实际 `productAction()`，注入 Endpoint 实际超时 wire；Promise 结果为 `{"operationId":"12345678-1234-4234-8234-123456789abc","operationGeneration":"generation","status":"rejected","error":"control_result_unknown"}`。现有 DirectServices CPU 用例已经明确覆盖生成该 wire，缺口在跨层解释。
- 建议：Endpoint 生成结构化 `unknown` receipt，或 transport 将已 dispatch 的 unknown 错误转换为 unknown/抛出带已发送语义的错误，保留同一 operation ID 并继续查账。不能自动重放动作；仅未派发、确定未执行的 admission 拒绝才使用 rejected。
- 必要回归：实际超时 wire 经过 transport 后保留 unknown；main 持续以原 ID 查询；晚到 committed 清除 pending 而不再次创建；旧 peer 结果仍不能改变新 peer。

## 已核对与验证范围

- 实读 Control 同租户队列、workspace/receipt SQLite 事务、导航终态写入后 ACK、重启 unknown 与 target-retired、快照 incarnation/sequence、Endpoint 管理 socket 代次/不重放、可靠 layout outbox、DC file 授权/worker/回调锁序与取消、SDK registry 锁/每 channel 串行/close 标记/shutdown operation drain 控制流。未发现另外可证实的 P0/P1/P2；这不是对并发或硬件行为的全面证明。
- 针对性现有测试：`node --import tsx --test test/product-operations.test.ts test/endpoint-node.test.ts test/http-lifecycle.test.ts`，21/21 通过。包含事务故障、失联不重放、旧 socket 回调、超时/heartbeat 与服务关闭排空；这些通过不能覆盖上述两个缺口。
- 两项新问题分别用实际 Control 与实际客户端 transport 的无文件内联 CPU 实例确认。未构建 C++，未进行浏览器/真实 WebRTC/磁盘故障注入运行。
