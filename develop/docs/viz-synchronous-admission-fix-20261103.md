# Viz同步BeginFrame完成修复（2026-11-03）

## 实际故障与原因

发布包`1e13f11`的`data/endpoint/sessions/1/browser.log`保留10次Viz CHECK（06:53:48–06:56:39）。06:56:17.368的完成ID和当前ID均为`source_id=2, sequence_number=5`；调用栈从`IssueExternalBeginFrame`同步经过`ExternalBeginFrameSource::OnBeginFrame`、`DisplayScheduler::OnBeginFrameContinuation`、`OnBeginFrameDeadline`进入`OnDisplayDidFinishFrame`。断言中的ID存在且相等，因此失败项为尚未安装的`pending_frame_callback_`。

旧0011补丁处理已提前NAK请求的准确退役ID，但仍在`OnBeginFrame(args)`之后安装当前请求callback。生产observer通知允许同步完成，因此当前请求会出现只有ID、没有callback的半初始化窗口。旧probe在`IssueExternalBeginFrame`返回后才手工通知Display完成，不能覆盖这个窗口。

## 修复契约

- 在调用source/display observer前安装完整请求及callback，并进入admission阶段。
- admission期间允许记录准确匹配的Display ACK与sink通知，但不发送终态callback。临时没有pending sink不等于observer注册已经结束。
- source通知已经同步完成Display时，不再调用`SetNeedsOneBeginFrame`调度同一已完成ID。否则确保Display收到一帧；全部admission调用返回后才允许发送callback。
- wait模式仍等待所有已登记sink，nonwait模式在admission结束后即可使用Display ACK。callback重入下一请求时，旧请求不再有后续admission动作。
- 保留未知/未来/未经证明旧ID的严格CHECK。对已完成但因sink等待仍保留的当前ID也明确拒绝重复Display完成。退役ID账本、上限背压与实际GPU Fence边界不变。

## 验证范围

`browser/begin_frame_probe.cc`新增真实`ExternalBeginFrameSourceMojo` observer fanout测试：`IssueExternalBeginFrame`内部同步发生root sink begin/finish、当前Display完成、之后才登记的另一个sink；callback重入下一请求并同步完成。`--mojo-sync`覆盖wait模式，`--mojo-sync-fast`覆盖nonwait；`--mojo-sync-duplicate`与`--mojo-pending-duplicate`必须分别在admission中及等待sink时CHECK。原有3个真实scheduler生命周期场景、退役Mojo场景及4个严格错误ID场景保留。

源码检查：11个补丁在隔离快照中完整撤回/重放通过；0011 manifest SHA256已更新；项目probe经`tools/chromium.py stage`下放；`git diff --check`通过。此记录创建时尚未构建或执行新增probe；真实产品运行与GPU硬件验收需由本轮后续报告记录，不能由CPU路径代替。

## 后续实际验收

本轮已完成[增量构建及原生正反例](loopback-hotfix-build-20261103.md)和[89/157真实运行](loopback-crash-runtime-qa-20261103.md)。上文pending说明为该步骤创建时状态；新包仍须独立验收，不能由源码运行替代。
