# 触控终止恢复运行验收

2026-11-04。使用本批增量 Browser/SDK、Endpoint Release 与生产 Control，分别启动隔离的单租户单窗口实例。宿主 Playwright 运行的 Viewer 由 CDP 读回 `Chrome/157.0.8103.15`，默认 video 实际解码 `video/H264`。可信触控由 CDP 发送，远端 fixture 记录 Chromium 原生事件及 `isTrusted`。证据位于 `develop/tmp/touch-stats-qa/`。

- 双指部分抬起及最终结束。远端接触集合依次为 `[0,1] → [0] → [0] → []`，分别对应两指按下、部分抬起、剩余指移动、最终抬起。同一触控序列最终收到 `processed`。见 `run2/host-result.json` 和同目录的 `fixture-events.jsonl`。
- 丢终止回执。fixture 在 Viewer 回调遮蔽原始 end 序号的 6 条真实回执，配置遮蔽窗 5500 ms。其中包含原始接受、原始处理及 4 次只读查询的处理结果。第 4866 ms 收到同一触控序列的自动 cleanup `processed`，远端仅记录一次可信 click。见 `run2/host-result.json`。
- 按住时真实 resize。Viewer viewport 从 1152×820 改至 932×686，H264 编码尺寸从 1168×752 改至 944×608。第一个新布局 epoch 10 到达后约 1 ms，仍处于 `resize-waiting` 的 Viewer 为旧 epoch 9 的确切 owner 发送无坐标的 `input.touchRetire`。收到原生 `processed` 及远端可信 `touchcancel`，之后 epoch 11 的有效 keyframe 恢复播放。两次观测中 retire 至新 keyframe 分别约 176 和 172 ms。后续可信 tap 获得 `processed` 及远端可信 click。peer、两条已打开 DataChannel、video、MediaStream 和接收 track 身份跨 resize 保持。见 `run3/host-result-retry.json` 与 `run4/host-result.json`。
- 旧 owner 的重复 cleanup。fixture 在新 owner 已被 Native 接受后，将同一个旧 owner 的 `input.touchRetire` 以新的合法 client 序号 6 重发并收到旧 sequenceId 的 `processed`。新 owner 随后继续可信 move、最终可信 end，远端活动接触从 1 到 0，期间无第二次 cancel。该 end 的线上 client 序号为 8，fixture 回拨序号后记录为 7，结果是 `processed`。见 `run4/host-result.json` 和同目录的 `fixture-events.jsonl`。

## 工具边界与清理

首个宿主入口因托管 Edge profile 在使用而无法启动，经已有宿主 broker 执行后实际开始。run2 的驱动误要求中间 epoch 10 自身产出 keyframe，最终恢复来自 epoch 11。run3 首次启动时在空白界面未完成解锁，驱动增加可见性门禁及有界可信按键重试。run3 之后原样重发的旧 client 序号遇到 Endpoint 单调序号门禁，run4 换成合法的新序号验证旧 owner 账本。run4 的 wrapper 原地还原新 owner 的回执序号，导致驱动断言等错序号，上面的结论由 wire 与独立 fixture 原始事件交叉核对。

各轮结束后，专项 Control/fixture 进程退出，33971/33972 无监听，按专项路径检查无 Browser/Endpoint 残留。本组覆盖真实 Native、触控状态机和 H264 换代，实体移动设备及采样比例单独变化不在本组条件内。

## 实际 Stats 叠层

在独立 instrumented-max50 运行的两个计时窗结束后，从更多 → 设置启用“显示连接统计”，关闭设置后采集 DOM 与截图。单窗口默认 video，32 项指标有值。该截图时刻的 Video 提交、解码、Video 元素收帧、rVFC 回调分别为 53.0、58.0、58.0、46.0 FPS。末包→提交 p95 为 68.5 ms，提交→回调 p95 为 11.9 ms，接收缓冲和解码均值为 30.6 和 4.4 ms。编码器为 qsv，源和编码尺寸均为 1936×1008。接收码率为 4.41 Mbps，发送端下行估计为 43.07 Mbps，目标接收缓冲为 0 ms。上述为启用叠层后的单次读数。

全屏图及叠层裁图中标签、单位和数值分列清楚，无设置遮罩、遮挡、裁切或溢出。叠层为 260×649.5 CSS px，位于 1920×992 内容视口右上角，顶边和右边均留 12 px。依据为 `develop/tmp/osr-video-profile-20261104/instrumented-max50/` 的 `final.png`、`stats-overlay.png` 和 `stats-overlay.json`。
