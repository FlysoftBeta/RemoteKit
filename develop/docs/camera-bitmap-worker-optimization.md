# 摄像头 immutable bitmap → Worker 优化

2026-11-02，源码/模型阶段，尚未生产build或浏览器验证。

原首次同步snapshot31.2ms超过20ms阈值，保留为失败证据；本次没有重拍或修改阈值。改用同一不可变ImageBitmap在Worker中缩小评分并生成完整照片Blob，主线程不再full canvas draw、getImageData或灰度转换。输出尺寸不超过源尺寸，最大4Mi pixels。Worker先draw到完整OffscreenCanvas、立即close bitmap，再从该canvas缩小评分/convertToBlob；finally归零两canvas。

主线程增强路径指标：snapshotSyncMs只累计createImageBitmap调用同步耗时与postMessage transfer同步耗时；bitmapWallMs是异步快照等待，workerWallMs为包含Worker评分/编码的整个往返，workerDrawMs为Worker draw/readback/灰度，scoreMs为原算法，blobWallMs为Worker异步编码等待。异步时间不能称为主线程卡顿；首次Worker启动/能力探测另在burst之前，真实运行应仍用longtask观察全流程。现有峰值指标是保守逻辑像素，包含候选Blob尺寸+在途bitmap+Worker完整backing，不是JS heap实测；最坏12Mi+4Mi+4Mi，再加评分小图至多65536像素。bitmap在full draw后立即关闭，之后完整backing与候选合计至多16Mi。实现没有持续保留bitmap。

Worker probe检查2D OffscreenCanvas与convertToBlob。缺少API、probe失败或video createImageBitmap拒绝时仍保留原canvas功能：同一个full canvas同时产生评分小图与照片，不能从活动video重拍照片。createImageBitmap失败尚未产生评分时才下一采样转fallback。每次只一个请求在途，串行等待、不积压；最多6采样/600ms、top3、80ms去重不变。取消/隐藏/lease变更由既有dialog调用cancel；generation拒绝旧结果，迟到bitmap先close，Worker terminate释放其backing；旧finalizer不能终止新Worker。

验证：全tsc --noEmit通过，4项定向模型通过（旧canvas取消/新Worker隔离、迟到bitmap关闭、增强burst同帧Blob与top3、Worker同一bitmap派生评分/编码且释放canvas）。未重复算法排序/HTTP对照。未生产build、未启浏览器、未接触GPU；等待root资源窗口。下一步157/89各一次必要短burst、取消/隐藏资源、候选视觉确认。20ms阈值与零新增>50ms longtask保持；89若fallback超预算如实报告，不能称本优化已解决。

## 实际首轮短组（2026-11-02）

生产 `npm run build`（含tsc、Vite、bundle验证与startup smoke）通过。复用正式Viewer/文件dialog和真实getUserMedia fake-device，隔离host-managed 157与89各**首次一次完整burst**，没有相机snapshot warmup、没有重拍求达标，不代表物理摄像头硬件/权限交互。

| 指标ms | 157首张 / 后5张范围 | 89首张 / 后5张范围 |
|---|---|---|
| 主线程snapshotSync（调用+transfer） | 0.9 / 0.7–1.5 | 5.35 / 3.655–4.49 |
| bitmap异步wall（包含调用） | 0.7 / 0.5–1.2 | 5.235 / 3.58–4.385 |
| Worker draw/readback/灰度 | 30.2 / 4–10.1 | 9.645 / 1.295–3.645 |
| Worker算法score | 3 / 0.6–2.7 | 10.165 / 0.75–8.23 |
| Worker Blob编码wall | 14.2 / 9.4–18.2 | 4.66 / 3.955–5.89 |
| Worker完整往返 | 56.3 / 15.4–31.9 | 25.14 / 7.015–15.94 |

每组6快照，snapshotSync p95（nearest-rank）分别1.5/5.35ms，均低于原20ms门槛；拍照前观察至候选展示期间0个>50ms longtask。Worker启动probe往返157约27.8ms、89约31.895ms，保留在workerWallMs首项；scoreMs不添加probe假0。首张Worker30.2ms draw是异步Worker成本，没有丢弃该冷开销。

每组保守逻辑峰值4,608,000px（3候选+bitmap+full，160px评分图额外有界）；Worker终止、主canvas集合0，候选3张未勾选，照片解码尺寸均1280×720。157抓取pool时因既有stopCamera清空pool为空，但UI候选已持有Blob且3张正常；不可把pool空当照片消失。89记录tracks ended；89拍摄中立即取消另一次功能动作后tracks ended、worker/pending false、canvas/pool0、dialog关闭，不计入性能首组。迟到bitmap关闭和新旧Worker隔离有模型验证。隐藏handler未改，未新做真实visibility切换；两版本均支持bitmap-worker，canvas fallback源码/模型保留，未新增fallback实机性能组。

Sol目视两张截图：三候选完整、无默认选、页脚/取消/使用文件可见，89焦点边框可见。仅桌面本专项，不替代既有窄屏报告。89 Playwright新版role engine调用缺失checkVisibility而失败，最终用DOM button.click触发产品原处理器；之前仅打开camera，没有snapshot，所以最终89结果仍首次capture。未修改产品以兼容测试器。

证据：`develop/tmp/camera-bitmap-qa/metrics/client-metrics.jsonl`，`157-camera-bitmap.png`与`89-camera-bitmap.png`。可复用操作为`tools/camera-bitmap-qa-browser.js`，接已有`viewer-presentation-baseline-browser.js` host/session。结束两context已关闭，fixture/shutdown完成、PTY退出0，已通知root释放GPU/host。
