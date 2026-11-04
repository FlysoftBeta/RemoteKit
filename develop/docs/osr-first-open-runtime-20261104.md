# 冷启动首次打开静态页面

2026-11-04，使用发布包 861200（源码 `433655d`）的 Control、Endpoint、Browser、SDK 和独立 Chromium 157。Viewer 1920×864、DPR 1，实际 atlas 1936×784，单租户、回环 H.264/QSV。关闭 Viewer 后保留一次性测试账号、Control SQLite 和 Endpoint 数据。两组冷启动均停止前一组 Control/Endpoint，从同一隔离工作区重新启动，再打开唯一 Viewer，以真实方向键序列和账户密码解锁已保存页面。测试页为无动画的静态 HTML。

| 场景 | 结果 |
| --- | --- |
| 新建窗口的内置起始页 | Viewer 本地呈现，观察到 16×16 空布局和呈现协议握手 |
| 首次导航到静态测试页 | 导航后约 0.8 秒首次采到可见 Video。初次运行 8/8 帧解码（5 个关键帧），复测 7/7（5 个关键帧） |
| 无注入冷启动，首次打开已保存静态页 | 解锁后约 1.12 秒首次采到可见 Video；连接尝试启动至首个匹配的 Video compositor 观察 1169.5 毫秒。4/4 帧解码（3 个关键帧），累计接收 192147 字节，页面恢复提示消失 |
| 冷启动，延后 4500 毫秒发出 `presentation.ready` | 第一个实际布局的 barrier 发生于 Viewer 时钟 1562 毫秒。2573、3583、4592 毫秒各请求刷新；5625 毫秒回退 Canvas，报告 `video-frame-metadata-timeout`。5673 毫秒收到第一帧元数据，累计解码两个关键帧并完成画面恢复。实际布局的 ACK 到 6085 毫秒才发送 |

延后场景在回退前无任何已收视频 RTP 或帧元数据。Endpoint 有 11 次硬件编码完成、`encoded_return status=8` 且无 wire RTP，其中包括 Viewer 刷新触发的编码；切至 Canvas 后两个 `status=0` 的 wire RTP 分别为 1719163324、1719164944，与 Viewer 元数据一致。Endpoint 日志出现实际 WebRTC SetRates 2 FPS。这组复现了等待首帧时误报元数据超时，最终画面在旧版 Canvas 路径恢复。现场的持续白屏、ACK 后已提交帧丢失以及新版修复效果仍需分别取证。

证据在 `develop/tmp/osr-first-open-433655d-{baseline2,baseline4,cold,delayed}/`。各目录的 `video-profile.json` 保存 Viewer 连接里程碑、布局、barrier、RTP 累计量、rVFC 和画面就绪；`server-trace/` 保存 Endpoint/SDK 事件。早期脚本在认证状态到达前触发解锁键序列，未通过重新附着步骤。冷启动两组等待真实锁定状态和 React 挂载后执行同一解锁序列。测试结束后通过独立 supervisor 关停自有进程。

复用方法见 [静态首帧采集驱动](../../tools/osr-first-open-browser.js) 与 [运行服务](../../tools/osr-video-profile-server.mjs)。先以全新证据目录运行服务并执行驱动默认模式，保存静态页。停止服务后以相同端口、新证据目录和 `--state <先前证据目录>` 启动，驱动复用先前的隔离 Viewer `profile`，传入 `resume: true`。控制变量场景可加 `delayReadyMs: 4500`，仅延迟产品 DataChannel 上的 ACK。测试使用真实媒体进行功能验证，未执行吞吐或延迟性能组。

## Video-only 最终产物验证

使用最终 Control 前端 `index-BjH88IME.js`（SHA-256 `fd179e63840986324ed2354dbd51c7f82f360c4bc9e30b2228092b58536ec7c6`）和 Endpoint（SHA-256 `5f77386930137dbcd5d0070a580f7014a62d377b770d7d1c6a4d7e07ce8b4131`），仍从同一份已保存静态页状态独立冷启动三次。157 两组用保存的登录会话解锁。89.0.4389.90 用全新独立 Profile 和一次性测试账号登录。三组均为单 peer、单接收视频 track、H.264 1936×784，最终页面恢复提示消失。测试未观察到呈现错误或非 Video 的呈现协商。

| 场景 | 首帧结果 | 帧／关键帧 | 稳定后的刷新计数 |
| --- | --- | --- | --- |
| Chromium 157，无注入 | 连接尝试后 1400.9 毫秒匹配 Video 首帧 | 7/7 解码，5 关键帧 | Comp 尝试／强制 Begin／成功 1/1/1，Viewer 1；空闲快照相隔 8.006 秒 |
| Chromium 157，延后 ACK 4500 毫秒 | ACK 前无视频 RTP 或帧元数据。正确布局 ACK 后 41.3 毫秒收到关键帧元数据，84.6 毫秒匹配 Video 首帧 | 1/1 解码，1 关键帧 | Comp 1/1/1，Viewer 5；空闲快照相隔 4.006 秒 |
| Chrome 89，无注入 | 连接尝试后 2227.0 毫秒匹配 Video 首帧 | 3/3 解码，2 关键帧 | Comp 2/2/1，Viewer 2；空闲快照相隔 7.004 秒 |

每组在两次独立 Endpoint 统计消息之间保持 `presentationRefreshPending=false`，且上表 Comp 与 Viewer 的计数保持不变。ACK 延迟场景在旧版改走 Canvas，最终产物在原 peer 保持 Video。最终 Endpoint 在 ACK 前的 7 个硬件完成结果返回状态 8 且没有 wire RTP；ACK 后发布的关键帧 wire RTP 为 1106252672，与 Viewer 帧元数据一致。

Chrome 89 实际观察到纹理 frame 1、2、3 的 SDK 提交返回 0，未出现对应 Encode 入口或 wire RTP。frame 4 在 frame 3 约 1.03 秒后进入 Encode，并成功发布 RTP 1108037531。Comp 报告两次呈现刷新尝试和一次成功。现有事件未记录逐帧刷新令牌，因此无法把前 3 帧中的特定一帧与首次刷新尝试绑定。

证据在 `develop/tmp/osr-first-open-video-only-{cold,delayed,chrome89}/`，各目录保存 Viewer 报告、Endpoint／SDK 追踪、前端 bundle 及实际可执行文件指纹和最终截图。三组 supervisor 均正常退出，自有进程已清理。日志未见 FATAL、CHECK 失败或 GPU 进程退出。
