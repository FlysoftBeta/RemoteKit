# 媒体反馈真实接线验证

## 结果

媒体反馈接线通过：Chrome89真实DataChannel反馈进入Endpoint stats，seq随连接递增、年龄使用Endpoint时钟；split保持两个plane的独立计数，没有相加成视频帧数；重复seq和旧输出身份被拒，inputRejected始终0。静态pending/inflight为0，动态inflight实际出现1，queueWaitSamples随真实编码增长。

**重连后的画面恢复失败，已独立复现并报告主Agent。** 新peer的feedback seq从1重新增长，但Chrome89的video在解码、时间轴推进时不再交付任何rVFC，canvas停留在“等待页面画面”。观测字段正确保留videoFrames未知、planes为空，没有伪填0。本轮不把整个重连功能写成通过。

## 版本与范围

- Release Endpoint SHA256：`87C53396DBB05969CDBF46714E5EEDD5A72E0B9FC91A8646495810A7FBA170A6`。
- Client：`index-CC1We13C.js`，SHA256 `C298CD31E976CA55ABB93F56E8299083301FF46C58BE5E2B4F961A077B7C0DB3`。
- 已先独立复核Client窗口修正：native反馈立即取样/发送，relay HTTP变为独立单pending请求；失败保留旧网络值，旧peer/connection响应不能覆盖新连接。新增测试覆盖延迟、失败和旧响应隔离。
- Chrome89.0.4389.90，host-managed headed实例；1280×720桌面，双页后1344×720，source render30、snapshot、RTP0/0、每Peer24Mbps/每向5ms整形。不是性能矩阵，未报告FPS/延迟验收。
- 临时功能fixture移除textarea autofocus以获得真实静态页面；没有改产品源码、默认、正式工具或构建。没有其他任务编译/GPU工作重叠。

## 实际反馈与队列

主要case：`develop/tmp/media-feedback-live-valid`。以下是真实Endpoint stats快照，不是测试内存对象：

| 阶段 | seq / epoch / generation | displayHzEstimate | age ms | pending / inflight | queueWaitSamples | feedbackRejected / inputRejected |
|---|---|---:|---:|---|---:|---|
| 单页静态 | 2 / 1 / 1 | 32.53 | 461 | 0 / 0 | 3 | 0 / 0 |
| 重复seq拒绝后 | 2 / 1 / 1 | 32.53 | 1463 | 0 / 0 | 3 | 1 / 0 |
| 单页动画 | 4 / 4 / 1 | 33.27 | 966 | 0 / 1 | 121 | 1 / 0 |
| split动画 | 6 / 8 / 3 | 33.15 | 1363 | 0 / 1 | 295 | 1 / 0 |
| 输出重建并拒绝旧身份 | 8 / 11 / 5 | 33.24 | 1175 | 0 / 0 | 453 | 2 / 0 |

age是Endpoint生成该份stats时距收包的时间，客户端稍后读取缓存stats不会重新计算它。displayHz约32–33是当前RAF回调能力，不是物理刷新率。实际反馈窗口包括约1500ms与3000ms；1500ms轮询存在小于采样下限的轮次时，Sampler等下一轮并报告真实较长windowMs，没有假写1500。

静态样本原生decodedFrames、videoFrames、plane frames均0，表示已有可靠基线且无新增帧。layout改变后的首个样本省略增量字段，保留未知。随后split真实发送seq7、window1500.78ms：decodedFrames58、videoFrames57，plane1/2各48；视频数仍57，没有变成48+48=96。Endpoint accepted计数从6增到8覆盖seq7/8，两个plane ID也分别出现在stats；这份seq7的完整增量在紧接着的输出重建中被清空，未单独截到包含该增量的stats快照。

所有观测中的encodePending均0，encodeInflight出现0/1；这说明普通快照没有恰好碰到pending驻留，并不证明没有pending。pendingReplaced从0到3、queueWaitSamples从3持续增长到1182，queueWaitUs从108到100361。hardwareBusy始终0，paused/error/inactive/cancelled drop本轮也未触发，不能写成这些硬件终态已实测覆盖。

## 身份与错误反馈分流

1. 发送一份当前身份、重复已接受seq2的feedback：feedbackRejected增加1，accepted/seq不前移，inputRejected仍0。
2. 输出从epoch8/generation3重建到epoch11/generation5后，发送旧身份feedback，并将seq提高到100008以排除“只因低seq被拒”的混淆：feedbackRejected再增加1；后续正常seq8仍接受，说明错误消息没有毒化seq基线，inputRejected仍0。
3. 同peer的输出重建保留序列，未退回1。换peer后第一份真实feedback seq1，随后增长至9，Endpoint stats也接受；连接ID确实改变。

没有宽泛fuzz、输入事件注入或使用CPU测试冒充DataChannel运行验证。

## 重连画面故障的定向复现

独立case：`develop/tmp/media-feedback-reconnect`。短双动画页初次连接正常，然后真实`/api/rtc/close`、disconnect、200ms后connect，未改flags或产品代码。

| 观测 | 重连前 | 重连4秒后 | 再调用video.play()后 |
|---|---|---|---|
| displayReady | true | false | false |
| video.paused / readyState | false / 4 | false / 4 | false / 4 |
| video.currentTime | 1.82s | 3.90s | 5.62s |
| webkitDecodedFrameCount | 72 | 144 | 208 |
| track | live/unmuted | 新track，live/unmuted | 同新track |
| 内部frameCallback ID | 53，持续推进 | 54，不再推进 | 54，不再推进 |
| 新注册的独立rVFC | 未添加 | 0回调 | 仍0回调 |
| Endpoint feedback seq | 1 | 2 | 3 |
| feedback planes | 两plane | 空 | 空 |

额外`video.play()`立即resolve，但没有恢复rVFC；所以不是单纯忘记play或内部callback自身异常就能解释。现有证据将故障定位到复用video/MediaStream后的Chrome89视频呈现回调链，尚未确定根因，也未擅自改为新video对象。内部和外部rVFC都不交付，RTC解码仍继续，反馈接线没有把未呈现帧虚报为canvas帧。

原主要case也出现相同现象：新peer H264 decode增至709、反馈seq1→9，两个页面都显示等待画面。故障截图已由Sol目视核对，不能称重连后的视觉恢复通过。最终双页静态归零步骤因这一故障未执行；最初单页真实静态的0/0结果保留，不扩大为全部重连后的状态已验证。

## 产物与清理

主要case保留全部metrics、发送feedback、200ms读取的Endpoint stats、Endpoint原始响应与指纹；紧凑复算为`feedback-summary.json`。定向case保存video/track/rVFC/renderer状态与截图。最早`media-feedback-live`因临时脚本误用Chrome89不支持的Array.at提前停止，修正临时脚本后才运行以上主case，没有把该失败当产品问题。

全部自建Chrome89、RTC、Control/source/resource进程均已清理，默认managed宿主也通过browser_close正式关闭；3001/3013无监听。GPU窗口已交还主Agent，未运行CPU构建、GPU probe或性能采样。
