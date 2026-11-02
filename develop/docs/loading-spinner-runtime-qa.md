# 标签页加载指示器修复与检查

2026-11-02。仅修改 `control/client/window-frame.tsx` 与 `control/client/style.css` 的标签标题/加载指示器样式，不改变加载状态判断、媒体 transport 或共享画布。

根因：原 `.tab-select span` 给所有后代 span 设置 `flex: 1`、`overflow: hidden` 和文字省略号。MUI CircularProgress 根节点也是 span，因此名义 13×13px 的指示器被扩宽，旋转中心偏移且图形被裁切。修复将文字规则限定为直属 `.tab-title`，加载指示器使用独立 class 并禁止 flex 收缩。

Control 148/148 测试、TypeScript、Vite 生产构建、server bundle 与生产启动 smoke 均通过。

真实运行使用生产 Viewer、Chromium 157 与隔离的慢 HTTP 文档，保持网络响应未结束以产生真实加载状态。桌面 1440×900 与窄屏 390×844 检查通过（本次范围评分 5/5）：

- 修复后指示器布局尺寸均为 13×13px，overflow=visible；桌面中心在间隔 240ms 的采样中稳定为 (20.5, 21.5)，旋转矩阵实际变化且动画 running。
- 临时仅在检查页面恢复旧 CSS 规则，立即复现 66×13px、中心偏到 (46.75, 21.5)、overflow=hidden；截图中指示器消失/被裁切。撤销该页面样式后恢复正常。
- 窄屏指示器仍为 13×13px，中心 (18.5, 21.5)，长标题正常省略，无横向挤压。已实际打开截图检查。
- 结束慢响应后指示器正常移除；不改加载状态逻辑。

证据目录：`develop/tmp/spinner-qa-1793605500/`。截图 `spinner-fixed-desktop.png`、`spinner-old-rule-desktop.png`、`spinner-fixed-narrow.png`、`spinner-finished-narrow.png`；测量记录在 `metrics/client-metrics.jsonl` 的 `spinner-ui-qa` 项。临时样式和慢响应仅用于 QA，不进入产品代码。

本次未新增 Chrome89 专项运行；修复仅使用已有 flex/class 语义。所有自有 Viewer context、host 页、Control/Endpoint/Browser 与慢响应服务均已正常关闭，未留下媒体进程。
