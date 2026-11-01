# 持续问题清单

主 Agent维护。性能任务与后续产品化分别见performance-goal.md、productization-next.md；这里集中记录排查中发现的额外问题。

|优先级|问题与证据|当前处理|阻塞|
|---|---|---|---|
|P2|browser的gn check因已有content/browser/renderer_host/render_widget_host_view_base.h私有头可见性失败；SDK另有ui/events/keycodes/platform_key_map_win.h同类问题。本轮前已存在，browser/SDK实际增量编译链接通过，新capture pool独立GN check通过。详见capture-to-atlas实施报告。|后续收束私有接口依赖或明确记录有理由的nogncheck，不扩大上游全局可见性。|不阻塞本轮硬件验证；不能将完整GN check写为通过。|
|P2|ApplyView配置已应用后，持久化/恢复失败可能保持输出停止，Control对账未必修复。|后续补重建/重试状态；本轮typed资源重建不自动等同解决此产品事务失败。|不阻塞固定scene性能实验。|
|P2|allocation alignment1右边缘偏绿根因未闭合；alignment16候选实际正常。|保留已验证alignment16，后续定位旧路径。|不阻塞现有固定条件。|
