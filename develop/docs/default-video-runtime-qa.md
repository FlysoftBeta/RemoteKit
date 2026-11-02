# 默认video运行QA

2026-11-02，Sol6.1。正式Viewer默认video的157/89单窗、split、输入、resize、DPR、重连及音频/文件共存已实际运行。发现的**静态页resize后空layout**已由独立owner修复capture oracle结算，并完成一次新Browser定向回归。

## 环境与证据

使用host-managed Playwright启动隔离157.0.8103.15与89.0.4389.90 headless context，不使用Computer Use、不抢宿主鼠标键盘。Browser为`C:/src/chromium/src/out/dev/remotekit_browser.exe`，Endpoint为本轮Release `build/endpoint-package/endpoint/endpoint_service.exe`，Viewer为本轮production dist。首组后暂停GPU，root更新179项测试通过的最新dist后完成后续组。没有重复历史性能矩阵或长稳定组。

入口为`tools/default-video-qa-server.mts`、`tools/default-video-qa-browser.js`，静态定向组为`tools/default-video-qa-static-browser.js`。独立数据库、profiles、fixture事件、截图及metrics位于`develop/tmp/default-video-qa`。测试读取生产React transport，默认不替换backend/mediaPolicy；指定用例才有界暂存ACK或延迟frame metadata。音频在实际解码post-gate PCM取样，destination前零gain让宿主静音。

原始布局/协议/每video身份、getStats与呈现诊断保存在`metrics/client-metrics.jsonl`；网页真实输入、文件/音频启动和几何保存在`fixture-events.json`。Endpoint停机前的完整snapshot另存`inspect-stalled.json`。本次没有把旧canvas性能结论冒充新video结果。

## 实际通过

- **正式默认video**：157与89均显示`backend=video / negotiated-video`，没有实验video替换。整个观察窗口MSTP构造计数0、viewport drawImage计数0；transport的plane2dDraws/atlasSnapshotCopies也为0。video muted/playsInline，controls=false、disablePictureInPicture/disableRemotePlayback=true、tabIndex=-1、draggable=false。89两video的contextmenu事件均preventDefault。
- **真正两个Window**：157和89桌面split呈现A/B两独立网页，而atlas把两平面纵向排列。客户端两个内容bounds分别`x=0/722.5, y=88, 717.5×812`；clip与各自透明canvas输入层精确一致。两video共享同一track id；各自有rVFC/RTP/ready，例如89分别4023845299/4023843499。不能据此宣称只有一个decoder。
- **输入坐标**：157 A/B分别点击160,450，真实远程pointerdown/up均为该窗口；B误差小于0.00004 DIP。resize1100×760后200,450准确；390×844下鼠标140,450和真实CDP触控180,450准确。89单窗200,450与split各窗180,450通过。事件包含pointerType、远程DIP和DPR。
- **resize/DPR**：157动态源390×844内容390×756、scrollWidth390，无Viewer横向溢出；窄屏A/B切换各自恢复。89 split缩至1024×768后两平面各509.5×680、clip与输入层一致。157 Viewer DPR2自动档实际服务DSF约1.67487（面积预算适配），高画质后DSF2、内容2200×1344、atlas2224×1360；客户端内容1100×672，两层bounds一致，点击240,450准确。
- **同尺寸换代与旧ACK**：736×1648 atlas从epoch13→15→16→17，暂存barrier8/9/10三个ACK后，两video opacity0且ready=false。发送旧barrier8 ACK并等待300ms，仍双隐藏。仅发送最新barrier10后，video12与video13分别收到自身真实rVFC/RTP2768499133再恢复epoch17。这是相同尺寸的Document身份换代，不是矩形packing顺序互换实验。
- **真实同尺寸packing位置互换**：权重1:2→2:1单组，总atlas保持1456×832。epoch32/gen10时A宽478、源x969，B宽957、源x4；epoch37/gen12后A宽957、源x4，B宽478、源x969。客户端A始终在左/B始终在右，两video ready且clip与输入层相等，目视A蓝/B橙没有串窗。交换后B点击150.00006,450通过；A首个点击没有fixture回报，不计这一次A输入通过。此前各窗输入已有独立证据。
- **metadata晚到**：157稳态30条frame metadata各延迟150ms；1.5秒94次采样，两video始终ready/opacity1，没有反复隐藏。没有逐帧截图测量真实屏幕闪烁；DOM隐藏检查与前后目视截图一致。单静态源首条frame metadata延迟180ms后可恢复匹配RTP，后续静态画面保持可见；有界media.refresh共3次。
- **重连与实际PCM**：157已有440/880Hz远程音源时reload Viewer，新video身份重新匹配并恢复，post-gate PCM两侧RMS约0.056；Control保存双关后严格0，再开约0.056。89同样实际PCM约0.056，保存双关并reload仍严格0，再开恢复约0.056。89最终PCM和媒体入口检查另存metrics。此处是短组功能检查，不是AV长期同步/网络gap验收。
- **文件共存**：157窄屏video+实际音频播放时，从远程真实网页触发自定义chooser，选择并确认`video-共存.txt`，Browser页面读到25字节、精确内容`video coexist exact α\n42`。完成后video ready、实际PCM继续约0.056。没有重跑此前全部上传/相机矩阵。

## 发现并修复：静态resize空layout

复现步骤：157 focused A，1440×900打开`http://127.0.0.1:33272/?label=A&static=1&test=late-first`（fixture只有首帧，没有持续rAF）；resize1100×760并等待ready成功，可选点击200,450；随后resize390×844。超过30秒仍显示“正在恢复页面…”。远程网页title/geometry已经390×756，Control activeWindow正确且tab为live，客户端canvas也为390×756，但DC最新layout为epoch30/generation0/16×16/views[]，prepare23已ACK，videoPlanes为空。相同390×844直接导航动态fixture后恢复epoch32/generation10。

证据：`157-resize`、`157-narrow-stalled` metrics；`inspect-stalled.json`；`157-narrow-stalled.png`；fixture-events的1100×672→390×756几何。root收到精确证据后交`static_resize_recovery` owner调查；未用旧纹理重贴新epoch规避。

补已有output.status只读诊断后，精确静态1440→1100点击→390单次未复现（2秒epoch26/gen7已ready）。按root新增预算恢复split→focused→首metadata延迟180ms静态导航→1100点击→390前置，完成2次均未复现（epoch37/gen11、epoch53/gen19）。`static-diag-inspect-2s.json`、`static-full-{1,2}-inspect-2s.json`、`diagnostic-service*.log`保存；第3次因root找到源码原因而取消。这些未复现不视为修复，也不覆盖原真实失败。

owner发现失败capture没有结算oracle pending，静态refresh会因此阻塞；0007修复为每个RecordCapture统一恰一次CompleteCapture，包括取消/失败，Browser已增量构建。修复后只做一次原完整前置定向组，390×844两秒内epoch28/gen10/views1/video ready。`static-fixed-inspect-2s.json`本代frame_id2/captured2/capture_callbacks3，capture_to_atlas active400×768、direct_frames2、error空；截图`static-full-fixed-2s.png`已目视。真实组没有主动制造GPU取消，也没有证明原偶发故障必然被触发；生产delivery+真实Oracle的3个CPU故障注入回归由owner另证，不能把两类证据混为一谈。

## 视觉检查与截图

Sol6.1已直接打开并目视157 split、390窄屏、89 split：A蓝/B橙独立内容正确，工具栏与视频内容边界对应，无原生video controls/PiP入口，窄屏可读无Viewer横向溢出。首组fixture遗漏charset导致符号乱码，已修fixture并重新截图，以下使用修正后的真实Viewer截图。89 fixture输入结果长JSON会令远程网页自身横向滚动，这不属于Viewer布局错位。

- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/157-split.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/157-narrow.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/157-narrow-b.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/157-single-static-late.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/157-dpr2-quality.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/89-split.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/157-weights-2-1.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/default-video-qa/static-full-fixed-2s.png`

## 证据边界与清理

本报告没有代替Native 12套CPU、Control179项模型/生产构建结果；那些由实现owner/root报告。真实运行未覆盖隐藏页rAF停顿后的canvas fallback竞态、旧peer伪造ACK、网络音频gap、实体相机/设备触控或长期AV同步。157的真实触控来自CDP注入，不能宣称实体触屏验收。

全部自有157/89 contexts已关闭，fixture `/shutdown`成功；主组session59500、诊断session70639与41428、修复回归session81220均退出0，GPU已向root释放。未修改产品源码，未commit/push。静态resize修复后最小定向复验已完成，未重复独立已通过功能组。
