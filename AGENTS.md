# RemoteKit 开发约定

本文件保存用户的长期要求、后续修正和继续工作所需的约束。新对话先读本文件，再读 `docs/current-state.zh-CN.md`。区分用户目标、Agent 的架构选择和当前实现；不能把暂未实现的功能或当前实现方式固化为用户要求。

## 沟通要求：优先让用户读懂

**用户特别强调：避免过度防御性回复。不要用大量免责声明、限定语和实现细节掩盖结论，否则用户无法理解输出。这是长期沟通要求，适用于回复、进度报告和文档。**

- 先直接回答问题或说明结果，再给理解它所需的解释。默认简短，用熟悉的词；必要术语随文解释。
- 已完成就明确说完成，发现问题就直接说问题，尚不确定就说明具体未知点。准确不等于每句话都加“仅”“暂时”“严格来说”“不能保证”等限定。
- 只说明会影响当前判断或操作的真实限制，将它们集中讲清楚；不要反复声明“这不等于……”，也不要列举用户没问的假想风险。
- 不用防御性措辞推卸设计责任。说明为什么选择某种实现、它的代价是什么；不能把 Agent 的选择说成用户强制要求。
- 面向用户讲行为、结果和下一步；只有在解释问题、支持结论或协助调试时才展开实现细节。不要把内部排查过程、所有分支条件和检查清单逐项倒给用户。
- 已授权的常规工作直接推进，不重复请求确认，不添加无必要的审批、警告或合规流程。确有阻碍时，说清具体动作、原因及需要用户做什么。
- 进度报告只讲新发现、重要决策和实际阻碍，不反复汇报等待状态。文档组织成可独立理解的说明，不写成不断追加的自我辩解。

保持事实准确，必要时直接纠正错误；这些要求不意味着隐瞒限制或把未经验证的结果说成已验证。

## 用户目标与原始需求

项目代号 **RemoteKit**，实现独立 content embedder。职责、生命周期、恢复、GPU、输入、页面功能及后续媒体边界已整理在 `docs/architecture.zh-CN.md`，该文档可独立阅读，不依赖外部计划。架构应按实际情况演进；逐项比较可行实现，保留更好的机制并落实选定改动，不能只交比较报告。

### browser

- 实现 Chromium content embedder，可参考 Chromium 产品层的部分实现，不直接装配整套 Chrome Browser 产品对象图。
- **User-Agent 与 Client Hints 的目标是完全复刻 Google Chrome。** `window.chrome` 也要对照 Chrome；没有对应功能实现的部分做兼容 stub 或模仿 Chrome 行为。当前辅助算法、bindings 和 stub 的实现不代表已完成全部兼容面。
- 有 Chromium patching 需求时，自行维护 patchset 管理工具。修改 Chromium 已跟踪文件必须生成补丁，更新有序清单和 hash，保证可复现应用与撤回。

### endpoint、示例控制面与 Client

- endpoint 管理多个 Tenant。一个 Tenant 对应一个 Session，一个 Session 对应一个或多个 Profile；**Session 是多租户数据隔离边界**。当前仅实现单 Profile，不应把这一实现限制当成最终层级设计。
- 控制面是 demo/testing harness，之后不会直接完全复用，不要按生产控制服务过度建设。新 `/control` 承担产品状态和多 Tenant 管理；原内置 demo 仅由显式构建目标包含。
- 示例将所有 WebView 通过 **Rectangle Packing** 排入一个 Windows 窗口，为未来用一个视频通道传输多个 WebView 做准备。
- 支持文字、IME composition、触控、鼠标和键盘。本轮通过 DataChannel 传输入，输入协议不能依赖本地 demo UI。
- endpoint 使用 **CMake + Ninja**，不希望其构建绑定 Chromium 自身的构建。Mojo 与 **libwebrtc 即使目前不用，也要接入构建/SDK 边界**；可按实际情况采用静态库或其他方案。当前 timeutils 探针不等于完成整个 libwebrtc 接入目标。
- **2026-11-01 新任务开启编码器和 WebRTC 媒体/网络管线**：oneVPL 异步 H.264、NVENC、libwebrtc；音频仍不在本轮范围。目标客户端 Chrome 89 Desktop，1/4 租户、RTT 10ms、下行 24–48Mbps，动态内容目标 FPS>50、Pixel marker 端到端延迟<100ms；目标需要实验测定，不能写作已达成。
- 新增 `/control`，使用 TypeScript、Better-sqlite3、Vite、React；产品状态由 Control 持有，浏览器恢复数据由 Endpoint Session 与 Browser 托管。Client 直连 Endpoint WebRTC，Control 鉴权与管理。支持多 tab、split、桌面/平板布局和受 Control 管理的平板设备配置；原生 demo 保留为显式构建目标。
- 用户要求实际使用 Fence 方案，正常运行不产生逐帧呈现通信。这里的边界是 browser ↔ endpoint；不要承诺 Chromium 内部 renderer/Viz/GPU 没有帧 IPC。
- 必须正确处理 HiDPI、窗口 DPI 变化与点击坐标，区分客户区物理像素、atlas 像素、viewport DIP、letterbox 和 screen 坐标。

## 仓库组织

- `browser/`：独立 content embedder，GN 构建。Chromium 源码不属于本仓库。
- `endpoint/`：C++20 模型、布局、输入和 Windows Client，CMake + Ninja，不依赖 Chromium 私有头。
- `sdk/`：GN 产出的 C ABI SDK 与独立 CMake 消费端。跨 DLL 不传 C++ STL、libc++、Abseil 或 Chromium C++ 对象。
- `protocol/`：共享协议定义。
- `patches/`：有序 Chromium patchset、清单及 hash。
- `tools/`：正式构建、导出、打包、验证、patchset 工具，以及频繁复用的工具调用组合。
- `docs/`：正式设计、接口说明及当前能力速查。维护 `docs/current-state.zh-CN.md`，改写当前状态，不无限追加变更历史。
- `develop/docs/`：可丢弃的实施 milestone、discoveries、调查报告和过程记忆。
- `develop/tmp/`：临时文件、日志、测试结果和交付测试包。

**用户已修正早先目录建议：构建脚本等正式工具必须放 `/tools`，正式文档放 `/docs`。`develop` 丢了也无所谓，构建和正式工具不能依赖其中的文件。** 文档以清楚为先，避免堆积防御性定语。工作流变化时同步更新本文件。

## Chromium 基线与开发机

- 源码：`C:\src\chromium\src`，使用 `remotekit` 分支，基于官方 Release。当前固定 tag `157.0.8103.15`，HEAD `1aa07b638799e59656559ae6c6649d4b197f555e`。
- Chromium 有其他项目留下的修改。保留原 `rb` 分支、stash 和未跟踪 `re`；不要清理、重置或把它们套回 RemoteKit。原 tracked 修改已保存到名为 `RemoteKit baseline preservation 2026-10-31 (original rb tracked edits)` 的 stash。
- **复用 `out/dev`、`out/rel` 的增量产物，避免全量构建。** 可继承合适 GN args，不继承其他项目的业务开关。参数备份为 `out/dev/args.before-remotekit.gn`。
- 用户允许跑满所有 CPU cores。构建默认使用全部逻辑 CPU，不主动限制到少量 jobs。不要并发操作同一个 Chromium out 目录的 gen/build；多个目标放在一次 Ninja 调用中。
- **不要读取或引用 `C:\Users\Flysoft\Desktop\remotekit` 的内容。** 那是旧实现，除非用户之后明确引用。
- Python 使用 depot_tools 的实际解释器或 `C:\src\depot_tools\python3.bat`，不要用 WindowsApps 空别名。当前 VS 为 `C:\Program Files\Microsoft Visual Studio\18\Community`，工具脚本支持的环境覆盖优先于硬编码。
- 用户授权必要的系统修改，可使用 Windows sudo，无需为已授权的常规步骤再次征求同意。宿主审批拦截不等于用户没有授权；如遇拦截，如实说明动作与拒绝原因。

## Agent 分工与沟通

用户已明确授权在本项目使用 Subagent。授权和下列偏好跨对话保留。

- **主 Agent 负责核心架构规划、目标和边界定义、任务拆分与委派、关键取舍、接口与集成决策，并简明审阅子任务结果、向用户汇报。** 核心架构规划和架构决策不能委派给 Subagent。
- 具体实现、深入调查排查、实验、构建及测试交给 Subagent。主 Agent 根据摘要、关键证据和必要的局部阅读做决策，避免把原始工具日志、整文件和反复排查搬入自己的上下文。
- **简单文档修改、决策记录、任务清单维护及轻量 doc check 由主 Agent 直接完成，不必委派。** 文档体现主 Agent 的决策；分工的目的是保护上下文和提高效率，不是把所有工具调用都交给子 Agent。
- **主 Agent 自行完成 commit 和 push**，不把这一步委派给子 Agent，也不留给用户手动收尾。目标仓库为 `https://github.com/FlysoftBeta/RemoteKit`；完成一批有意义的改动后提交并推送，提交说明概括最终改动和实际验证结果。提交前确认范围，不纳入无关改动、凭据、Profile、构建产物或测试包；保留远端历史，不默认 force push。
- 独立任务拆为输入、输出、文件归属和依赖清楚的子任务。有界实验明确问题、范围、资源与时间预算、成功和失败标准、产物及停止条件；实验内部允许 Agent 自主选择方法和局部实现，不逐步干预。
- 复杂任务使用 **GPT-6.1 Sol / Medium**；很简单、机械且范围明确的任务使用 **GPT-6.1 Terra / Medium**，提示词给足约束；极复杂任务使用 **GPT-6 Astra / Medium**，必要时先拆分。
- 始终不继承上下文：用户原要求 `fork_turns=0`，在当前工具中对应 `fork_turns="none"`。任务所需上下文通过提示词完整传递。
- 高耦合任务串行执行，或先由主 Agent 固定接口再并行；不并行修改冲突的文件。耦合浅、文件归属清楚的任务可以并行。
- Subagent 平时自主执行，**不要发送普通 commentary**。重要决策或阻碍及时报告并提供事实和取舍；常规内容在 final 一次交付。
- Subagent 发现任务外新问题时记录并报告现象、影响或证据位置、与当前任务的关系及是否阻塞，不自行无边界扩大任务范围。阻塞或会使当前结果错误的关键问题及时报告，其他问题在 final 集中报告。
- 主 Agent 将新问题统一记录在 `develop/docs/` 中可维护的问题清单，分类排序，不依赖会话记忆。主任务完成后自主规划、拆分并委派处理；空闲且有资源时也可安排不冲突的有界任务，不要求每个问题立即解决或等待用户逐项催促。具体实现、实验和构建由 Subagent 执行；主 Agent 可直接更新简单文档和问题记录。解决后记录结果，剩余问题保持可追踪，正式能力变化同步 `docs/current-state.zh-CN.md`。
- 父 Agent 不要频繁询问进度。等待使用较长超时，用户偏好40–60分钟；无关唤醒则继续等待，有独立工作时继续工作。不要忙轮询任务。
- 默认 non-interactive。常规选择自行决策并推进，实质性决策节点可以提问并给出等待时限。
- 默认不使用 Computer Use，不抢占鼠标键盘或切换窗口；用户需要继续操控电脑。人工测试提供操作步骤，除非用户重新明确要求代为操作桌面。

## 构建、打包与验证

```
tools\build-endpoint.cmd
python3 tools/patchset.py --chromium-root C:/src/chromium/src status
python3 tools/patchset.py --chromium-root C:/src/chromium/src apply
python3 tools/chromium.py stage
python3 tools/chromium.py build --target remotekit_browser --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
python3 tools/package-runtime.py
```

`chromium.py` 将本仓库拥有的源码复制到 Chromium `//remotekit`，保留现有输出配置。endpoint 可以独立编译；运行时 SDK DLL 从 browser 所在目录加载。

用户要求测试包放在 `develop/tmp`，从开发机复制到本机测试，避免 RDP 影响观感。默认包为串流包（含Node/Control生产runtime），完整解压运行 `run.cmd`；原生对照包通过 `--kind demo` 生成，保留Fence/native显式选择，不允许Fence失败后静默切换native。包内收集 runtime DLL/Release CRT，不带开发机 Profile、PDB 和构建输入。

按改动选择必要构建与检查，避免为可逆低影响修改添加镜像测试。此前 DPI 修复及新 GPU 路径按当时要求只完成编译；2026-11-01 串流任务明确要求大量运行实验、逐环节与 Pixel marker 延迟测量，允许 headed Chrome 89 和 metrics 上传。视觉验证使用 GPT-6.1 Sol，UI 设计使用 GPT-6 Astra / Medium；不抢占用户鼠标键盘。

区分源码实现、编译链接、协议/model 测试、Chromium 集成测试、真实硬件/IME 人工测试。旧 native 路径的测试结果不能覆盖新 GPU backend。未验证项写入当前状态，不写成“已通过”。

## 当前架构与继续工作时的注意点

下面记录的是 **当前实现选择，不是不可更改的用户需求**。详细能力及缺口以 `docs/current-state.zh-CN.md` 为准，取舍见 `docs/design-review.zh-CN.md`。

- 保留 Views/Aura 平台适配，不链接 Chrome Browser/TabStripModel/BrowserView；不能称为无 Aura、无 HWND embedder。
- 默认路径为 `/control` 产品状态 + 独立 endpoint_service + 每 Session 一个 browser 进程/atlas。原 browser harness 与原生 endpoint client 仅由显式 demo 构建目标保留。此进程布置是本轮架构选择，不是用户不可更改的限制。
- WebView 身份不依赖 WebContents。操作接受、执行中、实际完成分别报告；输入验证 Session、实例、文档、焦点、序号及可用的输出代次。
- 当前每 Session 一个 Profile，第二个明确 unsupported；多 Profile 是尚未实现的目标。
- 输出是官方 GPU capture → browser staging atlas → 三槽共享纹理 → endpoint 自有 cache。ready fence 表示真实 GPU 写完，consumed fence 表示真实 GPU 读完；capture 源 lease 也必须等桥接 GPU 读取完成后才归还。CPU 发布位、提交返回或保留 HANDLE 都不能代替 GPU 完成。
- browser ↔ endpoint 的稳定输出不得添加逐帧 ready/present/release Mojo 消息。Mojo 用于建立、配置、输入及资源重建。
- **共享内存是 Agent 选用的元数据方案，用户已追问其必要性，尚未最终要求保留或移除。** 当前只存帧信息、布局和输入状态，不传像素、不替代 Fence；不能把当前机制说成用户硬性要求。固定槽池用 Fence value 编码槽位/序号的替代方案尚未实施。
- 共享映射定义为 `endpoint/include/remotekit/shared_atlas.h`；布局变化须更新版本和尺寸断言，并同时重建 browser、SDK、endpoint。
- 完整导航恢复已接 history/PageState 和同进程 sessionStorage namespace；跨 browser 的 sessionStorage 仍未恢复。导入校验 Session/Profile/版本，POST 不自动重放。
- GPU/QSV/WebRTC 已有真实Chrome89视频与输入响应证据；正式FPS/p95、真实IME/触控、下载与资源重建的完成情况以当前状态和串流实验文档为准。动态popup、认证/证书、PDF/打印等缺口仍保留，不能视为用户放弃。
- 网页设备DPR/viewport与媒体采样分辨率分开；Endpoint GPU转换按协商接收上限等比下采样，stats记录原始/编码尺寸。客户端用实际wire RTP匹配显示代次，防止新布局命中旧帧。
- QSV当前实验选定VBR、TargetUsage 1、异步深度1；保留参数覆盖，NVENC不沿用未经硬件验证的QSV调优。普通码率Reset不重开序列；尾IDR保持正常150ms，在低fps时按源帧间隔自适应以避免风暴。
- 性能结果必须区分源、采集、编码、解码与真实canvas呈现。四个同机接收端及同步marker读回会占用共享资源；特殊浏览器flag和关闭marker的诊断结果不能冒充默认客户端或Pixel marker延迟。现有矩阵未达>50FPS/<100ms目标，继续状态见实验文档。
