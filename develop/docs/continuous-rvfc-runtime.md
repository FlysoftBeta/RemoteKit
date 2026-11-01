# Continuous rVFC 单变量实播

2026-11-01，receiver的默认关闭0006开关已验证真实生效，静止、resume、几何变化和重连边界通过；本轮没有证明稳定FPS收益。正式off为canvas52.81FPS/marker p95123ms，on为51.17FPS/p95104ms。两组均未同时达标，保持默认关闭。

## 条件与正式组

Chromium157.0.8103.15，精准synthetic60，receiver exe SHA256 `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`，DLL `20C0F298D2012B6841BA8ACB7AF7F62DC6DF23A40F899073C9D74DD0FC034FCC`；0005配对timer与0006都在同一binary。source browser仍`7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`，Endpoint仍`B7FB545A05359417DA74A390ACD260D8C565004D3B1D6392D13199FF74C50208`，canvas fixture仍`4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`，Client bundle仍C64R1vkN。各case保存完整fingerprints。

单租户1920×1080 DIP/DPR1，真实source/encoded/video1936×1088、mediaScale1、H264 actualLevel42；source render60、external16/direct、TU1/VBR/d1/LowPower auto，RTP0/0、每peer独立24Mbps/RTT10ms、marker1Hz、after-work/snapshot。暖机5秒+采样30秒，ResourceProfile开启，媒体及ServerTrace关闭。模拟刷新不代表物理扫描输出。

off目录`develop/tmp/continuous-rvfc-off-t1`；on最终正式目录`develop/tmp/continuous-rvfc-on-formal-t1`。on只在原`--fake-vsync-rate=60`之外追加`--enable-features=RemoteKitContinuousVideoFrameCallbacks`，原禁用features保持。产品binary、bundle、fixture指纹完全相同；两组工具指纹差异仅正式报告上传修复，发生在测量结束之后，不改变帧采样。

| 同组指标 | off | on |
|---|---:|---:|
| source RAF/render FPS |60.00|60.00|
| atlas FPS |59.98|59.98|
| encode FPS |58.42|60.01|
| decode FPS |58.38|59.98|
| metadata presentedFrames FPS |58.37|59.97|
| 实际rVFC/authorized/canvas FPS |52.81|51.17|
| 接收端RAF Hz |59.94|60.00|
| marker p50/p95/p99 ms |74/123/124|55/104/105|
| CRC有效/无效 |30/0|30/0|
| worker平均队列等候ms |2.052|0.256|
| pendingReplaced增量 |47|0|
| atlasPoolDrops增量 |1|0|
| marker同步readback p95ms |25.7|8.7|

真实30秒独立paint计数用于FPS，不使用metadata累计帧数替代；同窗各层计数保留在summary/stage-summary中。两组frameGate missed0、RTC packetsLost/framesDropped0、Endpoint error/errorDrops0、CRC有效，网络整形丢包0。无pageerror，RTC close均200；on关闭30.9ms。

host-load CPU p50/p95在off为46.05/76.40%，on为22.60/36.45%，同机背景负载明显不同。主Agent在构建结束后分配独占GPU窗口，本Agent未构建或启动其他实验；这项CPU差异仍使延迟及资源变化不能全部归因feature。on没有提升正式canvas FPS，当前证据不足以启用默认。

## 分段与GPU

| 分段统计ms | off | on |
|---|---:|---:|
| capture→ready快照p50/p95 |14.50/19.65|6.77/7.80|
| lastEncode快照p50/p95 |8.92/12.55|5.69/8.87|
| GPU copy快照p50/p95 |5.08/8.68|3.82/5.96|
| RTC平均decode |1.159|0.734|
| RTC平均jitter buffer |3.343|3.778|
| RTC平均processing |4.595|4.575|
| receive→rVFC p50/p95 |11.0/17.3|8.5/14.0|
| presentation→rVFC p50/p95 |9.5/15.9|7.6/13.0|

capture/encode/copy为32个秒级last-value快照；RTC平均用同窗累计差/帧数，receive/rVFC取逐帧metadata。on的104/105ms marker对应render→receive98.0/99.3ms、receive→canvas6.0/5.7ms；off的123/124ms异常也主要在到达receiver之前。未开逐帧server trace，不能将到达前异常再精确拆成source、编码、pacer和网络。

| 引擎/角色平均占用% | off | on |
|---|---:|---:|
|3D总计|85.60|71.39|
|3D sourceGPU|25.99|24.10|
|3D sourceBrowser|5.49|5.00|
|3D Endpoint|18.79|17.87|
|3D receiverGPU|20.08|16.85|
|VideoDecode总计|19.97|16.78|
|VideoDecode Endpoint|12.46|10.06|
|VideoDecode receiverGPU|7.50|6.72|
|VideoProcessing Endpoint/总计|7.77|6.89|

两组完整资源样本各29个，GPU collection errors0、resource.err为空。采样器平均0.06676/0.05151 CPU核、collection123.99/79.12ms，未视为零开销。独立引擎不相加；Endpoint的VideoDecode驱动命名不代表只做解码。

## 独立功能与native trace

`develop/tmp/continuous-rvfc-functional`是独立change-stop组，trace期间不计正式性能。host-managed CDP Tracing取blink/media，原始native-trace.json、逐chunk数据和functional-summary.json完整保存。

- SchedulingState共150次，全部`continuous_callbacks=true`；其中54次`is_hfr=false`，证明feature确实参与原先不会连续观察的分支。native ExecuteVideoFrameCallbacks95次。
- stale_frames=2状态20次；源停止后，stopped→idle-confirm的callbacks保持81、paint保持76、decoded保持109，marker frame138保持。trace对应约9秒没有新的render-step事件，静止没有无限自排或重复dispatch旧帧。
- 输入恢复产生有效CRC stimulus123；先前停止边界有效，后续聚焦光标可产生真实damage，不把后续额外帧全部当错误重复。
- 720→1080与重连均displayReady/CRC有效，epoch/generation依次3/2、5/3、6/4。旧renderer调用返回false；旧video身份改变、paused=true、srcObject=null。
- 117次native callback无连续重复RTP或metadata presentedFrames值；113次成功paint无stale epoch，paint/authorize最大嵌套深度1。所有阶段无pageerror或Endpoint error。

## 大报告上传修复与失败组

首次on组`continuous-rvfc-on-t1`在测量结束后因`/api/metrics`的1MiB限制返回HTTP413，未保存完整报告，标为上传失败，不列性能对照。临时UTF8生成器失败的`continuous-rvfc-on-chunk-t1`没有形成配置一致的有效组，排除。过渡完整分块组`continuous-rvfc-on-valid-t1`曾得到55.72FPS/p9589，但尚无正式source校验manifest，只作诊断保留；最终结论使用正式on组，避免挑选较好一次。

正式`tools/streaming-benchmark.js`现对≤900000 UTF8字节报告保持旧上传形式，较大报告按200000 JS字符分块，带runId/tenantIndex/part/chunks，最后写manifest、小摘要、完整字符数/UTF8字节数/SHA256；原presentation-raw-chunk不变。上传与hash都在采样结束后。没有截断或丢弃数组，也没有提高Control请求上限。

`tools/streaming_metrics.py`重组并验证身份、分块范围、重复/缺失块、长度和SHA256，正确处理UTF16边界拆开的emoji；全部6个正式metrics分析器接入该loader。最终on报告992777字节、5块，SHA256 `b1d9e1aa66e99f5ae8e74a45d6276b39d9fdaf067bb41108a674bb05642fbff2`，实际重组校验通过。off旧格式兼容通过；5项完整Unicode/旧格式/缺块或manifest/内容篡改/重复块检查通过，相关Python编译检查及JS语法检查通过。正式resource/cadence/matrix分析已对实际组运行。

各组原始metrics、source-trace、endpoint-responses、resources、fingerprints与确切run.js/config保留；配对layer表在`develop/tmp/continuous-rvfc-comparison`。所有自建source/receiver/Control已退出，3001/3013无监听，正式browser_close完成，GPU已交还。未修改codec、fixture或产品默认开关，没有构建或提交。
