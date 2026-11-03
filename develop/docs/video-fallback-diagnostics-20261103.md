# Video 回退诊断与隐藏计时修复

本次用户截图显示 H264、canvas-2d、track-processor 与“GL 初始化失败”。截图的真实首次回退原因未取得；用户之后无法复现，不能将以下模型结果认作截图根因。

## 确认的问题

`stats-overlay.tsx` 原先把未知 `backendReason` 统一显示为“GL 初始化失败”，而所有 Video 回退原因均不在该映射中。H264 是媒体编码，canvas-2d 是呈现后端；两者可同时成立。`fallbackPresentation` 在新版客户端选择 track-processor，截图本身不能证明 WebGL 初始化失败。

修复保留原 `backendReason`，增加 `presentationFallbackReason` 与 `canvasBackendReason`。前者保留当前连接首次回退原因，后者解释 Canvas 后端选择；叠层分别显示，未知原因保留原文。断开清除首次原因。未增加持久化遥测或改变协议。

生产 `RemoteTransport` 的确定性测试确认另一处独立问题：Video 帧元数据未匹配的重试预算到达 3 后，切后台仍让下一次定时器触发 Canvas 回退；尚未完成两轮隐藏 rAF 与 barrier ACK 时收到 metadata，也会提前开始计时。修复前新增两项测试均失败，原真实匹配超时正例通过。

修复后隐藏、布局失效和新 prepare 取消计时并清空预算。仅当前文档可见、完整当前 barrier 已 ACK、当前非 stale 平面且客户端 bounds 为正时，才允许累计。ACK 提交、前台恢复和 ResizeObserver 触发重新调度。恢复不会授权旧像素，仍须原有当前 epoch/RTP 与元素自身新帧授权；原有两轮 rAF ACK 保持。真正有资格但持续无匹配帧的情况仍会有界回退。

## 验证范围

定向命令：`node --import tsx --test test/video-presentation.test.ts test/stats-overlay.test.ts` 与 `npx tsc --noEmit`（在 control 下）。21 项通过，包含首因保留、未知原因呈现、预算边缘隐藏/前台重新计时、未 ACK 不计时、零 bounds 不计时及恢复、旧 epoch 仍阻断、有效匹配超时仍回退。属于模型与类型检查；未执行 GPU、真实浏览器或打包验证。

## 独立原生证据

只读最新 221813 包既有 `data/endpoint/sessions/1/browser.log`，22:26:30.603 记录 `external_begin_frame_source_mojo.cc:206` 的 FATAL：`completion={source_id:2,sequence_number:5} current=none`，随后 GPU 进程退出并重建。原生问题单独调查，本次客户端修复不宣称解决它，也未建立它与截图回退的因果关系。包内未找到客户端 metrics 文件，正常 Viewer 的首次回退原因没有持久日志，不能从该 Browser 日志恢复截图原因。
