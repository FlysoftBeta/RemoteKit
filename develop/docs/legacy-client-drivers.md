# 待收束的旧客户端验证驱动

`tools/streaming-benchmark.js`和`tools/verify-control-first-stream.js`已迁移至显式诊断环境下的`/automation`，用于媒体/输入验证，不代表新产品UI验收。

以下驱动仍依赖旧首页按钮、设备面板或`.view-pane`布局，需要移植到独立automation能力，或归档旧实验用途；不能直接用于新Viewer验收：

- `tools/verify-control-close.js`
- `tools/verify-control-input.js`
- `tools/verify-control-live-device.js`
- `tools/verify-control-presentation-roi.js`

迁移后须显式启用`REMOTEKIT_DIAGNOSTICS=1`并使用独立诊断用户会话。产品登录、多窗口、设置、页面Dialog等验证应使用正常Viewer和WS，不能用legacy HTTP操作替代。

2026-11-02收尾：四个旧驱动已迁移到/automation配置API，保留隔离诊断用户与真实输入/几何检查；旧互动面板已删除。静态语法、配置组合及diagnostics-off拒绝检查通过，不新增性能复验。
