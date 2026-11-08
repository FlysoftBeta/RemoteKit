# RemoteKit 开发约定

新对话先读本文件，再读 [系统架构](docs/architecture.md)（含全部文档索引）。本文件保存用户的长期要求与工作约束；设计、实现与调优经验放在 `docs/` 对应主题文档里。

## 沟通与执行

- 先讲结论、行为与下一步。语言清楚简短，不用免责声明、防御性措辞或"N 项测试通过"之类的填充掩盖结果；事实、未知项和未完成项直接说明。
- 已授权的常规工作直接推进，不重复请求确认。实质阻碍说明具体动作、原因及所需信息。
- 不把设计、编译、单元测试、真实运行和硬件验证混为一谈；旧路径的结果不能代替新路径的验证。
- 有意义的一批完成后，审阅范围、commit 并 push 到 https://github.com/FlysoftBeta/RemoteKit；保留历史，不 force push，不提交凭据、Profile、数据、日志、构建产物或测试包。

## 代码原则

- 没有明确用处的路径一律删除：demo、实验开关、兼容分支、回退路径、过时工具、旧格式迁移。"可能有人用"不是保留理由；删除要彻底，不留 stub、别名或 TODO。行为兼容不是默认要求。回退路径只在实际会走到时保留。
- 测试与自动化用的钩子、开关可以有（例如开发构建里读取产品状态、触发解锁），但不能进入最终产品：按构建期条件剔除（如 `import.meta.env.DEV`），并确认发布产物里没有；完成使命后删除，不长期留着。
- 职责清晰：每个状态只有一个所有者，模块之间通过窄接口和不可变快照交互，不读别人的字段。长生命周期对象用显式状态枚举/判别联合表达，不用标志位组合。
- 统一错误模型：三端共用一组错误码（见 [架构 · 错误模型](docs/architecture.md#错误模型)），错误码同时表达"是否可能已执行"；每个边界只转换一次，不按消息文本分支。
- 代码可读：C++ 用 clang-format（Chromium 风格，100 列），TS/JS 用 prettier（`control/.prettierrc.json`）；不写压成一行的密集代码；注释只写不明显的原因，不写历史叙述。

## 用户目标与边界

- 独立 Chromium content embedder，不装配 Chrome Browser/TabStripModel/BrowserView 产品对象图。UA/Client Hints 目标匹配 Google Chrome；window.chrome 对照实现，兼容 stub 不等于全部功能完成。
- Tenant 对应 Session，Session 是多租户数据隔离边界；其下可有多个 Profile。当前单 Profile 限制属于实现状态，不是最终层级需求。
- Control 是产品状态真相，持有 User/Window/tab/设置与 Endpoint 对象有限引用。Chromium 恢复数据由 Endpoint Session/Browser 托管；对象丢失可按有限产品信息重建，对账清理 orphan。
- `control/` 使用 TypeScript、better-sqlite3、Vite、React、MUI。普通 Viewer 采用沉浸式浏览器外壳、实际内容区尺寸、多个独立 Window 并排/窄屏切换；不是两个 active tab 冒充多 Window。
- 每站点设置放更多→网页兼容性处理，包含平板版网站与不自动弹出键盘；平板选项只改变 UA/CH，不模拟 viewport。提供可拖动停靠的悬浮图标按钮显示、隐藏键盘。其余设置统一在更多→设置。质量选择只保留优先高画质、自动、优先流畅；画面始终按 Viewer 原生分辨率串流，界面缩放是外壳与网页内容整体一起缩放；可选顶部留空（至少避开系统安全区）。设置存 Control，客户端只持久化用户 token。
- 没有公开注册：首个账户为管理员，其余账户只能由管理员在管理员面板创建。管理员面板分概览、用户、节点、存储、诊断；用户管理含重置密码、清除 PIN/人脸、强制下线、休眠与重置浏览器数据、停用、转让管理员和彻底删除（含各节点上的数据）。
- 高级认证包含完全空白、无交互反馈的锁屏；上上下下左右左右支持键盘与触屏/鼠标点击屏幕区域。未登录只用账密，登录后可配置密码、PIN 与人脸验证；锁定下保留人脸验证，检测用户离开及浏览器可提供的关屏相关信号。
- 人脸摄像头通过既有 Client↔Endpoint WebRTC 连接传送未压缩 RGB，帧率每秒 5 帧、由服务端协商；Control 参与发起与授权，Endpoint 承担 OpenCV YuNet/SFace 与 MiniFASNet V1SE/V2 ONNX 推理，可自行转换 ONNX。不能为鉴权另建重复 peer 或把识别计算放回 Client/Control。
- Client 直接与 Endpoint 建立 H264 WebRTC 及 DataChannel 输入；鉴权、信令、产品状态由 Control 管理，Viewer↔Control 使用 WebSocket。支持键鼠、文本、IME 与触控。
- Endpoint 是可与 Control 分机部署的 Native 算力节点，Browser 是其组件；当前每 Tenant 一个 Browser 进程、单 Profile，保留多 Profile 余量。不能把 Control 与 Endpoint 共享路径、时钟或进程的现状当成架构要求。
- Client 与 Endpoint 的常规数据统一经 WebRTC，包含音视频、输入、浏览器操作及文件数据；resize、focus、导航不得随意销毁连接。Control 与 Client 同步既要即时操作反馈，也要最终状态一致，客户端不持久化产品状态。
- 常见触摸手势由 Client 计算，页面消费或自定义触摸保留 passthrough，不能绕过 touch-action/preventDefault。移动键盘跟随远端编辑焦点并遵守站点手动开关，真实失焦关闭输入法，IME composition 绑定正确文档。软键盘引起的尺寸变化使用顶部锚定、保持比例的 peek；普通布局变化使用最后一帧模糊拉伸，严守新旧布局输入门禁。Viewer 外壳滚动不能误触发远端 resize。
- 提供可选择搜索引擎及简易起始页；与独立 Window、服务端设置和 video 路径保持一致。
- 开启 Control Memory Saver 策略。Viewer 断线决定产品 visible=false 及回收资格；RTC 连接独立决定渲染/编码需求，不反向把 hidden 页面显示出来。
- Rectangle Packing 把多个可见平面合为视频 atlas；必须处理 DPR、DIP、编码采样比例、letterbox、screen 坐标与旧布局输入门禁。
- Endpoint 用独立 CMake/Ninja，Mojo/libwebrtc 纳入 SDK 边界；跨 DLL 不传 C++ STL/libc++/Abseil/Chromium 对象。oneVPL 异步 H264 与 NVENC 均在范围内。音频目标必须是 Chromium 播放输出 target，不用系统 hook/capture。
- 音频播放配置按整个 Viewer 统一并由 Control 保存：更多菜单用一个紧凑按钮组：左声道、右声道可多选，"不播放"清空选择。
- Viewer 统一使用 video 呈现，没有 Canvas 串流后端或自动回退；尺寸过渡快照、摄像头处理与测试像素读回不属于串流后端。显示布局来自客户端内容 bounds，atlas 矩形用于裁剪；不启用原生 controls、画中画和多余媒体功能。布局/输入对应必须正确，不能把实验原型当成已完成的产品实现。
- 网页文件上传使用自定义文件篮，支持设备文件和摄像头拍照。拍照用摄像头 feature 而非 capture input；全屏取景，横屏快门在侧边，模式与连续拍摄配置在相机中选定。只有文件篮和拍照两个主界面，拍后直接入篮，不经过独立"检查照片"。Endpoint 选片，质量够用即停止采样，单次采样最长 1 秒、最多 20 个不同源帧；照片不经过视频编解码链，限制并发与内存。仅足够不确定时在篮内提供候选，可移除或原位重拍。文档扫描是统一功能，合并几何矫正与保色扫描增强，默认保留颜色，不做黑白硬二值化；文档不完整入镜也应有可用结果，不能猜裁丢掉已有内容。照片和普通文件共用有序文件篮，可插入、排序；图片为主时横向卡片整卡拖拽、点击菜单，简易态为小 strip 和右侧纵向发送/添加/更多图标；明显普通文件居多时列表手柄拖拽且操作展开为按钮，可切换视图。multiple 可选全部，否则手动选一项，选择确认后消费项自动出篮。更多→我的文件是独立 tab，按时间排列、可分组、上传及加入文件篮；有分组后每次上传显式选择分组或不分组。文件字节在服务端按 hash 存储。文件选择 UI 紧凑，是不遮挡下方操作、不强制关闭的悬浮面板，可用 handle 拖动；输入可见且有可靠位置时锚定输入，否则停在底部居中。
- 实际 GPU Fence 保护读写与复用；CPU 发布位、提交返回或持有 HANDLE 不能假装完成。Browser↔Endpoint 采用 Comp 主动 Slot Begin、Rend Reject 或 GPU Fence Signal，均绑定 Slot Value 并允许多个请求在途；成功帧不增加 ready/present/release 消息。Rend 主动 Wake 后 Comp 应尽快申请新帧，仍遵守 Slot 租约、背压及媒体暂停门禁。Chromium 内部 IPC 和 Endpoint↔Client 媒体元数据是不同边界。
- 保留 Views/Aura 功能适配是允许的；服务渲染目标为离屏，不需要本地屏幕 Present。不要把无页面 HWND 说成整个 Chromium 进程零 HWND。
- 服务串流与输入的关键参数尽量独立于宿主系统设置，避免服务器显示器、DPI、刷新率或 RDP 改变行为；客户端 DPR/刷新能力和产品媒体策略仍作为适配输入。
- 保留 Chrome89 支持。性能环境为 UHD630、RTT10ms、24–48Mbps；重载目标 2–3 租户。目标实际动态画面 ≥50FPS、Pixel marker p95 ≤100ms；静态低 FPS 正常。
- 单次 idle 尾 IDR、显示/网络自适应 FPS、背压、高码率换编码速度与高精度计时。拥塞控制与媒体降级交给 WebRTC，质量三档对应 DegradationPreference；不保留自行按延迟调整 DPR/分辨率/码率的控制器。Comp 依据 SetRates 与 Slot 压力安排 Begin 和活动队列深度，经 BeginFrameSource 驱动自定义 OSR 呈现后端，不使用 Capture API 截取。Viewer 接收端 jitterBufferTarget 设为 0。受控实验使用独立无交互测试页；保留细粒度 GPU/延迟 profile，淘汰无效旋钮。
- 诊断从设置内点击开始，收集期间显示可拖动停靠的悬浮停止按钮；停止后打包为 tar.zst 文件保存在服务端，客户端显示诊断 ID。诊断包尽可能涵盖完整的调试信息。

## 仓库与文档

- 目录：`control/`（server、client、shared）、`endpoint/`（C++20 服务）、`browser/`（GN embedder 与 `browser/sdk/`）、`protocol/`（跨组件契约）、`sdk/`（公共 C 头与消费者 smoke）、`patches/`（有序 Chromium 补丁）、`tools/`（构建/打包；`tools/measure/` 测量）、`tests/`（`e2e/` 真实栈场景、`integration/` 原生集成）。结构说明见 [架构 · 代码结构](docs/architecture.md#代码结构)。
- `docs/` 只放设计文档：设计意图、具体实现、子系统架构、调优经验与被否决方案。不写开发日志、进度、测试通过数、取件码。改代码时同步改对应文档；文档描述现状，不追加历史。
- 过程记录、实验证据和测试包放 `develop/tmp/`，不提交。正式构建工具不能依赖 develop 中的文件。
- Chromium tracked 源码修改须更新 patchset 清单/hash，验证可复现应用/撤回。项目源码由 `tools/chromium.py stage` 同步，不手工留下未管理改动。

## 开发机与构建

- Chromium：`C:\src\chromium\src`，remotekit 分支，固定官方 157.0.8103.15，基线 HEAD `1aa07b638799e59656559ae6c6649d4b197f555e`。
- 保留原 rb 分支、stash（RemoteKit baseline preservation 2026-10-31 (original rb tracked edits)）及未跟踪 re。不得清理/重置这些其他项目数据。
- 不读或引用旧 `C:\Users\Flysoft\Desktop\remotekit`，除非用户重新明确引用。
- 复用 out/dev 和 out/rel 增量产物，不 full/clean/新建 out；不要并发 gen/build 同一 out。默认使用全部逻辑 CPU，同 out 多目标一次 Ninja。Browser（Chromium out）、Endpoint（`build/`）、Control（npm）三个构建域可以并行。
- 搜索代码与文件可以使用 ripgrep（`rg`）；没有时再用其他工具代替。
- Python 用 `C:\src\depot_tools\python3.bat`；不用 WindowsApps 空别名。VS 为 `C:\Program Files\Microsoft Visual Studio\18\Community`。clang-format 需设置 `CHROMIUM_BUILDTOOLS_PATH=C:/src/chromium/src/buildtools`。
- 用户授权必要系统修改及 Windows sudo；不为已授权步骤重复确认。
- 选择必要测试：迭代时只跑相关的测试文件/目标，完整套件最多在一批结束时跑一次；不反复跑已通过且无新疑点的组。计时 GPU 实验独占资源，不与 CPU 构建混跑；只清理自己创建的进程，不动用户/RDP/系统服务。
- 默认 non-interactive，不使用 Computer Use 抢鼠标、键盘或切窗口。允许隔离的 headed Chrome89/自动化。
- 打包工具为 `tools/package-runtime.py`，默认 `--out rel`（non-component、DCHECK-off），Control 包、Endpoint 引导包及 SHA-256 输出在 `develop/tmp/<时间戳>/`。归档用 Node 内置多线程 zstd，解压用 7-Zip ≥ 24 或支持 zstd 的 tar。部署入口见[构建与发布](docs/build.md#发布包)。收集运行 DLL/Release CRT，不带 PDB、编译输入、开发 Profile 或凭据。

常用入口（详见 [构建与发布](docs/build.md)）：

```text
C:\src\depot_tools\python3.bat tools/patchset.py --chromium-root C:/src/chromium/src status
C:\src\depot_tools\python3.bat tools/chromium.py stage
C:\src\depot_tools\python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk
C:\src\depot_tools\python3.bat tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd            (build-only | package)
npm --prefix control test / run build
C:\src\depot_tools\python3.bat tools/package-runtime.py
```

## 委派（Codex）

- UI/UX 设计与架构设计之外的探索类、实现类任务可以直接交给 Codex；UI/UX 与架构设计由主对话完成。
- 委派时：主对话负责架构设计、接口契约、取舍、拆分、审阅、集成与 commit/push，不把核心架构决策委派出去；`docs/` 由主对话亲自撰写。用法、提示写法、并行与审阅要点见 [tools/codex/README.md](tools/codex/README.md)。
- 不频繁询问进度；有独立工作继续推进，等待使用合理长超时，不忙轮询。

## 发布

- 上传流程见 `docs/upload/README.md`（本地文件，不纳入版本控制）；上传已授权，凭据不输出、不打包、不进日志。用户要求用 Codex 时以 gpt-6.1-sol、low 执行，返回取件码。
