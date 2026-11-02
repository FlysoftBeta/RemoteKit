# Snapshot容量有界修复（2026-11-03）

本批按root限定范围实现，不引入分页架构，也不把有限保护写成任意巨型网页状态同步完成。

- 产品导航保留8192 UTF-16输入上限，最终规范化URL/搜索模板编码后统一检查8192 UTF-8字节；错误在返回导航地址前抛出。`tab.navigate`执行位置在修改pendingUrl及调用Endpoint前。
- Browser生产`WriteControlResponse`在完整JSON超过1MiB时发送同request ID的`ok:false/error:response_too_large`有界小回复，保留原始reply及账本。只有JSON编码或实际write失败才走ControlServer Close；超大输入消息本身仍是协议故障。
- Endpoint生产`BrowserRpc`返回应用错误，`RequireBrowserOk`抛`browser: response_too_large`。Session::Rpc只在SDK transport status非零时清control；Snapshot catch在控制通道仍活着时继续抛错误，不转inactive。此链路根据源码及CPU helper检查，尚无真实Browser/GPU超限运行证据。
- `ExportFileChooserAcceptHints`保留可用MIME/扩展名hint，最多64项/单项256 UTF-8字节，整个JSON数组16KiB（包含JSON转义、引号、分隔符）；无效、无法无损转UTF-8或超预算项省略并显式标记。原生listener、mode、document、request及文件内容链不变。
- Browser `accept_types_omitted`经Control映射为`acceptTypesOmitted`；Viewer不以剩余hint限制picker，并提示显示所有文件。完整普通声明不变。

已运行：Control导航/file-selection/reply-lifecycle定向11项通过（含8192精确边界、Unicode URL/搜索膨胀、hint省略和Browser请求绑定不变）。

已新增待统一构建运行：`remotekit_control_payload_probe`直接调用生产response writer/accept exporter，检查同ID、小错误、不Close分支、下一回复、原reply不变、实际write失败，以及accept字节/转义/数量预算。Endpoint `control_reliability_tests`新增相同错误envelope经过生产Rpc/RequireBrowserOk及下个RPC检查。未在本子任务build，无GPU。

重建需求：Browser `remotekit_browser`和`remotekit_control_payload_probe`，Endpoint `endpoint_control_reliability_tests`（CTest名`endpoint_control_reliability`）；Control统一生产build由split-barrier owner执行。无Chromium patch、SDK/publicheader变更。若要发布native demo，则其共用Browser源也需重建。

保留限制：页面自己的长URL/title/dialog及许多合法请求组合仍可使snapshot超限；明确错误能保护Browser/RTC/账本，不等于完成巨型状态同步。管理聚合响应另有Endpoint总预算保护，按root在另一任务集成。用户可关闭/改变相关页面恢复；本批未新增分块恢复能力。
