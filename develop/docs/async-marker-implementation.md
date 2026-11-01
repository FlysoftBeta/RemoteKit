# Pixel marker Worker读回候选

2026-11-01。已实现自动化设施中的显式`markerReadback=worker`候选，默认仍为`sync`。没有修改Viewer产品UI、transport调度、Endpoint或Chromium。已完成源码检查、78项Control测试、类型检查、生产构建与启动smoke；未启动浏览器/GPU实验，性能收益和Chrome89实际支持仍待实跑。

## 使用与真实性边界

`tools/prepare-streaming-case.ps1 -MarkerReadback worker -FrameSource track-processor -PresentationMode snapshot -ProcessorScheduler fifo2 -MarkerHz 1`写入配置`markerReadback: "worker"`，其它配置沿用原对照组。`-MarkerReadback sync`为原同步对照。已有case的run.js不会随工具文件自动更新，须用新case或按原driver生成流程重新生成。

Worker模式在实际paint通知中取得`getPresentedPlane`返回的`kind=plane` HTMLCanvasElement，并在同一个同步调用栈立即调用`createImageBitmap(canvas, x, y, 256*pixelsPerDip, 112*pixelsPerDip)`。ROI与原同步算法相同，采样覆盖整个marker；没有在Promise完成后再读会变化的原canvas。MSTP当前返回实际已绘制的plane canvas。旧video snapshot路径返回`kind=atlas`，本候选明确报错；single-plane-direct实际返回plane时可以使用。非整数或越界ROI同样报错，不以其它source补测。

每个job保留id、原paint RTP/epoch、paintedAt/paintedWallTime及sourceRect。bitmap完成后transfer给模块Worker，Worker使用256×112 OffscreenCanvas，先清空该canvas，再执行原draw缩放、getImageData、原`decodeMarker` CRC算法。每次清空避免透明输入以source-over绘制时继承前一个job的marker像素。结果按paint提交顺序计入样本，E2E终点仍取原paint时间；没有把Worker完成时刻或未绘制VideoFrame作为终点。

Chrome157本地源码`third_party/blink/renderer/core/html/canvas/html_canvas_element.cc`的`HTMLCanvasElement::CreateImageBitmap`同步构造ImageBitmap；`core/imagebitmap/image_bitmap.cc`的canvas构造函数同步调用`GetSourceImageForCanvas`后应用裁剪，再兑现Promise。由此可确认当前实现调用时捕获canvas源，而不是稍后读取新canvas；snapshot构建仍可能在主线程花费时间，不能提前宣称消除了主线程阻塞。Chrome89及交替画面不可变性需要真实浏览器验证。

## 时间、失败与所有权

完整report新增`markerReadback`，明确requested/effective模式，记录每个job原身份、ROI、CRC结果及下列耗时：主线程`captureCallMs`、bitmap兑现`bitmapReadyMs`、端到端异步周转`turnaroundMs`、Worker draw/readback/decode/total。后三项是Worker自身时钟差值；不跨realm直接相减时间戳。同步模式原`markerDraw/markerReadback/markerDecode`设施保留。

最多4个未完成job，单job超时5秒。满容量、创建/transfer失败、worker报错、超时、pagehide都产生显式失败。Worker正常/CRC无效/异常均在finally close bitmap；transfer失败和超时后才兑现的bitmap在主线程close。超时或关闭终止Worker并销毁该realm拥有的资源，不把它计作显式Worker close成功。ownership统计分别记录created/transferred/main close/worker close/terminated；失败不伪造为CRC成功。

计时窗口结束先停止paint订阅，再等所有已提交job完成或显式失败，然后上传。Worker drain不计入FPS窗口，也不改变原paint延迟终点；report独立记录drainMs。FPS分母保留旧同步实现的末次collect耗时，只减去新增的worker drain，避免把删掉末次collect的细小差异误当作跨越50FPS的收益。worker的`markerHz>0`要求至少floor(sampleMs*markerHz/1000)个CRC有效且非重复样本，因此45秒/1Hz不足45个会在保存原始report后抛错。所有worker job错误亦在保存report后抛错。未做静默sync fallback。

## 检查与指纹

- `npm test`：78/78通过，新增4项覆盖同栈快照调用与paint身份、容量/超时及迟到bitmap回收、transfer失败、Worker原CRC算法与成功/无效/异常close。
- `npm run build`：TypeScript、Vite、server验证、production startup smoke通过。
- JS syntax check、PowerShell AST解析、git diff whitespace检查通过。
- bundle仍`index-BI4yf---.js`，SHA256 `F86A2BA691C5C54A07EFF0D08E362ECB34B5D040EDADFFBC0B05C15DB3F38CD1`（本改动全在自动化工具/public资源，Viewer bundle未变化）。
- `benchmark-marker-readback.js` SHA256 `75A0CF1A08388A297C73A3A46803C8E5CE889734B32654891411F51100CFE249`。
- `benchmark-marker-worker.js` SHA256 `689510C6604D04DAB054FFE8073CAD63C443274E7DC0E462C153ABB29AE59DFB`（透明输入修复后，public与dist副本相同）。旧`8C7096FB…`版本存在透明样本继承前帧像素的问题，不用于正式A/B。
- `tools/streaming-benchmark.js` SHA256 `48730DE01498EBBDB6D0EF02D6CC51F0C4F0E76EDFC0EB1B7EECAADA912C1947`。prepare新增三个实际served public模块的hash，避免bundle未变化时漏记Worker候选版本。

待实证：模块Worker/OffscreenCanvas在Chrome89与Chromium157的支持、画面交替后的job不可变归属、是否完整取得45个CRC样本、主线程capture调用是否仍同步阻塞，以及同配置FPS/p95与GPU资源对照。构建无浏览器/GPU采样并行。

## 透明输入回归修复

后续runtime Agent报告：opaque plane的不可变job、RTP/epoch/paint身份、close及Chrome89独立API检查通过；透明/空输入发现原Worker会沿用上一job像素。已按主Agent决定在每job drawImage前clearRect完整Worker canvas，未变更CRC算法、paint端点或source要求。

对应回归使用source-over语义的绘制模型，先提交有效marker，再提交全透明bitmap，确认第二个结果为invalid且两者均close；旧代码不清空时该测试会返回前一个有效marker。修复后4/4专项测试、TypeScript、Vite/server构建、production smoke及whitespace检查通过，Worker dist资源已更新。运行组已释放GPU后才执行本次构建；修复后透明/Chrome89实跑及正式A/B交由runtime Agent。
