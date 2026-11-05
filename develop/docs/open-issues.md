# 当前问题与收尾记录

## 搜索框软键盘循环（2026-11-05）

- KEYBOARD-3（基础与移动IME模拟通过，实体设备待验）：用户确认Google二次搜索/Bili顶部搜索第一次点开即偶发循环。真实RTC可控搜索页基线一次触控触发7次模拟键盘尺寸往返；Client已分离键盘意图与严格IME target，重写几何分类及VV/RO过渡，同文档节点替换不主动blur/reopen，持续NONE关闭，旧文本不跨target。35项定向、生产构建与157/89真实RTC首击替换/继续输入/持续blur通过。157 mobile/DPR2/229/CDP候选与交错视口模拟也重现旧版、修后保焦，旧commit零包、新composition成功，系统收起不自动重弹且可信show可恢复。不是实体键盘已验收。[证据与边界](keyboard-search-investigation-20261105.md)。
- GOOGLE-INPUT-REPRO（复现阻碍，未修）：本轮Google搜索结果页可显示，但可信触控明确收到`Renderer widget required`，鼠标对照也未取得editable，故不能核对用户Google键盘循环的真实起点。Bili顶栏可进入编辑，本次6秒对照没有循环。本批不猜测或绕过缺失的原生输入路径。

## 后续本地筛选（2026-11-05）

交付774805来自干净提交`002aab5`；包内启动、571项ZIP文件校验及Chrome89真实H.264/resize同连接功能通过，2026-11-05 07:17（UTC+8）上传确认成功。[交付记录](ud710-optimization-delivery-20261105.md)。

- MOBILE-PACING（本地改善，生产待验）：保留原生ALR factor1.1；同组基线→候选→返回基线marker p95首段299→171→359ms、第二段174→146→180ms，提交约46–47FPS及低FPS停稳质量保持。1.5虽然降marker，但明显增加丢包/RTX/RTT，已从代码撤回。接收等待仍有约50ms，100ms总体目标及UD710现场未验收。[证据](ud710-pacing-20261105.md)。
- MOBILE-CANDIDATES：LowDelayBRC与I=5T/P=2T分别因低FPS画质退化撤回，0/10ms接收预算因提交FPS下降15–17%且marker未改善拒绝。保留实际QSV码控读回诊断，两个失败硬件策略不留产品开关；默认接收仍0/50。纯诊断版本质量、QSV硬件与定向归档检查通过。未宣称达到100ms或完成UD710生产验收。[完整取舍](ud710-followup-20261105.md)。

## 移动端低RTT卡顿与诊断（2026-11-04，已交付761470）

- MOBILE-LAG（待定位）：UD710、Brave138、惯性滚动截图中RTT15ms，接收缓冲均值303.2ms，末包到Video提交p95 335.5ms，解码45.2FPS而提交29.1FPS。低RTT/高带宽估计不能排除帧到达抖动或重传，单次截图也不能证明硬件解码瓶颈。新增接收组帧/目标缓冲、音频缓冲、RTX以及逐帧呈现时序，已收到实际连续包，结果见下项MOBILE-PACER；不宣称已修复。[调查](mobile-receiver-diagnostics-20261104.md)。
- MOBILE-PACER（本地改善，生产待验）：实体包发送排队1.3–1.8秒，后续另有接收积压。本地复现低RTT下发送窗口270ms；仅撤销可信码控声明效果不充分。最终恢复原生超发保护，并对QSV观测FPS去抖、真实时基变化才新序列；新序列17→4，首段发送均值72→39ms、marker p95 463→282ms，低FPS停稳画质接近原版。CBR、固定60FPS和BRC-only实验均未采用。接收侧尾延迟、100ms目标和UD710生产网络仍未解决/验收；maxFps上调不一定触发新Configure，名义恢复上限仍是最近配置值。[本地实验](ud710-local-repro-20261104.md) · [实体分析](ud710-diagnostic-analysis-20261104.md)。
- MOBILE-AV-ISOLATION（四组已测，根因仍未确认）：首对有音频接收p95 270/90ms、无音频45/44ms，反序无读回仅50/61ms对44/48ms；不能认定音频为唯一根因。Viewer RAF约32Hz、解码54–57FPS，旧组RAF约53Hz，提交FPS不能跨组直接比较。QSV固定I150KB/P100KB限制在60FPS读回保留、2FPS清零，未进入产品。[实际结果](ud710-av-results-20261104.md)。
- DIAGNOSTIC-COLLECTION：按用户指定设置内开始、悬浮停止，Control保存tar.zst并返回ID。已接入授权和断线/锁屏中止、完成文件原子发布及重启查询。CPU定向、生产构建和157/89真实H.264收集/归档流程通过，媒体连接保持；157另通过Control重启后查询原ID。强制终止Control时未归档的内存样本可能丢失；已完成文件无自动保留期。[契约](../../docs/diagnostic-collection.md) · [运行](mobile-diagnostic-runtime-20261104.md)。
- DIAGNOSTIC-DELIVERY：用户重新授权上传，以干净dd6d850打包，包内启动与571个ZIP文件hash/CRC通过，包含此前全屏增量；21:13:04（北京时间）上传成功，取件码[761470](https://airportal.cn/761470/EXGZc1IoQx)。[交付](mobile-diagnostic-delivery-20261104.md)。

## Viewer与内部网页全屏（2026-11-04，随761470交付）

- FULLSCREEN：Control持久化自动外层全屏开关；内部网页全屏铺满Client且不调用外层Fullscreen API，按实例/文档快照恢复，支持悬浮退出与Esc。157/89真实内部链路通过，89外层真实成功。157的可信交互重试已发生，但原生API返回`TypeError: not granted`；本环境未验证外层成功，不以89结果覆盖。返回前台用合成focus/blur触发，实体移动设备待验收。原取消独立上传，现随761470交付。[运行记录](fullscreen-runtime-20261104.md)。

## 快速拍照与彩色扫描修订（2026-11-04，已交付306244）

- CAMERA-FLOW：162141横屏仍底部快门、contain小取景和独立检查照片页被用户否定。已改为全屏cover/同源裁剪、横屏右侧快门、相机模式与连续拍摄、文件篮内候选/重拍；简易态strip+发送/添加/更多三图标。157完整、最终窄组及DPR2平板触控模拟通过，89活跃远页组通过。三种平板尺寸取景铺满、横屏右侧快门；strip实测148px。实体Android相机/手持体验未测。[运行记录](camera-flow-qa-20261104.md)。
- CAMERA-SPEED：旧版逐帧JPEG压缩、所有整图逐块stop-and-wait上传后再排名。新路径只送512分析图，Endpoint按帧反馈保留/早停，采样≤1s/20个不同帧，最终保留帧PNG且4块窗口上传。实际设备帧率、可用像素和采样帧数须报告，不能把上限当硬件保证。
- SCAN-COLOR：扫描统一几何与保色增强，完整可信页透视、正文方向deskew或保持原几何；无四边不失败、不猜裁。Native合成弱字/彩字/阴影与2公开实拍通过保全检查，硬阴影仍可见窄光晕，弯书脊未展平。UVDoc改善行弧但截边标记8→1/0，故不接本批。[Native](photo-pipeline-native-20261104.md) · [UVDoc](document-unwarp-eval-20261104.md)。
- QSV-LOW-FPS-LEVEL（待修）：89静态远页组 `camera-flow-89-5` 在390px布局和文档选择退役期间，400×768编码器由2FPS降至1FPS、Reset返回-14；重建实际level50超出协商42而停止编码。peer/DC仍连接，media.refresh未恢复。原FILE-UNLOCK修复只解决Reset失败后的重建，未保证此驱动配置仍符合协商level。本轮相机改动未涉及媒体代码，89剩余功能在24×24变化的活跃远页复验通过，不计为静态恢复通过。证据：`develop/tmp/camera-flow-89-5/control.stderr.log`，后续媒体任务处理。
- CAMERA-DELIVERY：源码`3e7ad7a`已推送，干净包清单/CRC/hash及包内真实H.264窄组通过。20:01:28（UTC+8）上传成功，取件码[306244](https://airportal.cn/306244/AYeXJ2MWCd)，24小时/2次/无密码。[交付记录](camera-flow-delivery-20261104.md)。

## 文件库、文件篮与Endpoint拍照（2026-11-04，已交付162141）

- FILE-LIBRARY：文件字节按Session内SHA-256资产存储，Control持久目录/分组/有序篮子。原生回执绑定selection_id，成功才消费；版本校验阻止旧排序把已消费条目加回。157/89整链通过原生FileList哈希/顺序、分组、消费、重附着与锁定门禁。图片卡片整卡拖动、文件列表手柄与按钮、视图切换及触屏/键盘排序均已实测；预览裁切与列表提示修正后，最终包157整组和截图复核通过。[契约](../../docs/file-library-contract.md) · [运行记录](file-library-qa-20261104.md)。
- PHOTO-QUALITY：Endpoint OpenCV质量排序、近重复过滤、文档矫正与扫描增强已有合成模型测试；阈值为启发式，实体摄像头、运动和复杂光照效果未验收，不等同OCR或人像语义识别。
- FILE-ANCHOR：本次支持主框架真实文件input的可见裁剪区域，隐藏/失效回退紧凑Dialog。子框架坐标转换未纳入本批，使用Dialog；位置异步更新，不宣称物理显示帧同步。
- FILE-RECEIPT：Browser selected表示向原生监听器交付，不是网站完成上传。Browser在Endpoint观察之前丢失回执时结果保持unknown；无证据不消费或重放，相关引用继续保留。此前进程未确认Browser退出的原生暂存也继续计入配额。
- FILE-UNLOCK：本批运行暴露QSV低帧率Reset返回-14后编码线程退出，现排空任务后在原oneVPL session/device重建encode component并要求IDR。UHD630独立60→2→1→60 FPS及async VPP检查通过，修后157/89全链解锁恢复画面且peer/DC/轨道保持。[定位与硬件证据](file-unlock-investigation-20261104.md)。
- FILE-DELIVERY：功能源码7ab9b62已推送，干净源码包570项manifest、571个ZIP文件及11项人脸资产校验通过；包内157完整H.264/QSV与最终视觉复验通过。17:33:57（UTC+8）上传成功，取件码[162141](https://airportal.cn/162141/wiVzM0mMmp)，有效24小时、可下载2次。[交付记录](file-library-delivery-20261104.md)。

## 冷启动首帧与Video-only（2026-11-04，已推送，用户取消上传）

- FIRST-OPEN：用户确认新包冷启动首次客户端白屏，刷新恢复。自然冷启动本机通过；人为延后呈现ACK 4.5秒复现旧版零RTP时错误回退Canvas，未复现现场持续白屏。新版同条件保持Video，ACK后约84.6ms取得匹配帧，输入门禁和单peer/track保持。
- VIDEO-ONLY：按用户要求删除生产Canvas、MSTP和共享WebGL呈现后端与旧配置/诊断/实验原型。Endpoint必须收到Video协商和当前布局完整ACK才发布码流。能力/协议/播放错误明确提示；首帧或元数据迟到在原Video连接限频补帧。保留尺寸过渡快照、摄像头与测试读回。
- REFRESH-COMPLETE：刷新请求按peer/授权/布局/屏障绑定，只有标记的IDR通过屏障并成功发布才完成。源丢弃、发布失败不会消费请求；单请求在途、重试至多每秒一次，旧结果不能完成新请求。定向模型覆盖掉帧/迟到，真实157/89成功后pending=false且计数静止。
- 验证：Client 96项定向及生产构建/smoke，Endpoint Release增量与4项定向通过。157普通及延迟确认、89冷启动真实H264/QSV通过；本轮没有新增性能矩阵。源码`3a5df07`已推送，本地包清单/CRC/启动与真实Video/触控通过；按用户指示未上传。[修复与本地包](first-open-recovery-20261104.md) · [运行](osr-first-open-runtime-20261104.md)。

由root维护。最新交付见本页文件功能162141记录。此前源码433655d、取件码[861200](https://airportal.cn/861200/YnupKqRq8U)包含生命周期恢复、跨布局触控退役、Stats与接收端等待优化，并保留此前站点手动键盘、尺寸过渡、Comp选卡与锁定调整。[此前包内验收与上传](osr-lifecycle-delivery-20261104.md)。不重复历史性能组；旧全库审查依据见[审查报告](post-release-astra-review.md)。

## 152167 后生命周期、触控与延迟（2026-11-04，已交付861200）

- LIFE-2：已修逐RVH、绑定代次的真实ACK，冻结竞争确证后解冻保留JS堆；真正未知使用guarded unload→restore闭环，不重放未知导航。真实Browser同文档/慢跨站导航竞争、10秒超时/迟到ACK、稳定frozen renderer退出与恢复通过。导航导出跳过pending/uncertain。Control持久恢复/丢回执/restart/POST拒绝模型通过。[运行](osr-lifecycle-runtime-20261104.md)。
- TOUCH-5：已补精确账本、未路由撤回、早拒绝可靠回执及零坐标旧owner retirement。157真实双指部分抬起、屏蔽end回执后的查询/cleanup恢复、按住期间编码布局变化、重复旧retire不取消新触控通过，同peer/DC/video/track保持。普通坐标门禁不变；全tsc和24项touch测试通过。[运行与工具误判](touch-terminal-runtime-20261104.md)。
- PERF-OSR：已用真实Fence观察、wire RTP和input序号拆清链路，主要等待在receiver；无marker也有真实video丢帧。采用原生RTP min0/max50ms，严格同条件none窗口提交55.48→57.87FPS、丢帧58/1172→9/1170、末包→提交p95 78.5→50.4ms。sync45 marker p95 115→92ms；独立Worker组99ms，首击focus ACK27ms，18/18回显。未复现约1秒，不能宣称已解释用户所有现场；物理scanout未测。89默认video/可信touch兼容通过。[分段、口径与原始数据](osr-profile-runtime-20261104.md)。
- STATS-2：同窗区分解码、video元素/丢帧、compositor提交和rVFC，删除旧capture空白项，接入实测receiver分段；30项定向、生产构建和实际32项读数/无遮挡截图通过。不能以单次overlay截图代替性能窗口。
- DISPLAY-2：已实测本用户会话Disc→console和console→Disc，同UHD630/LUID的DXGI输出真实0→1→0。两组Browser/GPU PID及peer/track保持，60/60和25/25健康采样，无FATAL/CHECK/dump；移除后实际观察12.869秒。未复现此前偶发崩溃，未做物理拔插。[显示运行](osr-display-runtime-20261104.md)。

实现、原始证据与实验排程见[本轮记录](osr-latency-investigation-20261104.md)。本节按各自CPU、原生和实际串流范围列验收，不覆盖未测的用户设备与页面负载。

## 软键盘与尺寸过渡（2026-11-04，修复与运行验收完成）

- KEYBOARD-1：Chrome157真实H264基线中，模拟visualViewport从820逐段缩到625、520，输入代理产生可信focusout/focusin，过渡期间输入丢失，peer/DC/video身份未变。根因链包括reconfigure临时空layout、尚无有效元数据与stale像素被误报inactive，以及Browser布局失效结束composition。原始证据保留在`develop/tmp/keyboard-viewport-qa/baseline157c/keyboard-results.jsonl`，不等同实体软键盘验收。
- KEYBOARD-1已修复：媒体/坐标布局租约与编辑目标分开，保留原focus/input门禁，以稳定target绑定暂存与最终派发。明确reconfigure保留键盘，真实失焦、换目标/文档、锁定/断链仍撤销。键盘使用顶部保比例peek，普通布局使用最后帧模糊拉伸，旧帧不赋予输入ready。Control319项全量、最终16项定向与生产构建通过；Native构建及19项CTest完成。
- 157/89修后真实H264组通过不失焦、composition跨resize、恰一次commit、target切换/旧target拒绝、远端blur及媒体身份保持。157本地IME用CDP，89用合成CompositionEvent，远端均为Native。Sol6.1检查两版peek与过渡截图通过；普通动画终点未单独截图。571项包文件/ZIP、启动及包内真实H264/PIN/同peer检查通过，已交付137959。实体移动软键盘仍待验收。[运行证据](keyboard-viewport-runtime-20261104.md) · [交付](keyboard-viewport-delivery-20261104.md)。

## 兼容菜单与触控确认（2026-11-04，已交付152167）

- KEYBOARD-2：137959仍将visualViewport偏移计入可见矩形交集，键盘打开后平移也会改变远端DIP并触发重配。已改固定Viewer外壳按visualViewport宽高布局，offset仅移动；代理输入框顶端锚定，标签切换只滚动标签条。更多菜单改“网页兼容性处理”，按站点保存manualKeyboard，浮钮控制本地键盘，同目标手动隐藏不因resize重开。
- TOUCH-4：Endpoint对每个end同步等待终止，双指部分抬起也阻塞输入worker；Client入队即开始2秒计时、focus队列丢弃无反馈、终止回执可能在SDK BUSY或普通输入历史淘汰中丢失。已拆分queued/submitted/accepted/completed，Browser真实terminal判断与精确完成账本、Endpoint公平异步查询及可靠发送、Client原请求只读查询恢复。旧身份和未知结果不授予新输入资格，移除默认整页重连遮挡。
- 构建与CPU：Control333/333及生产smoke、Endpoint19/19、Browser/SDK增量通过。原生probe首轮发现刚完成记录按旧插入顺序过早淘汰，production ledger修正为按状态更新时间保留后原断言通过。[边界](keyboard-touch-compat-contract-20261104.md) · [构建](keyboard-touch-compat-build-20261104.md)。
- 真实157-run2/89-run3均通过新菜单/manual键盘单次提交、offset不改变远端DIP/epoch、可信双指部分抬起及远端滚动。屏蔽2250ms终止回执后各经四次原请求查询约3.75秒恢复，无重放、无重连提示，媒体身份保持。三次失败为弹层退出时序及新版Playwright调用89缺少API，原证据保留；Sol检查两版各6张截图无阻塞问题，实体移动键盘及更窄屏幕仍待验收。[运行记录](keyboard-touch-compat-runtime-20261104.md)。
- 571项包文件/ZIP、11项人脸资产、启动smoke及包内157同一套真实键盘触控回归通过，已上传152167。首包因MCP预检文件使manifest标dirty未发布，同功能源码清理自有临时输出后重打干净包。[交付记录](keyboard-touch-compat-delivery-20261104.md)。
- TOUCH-EDGE：原152167中raw路由前官方packet拒绝可留下canonical注册；本轮TOUCH-5已加入仅未路由注册撤回和候选状态回滚，受管0010及原生构建/probe通过，未知ACK仍不算完成。
- PACKAGE-DOC：本轮已将包内README初始屏black改为blank white，并修SDK导出manifest从实际公共头读取RTC ABI（4），避免旧硬编码3。861200包内校验通过。

## 高级认证（2026-11-04，已交付316234）

- AUTH-1：空白锁屏、方向序列、密码/PIN及设置、Control/Endpoint产品权限门禁已实现。新Viewer默认锁定，序列仅揭示验证入口；旧输入/操作/媒体工作按授权代次退休。Control314项及后续transport17项、Endpoint19项、SDK/RTC/audio smoke通过。修后157/89核心7项断言均通过，同peer/DC/track锁定和密码/PIN恢复、锁下产品state及媒体截止、过期输入/产品操作拒绝均有实际证据。
- AUTH-2：同peer独立认证DataChannel传送原尺寸RGB24，Endpoint协商/授予5fps取帧；SDK RTC ABI4、YuNet/SFace与MiniFASNet V1SE/V2 ONNX及静态OpenCV已构建。157/89实际各5完整帧及取消停发通过；官方T1合成摄像头另通过3帧登记、AES-GCM模板、锁下匹配解锁及空帧离开锁定，未替代真人活体验收。ONNX数值等价通过；LFW全6,000对识别准确率81.07%，双方特征可用4,130对为95.62%，未观测到异人误接受，实体摄像头/防伪效果未验收。原始画面不落盘，模板由Control加密持久化。[评测](face-public-benchmark-20261104.md)。
- AUTH-3：浏览器系统锁定/闲置、页面后台及Endpoint人脸缺席是独立信号，不能把visibilitychange当物理关屏；89真实15秒页面闲置锁定通过。两版第二tab未产生可信hidden，真实后台、系统/物理关屏与实体摄像头仍待验收。具体边界见[实施契约](advanced-auth-contract-20261104.md)。
- AUTH-4：已修复。CDB明确定位RenderChannel析构时调用disconnected回调，重入正在销毁的OsrRenderer::State，shared_from_this触发bad_weak_ptr并以0xC0000409退出。析构先撤销回调再关闭watcher/pipe，存活通道的正常断链通知保持；新增生产Mojo生命周期probe通过。修后157/89及合成人脸组三组各单一Browser PID，无replacement/FATAL/CHECK/GPU退出，原连接保持。初次失败与符号堆栈保留于[运行记录](advanced-auth-runtime-20261104.md)。
- AUTH-5：已修复。首登RTC未就绪时“新建窗口”误报已锁定；增加Endpoint授权代次、产品DataChannel及状态快照就绪门禁，定向测试及157真实首次连接检查通过。
- AUTH-DELIVERY：源码ba667bf已提交推送，干净源码包571项manifest/ZIP及11项人脸资产校验、启动/模型可用和独立包内H264/锁屏/PIN同peer/DC检查通过。已于08:09上传[316234](https://airportal.cn/316234/d99cU47GIx)，详见[交付记录](advanced-auth-delivery-20261104.md)。

## Wake优先发帧（2026-11-04，源码完成，本次高级认证包包含）

- RENDER-3：旧实现只在轮询发现Wake时清除deadline，SDK callback不能中断Comp的timer等待，且未发送成功的Begin也会推进一个帧间隔。现以每代独立Windows事件唤醒Comp，入队/Signal与出队/Reset共用锁；输出暂停时不等待未消费的事件，旧代事件不唤醒当前代。合法Wake的优先请求保留到Begin实际发送，Slot占满或SDK_BUSY不会消耗它，Stop/换代取消，零码率/FPS及产品可见性门禁保持。
- 验证：Endpoint Release增量构建通过；生产CompBeginSchedule/CompPacing和RenderEventQueue两项CTest通过，覆盖提前到期、Slot饱和/BUSY、发送后周期、零rate/Stop/旧代，以及实际Windows事件对长timer的唤醒、预先Signal、drain后重新入队和代隔离。当时未追加真实GPU/浏览器组，也未单独发布；后续高级认证功能组使用包含该增量的产物，但没有测量Wake唤醒延迟。

## Comp / Rend重构（2026-11-04，已交付352318）

- RENDER-1：Comp Slot Begin、Reject/真实Fence、FIFO Stop/Stopped及Idle/Wake已实现。迟到Begin清除Idle证明、跨通道关闭未排空及多出口未退休已修复；CPU及157/89真实组通过，单次尾IDR/Wake正确，29个旧代全部退休，无unknown GPU retention。
- RENDER-2：专用OSR OutputDevice与多plane GPU合成已构建并在UHD630通过首帧、双Window画面/输入、resize/focus/导航检查；默认video且组内RTC/track/video身份保持，无FATAL/CHECK/GPU退出。
- RTC-1：WebRTC原生source adaptation、screenshare BALANCED/scaler、SetRates到QSV时基及三档映射已实现；旧网络/DPR策略删除。实际质量热切换、QSV时基Reset后持续解码通过。短限速组GCC目标下降和部分恢复已观测，但未触发网络尺寸变化；10秒恢复未回基线。驱动192次正status5及目标码率改写仍为已记录硬件限制，不宣称请求值等于实际线上码率。
- RTC-2：157标准jitterBufferTarget与89兼容playoutDelayHint均实际读回0；89无标准属性。两版DPR/布局及ROI输入验收通过。
- DELIVERY：源码94cd174已提交推送；最终包560项manifest/ZIP、启动smoke及独立包内真实产品检查通过，已上传[352318](https://airportal.cn/352318/RGG7EQ9ZwD)。两处遗留诊断字串/注释清理后完成必要增量及SDK3项smoke；前一54ae4c2临时包未发布。详见[交付记录](comp-rend-delivery-20261104.md)，未重复旧性能矩阵。

前三次实际首帧组分别发现并修复：Browser残留output.open旧fps前置；第二IsolatedConnection在Chromium157 ipcz替换原Control；Windows真OSR配置缺少合法GPU调度scope。现在render MessagePipe通过原Control成功describe一次转交，token一次claim；0013仅在Windows真OSR的Display Configure/Begin/Finish使用现有ScopedAllowScheduleGpuTask，保留全局DCHECK及普通路径。对应生产probe/增量构建及第四次157/89功能组通过，前三次失败现场完整保留于[运行记录](comp-rend-runtime-20261103.md)。

2026-11-03进度：产品重构14859f6及工具修正1e13f11已提交推送，新streaming包通过startup、包内WebRTC操作、逐文件/ZIP校验后上传。跨机管理、DC常规操作/文件、收据同步、独立时钟、移动编辑/Client手势的契约和证据见[本轮架构记录](robustness-contract-20261103.md)。下列问题按对应源码、CPU和真实证据关闭；实体设备与尚未装配能力仍见当前状态，不能宣称整个浏览器无任何缺口。

## 467761新回归（70e4243源码修复；按用户要求仅测试、不发布）

- **V6 回退原因误报：** 截图canvas-2d/track-processor；unknown backendReason被叠层统一标成GL初始化失败。已在源码拆分Video首因与canvas后端原因，293项Control/生产构建及独立157实际能力回退标签检查通过，本次不发布。实际截图首因缺日志且用户无法再现，保持未知。
- **V7 hidden回退预算：** metadata watchdog未检查页面visibility及屏障完成，后台等待可能消耗失败预算。生产transport定向测试先证实后台/未ACK计时错误，已限制前台且屏障完成、有效bounds后才计预算；21项定向及全293项通过。实际headless标签切换未产生hidden，真实后台行为仍未覆盖，不能据此认定截图原因。
- **F5 当前请求为空时Viz完成：** 221813包Browser日志22:26:30.603，frame source2/seq5而current=none，GPU随后重启。源码发现MISSED与正常scheduler-client交付可重复接纳当前帧。0012按有效完整ID与不可变frame_time幂等接纳，保留原Mojo CHECK/Fence；增量、正向生命周期、12补丁可逆及89/157正常运行无新fatal通过，本次不发布。

## 发布后阻断项（2026-11-03 06:54日志）

11299d9修复包已实际上传：[467761](https://airportal.cn/467761/ojJvgTbRL9)。新包560文件及ZIP校验通过，包内实际WebRTC、设备枚举与双声道PCM再次通过，Browser身份稳定、无FATAL/CHECK。完整交付记录见当前状态；旧353287不能当修复包。

- **A1 音频服务设备枚举致命退出：已修复并发布467761。** 自定义AudioManager实际强制进程内服务，但默认AudioServiceOutOfProcess feature仍使Windows设备监听走远程DeviceNotifier，触发断言。已修正式Browser服务放置配置的一致性并完成增量构建；89/157播放前10次及播放中1次实际枚举、Viewer双声道PCM通过，Browser未重启。
- **F4 Viz同步当前帧完成致命退出：已修复并发布467761。** IssueExternalBeginFrame先广播再安装callback，当前frame ID匹配但callback为空；旧0011仅覆盖退役完成。已先安装事务并在接纳阶段延迟终态派发；真实production source同步完成/sink注册/重入正例通过，6项负例保持CHECK。89/157真实resize/导航及Google页运行通过，约271秒仅一次Browser启动，无FATAL/CHECK。
- **L1 RPC故障到Browser重建边界：独立缺口保留。** 纯RTC断开路径不直接Stop Browser，但SDK请求非零会清control，随后Start可终止仍存活Browser。已确认普通业务ok:false不触发，SDK传输超时会退役通道，Browser当前为一次性监听；需要独立的同incarnation重附着契约，不能直接重用失效handle或重放未知mutation。本次实际故障有明确致命退出证据；该独立问题保留，未将修复两处崩溃声称为IPC恢复已完善。

证据：[构建/原生probe](loopback-hotfix-build-20261103.md)、[89/157真实运行](loopback-crash-runtime-qa-20261103.md)。后者保留首次点击播放未生效、QA错误关闭码和几何取整等失败尝试，不能称所有输入边缘都已覆盖。

## 本批运行发现与待验收项

| 项目 | 当前证据与进度 |
|---|---|
| V4 split长时白屏 | 布局候选缺clientGestures而已发布layout含该字段，每Tick误判变化；2.375秒重复1000次prepare，Client反复取消两rAF导致ACK饥饿。已修完整布局比较及两端事务幂等；157/DPR2原场景实际复验580ms恢复，两plane裁剪正确，无flood |
| V5 窄屏误退canvas | 隐藏旧Window current=false却累计retry到3触发全局fallback。已修watchdog仅统计当前有效未ready plane；定向/生产构建及89/DPR1、157/DPR2实际split→1100→390约6秒→split通过，隐藏重试0、可见ready、返回各自新帧/坐标正确，媒体身份保持且稳态MSTP/draw0 |
| S1 快照组合字节上限 | 已限制最终URL字节与accept提示预算；Browser响应超限改有界语义错误而非关闭健康通道。Control、Browser真实生产helper probe与Endpoint语义错误回归通过；不宣称任意巨型页面状态已支持分页 |
| N1 首导航失败遮蔽错误页 | 已分开真实primary documentCommitted与failed收据；已提交仍remote，未提交回start并hide-only残留Native。CPU、生产构建及89/157实际错误页/首导航取消恢复通过 |
| N2 receipt被当workspace解包 | 已收紧receipt类型并去掉state.workspace读取，pending/unknown语义保留。CPU/构建及157实际前进后退无原异常banner通过 |
| N3 Browser错误文档空白 | 已补embedder PrepareErrorPage静态中文HTML，动态文本转义、无JS/外部资源；生产helper/构建及Astra设计审阅通过，Sol实际89/157错误页标题/URL/net错误可读、remote+rejected正确 |
| N4 start首导航stop丢回滚归属 | stop保留独立收据、不占原导航owner；即时终态同步活动对象，finally不回退applying。明确回start清loading。CPU/构建及89/157真实首导航stop回start/Native隐藏通过；最后157补验loading=false、stop按钮0/refresh1/progressbar0，无SDK5重试，remote stop保留原URL |
| G1 首tap致命退出 | 已修生产候选touchscreen设备类型，probe实际执行filter输出→Blink转换；157首tap真实复验恰一次click、terminal processed通过 |
| G2 拖动转惯性丢位移 | production ScrollPredictor CPU与真实轨迹证明服务端二次预测在相位转换时丢/增尾差。正式离屏Browser固定关闭该重采样，保留原始事件/权限仲裁且不影响demo/Viewer。默认新产物DOM510对Client509.815，延迟轨迹510/509/510通过 |
| F1 Viz BeginFrame完成时序 | 已用真实Scheduler/Mojo CPU复现早NAK留下的旧interval完成污染新callback；0011只接受精确退役ID，有界8项满则背压，保留未知/重复完成CHECK。生产构建、正反例及11补丁撤回/重放通过；最新89/157常规手势组无此前CHECK/GPU崩溃/Browser重启 |
| F2 Native输入未来时间 | arrival fallback首包原点叠加后包source elapsed产生约57ms未来时间。已分离source elapsed与非未来、非递减Native dispatch timestamp，生产helper/probe通过；新版89/157延迟轨迹位移一致且未出现旧reporter断言 |
| G3 child销毁后输入锁定 | 已修有界精确token+sequence退役证明，未知/超时仍unconfirmed，正常cancel仍等canonical ACK。279项Control/原生构建通过；89/157真实owned child销毁→明确invalidated→同doc新tap通过、无误投及遮罩，旧回执不清新held owner |
| F3 正常停止丢弃未交付atlas帧 | 已修StopAndResetConsumer跨Mojo pipe丢排队帧：正常退役转drainer，仅对producer实际写完但应用未读帧Done；已交付lease保留consumed Fence、未知断开仍隔离。生产构建、真实Mojo5例/池13项及11补丁撤回重放通过；89/157专项自然generation1→17无atlas fatal/CHECK/重启 |
| 新路径功能覆盖 | 规定范围验收完成：89/157布局/文档失效、触控/滚轮/scrollbar、bounds与DPR坐标、无原生媒体入口；双Tenant管理断链保持媒体；DC文件/拍照字节、实际PCM、搜索持久化、模拟IME/键盘resize；真实popup opener/关闭、Sol清洁效果图。实体移动键盘/NVIDIA/真实摄像头效果仍是明确硬件边界，见当前状态与各运行报告 |
| P1 发布smoke契约过期 | 1e13f11已同步CLI startup/auth/assets/WS/clock及拒绝旧产品入口，修复父子Unicode失败证据；新包startup通过。独立包内host-managed WebRTC真实建窗/导航/点击/wheel、默认video及包内Browser路径通过；560逐文件hash与ZIP CRC/hash通过，已上传353287 |

## 8423204发布后输入与video回归

此前默认video验收覆盖点击坐标，未覆盖连续滚轮和真实滚动条拖拽，不能据此声称输入全面通过。root承担方案审阅和验收范围不足的责任。

| 项目 | 证据、决策与进度 |
|---|---|
| V3 focus/导航看似重连 | 89/157旧版实际peer/connectionId/track不变，但video与srcObject反复重建。根因是React注册effect依赖surface对象。改为可见viewport稳定持有renderer/video；focus仅更新输入身份，document/epoch改变仍隐藏并验证新ACK和该元素自身RTP。Control182项/生产构建与89/157连续运行通过，focus/导航/resize均保持媒体身份 |
| I1 滚轮无效 | 存在焦点和派发两个缺口。Client补ensureInputFocus/非passive监听后，实测仍是input.result ok而DOM无wheel。根因是直接RouteMouseWheelEvent的phase=None，router未建立hit-test目标。已复用Aura已有MouseWheelPhaseHandler补begin/sequence/end再路由。89/157实际失焦、burst、间隔重开、nested、跨窗、resize/reload后wheel均通过；不能把AcceptInput成功当网页消费 |
| I2 原生scrollbar拖拽取消 | Browser把move的changed-button=0直接转成Blink NoButton，Chromium主线程和compositor均据此取消drag。adapter现从held modifiers生成move.button，down/up保留changed button语义；7项编译期断言与Browser增量通过，89/157均实际页面scrollY 0→2739、nested 0→903 |
| D1 多video是否重复解码 | Chromium157源码确认同remote track共享receive stream decoder，解码后VideoFrame分发给各sink；每元素仍有独立player/compositor及可能的转换成本。不能相加各元素webkitDecodedFrameCount声称重复物理解码，亦不把157源码结论扩写成所有浏览器保证 |

## 首版后修复

| 项目 | 决策与进度 |
|---|---|
| R1 多页恢复阻塞全部Tenant | 改为主dispatcher拥有的有界恢复状态机；stdin只入队，定时维护推进，无请求也能完成；ensure不等导航完成。已完成，定向检查通过 |
| R2 旧token注销踢掉新Viewer | lease绑定认证token哈希；撤销只影响同token，执行排队请求时再验身份。22项相关测试通过 |
| R3 恢复文件漏同文档/PageState变化 | Browser navigation revision、export对应revision；重启清缓存。与R1一起实施 |
| R4 atlas轴/面积/布局限制不一致 | 统一确定性PlanAtlas与共享跨层fixture，真实DIP不变；DPR可低于1，物理尺寸与逻辑extent分开。已完成，定向检查通过 |
| R5 时钟reset使feedback序号回退 | 测量reset保留反馈流序号和已见source身份；首个有效反馈立即接受。9项相关测试通过 |
| R6 Browser关闭墓碑无限进入snapshot | Endpoint durable落盘后幂等ACK Browser完整墓碑；保留当前Browser compact closed-ID集合防旧ID复活，不声称集合常量空间。已完成，定向检查通过 |
| V1 回复跨Browser身份 | 已用模型确认PID/局部数字复用无法保护；增加browserIncarnation及实例/文档/请求绑定，回复不能启动Browser。已完成，定向检查通过 |
| V2 离线缺页误判关闭完成 | 模型已复现Tab误删；关闭只认明确事件/状态/完成响应，离线或换代取消旧待确认请求并保留Tab。已完成，定向检查通过 |

几何切换采用原子viewConfigs事务；横竖最终各自可行而中间max超限的场景真实通过。Control全117项、原生9项CPU suites、Browser/SDK/Endpoint增量和恢复/ACK/几何定向检查通过。审查复核的viewport拒绝提示也已补齐。最终证据：recovery-regression/1793556577736431200、browser-close-ack/1793556555694229500、geometry-regression/1793556819560716400。

## 保留调查项

- 完整gn check曾因Browser/SDK私有头可见性失败；实际编译链接通过。后续明确合理依赖或局部nogncheck理由，不扩大全局可见性。
- 显式实验alignment1旧路径边缘偏绿尚未定位；产品默认使用已验证alignment16。
- ApplyView配置已生效后持久化/恢复失败的事务补偿已修复：保留已提交desired，后台及同参请求重试；故障注入通过。

## 已关闭的早期问题

GPU故障同RTC恢复、逐代retirement终点证明及最后native ref释放后trace访问问题均已有实现与相应记录。旧清单的空布局问题不沿用旧结论，由当前关闭/生命周期检查覆盖。

旧legacy迁移质量模式线索未获足够证据，不列为确认bug。多Profile、跨Browser sessionStorage等保留功能差距统一在正式当前状态中维护。
