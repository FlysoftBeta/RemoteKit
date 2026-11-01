# Chrome89重连后的video呈现生命周期

已修复Chrome89在双页split手动重连后持续解码、却不再触发rVFC导致无画面的问题。每个Peer现在有新的HTMLVideoElement；旧元素清理官方rVFC、pause、srcObject和可能的诊断DOM。rVFC和play Promise按Peer/attempt/video身份隔离，布局epoch和输入授权逻辑保持原路径。

## 根因判别

`develop/tmp/media-feedback-reconnect-fix`使用旧客户端bundle、相同单租户双720页面split、QSV d1/TU1/VBR、render30、独立24Mbps/10ms RTT整形复现：

- 首连displayReady=true。
- 断开再连后video readyState=4、paused=false、track live/unmuted，currentTime3.884→5.614秒，decoded146→210，但内部rVFC没有增加，额外独立注册rVFC也为0。
- 显式video.play()立即resolve，画面仍未恢复。
- 保持同一个Peer、同一个MediaStream，不重新协商、不重建服务端输出，只改为新video并注册官方rVFC；2秒内displayReady恢复true，feedback重新包含两个plane。

因此问题出在Chrome89旧video跨MediaStream复用的呈现状态，产品/反馈忠实报告缺少实际呈现。没有用decode计数或polling伪造呈现。

## 修复

`control/client/transport.ts`的video改为只读getter，底层receiverVideo在每次establish创建；ontrack和play失败回调捕获本次元素身份。startFramePump捕获video，仅消费该元素且该Peer/attempt仍有效的回调；关闭清理旧资源。

MarkerTools正在运行的测量捕获video引用，因此重连connectionId变化时停止旧测量；新测量通过getter取当前video。没有UI视觉变化。正常snapshot与direct绘制仍使用当前video，frame gate、布局/代次与输入身份验证未放宽。

新增回归确保被替换video的迟到回调不能授权新RTP或在新元素上续注册，新元素的真实回调才可推进呈现。

## 实播验证

`develop/tmp/media-feedback-reconnect-fixed-live`使用正式新bundle，原条件下依次验证首连、disconnect→connect、在线manual connect两种重连。三个阶段均displayReady=true、双plane的当前Pixel marker CRC有效、无pageerror；每次新连接反馈seq从1起，第二窗口已具有videoFrames和两个plane的非零新帧增量。

| 阶段 | 当前video presentedFrames | 累计rVFC callbacks | Endpoint反馈seq / videoFrames增量 | 两plane新帧增量 |
|---|---:|---:|---:|---:|
| 首连 | 241 | 201 | 2 / 112 | 93 / 93 |
| disconnect后重连 | 232 | 397 | 2 / 107 | 89 / 89 |
| 在线manual重连 | 207 | 560 | 2 / 55 | 42 / 42 |

各阶段snapshot时刻不同，表中累计数不用于FPS或延迟验收。两个旧video均确认paused=true、srcObject=null、未连接DOM；当前video与它们身份不同。截图为同目录`split-after-two-reconnects.png`，完整metrics内保留stage、layout、epoch和marker。

CPU检查和正式生产build+startup smoke通过，新增测试后Control全43项通过。bundle为`index-COuWf0fP.js`，SHA256 `7b943c364be32232fbaca36d84d9fa1e8e93fbf5eb137567de812d0f5549d46c`。构建/CPU测试与实播窗口串行，没有重叠。

两组自建Control/source/resource进程及后代、Chrome89均已清理，所属默认host也已关闭。无Endpoint/browser或帧率策略改动；本轮是重连正确性验证，不替代1/4租户1080目标验收。
