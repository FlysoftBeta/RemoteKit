# RemoteKit当前状态

更新：2026-11-05。Windows x64；Chromium官方157.0.8103.15，基线`1aa07b638799e59656559ae6c6649d4b197f555e`。复用out/dev、out/rel增量构建，继续支持Chrome89。

## 后续多轮筛选与保留项

最终保留原生screenshare pacing factor 1.1，仅在没有显式冲突trial时设置，GCC继续管理目标码率。相同输入的基线→1.1→返回基线，首段marker p95为299→171→359ms，第二段174→146→180ms；发送队列均值49.4→23.2→57.6ms及20.7→12.4→20.7ms，提交约46–47FPS保持。2/15Hz停稳质量通过。接收等待仍略高，尚未达到100ms目标；1.5因明显丢包/RTX/RTT代价已撤回，不留产品开关。[发送实验与边界](../develop/docs/ud710-pacing-20261105.md)。

真实UHD630实验拒绝三个候选：LowDelayBRC令2/15Hz停稳MAE约2→20；按名义时基计算I=5T/P=2T令15Hz MAE2.01→3.46；接收0/10ms虽把末包→提交p95约40→18ms，却令提交45→38FPS、marker无改善。两个硬件策略均已从产品代码撤回，不留开关；接收默认仍0/50。保留驱动实际码控参数诊断、旧时基读回预算清理和实验运行时DLL校验。纯诊断版本低FPS质量、尾IDR、真实QSV smoke及定向归档检查通过。[本轮记录](../develop/docs/ud710-followup-20261105.md)。

干净提交`002aab5`成品已上传，取件码[774805](https://airportal.cn/774805/uFqAoQNWrJ)，2026-11-05 07:17（UTC+8）确认成功，有效24小时、2次、无密码。571个ZIP文件逐项hash/CRC、包内启动及Chrome89真实H.264/尺寸切换同连接检查通过。[交付记录](../develop/docs/ud710-optimization-delivery-20261105.md)。空白Viewer校准50–53FPS没有复现早前串流组32Hz；最终pacing同组RAF约54Hz，不能把跨组提交FPS差异简单归因于编码变更。

## 后续音频隔离与硬件预算实验

已完成四个串行70秒音频有/无实验：首对有音频末包→提交p95 270/90ms、无音频45/44ms；反序无像素读回组分别50/61ms与44/48ms，未稳定复现大差异，不能认定音频为唯一根因。四组Viewer RAF约32Hz、解码54–57FPS，不能与此前约53Hz组直接比较提交FPS。补齐SDK音频发送统计，CRC及帧时间核对146/146、150/150通过，真实归档与同连接验证完成。[实际结果](../develop/docs/ud710-av-results-20261104.md) · [条件与执行](../develop/docs/ud710-av-experiment-20261104.md)。

独立QSV探针在60FPS下接受I150KB/P100KB限制，2FPS下驱动将它们清零；未采用固定限制，未声称实际AU/质量/时延已改善。本地d275b28成品不包含音频统计扩展；其上传已按用户指令终止。

## 最新本地修复（QSV时基与发送积压）

已用UHD630/QSV、1936×816、24Mbps/基础RTT10ms串行复现并比较。恢复WebRTC超发保护，QSV不再随每次观测FPS波动重配：持续明显降低才更新名义时基，恢复时一次回到Configure上限；原生网络适配、VBR及码率保持原职责。固定60FPS和BRC-only两条候选因低FPS画质退化均已撤回。Stats把错误的“GCC目标FPS”改为“输入FPS估计”；占位window/tab确认前禁用导航输入，防止身份替换时丢失草稿。

原版→最终本地首段发送队列均值72→39ms、窗口峰270→167ms，稀疏页面marker到video提交p95 463→282ms，提交44.56→44.79FPS；第二段marker p95 276→211ms，提交45.11→43.38FPS。全组QSV新序列17→4、尾IDR3/3完成。低FPS停稳画质恢复接近原版。接收缓冲仍波动、100ms目标未达到，不能将桌面结果当UD710/Brave138生产验收。SDK/Endpoint/Control定向构建检查、真实QSV smoke和Chrome89静态首帧/活动停止/resize同连接验证通过。[完整实验与范围](../develop/docs/ud710-local-repro-20261104.md)。

干净d275b28本地包`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-224459.zip`通过清单/ZIP/产物匹配和包内启动检查。23:19:43按用户要求在82%终止上传，没有取件码，不再重传。[本地包及停止记录](../develop/docs/ud710-cadence-delivery-20261104.md)。

## 上一交付（移动端卡顿诊断与全屏，761470）

用户UD710/Brave138惯性滚动截图显示RTT15ms，但接收缓冲均值303ms、末包到提交p95约336ms，解码45FPS而提交29FPS。尚不能排除网络或确认唯一瓶颈。新增同窗重传占比、组帧/处理/缓冲目标、音频缓冲与解码器观测；支持设置内开始诊断、悬浮停止、服务端tar.zst归档和客户端显示ID。包记录Client、Control、Endpoint/Browser的可用指标、逐帧时序、时钟、缺测及终止原因；不会把诊断设施当成卡顿已修复。[诊断流程](diagnostic-collection.md) · [现场与口径](../develop/docs/mobile-receiver-diagnostics-20261104.md)。

随后收到实体设备34.9秒诊断：前段实测发送包排队均值约1.3–1.8秒，之后另有接收末包到提交数百毫秒积压；解码均值12.6ms，不能将主要秒级延迟归因于纯解码。发现SDK可信码率控制声明与现场编码超发矛盾，QSV帧率变化/关键帧突发及音频同步进入调查。该次仅分析，后续本地修复见上节。[实际诊断分析](../develop/docs/ud710-diagnostic-analysis-20261104.md)。

定向模型/协议测试与Control生产构建、启动smoke通过；157/89真实H.264中设置开始→悬浮停止→服务端归档/ID显示通过，两组媒体连接保持，tar.zst解压核对包含真实收发及逐帧RTP关联数据。157另通过Control重启后同账户查询原ID；桌面无头与隔离mDNS配置的范围见[运行记录](../develop/docs/mobile-diagnostic-runtime-20261104.md)。未改原生编码或拥塞控制策略，未重跑性能矩阵，实体平板待采样。

用户重新授权上传后，以干净源码`dd6d850`打包；571个ZIP文件CRC/逐项hash、关键构建产物一致性及包内启动检查通过。2026-11-04 21:13:04（北京时间）上传成功，取件码[761470](https://airportal.cn/761470/EXGZc1IoQx)，有效24小时、2次、无密码。包名`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-205438.zip`，505528984 bytes，SHA256 `519c4a178bd4343f181425d76c84bfa3433734618c571d427a4afc11b5ea19a0`。[交付记录](../develop/docs/mobile-diagnostic-delivery-20261104.md)。

## 同包增量（Viewer自动全屏与内部网页全屏）

设置新增“打开或激活时全屏”，默认关闭并由Control持久保存。打开或回到Viewer时尝试外层全屏，浏览器手势限制导致失败则等待可信交互；主动退出后不立即抢回。远端网页Fullscreen API只使内容铺满整个Client，隐藏外壳与其他Window，不请求Client原生全屏；悬浮按钮、Esc或网页自身可退出。当前状态快照绑定Browser incarnation/instance/document，导航及连接生命周期清理或重新对账，沿用现有RTC与布局输入门禁。[契约](control-plane.zh-CN.md#viewer与网页全屏)。

Browser/SDK、Endpoint Release与Control生产构建通过，Endpoint定向CTest 1/1、Control定向69项通过。157/89真实H.264内部全屏、输入命中、网页退出、悬浮退出及导航恢复通过，157另通过Esc；同组peer/track/DC保持。89通过外层设置重载读回、无手势拒绝与可信交互重试成功。157外层确认hook在可信交互时调用API，但浏览器返回`TypeError: not granted`，未验证原生全屏成功。回前台事件使用合成focus/blur，实体移动设备未验收。证据见[运行记录](../develop/docs/fullscreen-runtime-20261104.md)与[构建记录](../develop/docs/fullscreen-build-20261104.md)。最初取消单独上传，现已随761470交付；下述306244不包含此增量。

## 最近交付（平板拍照与彩色扫描，306244）

用户实用反馈否定162141的拍照布局和三层流程：横屏快门难触达、取景被挤小、采样与上传串行造成等待、扫描依赖完整页边并丢色。现已重做全屏覆盖取景/侧边快门、相机配置和连续拍摄，取消独立检查照片页，拍后在紧凑文件篮strip中处理；只保留普通照片/文档扫描，扫描合并几何与保色增强。原图不经串流视频codec，临时小图经Endpoint增量评分，最多1秒/20个不同帧，质量够用提前停止；最终上传保留帧PNG。

本轮Endpoint与Control构建、4项原生文件测试及Client/Control定向检查通过。157完整RTC与Native FileList链路、最终Control窄组、三种平板尺寸/DPR2触控模拟通过；89完整组在活跃远页条件下通过。清晰合成样例两帧提前停止，软糊样例19个不同帧、UI约1秒解锁。四份彩色扫描RTC输出与Native探针一致。源码`3e7ad7a`已推送，干净成品通过清单/ZIP/人脸资产检查和实际包内H.264/文件篮窄组。实体Android平板、物理摄像头和手持效果未验收。[交付记录](../develop/docs/camera-flow-delivery-20261104.md) · [当前契约](camera-pipeline-contract.md) · [运行记录](../develop/docs/camera-flow-qa-20261104.md) · [构建](../develop/docs/camera-flow-build-20261104.md)。

取件码[306244](https://airportal.cn/306244/AYeXJ2MWCd)，2026-11-04 20:01:28（UTC+8）上传成功，有效24小时、可下载2次、无密码。包为`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-194030.zip`，505509847 bytes，SHA256 `db7871c74d87332292897d4dbb37a390455a8f2ab59ec1496c1ec0946b5d651a`。

部分页/阴影/弱字和彩色样例已做Native对照；UVDoc虽改善行弧，实测会丢失部分入镜页的边缘内容，本批不接入。书页展平、严重截断透视尚未解决，硬阴影可有窄光晕。另发现89静态页1FPS时QSV重建实际level50超过协商42导致画面停止，原有重建修复未覆盖此情形，本轮未修改媒体路径。[Native记录](../develop/docs/photo-pipeline-native-20261104.md) · [模型实验](../develop/docs/document-unwarp-eval-20261104.md) · [问题清单](../develop/docs/open-issues.md)。

## 文件库与此前版本

本包继续包含162141的文件篮、独立“我的文件”tab、时间排序/分组、图片整卡拖拽和文件列表手柄、输入框锚定、单选/多选与原生终态确认后消费，以及Session内hash文件存储。此前157/89的FileList字节/顺序、分组、缩略图重载和授权换代证据见[上一版交付](../develop/docs/file-library-delivery-20261104.md)及[运行记录](../develop/docs/file-library-qa-20261104.md)，旧拍照流程由本轮替代。QSV Reset -14后的同session重建来自该版，原硬件和解锁证据见[定位记录](../develop/docs/file-unlock-investigation-20261104.md)；它未覆盖本轮发现的level超限情形。

本包也包含`3a5df07`的冷启动补帧与Video-only清理。该批96项Client与4项Endpoint定向、157正常/ACK延迟冷启动及89静态页恢复通过，证据不代替本轮新故障的复验。[修复记录](../develop/docs/first-open-recovery-20261104.md) · [实际运行](../develop/docs/osr-first-open-runtime-20261104.md)。

## 生命周期、触控与延迟（已交付861200）

本轮后续修复：freeze导航竞争通过逐RVH精确ACK后解冻，保留JS堆；真实未知和frozen renderer退出按incarnation/代次守护卸载恢复，导出跳过pending/uncertain。触控增加未路由撤回、精确已完成账本、早拒绝可靠回执与跨布局零坐标旧owner退役。157真实回执丢失/双指/尺寸换代/旧owner重复请求通过，媒体身份保持；89默认video/可信touch终止通过。CPU/构建及真实证据见[生命周期](../develop/docs/osr-lifecycle-runtime-20261104.md)、[触控与Stats](../develop/docs/touch-terminal-runtime-20261104.md)。

Stats按同窗区分解码、元素收帧/丢帧、compositor与rVFC，接入实际接收/解码/提交耗时，删除旧capture空白项。OSR/Input/编码新探针按精确身份关联。原生RTP playout默认0/50ms：同条件none窗口提交55.48→57.87FPS、丢帧58/1172→9/1170、末包→提交p95 78.5→50.4ms；sync45 marker p95 115→92ms。Worker独立组18/18输入回显、marker p95 99ms，首击focus ACK27ms；输入总尾延迟未证明同幅改善，约1秒未复现。实际ICE RTT约17–19ms，非物理scanout。[分段及测量边界](../develop/docs/osr-profile-runtime-20261104.md)。

Windows真实完成同UHD630/LUID的显示输出0→1及1→0，两组PID/peer/track保持、H264持续，无FATAL/CHECK/dump；输出移除后观测12.869秒，未做物理拔插。[显示会话证据](../develop/docs/osr-display-runtime-20261104.md)。

## 网页兼容设置、键盘与触控（已交付152167）

更多菜单改为“网页兼容性处理”子菜单，按站点保存平板UA与“不自动弹出键盘”。键盘设置不刷新页面；悬浮按钮显示/隐藏本地键盘，手动隐藏完成同目标组合文本一次，真实远端失焦关闭输入法。同一目标的重复状态与resize不会重新弹出手动隐藏的键盘。

Viewer外壳按visualViewport宽高布局，offset只移动，不改变远端DIP。内容真实大小变化继续保持键盘顶部保比例peek与普通布局最后帧模糊拉伸。沿用稳定编辑target、临时reconfigure保留及有界暂存，原focus/layout和新帧输入门禁不放宽。快照最多4Mi像素、1.8秒，不计入稳态video帧数。

Browser依据真正最后触点登记精确终止账本；Endpoint异步跟进canonical ACK，关键回执遇到SDK BUSY保留重发；Client从实际发送开始有限查询，使用原请求恢复，已受理end不重放。双指部分抬起不阻塞全部输入。未知结果仍不授予新触控资格，但改为原连接上的确认重试，键盘和其他控件可用，不默认要求重连。

Control333/333及生产构建、Endpoint19/19、Browser/SDK增量通过。原生probe首轮发现刚完成记录会被过早淘汰，修复后原断言通过。157/89真实H264组通过菜单、手动键盘、composition跨resize与单次提交、旧target拒绝、远端blur、偏移不重配、可信双指部分抬起和远端滚动。屏蔽终止回执2250ms后，两组约3.75秒以只读查询恢复，无重复输入，peer/双DC/video/track保持。Sol检查两版各6张截图，无阻塞视觉问题。89本地composition为合成事件、远端均为Native；实体移动键盘仍待验收。

[构建](../develop/docs/keyboard-touch-compat-build-20261104.md) · [运行与失败尝试](../develop/docs/keyboard-touch-compat-runtime-20261104.md) · [正式回归工具](../tools/test-keyboard-viewport.mjs) · [此前137959证据](../develop/docs/keyboard-viewport-runtime-20261104.md)。

## 高级认证与此前交付证据

锁定行为源码已调整：默认5分钟无操作锁定，切到后台锁定默认开启，锁屏及初始空白背景为纯白。已保存的账号设置继续生效。6项认证/解锁定向测试及Control生产构建、启动smoke通过；未做真实5分钟等待或后台切换复验。该调整当时未单独打包，现包含于137959；以下旧包不含此调整。

高级认证已发布，源码`ba667bfe5675e4aa9bf2fc973b1b269ae65068f5`已推送。取件码[316234](https://airportal.cn/316234/d99cU47GIx)，2026-11-04 08:09:29（Asia/Singapore）确认成功，页面显示有效24小时、可下载2次、无密码。

新包`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-080340.zip`为504933129 bytes，SHA256 `3314e13738f6cf473334f6d895ce6b2c56fc1a3530ac276ca17344f00cd0a8dc`。manifest记录干净源码，571项文件和ZIP及11项人脸资产校验通过，包内启动/模型可用及独立真实H264、锁定/PIN恢复与同peer/DC检查通过。详情见[交付记录](../develop/docs/advanced-auth-delivery-20261104.md)。

空白锁屏与上上下下左右左右、账密/PIN/人脸设置、Control挑战及Endpoint授权代次门禁已实现。摄像头复用现有WebRTC peer的独立认证DataChannel，传送原尺寸RGB24，由Endpoint协商并按5fps授予取帧；使用YuNet/SFace和MiniFASNet V1SE/V2 ONNX，OpenCV最小模块静态链接。正式契约见[锁屏与高级认证](authentication.zh-CN.md)。

当前新路径已通过Control生产构建与314项测试、后续17项transport定向检查、Endpoint Release及19项CTest、SDK增量/RTC probe和3项实际SDK/RTC/audio smoke。初轮锁屏导致Browser退出，CDB定位为RenderChannel析构回调重入正在销毁的OSR状态；已撤销析构时回调，生产Mojo生命周期probe通过，正常断链仍通知。首登RTC未就绪时操作误报也已修复并实测。

修后Chrome157/89均通过空白与可信键鼠/触控序列、密码/PIN设置及锁定/解锁，同组peer、两条DataChannel和接收track保持；锁下无新增产品快照，尾包结束后H264/Opus计数停止，旧代输入/产品操作无效果，解锁恢复H264。两版各实测320×240 RGB24协商5fps、5完整帧/75块及取消后停发。89另通过真实15秒页面闲置和有Cookie重附着默认锁定、无产品state。

157独立官方T1合成摄像头组通过3帧录入、Control AES-GCM模板、锁下3帧匹配解锁、空帧离开锁定，全程同peer/DC。该组是接线与状态机证据，不是真人活体效果。修后三组各只有一个Browser PID，无replacement/FATAL/CHECK/GPU退出，已清理自有进程。两版第二tab操作未产生可信visibilitychange，真实后台触发、系统锁屏与物理关屏尚未验收。[构建](../develop/docs/advanced-auth-build-20261104.md) · [实际运行](../develop/docs/advanced-auth-runtime-20261104.md)。

LFW公开人物固定6,000对、生产阈值0.50，识别阶段全量准确率81.07%，异人误接受0/3,000、同人误拒绝37.87%；双方成功提取特征的4,130对准确率95.62%。较多拒绝来自多人脸/质量门禁，未调阈值或剔除样本。MiniFAS ONNX与PyTorch数值检查及官方T1/F1/F2管线检查通过；静态照片评测不包含摄像头与活体效果，实体摄像头仍待验证。[评测报告](../develop/docs/face-public-benchmark-20261104.md)。

## 上一批交付与渲染证据

Rend Wake优先发帧增量允许当前代渲染事件唤醒Comp定时等待；合法Wake清除旧期限，Slot饱和或SDK暂忙时保留优先请求，成功发送Begin后恢复正常帧间隔。Endpoint Release与Comp节拍、Windows队列事件定向检查通过；当时按用户要求未单独打包，也未测量唤醒延迟。本次高级认证版本包含该增量，旧352318包不含。

Comp / Rend重构已完成并上传。发布源码`94cd1740148dda41f5609eb604bbd2d9d669fee3`，取件码[352318](https://airportal.cn/352318/RGG7EQ9ZwD)。上传完成于2026-11-04 00:50（Asia/Singapore），界面显示有效24小时、可下载2次、无密码。

包为`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-004705.zip`，462555599 bytes，SHA256 `3eb873b833d8e7a958726861187f190a35a8c12c8ef6b4e2dce28db4c3dc0117`。manifest记录干净源码，560文件逐项hash、ZIP CRC/hash、CLI启动检查及独立包内产品检查均通过。实际包内注册/注销/登录、UI建窗与导航、H264默认video、可信点击/滚动、播放前设备枚举及媒体身份保持通过；加载Node/Endpoint/Browser/SDK/Viz路径和hash已核对，无FATAL/CHECK/GPU退出，自有进程已清理。[交付记录](../develop/docs/comp-rend-delivery-20261104.md)。

Browser/SDK四目标及Endpoint Release已构建成功；Endpoint15项CPU测试与后续H264/生命周期定向检查、Slot/Wake编译期probe、WebRTC adaptation与3组BeginFrame probe通过。SDK195项导出依赖、4个公开头及import lib与实际消费者hash匹配；外部SDK/RTC/audio smoke 3/3通过，RTC smoke包含D3D纹理。

Chrome157/DPR2与Chrome89/DPR1真实通过默认video首帧、双Window画面及点击/text/wheel、单次Idle尾IDR与Wake、三档质量热切换、1440/1100/390布局及导航。组内RTC/video/track身份保持，两组共用同一Browser，无FATAL/CHECK/GPU退出；29个旧代全部退休，retired occupied与unknown retention均0。157标准jitterBufferTarget读回0，89无该属性但兼容playoutDelayHint读回0。前三次首帧失败及对应修复保留在运行记录，不计作成功证据。

157短限速组48→4→48Mbps中，GCC目标由33–38.6Mbps降至0.791Mbps，恢复10秒后3.512Mbps，视频持续解码；没有回到原目标，也未观测到网络触发编码尺寸变化。QSV共588次Reset，192次正status5；驱动会调整目标，例如请求1.5Mbps、读回4.908Mbps，不能当作实际线上码率。没有负Reset状态。旧capture性能与包验证不能代替本批证据。[构建记录](../develop/docs/comp-rend-build-20261103.md) · [真实运行记录](../develop/docs/comp-rend-runtime-20261103.md) · [问题清单](../develop/docs/open-issues.md)。

## 本次渲染与媒体契约

- 串流Browser启动前由Endpoint Comp探测硬件H.264编码器并固定后端和GPU LUID。Rend按该LUID创建设备，Comp每代导入前核对LUID。Browser/SDK增量构建及Endpoint Release通过。UHD630、Chrome157实测QSV首帧和atlas从1168×752换代至816×560，H.264持续解码，Browser、peer、video track与DataChannel保持，旧代完成退役。NVENC已检查无对应硬件时在启动Browser前失败，实际编码和多GPU选择尚未在本机验收。详见[GPU输出](gpu-output.zh-CN.md)。

- Endpoint Comp选择空闲Slot，异步发送带generation/slot/value的Begin；Browser Rend返回Reject，或在实际GPU队列Signal对应Slot ready Fence。最多四个atlas Slot，活动深度按压力变化，允许多个请求在途。成功帧没有ready/present/release IPC。
- 每WebContents独立Aura root，经BeginFrameSource驱动专用Viz OSR OutputDevice，直接绘制共享BGRA目标；Browser在GPU上合成各plane为请求指定的atlas Slot。旧Capture/CopyOutput生产路径、旧自治节拍及桥接fallback删除，不需要本地屏幕Present。
- 每Slot独立ready/consumed Fence及元数据。必须观察真实ready后才编码；SDK、转换和硬件编码租约全部结束，且consumed实际完成后才能复用。Stop/Stopped仅证明有序请求排空；未完成GPU工作继续保留。
- Idle只在最后有效内容已提交、后续渲染需求停止时返回；后续Chromium需求通过绑定最后Idle身份的Wake恢复并优先安排新帧，遵守原有媒体门禁和Slot背压。已在途的晚到Begin不能清除唤醒证明。单次尾IDR通过force Begin取得合法Slot。
- 三档质量分别映射WebRTC的MAINTAIN_RESOLUTION、BALANCED、MAINTAIN_FRAMERATE。官方source adaptation选择缩放/丢帧，SetRates提供目标码率与观测输入FPS；QSV对观测FPS去抖后才重配硬件时基。删除自制延迟阈值、DPR因子和码率/FPS预设。Comp另外遵守客户端、编码器及协商H264的硬能力上限。
- 媒体适配缩放完整atlas，页面DIP和Client Scale不随网络改变。X/Y对齐取整分别进入ROI、输入与caret转换；尺寸变化保持旧布局输入门禁及新布局首帧屏障。
- 实际receiver设置jitterBufferTarget=0；Chrome89仅在标准属性缺失时使用可用的playoutDelayHint=0，能力与读回分别报告。
- SDK控制/渲染ABI为2，当前源码RTC ABI为4，SharedRenderMapping版本2，新增稳定编辑target；旧316234包使用Mapping1，不能与本批混用。高级认证新增独立认证DataChannel与媒体授权接口；旧352318包使用RTC ABI3。Browser、SDK、Endpoint须配套更新。显式native demo仍可独立构建，其fence模式明确Unsupported，不切回旧capture。

正式细节：[Comp / Rend](rendering.zh-CN.md) · [GPU](gpu-output.zh-CN.md) · [SDK](sdk.md) · [媒体反馈](media-feedback.md)。

## 保持的产品边界

Control拥有User、Window/tab、设置与有限Endpoint引用；Session托管Chromium恢复数据。当前每Tenant一个Browser进程、单Profile，Endpoint可分机部署。Client只持久化token，产品状态由WS快照和持久操作收据收敛；常规媒体、输入、浏览器操作与文件走WebRTC。

Viewer默认video，独立Window按客户端内容bounds布局、atlas只负责裁剪，关闭原生媒体入口。focus、导航、resize保持RTC与媒体身份；旧文档/布局撤销输入资格，新布局首个有效关键帧后才放行。Client触摸保留touch-action/preventDefault仲裁，移动编辑绑定文档/owner；真实移动软键盘仍须实体设备验收。

Memory Saver由Control维护：Viewer断线决定产品hidden与回收资格，RTC仅决定渲染需求；安全隐藏页面30秒冻结、120秒丢弃，Native执行点复查。保护条件或实例变化会重置计时，不把RTC连接反向当作产品visible。

搜索设置与起始页保留；文件选择采用统一文件篮，拍照评分与文档后处理由Endpoint执行。音频来自Chromium播放target，经独立Opus管线发送；左右声道选择按整个Viewer持久化。本次质量偏好仅更新video sender。

## 已发布与重构前证据

重构前已上传版本`11299d9`，取件码467761，旧包名`RemoteKit-win-x64-streaming-qsv-nvenc-20261103-221813.zip`，462549523 bytes。SHA256：`0699efcb56288d0dea734c256cf2b2c37f41d261ef298441694352723aa2e79c`。它修复音频设备枚举和Viz同步完成致命退出；560项manifest/ZIP及包内真实WebRTC操作、设备枚举和双声道PCM通过。[发布后修复运行](../develop/docs/loopback-crash-runtime-qa-20261103.md) · [构建](../develop/docs/loopback-hotfix-build-20261103.md)。

其后的`70e4243`已提交推送，按当时要求仅测试、未上传。修复Video回退原因误报、hidden/未ACK期间metadata重试预算，以及Viz相同frame ID重复接纳。Control293项、增量编译、12补丁可逆及89/157功能组通过；真实整个Viewer hidden未由headless产生，截图原始回退原因仍未知。该本地包另通过560项manifest/ZIP及包内注册、导航、点击/输入/wheel/resize、10次设备枚举和双声道PCM；无fatal、媒体身份保持、MSTP/draw0。证据`develop/tmp/release-70e4243-product-qa/test-summary.json`，详见[运行](../develop/docs/video-lifecycle-runtime-qa-20261103.md)与[构建](../develop/docs/video-lifecycle-build-20261103.md)。这些均属于重构前路径。

历史双Tenant45秒组为canvas51.69/51.73FPS、Pixel marker p95 76/79ms，条件1920×1080/DPR1、atlas1936×1088、RTT10ms、每peer48Mbps、UHD630/QSV。用户取消额外稳定尾跑和单Tenant重复组，本次不重跑。Marker终点为canvas提交，不能改称video物理显示FPS。[完整条件及历史工具](streaming-experiments.zh-CN.md)。

## 明确保留的差距

每Session当前单Profile；完整IME replacement/span、原生popup widget合成/命中、目录上传、认证/证书、跨端剪贴板、PDF/打印及原生长按仍有缺口。POST reload缺少repost确认协议时明确拒绝。IPC传输故障后同Browser incarnation重附着仍需独立契约，不能重放未知mutation；跨进程重启不能恢复网页JS堆。

本机没有NVIDIA硬件、实体移动软键盘及真实摄像头效果验收。新OSR路径目前没有可靠的GPU完成时间戳，capture_time_us保持0并省略相应延迟样本；不能用提交/Flush时间补造，也不能引用旧capture-end延迟作为新结果。CPU测试、编译、真实GPU与实体硬件证据分别记录。

[系统架构](architecture.zh-CN.md) · [Control](control-plane.zh-CN.md) · [协议](streaming-protocol.md) · [输入](client-gestures.zh-CN.md) · [导航](navigation-operations.zh-CN.md) · [音频与文件](audio-and-files.zh-CN.md)
