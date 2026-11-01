# 首版上传后的代码审查任务

开始条件：首版ZIP已经上传并取得取件码。审查者Astra6 Medium；本文件是任务说明，不代表审查已开始。

## 范围和交付

对照AGENTS.md、docs/current-state.zh-CN.md、architecture/control-plane/gpu-output/streaming-protocol及实际源码，审查Control→Endpoint→Browser→Client的功能逻辑。重点是状态归属、生命周期、恢复、错误和竞态；寻找能减少重复状态/逻辑的重构，不做大规模风格改写。

每个发现提供严重度、文件与具体路径、触发条件、后果、证据、建议修复边界及验证办法。区分确认bug、待核实风险和可选重构。不要将已知未实现目标自动列为本轮阻塞。独立检查核心链，不能只复述下面线索。

只读审查，必要时运行已有小型测试；不修改、不commit、不操作用户桌面、不跑性能矩阵、不访问旧Desktop/remotekit、不全量构建。不要向网络目标执行安全攻击或漏洞利用。根agent决定接口/架构取舍，再交Sol实施。

## 重点线索

1. 已确认冷启动多页面恢复串行等待，每失败页面约11秒；4页超过Control20秒RPC超时后才fallback。如何保持恢复身份和可观察状态、避免队列长阻塞？
2. 注销/重新登录是否误撤销另一活跃Viewer，lease/token/Session.stop的作用域是否一致？
3. legacy数据库迁移后质量模式、注册/登录及状态归属是否合理？
4. 分辨率面积预算是否遗漏单轴/组合atlas尺寸上限；不能以硬夹实际viewport改变用户布局。
5. 空布局、关闭最后页、popup收养持久化与失败重试、自然close事件确认、dialog实例/文档/进程绑定。
6. WS断线visible、RTC编码需求、memory saver、snapshot不重启及requireRunning之间的竞态。
7. client/peer/browser三层输入序号，mousemove合并、重连、过期帧布局及焦点token。
8. capture QPC与wall mapping、wire RTP/epoch、重复尾帧、clock置信度、自动策略迟滞。
9. GPU租约、ready/consumed fence与退役资源；不能为方便释放弱化真实完成证明。
10. docs与当前实现不一致之处、正式工具依赖develop的问题、失效实验配置残留。

已知保留目标：单Profile、跨Browser sessionStorage、完整IME与popup widget、认证/证书/PDF/打印等；NVENC无本机硬件。已通过双租户固定目标组，用户取消额外性能复验，只对修复做必要检查。
