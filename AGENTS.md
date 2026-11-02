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
- 每站点平板设置只改变UA/CH，不模拟viewport；放更多菜单。设置统一在更多→设置。质量选择只保留优先高画质、自动、优先流畅；Client Scale默认Viewer DPR，可override。设置存Control，客户端只持久化用户token。
- 首个正式注册用户为管理员；管理员面板管理服务器级注册口令。口令只用于后续注册，账号密码独立，设置由Control持久化，客户端不保存或回显口令。
- Client直接与Endpoint建立H264 WebRTC及DataChannel输入；鉴权、信令、产品状态由Control管理，Viewer↔Control使用WebSocket。支持键鼠、文本、IME与触控。
- 开启Control Memory Saver策略。Viewer断线决定产品visible=false及回收资格；RTC连接独立决定渲染/编码需求，不反向把hidden页面显示出来。
- Rectangle Packing把多个可见平面合为视频atlas；必须处理DPR、DIP、编码采样比例、letterbox、screen坐标与旧布局输入门禁。
- Endpoint用独立CMake/Ninja，Mojo/libwebrtc纳入SDK边界；跨DLL不传C++ STL/libc++/Abseil/Chromium对象。oneVPL异步H264与NVENC均在范围内，音频本轮不做。旧内置demo仅由显式构建目标包含。
- 实际GPU Fence保护读写与复用；CPU发布位、提交返回或持有HANDLE不能假装完成。browser↔endpoint正常帧不增加逐帧ready/present/release消息；Chromium内部IPC和Endpoint↔Client媒体元数据是不同边界。
- 保留Views/Aura功能适配是允许的；服务渲染目标为离屏，不需要本地屏幕Present。不要把无页面HWND说成整个Chromium进程零HWND。
- 服务串流与输入的关键参数尽量独立于宿主系统设置，避免服务器显示器、DPI、刷新率或RDP改变行为；客户端DPR/刷新能力和产品媒体策略仍作为适配输入。具体固定值与实现方式放正式架构文档，不固化为用户要求。
- 保留Chrome89支持。性能环境为UHD630、RTT10ms、24–48Mbps；用户把重载目标从4调到3，再允许2租户，接受新版Chromium模拟刷新验收。目标实际动态canvas≥50FPS、Pixel marker p95≤100ms；静态低FPS正常。
- 用户要求单次idle尾IDR、显示/网络自适应FPS、背压、高码率换编码速度、高精度计时，以及>300ms延迟时分辨率/DPR适配。受控实验关闭自动调节，使用独立无交互测试页和下放配置；保留细粒度GPU/延迟profile，淘汰无效旋钮并集中归档。

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
