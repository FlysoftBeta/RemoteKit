# Browser 生命周期功能验证

2026-11-04，Windows x64。使用当批增量构建的 `out/dev/remotekit_browser.exe` 和配套 `remotekit_sdk.dll`。验证通过 SDK 控制通道驱动生产 Browser，每次启动独立的本地 HTTP fixture、控制通道和 Profile。没有打开媒体输出，也没有使用 Viewer、Endpoint 服务或 GPU 性能计时。正式工具为 [probe-browser-lifecycle.py](../../tools/probe-browser-lifecycle.py)。

## 通过的用例

| 用例 | 观察结果 | 证据 |
|---|---|---|
| 冻结与同文档导航竞争 | `freeze` 事件同步执行 `history.pushState`。冻结代次 1 以 `succeeded=false` 结束，`actual=live`、`lifecycle_uncertain=false`。原 instance 的 JS 标记在 `resume` 后仍在，URL 保留 `#raced`。随后正常冻结代次 2 和解冻代次 3 均成功。 | [3350726343c7](../tmp/browser-lifecycle/3350726343c7/transcript.json) |
| 冻结与跨站子框架导航竞争 | `freeze` 事件把同源 iframe 导航到另一个站点。服务器保持响应未完成时，原冻结请求已经取消，页面回到 live，instance 和主文档 token 保持。放开响应后，新子框架的定时任务运行并向父页面报告。 | [3350726343c7](../tmp/browser-lifecycle/3350726343c7/transcript.json) |
| 精确 ACK 超时与迟到回复 | `freeze` 事件中的有界 12 秒任务使代次 1 达到 Browser 的 10 秒等待上限。任务结束并允许 renderer 回复后，Browser 仍保持同代 uncertain。按旧代次 0 卸载得到 `stale_lifecycle_recovery`，instance 保持。 | [3350726343c7](../tmp/browser-lifecycle/3350726343c7/transcript.json) |
| 同 Browser 的 guarded 恢复 | 按 uncertain 代次 1 卸载，返回代次 2 且 `completed=true`。按代次 2 恢复，代次 3 精确成功，`actual=live`、`lifecycle_uncertain=false`，以新 instance 加载原 URL。服务器记录该 URL 共两次 GET。另一个可见 view 的 instance 与可见状态保持。 | [3350726343c7](../tmp/browser-lifecycle/3350726343c7/transcript.json) |
| 稳定 frozen renderer 退出 | 代次 1 已成功冻结。结束独立 Browser 中通过父 PID、创建时间、镜像和 renderer 参数核对的自有 renderer 子进程后，Browser 报 `crashed` 与 uncertain、旧 instance 作废，当前代次 2。按代次 2 卸载得代次 3，再按代次 3 恢复，最终代次 4 live。原 URL 共两次 GET。 | [546f34f52163](../tmp/browser-lifecycle/546f34f52163/transcript.json) · [进程记录](../tmp/browser-lifecycle/546f34f52163/terminated-renderers.json) |

MSVC 独立 CPU 检查通过 Endpoint `core_tests` 和 `control_reliability_tests`。覆盖冻结与解冻期间主文档 token 推进、discard 期间拒绝该推进，以及生命周期 pending/uncertain 时取消导航导出、保留上一次文件并在恢复后重新导出。受管 Chromium 补丁 0015 已应用，八项 patchset status 验证通过。

## 失败尝试与边界

- 第一轮 `0baeb4ec7045` 已通过同文档、正常冻结/解冻和跨站竞争。用于制造超时的同步 XHR 被 Blink 的 freeze 事件策略拒绝，未产生超时证据。后续改用固定时长的 renderer 本地任务。[首轮日志](../tmp/browser-lifecycle/0baeb4ec7045/browser.log)
- 第二轮 `3350726343c7` 通过直到稳定 renderer 退出注入。最初使用的 DevTools 注入在生产 Browser 没有监听端口，仅显式 demo target 启用 DevTools。后续使用自有进程树中的 renderer 退出，第三轮只执行该用例。[第二轮日志](../tmp/browser-lifecycle/3350726343c7/browser.log)
- 回归工具支持 `--case races`、`--case timeout` 和 `--case frozen-crash`。各组的 Browser 控制通道均正常关闭。运行后检查三组 Profile 路径对应的进程命令行及第三轮记录的 PID，未发现残留自有 Browser 或 renderer。
- 以上验证覆盖 Browser 真实生命周期和恢复语义。Endpoint JSONL/Control 的跨边界工作由各自的构建及模型测试覆盖，当前用例直接使用 Browser SDK 控制通道。
