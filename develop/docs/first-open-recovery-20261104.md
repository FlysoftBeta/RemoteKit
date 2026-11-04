# 冷启动首次打开白屏排查

2026-11-04，用户确认861200的其他问题改善，但刚启动新包后首次打开客户端停留在“正在恢复页面…”，刷新客户端后恢复。截图时间14:54，Android Brave；具体浏览器版本未知。

## 现场证据与判定

截图有已连接RTC（RTT 9ms）、H264 level52、QSV和1936×816源atlas。当前窗口接收码率0、解码0 FPS；后端已经回退到canvas-2d/track-processor，原因为`video-frame-metadata-timeout`。这些瞬时增量不能证明整个连接从未收到或解码过帧，最近编码耗时也不能证明码流已通过呈现屏障并交给WebRTC。

Client原先对所有当前布局未ready的video平面使用同一个元数据超时原因，包括没有当前帧回调的情况。延迟首次`presentation.ready` 4.5秒的实验复现了零RTP期间错误回退Canvas，正常冷启动则通过。用户随后明确要求删除Canvas fallback：生产串流统一Video，移除MSTP、共享WebGL及2D绘制路径与无效统计项；首帧和元数据迟到保留原连接、继续限频补帧。能力或协议不满足时明确提示，不放宽输入授权。resize过渡快照、摄像头处理及测试像素读回保留。

Endpoint代码存在独立的首帧请求丢失风险：Comp在`remotekit_rtc_submit_texture`返回OK时清除刷新请求；该接口只表示纹理交给source，不代表Encode接收或当前IDR成功发布。若随后被source丢弃或呈现屏障拒绝，静态页面可能没有新的自然内容来补帧。修复以逐请求的实际IDR发布结果完成恢复，不以提交返回代替完成。

## 验证

Client 96项定向测试、TypeScript及Control生产构建/startup smoke通过。覆盖Video协商、旧布局/旧回调门禁、首帧和元数据迟到、同peer播放重试、授权换代、输入/触控、反馈与统计。Endpoint Release增量及core、control reliability、presentation barrier、Comp pacing共4项测试通过；原生模型覆盖source在Encode前释放、发布失败、源等待取消、编码中不超时、旧请求迟到和成功后新请求重新补帧。

最终157普通冷启动与首个ACK延迟4.5秒、Chrome89冷启动已保存静态页均通过。延迟场景ACK前保持零RTP/元数据，始终Video；ACK后41.3ms收到关键帧元数据，84.6ms得到匹配的Video观察。157两组补帧attempt/force/success为1/1/1；89为2/2/1。各组成功后pending=false，跨至少两个不同秒级Stats计数静止，单peer与单视频track保持，恢复提示消失。详见[真实运行与原始证据](osr-first-open-runtime-20261104.md)。这是功能恢复测试，不是输入延迟或吞吐benchmark。

最终Endpoint SHA256 `5f77386930137dbcd5d0070a580f7014a62d377b770d7d1c6a4d7e07ce8b4131`；Control主bundle `index-BjH88IME.js` SHA256 `fd179e63840986324ed2354dbd51c7f82f360c4bc9e30b2228092b58536ec7c6`。Browser/SDK沿用861200对应构建，未修改Chromium补丁。日志位于`develop/tmp/first-open-native-build/`及`develop/tmp/video-only-control-build.log`。

用户截图本身不够确定是哪一步丢帧，不将代码风险直接宣称为现场故障的唯一根因。自然运行未复现原始持续白屏；旧版错误切换后端则已受控复现，最终同场景通过。
