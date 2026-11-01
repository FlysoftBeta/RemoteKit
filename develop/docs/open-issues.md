# 持续问题清单

主 Agent维护。性能任务与后续产品化分别见performance-goal.md、productization-next.md；这里集中记录排查中发现的额外问题。

|优先级|问题与证据|当前处理|阻塞|
|---|---|---|---|
|P2|browser的gn check因已有content/browser/renderer_host/render_widget_host_view_base.h私有头可见性失败；SDK另有ui/events/keycodes/platform_key_map_win.h同类问题。本轮前已存在，browser/SDK实际增量编译链接通过，新capture pool独立GN check通过。详见capture-to-atlas实施报告。|后续收束私有接口依赖或明确记录有理由的nogncheck，不扩大上游全局可见性。|不阻塞本轮硬件验证；不能将完整GN check写为通过。|
|P2|ApplyView配置已应用后，持久化/恢复失败可能保持输出停止，Control对账未必修复。|后续补重建/重试状态；本轮typed资源重建不自动等同解决此产品事务失败。|不阻塞固定scene性能实验。|
|P2|allocation alignment1右边缘偏绿根因未闭合；alignment16候选实际正常。|保留已验证alignment16，后续定位旧路径。|不阻塞现有固定条件。|
|P1|D2源GPU进程故障注入后GPU自动重启，但15秒内媒体未自动恢复；显式RTC重连后gen4/CRC6002恢复。详见capture-to-atlas-runtime.md。|已区分transport reason0、重配1与fatal2，源GPU退出同RTC恢复CRC8201、正常close不复活均通过。|已验证修复。|
|P1|关闭全部tab后800ms，Viewer仍保留旧layout/displayReady=true；同RTC重建tab可恢复CRC6001。|补空布局通知与客户端画面/输入资格清理。|不阻塞固定scene性能对照；产品行为缺口。|
|P1|故障旧pool在producer ready变UINT64_MAX后保持terminal_ready=false，但等值终点已由同State真实观察并退役；旧Close还会阻挡后代。详见endpoint-retirement-runtime.md。|逐代Close、等值历史证明复用已通过GPU/Browser退出硬件回归；未知更高终点继续保留。|已验证修复。|
|P1|最后native refs递减后仍访问State的trace，ReapRetired可能同时析构State。|已先快照trace与记录字段，递减后只访问局部；编译与CPU检查通过。|修复已实现，不再阻塞。|

## 首版后Astra审查输入（2026-11-02）

先完成首版上传，随后审查，不把待核实项当作已确认bug。

- 已确认：冷启动4个保存页面串行恢复，各失败导航等待约11秒，总时间超过Control 20秒RPC超时；稍后fallback恢复。证据product-runtime-qa.md，需优化恢复调度/超时语义。
- 待核实：旧/已撤销Viewer的logout是否全局关闭同用户当前活跃Viewer；检查token、租约和注销作用域。
- 待核实：旧数据库用户isLegacy状态与新质量策略、账号迁移的语义是否完整。
- 待核实：质量策略仅面积预算是否遗漏极端长宽与组合atlas的8192轴上限。
- 已完成：产品UI、WS、站点UA、popup/dialog、memory saver、自适应、capture时钟、重连输入序号和自动化驱动迁移；实际检查见product-runtime-qa.md。旧条目的空布局/恢复事务等应在审查中按当前代码重新确认，不能沿用旧结论。
