# f1b2638用户机器启动问题

用户报告browser control connect failed 7、pool close unfinished及Endpoint session.sitePreferences超时。7为SDK_CHANNEL_CLOSED；旧日志不能区分Browser早退或15秒内未建立IPC。尚未定位用户机器根因，不能宣称已修复。

原发布包及只保留Windows PATH的本机真实smoke均通过，ZIP hash一致。新Endpoint仅补PID、存活状态、十六进制退出码、连接尝试/耗时与browser.log路径，RPC失败补method；不改变超时或资源安全策略。单目标Release增量、早退与存活无IPC两条受控失败路径、新Endpoint搭配原包的真实smoke通过。证据develop/tmp/startup-diagnostic-check。

sitePreferences不启动Browser；Node 20秒期限包含全局dispatcher排队，其他启动/维护或此前已经超时仍在执行的请求可使其超时。同Tenant Control.serial会串行化，因此不能只凭多次启动日志断言某个确定重试顺序。需用户browser.log及带时间戳的新失败信息。

已询问出错机器Windows/CPU/GPU、前版是否正常、data/endpoint/sessions/1/browser.log末40行。音频/文件新功能暂未实现，调查与设计保存在audio-upload-plan.md和audio-upload-ui-design.md，不混入此诊断补丁。
