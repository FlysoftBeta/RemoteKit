# 多平面共享WebGL实现与真实联调

2026-11-02，Sol。按root选择集成；[原生产基线](viewer-presentation-baseline.md)与[同流候选对照](viewer-presentation-candidates.md)是前一阶段，不能将其4.2采样尺寸与本轮5.2完整尺寸拼成FPS收益。此轮仅功能检查，没有追加旧性能矩阵。

## 实现

`shared-plane-renderer.ts`以一张可复用atlas texture、一个透明共享canvas呈现多个有效plane；原每plane canvas保留几何、pointer capture与输入命中，提交成功后用opacity隐藏其旧像素。共享canvas只画实际内容ROI，pointer-events:none、z1；stats z6、page overlay z4、MUI portal仍在上层，分隔/工具栏不会被不透明atlas背景覆盖。

Transport保留MSTP/fifo2、不可变frame owner及严格wire RTP/layout epoch/resource generation校验。只有GL upload/draw成功后更新`paintedPlanes`和每plane presentation；Marker从实际shared canvas的ROI取像素，不读取隐藏2D冒充显示。drawingBuffer保留，异步采样仍可读当前已提交的真实像素；后续RTP替换后旧presentation getter失效。

共享画布按实际CSS内容位置及采样密度计算，最大8192边、8Mi像素且受GL设备上限限制；每plane ROI独立映射，非等比静态CSS resize有独立`pixelsPerDip`/`pixelsPerDipY`。ROI引用不重复应用DPR。ResizeObserver只重画保留texture，同RTP增加redraw、不增加unique FPS；布局变代、隐藏、卸载和关闭清理共享资源。没有额外持有一组VideoFrame或每plane texture。

>=2个不同有效view且有WebGL2时自动尝试，单plane、重复view注册、89或无能力仍2D。context创建/上传/绘制错误及contextlost停用本连接shared backend，先撤共享canvas、恢复原canvas opacity，再从当前有效MSTP owner或授权atlas立即2D重画。无可用source时只向当前peer开放DC请求一次有界`media.refresh`；客户端/Endpoint均限频约1秒，Endpoint复用缓存刷新/IDR路径，不改输入资格、不逐帧发送。此连接不会循环重试失败GL。

诊断新增backend、shared upload/draw、2D draw/atlas copy、refresh次数，以及metadata读取缺失、阻塞schedule尝试、drop原因、read→authorize与RAF wait有界分位数。read→authorize包含FIFO/RAF，不能称作DC单阶段延迟。Stats显示“绘制 FPS”，计数终点为unique canvas draw提交、不是物理屏幕刷新。质量限制与实际编码FPS上限也由Endpoint字段解释。

## 实际验证

服务`127.0.0.1:33271/33272`，独立数据`develop/tmp/shared-presentation-qa`；新Browser/SDK out/dev、新Release Endpoint package，157.0.8103.15 headless/fake60、89.0.4389.90 headless。没有接收端桌面窗口/RDP显示链验收。所有自有contexts/Control/Endpoint/Browser已关；宿主Playwright已正常关闭并向touch agent交还，后续未再操作浏览器。

| 检查 | 实际结果 |
|---|---|
| 正常生产trickle | 修复tenant信令路由后成功。一次记录从peer尝试起offer69.3ms、answer96.0ms、ICE113.9ms、DC124.8ms、decoded1103.2ms、authorized1178.2ms、canvas1193.4ms。此例是同隔离数据冷恢复源，不能当已运行源的平均值/p95 |
| 实际level5.2 | getStats codec=`42e034`、Endpoint actualLevel52、真实framesDecoded467；不是仅decoder能力probe |
| 双plane | 自动shared-webgl，736×1648源/编码/视频，mediaScale1；两个独立ROI，实际shared像素解出CRC Marker |
| 四plane、ClientScale1.5 | source=encoded/video **2912×1632**、mediaScale1，每plane714×1620。四个shared ROI均CRC有效，pixelsPerDip1.5。不是完整4K验证，4K由后续专门QA负责 |
| 静态contextlost，有保留owner | 原RTP156981940立即恢复4个2D source，unique frames不变、各redraw+1；shared canvas移除、opacity恢复，media.refresh次数0 |
| 静态contextlost，无保留owner | 测试主动closeLatestProcessorFrame模拟source不可用；一次media.refresh令RTP4090343525→4093824005，4个真实2D source恢复、请求次数恰为1 |
| 静态非等比CSS resize | 只改首plane canvas CSS宽95%，RTP4090343525不变、各unique frames不变/redraw+1；实际ROI714×1704、scaleX1.5/scaleY1.57778，CRC Marker有效 |
| stats、更多、设置层级 | 4个stats在共享画面上，menu/设置正常交互，dialogContainsHit=true；已等待MUI过渡完成拍稳定截图，Dialog完整不透明、无共享画面盖住控件 |
| Chrome89 | video/2D，shared canvas数量0；新白名单实际选择chrome89-h264-42，真实1980×1110 FFmpeg解码4帧。前一基线Headless UA落native的问题已由接收策略代理修复，不继续沿用其旧结论 |

Static test-pattern场景canvas仅在首render设内部分辨率，随后仅CSS缩放；跨源viewport变化后文字可能被fixture自身缩放，Marker为独立固定DIP画布，不依赖scene文字的比例。此轮验证的共享ROI、Marker与DOM层级按实际值判断，不把fixture文字观感当编码画质评分。

本次初次新native接入遇到tenant路由bug：原生`FlushSignals`用内部数字Session ID作为tenant，Control正确鉴权后丢弃answer/ICE，连续约15秒答复超时。代理修复并仅重编Endpoint后生产trickle复验通过。中间full-gather仅用于隔离问题，不能计作trickle通过；这15秒失败属于本轮联调回归，**不是旧版连接基线**。失败摘要与early snapshot独立保存。

## 证据与检查

`develop/tmp/shared-presentation-qa/metrics/client-metrics.jsonl`含带类型的真实检查记录；四plane Marker/尺寸、trickle阶段、两种contextlost与静态resize均已落盘。稳定截图：`four-shared-menu-stable.png`、`four-shared-settings-stable.png`；另有`dual-stats.png`、`four-static-stats.png`、`chrome89-four-2d.png`。带`-stable`者用于最终视觉判断，先前刚打开MUI时的截图处于过渡中。

57项相关测试通过：2D旧geometry/epoch/duplicate输入守卫、MSTP/FIFO owner生命周期、shared geometry/resize/contextlost/上传失败、保留owner回退与peer-bound refresh、Marker worker有界所有权及fractional ROI同步规范化。TypeScript检查通过。两次客户端生产build+startup smoke通过。

最后检查补强了WebGL2能力/重复view门禁并恢复2D单renderer静态remount语义；针对旧2D/MSTP套件实际修复了5个回归，57项随后全过。另新增“绘制FPS”文案、编码FPS上限、fractional Worker ROI规范化后交统一最终构建；没有再做性能组。fractional Worker分支为模型测试，真实browser的Marker验证使用实际shared ROI同步读CRC。最终统一构建与打包由connection_quality代理/root负责，本文不冒充最终包验收。
