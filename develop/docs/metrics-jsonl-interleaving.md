# Client metrics并发JSONL写交错

## 问题与影响

修复前，`control/server/http.ts`为每个metrics HTTP请求独立await appendFile。同一Control进程接收四个Peer的40秒benchmark报告时，每份JSON超过512KiB；Node把一次appendFile拆成多个write，异步调用之间交错。所有HTTP上传成功，但多份JSON的前缀和尾块互相穿插，日志不再是有效JSONL。

不影响视频/输入实验本身。分析若跳过JSONDecodeError会静默丢掉四份主报告，因此该错误会阻塞精确结果分析。与GPU、RTP数据丢失无关。

## 最小非GPU复现

运行 `node tools/repro-metrics-append-interleaving.mjs develop/tmp/metrics-append-repro-40s`，指定一个尚不存在的输出目录。工具不启动浏览器或网络，分别并发与顺序append四个700000字节payload的JSON对象，保留两个原文件和summary。

本机Node v24.22.0实测：并发文件2800156字节、4行、4份无效JSON；顺序文件同为2800156字节、4行、0份无效，Peer0/1/2/3均完整。产物 `develop/tmp/metrics-append-repro-40s/summary.json`。

## 已实施修复

同一metrics文件使用单一顺序writer或Promise队列，整个一份JSON写完后再启动下一份；队列失败后应恢复后续调度，同时把当前请求的写失败传回HTTP。不能假定一次appendFile或单个HTTP请求就是一次原子文件写。无需改媒体或benchmark测量逻辑。

7e30ee1已落实单server Promise队列，每请求等待自身写入结果，失败不会阻塞后续调度。真实文件系统错误后并发上传四个大于512KiB的不同Tenant报告，2,916,512字节JSONL及内容、归属均通过验证。Control 36项测试、typecheck、生产build与startup smoke通过；Client bundle未变化。

## 本轮恢复与边界

受影响case：`osr-render16-playout-unset-reverse40`、`osr-render16-playout0-reverse40`。原文件SHA256分别为 `2d4aff5e39e72e30445d314668d1e53616c0138e6f8eefc8ee2ff41b8b004cf0`、`4c589ad4ee8467279d73aa22cc643417885df017c20312db920af545034b46fd`，原始文件保留。

每case为4个512KiB JSON前缀、4个不足512KiB尾块以及9条完整小记录。对24种前缀/尾块排列逐一解析，要求每份原生视频帧RTP模32位差不超过90000、callback now及presentedFrames单调；两case均只有一个有效排列。实际最大RTP差为10800–17010，跨Peer错误拼接无法通过。恢复清单记录Tenant UUID、Peer index、实际Session、RTC SSRC、首尾RTP、偏移/长度/SHA256，恢复后13条JSON全部解析成功，四Peer各一份benchmark，原始总字节数完全保留。

该恢复依赖当前四份报告恰好各两块的结构，不是通用JSONL修复工具。以后存在多解或字节缺失时不得据此生成精确报告。本次脚本和清单留在 `develop/tmp/osr-playout-reverse-result` 及各case的metrics目录。
