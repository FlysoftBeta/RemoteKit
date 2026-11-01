# Endpoint 共享槽退休修复

本轮修复最后一个 native lease 释放时的 State 生命周期竞态，让 Close 独立推进每个旧代，并复用同一代已经实际观察到的 GPU 完成证明，避免 producer 退出后 fence 查询失效使等值终点永久卡住。未知更高终点仍保留，不能用进程退出代替真实 GPU 完成。

## 改动

- `State::Release` 在最后一次 refs 递减前保存独立的 trace shared_ptr 和所有 trace 身份。递减后只访问局部变量，不再读取 State、slot 或退休 ledger，也不调用 GPU driver。
- `Close` 对每个代独立检查 lease、terminal、ready 与 done。一个代失败后继续处理其它代；已安全完成的代移除，失败代保留，返回各失败代的详细错误。
- 每个导入 State 获得进程内单调的 `atlas_pool` 标识。结合 trace 的 PID 可区分 Browser 重启后重复的 generation；lease、borrow、retire 和其它 AtlasPool trace 携带该标识。
- 失败快照包含 pool、generation、等待阶段、terminal 观察/目标、ready 完成值、退休/已观察前缀、各槽 refs、done 完成/目标、当前 publication、producer 退出证明及 consumer device reason。stderr 每 pool 每阶段只输出一次，返回错误始终使用最新快照；正常逐帧路径不打印。
- 等待事件创建失败按失败处理，记录 HRESULT 和等待结果。
- `SharedLeaseRetirement::ObserveUnborrowedThrough` 接受与 `last_observed` 相等的终点，复用同 State 的历史 CPU-ready 证明；当前 fence 即使为 `UINT64_MAX` 也不抹掉历史证明。终点更高时仍必须拿到有效当前完成值，不能把 `UINT64_MAX` 解释为完成。

`Observe` 的唯一生产调用在 `AtlasPool::Poll` 的 shared 分支，调用前始终经过真实 ready 门：`UINT64_MAX` 报错，完成值小于 publication fence 则返回 idle。该前提已写入 ledger 和调用点注释。封口不释放真实 reader，`SafePrefix` 仍受最后 lease 限制，owner 的 GPU consumed/done 屏障保持不变。

没有新增线程或后台 reaper，没有为未知终点补造证明，也没有扩大 device-loss 强制释放规则。

## 验证

在主 Agent 分配的构建窗口使用 `tools/build-endpoint.cmd verify-media`，现有 `build/endpoint-package` Release 增量构建通过。最终历史证明修复为8项增量编译/链接，7项 CPU 检查全过：core、shared lease retirement、adaptive fps、QSV session pattern、media feedback、atlas publication、encoder stats。新增回归覆盖：等值终点在当前 MAX 时可封口、相同条件持有 lease 时不得越过、未知更高终点在 MAX 时不得推进。CTest 记录在 `build/endpoint-package/Testing/Temporary/LastTest.log`。源码复核及限定文件的 `git diff --check` 通过。没有运行 GPU 实验，故障场景的运行验证由后续新 case 完成。

最终二进制：`build/endpoint-package/endpoint/endpoint_service.exe`，SHA-256：`1607e34b1ebd08f489b89f1db978bd6dc95ca360e1d413366939426b9adce14c`。`prepare-streaming-case.ps1` 默认直接从该目录复制 Endpoint 与 libvpl 到新 case，无需覆盖历史 case 的运行文件。先前诊断版 `16a5e60e...` 的硬件证据见 `endpoint-retirement-runtime.md`，不作为本次修复后的运行结果。

## 硬件复测

最终1607版本已通过GPU退出后重连、Browser退出自动恢复与最终关闭：CRC8101/8102正确，三个pool借用/释放/退役计数分别1030/178/717守恒，没有terminal incomplete。故障代的等值180复用已有真实观察证明；健康代720由当前实际完成证明覆盖。未知更高终点没有被放行。详见endpoint-retirement-runtime.md。
