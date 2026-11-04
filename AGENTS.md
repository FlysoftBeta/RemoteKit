# RemoteKit 开发约定

新对话先读本文件，再读[当前状态](docs/current-state.zh-CN.md)。本文件保存用户长期要求与工作约束；当前实现、实验历史和接口细节放对应文档，不把Agent选择或暂未实现的限制固化为用户要求。

## 沟通与执行

- 先讲结论、行为与下一步。用清楚简短的语言，不用大量免责声明、分支细节或防御性措辞掩盖结果；事实、未知项和未完成项直接说明。
- 已授权的常规工作直接推进，不重复请求确认。实质阻碍说明具体动作、原因及所需信息。
- 维护当前状态与可追踪问题清单；不把设计、编译、模型测试、真实运行和硬件验证混为一谈，不拿旧路径结果覆盖新路径。
- 有意义的一批完成后，由root审阅范围、commit并push到 https://github.com/FlysoftBeta/RemoteKit；保留历史，不force push，不提交凭据、Profile、数据、日志、构建产物或测试包。

## 用户目标与边界

- 独立Chromium content embedder，不装配Chrome Browser/TabStripModel/BrowserView产品对象图。UA/Client Hints目标匹配Google Chrome；window.chrome对照实现，兼容stub不等于全部功能完成。
- Tenant对应Session，Session是多租户数据隔离边界；其下可有多个Profile。当前单Profile限制属于实现状态，不是最终层级需求。
- Control是产品状态真相，持有User/Window/tab/设置与Endpoint对象有限引用。Chromium恢复数据由Endpoint Session/Browser托管；对象丢失可按有限产品信息重建，对账清理orphan。
- `/control`使用TypeScript、better-sqlite3、Vite、React、MUI。普通Viewer采用沉浸式浏览器外壳、实际内容区尺寸、多个独立Window并排/窄屏切换；不是两个active tab冒充多Window。
- 每站点设置放更多→网页兼容性处理，包含平板版网站与不自动弹出键盘；平板选项只改变UA/CH，不模拟viewport。提供悬浮按钮显示、隐藏键盘。其余设置统一在更多→设置。质量选择只保留优先高画质、自动、优先流畅；Client Scale默认Viewer DPR，可override。设置存Control，客户端只持久化用户token。
- 首个正式注册用户为管理员；管理员面板管理服务器级注册口令。口令只用于后续注册，账号密码独立，设置由Control持久化，客户端不保存或回显口令。
- 高级认证包含完全空白、无交互反馈的锁屏；上上下下左右左右支持键盘与触屏/鼠标点击屏幕区域。未登录只用账密，登录后可配置密码、PIN与人脸验证；锁定下保留人脸验证，检测用户离开及浏览器可提供的关屏相关信号。
- 人脸摄像头通过既有Client↔Endpoint WebRTC连接传送未压缩RGB，帧率每秒5帧、由服务端协商；Control参与发起与授权，Endpoint承担OpenCV YuNet/SFace与MiniFASNet V1SE/V2 ONNX推理，可自行转换ONNX。不能为鉴权另建重复peer或把识别计算放回Client/Control。
- Client直接与Endpoint建立H264 WebRTC及DataChannel输入；鉴权、信令、产品状态由Control管理，Viewer↔Control使用WebSocket。支持键鼠、文本、IME与触控。
- Endpoint是可与Control分机部署的Native算力节点，Browser是其组件；当前每Tenant一个Browser进程、单Profile，保留多Profile余量。不能把Control与Endpoint共享路径、时钟或进程的现状当成架构要求。
- Client与Endpoint的常规数据统一经WebRTC，包含音视频、输入、浏览器操作及文件数据；resize、focus、导航不得随意销毁连接。Control与Client同步既要即时操作反馈，也要最终状态一致，客户端不持久化产品状态。
- 常见触摸手势由Client计算，页面消费或自定义触摸保留passthrough，不能绕过touch-action/preventDefault。移动键盘跟随远端编辑焦点并遵守站点手动开关，真实失焦关闭输入法，IME composition绑定正确文档。软键盘引起的尺寸变化使用顶部锚定、保持比例的peek；普通布局变化使用最后一帧模糊拉伸，严守新旧布局输入门禁。Viewer外壳滚动不能误触发远端resize。
- 提供可选择搜索引擎及简易起始页；与独立Window、服务端设置和默认video路径保持一致。
- 开启Control Memory Saver策略。Viewer断线决定产品visible=false及回收资格；RTC连接独立决定渲染/编码需求，不反向把hidden页面显示出来。
- Rectangle Packing把多个可见平面合为视频atlas；必须处理DPR、DIP、编码采样比例、letterbox、screen坐标与旧布局输入门禁。
- Endpoint用独立CMake/Ninja，Mojo/libwebrtc纳入SDK边界；跨DLL不传C++ STL/libc++/Abseil/Chromium对象。oneVPL异步H264与NVENC均在范围内。新增音频目标必须是Chromium播放输出target，不用系统hook/capture。旧内置demo仅由显式构建目标包含。
- 音频播放配置按整个Viewer统一并由Control保存：更多菜单紧凑放左右声道多选Switch与“不播放”（清空选择）。
- Viewer统一使用video呈现，不保留Canvas串流后端或自动回退；尺寸过渡快照、摄像头处理与测试像素读回不在此删除范围。显示布局来自客户端内容bounds，atlas矩形用于裁剪；不启用原生controls、画中画和多余媒体功能。新路径必须保持布局/输入对应正确，不能把实验原型直接当成已完成的产品实现。
- 网页文件上传使用自定义文件篮，支持设备文件和摄像头拍照。拍照用摄像头feature而非capture input；全屏连续拍照，Endpoint负责选片与文档矫正/扫描后处理，仅足够不确定时统一提供候选，可移除或原位重拍，限制并发与内存。照片和普通文件共用有序文件篮，可插入、排序；图片为主时采用横向卡片，整卡直接拖拽、点击才显示菜单；明显普通文件居多时采用列表，用手柄拖拽且操作展开为按钮，并提供视图切换按钮。multiple可选全部，否则手动选一项，选择确认后消费项自动出篮。更多→我的文件是独立tab，按时间排列、可分组、上传及加入文件篮；有分组后每次上传显式选择分组或不分组。文件字节在服务端按hash存储。文件选择UI紧凑，输入可见且有可靠位置时锚定输入，否则使用dialog；拍照始终全屏。
- 实际GPU Fence保护读写与复用；CPU发布位、提交返回或持有HANDLE不能假装完成。Browser↔Endpoint采用Comp主动Slot Begin、Rend Reject或GPU Fence Signal，均绑定Slot Value并允许多个请求在途；成功帧不增加ready/present/release消息。Rend主动Wake后Comp应尽快申请新帧，仍遵守Slot租约、背压及媒体暂停门禁。Chromium内部IPC和Endpoint↔Client媒体元数据是不同边界。
- 保留Views/Aura功能适配是允许的；服务渲染目标为离屏，不需要本地屏幕Present。不要把无页面HWND说成整个Chromium进程零HWND。
- 服务串流与输入的关键参数尽量独立于宿主系统设置，避免服务器显示器、DPI、刷新率或RDP改变行为；客户端DPR/刷新能力和产品媒体策略仍作为适配输入。具体固定值与实现方式放正式架构文档，不固化为用户要求。
- 保留Chrome89支持。性能环境为UHD630、RTT10ms、24–48Mbps；用户把重载目标从4调到3，再允许2租户，接受新版Chromium模拟刷新验收。目标实际动态canvas≥50FPS、Pixel marker p95≤100ms；静态低FPS正常。
- 用户要求单次idle尾IDR、显示/网络自适应FPS、背压、高码率换编码速度与高精度计时。拥塞控制与媒体降级交给WebRTC，质量三档对应DegradationPreference；不再保留自行按延迟调整DPR/分辨率/码率的控制器。Comp依据SetRates与Slot压力安排Begin和活动队列深度，经BeginFrameSource驱动自定义OSR呈现后端，不使用Capture API截取。Viewer接收端jitterBufferTarget设为0。受控实验使用独立无交互测试页和下放配置；保留细粒度GPU/延迟profile，淘汰无效旋钮并集中归档。

## 仓库与文档

- `browser/` GN embedder；`endpoint/`独立C++20；`sdk/` C ABI；`protocol/`共享协议；`patches/`有序Chromium补丁。
- 正式工具放`tools/`，正式说明放`docs/`；`develop/docs/`是过程记录，`develop/tmp/`是临时证据/测试包。正式构建工具不能依赖develop中的文件。
- 文档核对实际状态归属、生命周期、接口、恢复与错误路径、运行实践；不只整理格式或照抄设计意图。当前状态改写，不无限追加历史。
- Chromium tracked源码修改须更新patchset清单/hash，验证可复现应用/撤回。项目源码由tools/chromium.py stage，不手工留下未管理改动。

## 开发机与构建

- Chromium：`C:\src\chromium\src`，remotekit分支，固定官方157.0.8103.15，基线HEAD `1aa07b638799e59656559ae6c6649d4b197f555e`。
- 保留原rb分支、stash（RemoteKit baseline preservation 2026-10-31 (original rb tracked edits)）及未跟踪re。不得清理/重置这些其他项目数据。
- 不读或引用旧`C:\Users\Flysoft\Desktop\remotekit`，除非用户重新明确引用。
- 复用out/dev和out/rel增量产物，不full/clean/新建out，不继承无关项目业务flags；不要并发gen/build同一out。默认使用全部逻辑CPU，同out多目标一次Ninja。
- Python用depot_tools实际解释器或`C:\src\depot_tools\python3.bat`；不用WindowsApps空别名。VS为`C:\Program Files\Microsoft Visual Studio\18\Community`，工具环境覆盖优先。
- 用户授权必要系统修改及Windows sudo；不为已授权步骤重复确认。审批拦截需如实说明实际动作与原因。
- 选择必要测试，避免反复跑已通过且无新疑点的组。计时GPU实验独占资源，不与CPU构建混跑；只清理自己创建的进程，不动用户/RDP/系统服务。
- 默认non-interactive，不使用Computer Use抢鼠标、键盘或切窗口。允许隔离的headed Chrome89/自动化metrics；视觉验证由Sol6.1，UI设计由Astra6 Medium。
- 打包工具为tools/package-runtime.py，测试包在develop/tmp。默认串流包带Node/Control生产runtime，解压run.cmd；原生包显式--kind demo。收集运行DLL/Release CRT，不带PDB、编译输入、开发Profile或凭据。Fence失败不得静默切native。

常用构建入口：

```text
tools\build-endpoint.cmd
python3 tools/patchset.py --chromium-root C:/src/chromium/src status
python3 tools/chromium.py stage
python3 tools/chromium.py build --target remotekit_browser --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
python3 tools/package-runtime.py
```

## Agent分工

- 用户明确授权subagent，跨对话保留。root负责核心架构/边界、契约、取舍、拆分、集成审阅与commit/push；不能把核心架构决策委派。
- 实现、深入调查、实验、构建与测试委派。普通复杂任务Sol6.1 Medium，简单机械任务Terra6.1 Medium，极复杂任务Astra6 Medium；始终fork_turns="none"，提示完整上下文。
- Subagent是上下文隔离primitive：不同任务必须新建代理，不把已完成任务的代理转去无关领域；仅紧密相关的连续工作可复用。重要milestone后优先用简短交接记录开启新上下文。工具并发/线程额度不足时排队或收尾释放，不以跨任务复用绕过隔离要求。
- 不向已完成代理发送仅排队的send_message来要求停止，避免残留pending_init。若已确认任务结束但占槽，可用一次followup_task要求“不调用工具、不做新工作，立即final”，收到完成通知后再重试创建新代理；这是生命周期清理，不是复用旧上下文执行新任务。
- 简单文档、决策/任务记录和轻量doc check由root直接做。
- 明确输入输出、文件归属和依赖；高耦合先定接口或串行，不并改同一文件。实验设范围、预算、判定和停止条件。
- 子agent无普通commentary，重大阻碍/决策及时报告，常规内容final交付。任务外问题报告证据和影响，root统一排队，不无边界扩大。
- 不频繁询问进度；有独立工作继续推进，等待使用工具允许的合理长超时，不忙轮询。

## 已完成批次的验收与发布约定

- 双租户45秒同组已达到约51.7FPS、Pixel marker p95 76/79ms，条件见当前状态。用户取消额外120秒稳定复验与单租户重复复验；不得为再次确认结果追加性能组。功能改动仍做必要检查。
- 完成功能任务并认真整理codebase/docs后，先构建上传第一版。委派Sol6.1按[上传流程](docs/upload/README.md)执行，返回取件码；上传已授权，凭据不输出/打包。
- 第一版上传后，委派Astra6 Medium对照文档审查代码库，寻找逻辑bug与有价值的重构。root审阅取舍，委派必要修复并同步文档；有任何变动，再构建并委派Sol上传第二版。
- 完成两阶段交付和commit/push后，最后删除goal；不得提前结束。

2026-11-02：上述两阶段审查交付已完成。后续新增功能按各自任务构建发布，不自动重复全库审查或性能矩阵。
