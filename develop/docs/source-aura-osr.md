# 每页 Aura 离屏宿主实施与验证

## 结果

服务端已改成每个 WebView 独立的无页面 HWND Aura 宿主，真实 GPU capture、H.264、远程输入、混合 DPR 和 GPU 进程恢复已跑通。默认输出帧率仍为 60。单租户编码加快、marker p95 降低，但四租户最终画面更慢；本轮没有达到 >50FPS/<100ms，也没有把源端 FPS 增长记作最终收益。

## 实现

`browser/offscreen_host.{h,cc}` 复用官方 Headless 的 WindowTreeHost、FocusClient、ParentingClient 契约。Compositor 创建时启用 external BeginFrame，AcceleratedWidget 从始至终为空；不创建 source Views Widget。每页根在自己的原点，atlas 位置只进入既有 GPU packing。

服务模式独立 Screen 固定 DSF=1。宿主像素=内容 DIP，页面 DPR 和 capture scale override 仍由现有设备仿真配置。例如平板宿主 820×1180@1，而实际 renderer 提交 1640×2360@2。native demo 继续使用原窗口/显示器 DPI 路径。

本地 pacer 按现有输出 fps 配置发送 tick，每 host 最多一个未 ACK tick，合并逾期 tick；未订阅、隐藏和卸载时停止，恢复/resize 后继续调度。ACK 只用于下一 tick admission，不替代 GPU fence、捕获 lease 或 consumed fence。

每个 host 通过官方 `StubBeginFrameSource` allocator 获取独立 source_id；sequence 在浏览器 UI 序列递增。最初共用 kManualSourceId 的双 host 复现已修复：Viz 的全局 FrameSinkObserver 按 source_id 跟踪，原先会把另一根的未完成帧记入当前根并报 overlapping IssueExternalBeginFrame。现在两个 host 分别是 source_id 0/1，未修改 Viz 全局规则或 ACK 语义。

断连回调使用官方 default-invoke 包装，并以 host/controller 代次和 sequence 校验；旧代回调不能清除新代 pending。WebContents 销毁期间保留 Aura 父链，随后 DeleteSoon 宿主，避免同步 Mojo 重入。Fence 池、capture lease、GPU 写入/读取完成条件和输入 epoch 保持原边界。

Windows 的 InputMethodMinimal 仍为抽象类，缺少本地 IME/locale 的四个 Win32 入口，因此使用官方 headless 同款 MockInputMethod，在 AddChild/Focus 前注入，不懒建 WinTSF。远程 composition 继续到真实 focused RWH，保留 TextInputManager 路径。

Endpoint 参数 `--browser-render-host=offscreen|window` 默认 offscreen，严格校验；prepare 对应 `-BrowserRenderHost` 并规范小写。window 仅作旧宿主诊断。0003/0004 历史 Feature 均不参与新路径，所有本轮实播均关闭。prepare 保存实际命令、二进制/patch 清单和 Client assets 指纹。另修复子进程继承日志 HANDLE 的接线，GPU/renderer CHECK 现在进入同 Session browser.log。

## 功能证据

原始数据均在 `develop/tmp/`，失败/早期 case 原样保留。

| case | 已验证结果 |
|---|---|
| osr-aura-single720-first | Chrome89 H264；初始 hover 不改变焦点；真实点击 marker60001；IME marker42；1280×720@1；90 sent/90 ACK |
| osr-aura-edges | desktop1920×1080@1、tablet1640×2360@2 的真实 RenderFrameMetadata；四角视频像素；右下鼠标 source1904,1064、touch803.94,1164.17；静态最后变化、IME92、reload |
| osr-aura-live-fixed | 两个 host 同时动画；8组单/双页、desktop/tablet、snapshot/direct 切换；旧 epoch 被拒绝；无 stale paint |
| osr-aura-mixed-fixed | test adapter 将第二页配置为 tablet；desktop1920×1080@1 与 tablet1640×2360@2 同时提交，宿主 DSF 均1；视频 touch32769、中文 composition/commit91；每 host239 sent/239 ACK |
| osr-aura-oopif-accepted | 127.0.0.1 主文档、localhost iframe，renderer PID8680/19356；真实视频/DC 点击；iframe 中文 composition/commit；回主文档输入；再回 iframe；离开 canvas 无拒绝 |
| osr-aura-gpu-recovery | 核验后终止当前 source GPU1708；有 pending 的 controller 断连后 generation1→2、cancelled1，继续1752 ACK |
| osr-aura-gpu-recovery-full | 同一 Chrome89 连接终止 source GPU19116→1544；解码35→181；恢复后的真实点击/IME同 RTP视频 marker88；共享资源 generation/epoch 均保持1，encoder 无错误 |

混合、OOPIF 中文及 GPU 恢复截图已由 Sol 检查。混合 atlas 的媒体下采样与页面 backing 分别记录，未以视频尺寸代替 renderer 实际提交尺寸。

OOPIF 验收 fixture 的 focusReport 参数通过页面自身状态反馈真实 DOM 焦点，避免把鼠标派发完成误当作 renderer 焦点已经更新。早期工具错误包含未等待 HTTP fixture 就绪、异步 waitForFunction 谓词，以及事件历史 title 超过128字；这些 case 未列为通过。

## 页面 HWND 与原生呈现

`osr-aura-edges/windows.json` 枚举到一个隐藏 Chrome_WidgetWin_0。通过只读 GWLP_USERDATA/ReadProcessMemory 取得对象 vtable，精确匹配当前 ui_gfx.dll 基址 + PE .rdata RVA + PDB `gfx::SingletonHwnd` vtable 地址；`window-object-proof.json` 保存相等结果。这是 Chromium 广播消息辅助窗，不是隐藏页面窗。其余枚举项为 OLE、PowerMessage、Chrome_MessageWindow 等辅助窗口。页面宿主代码自身不调用 CreateWindow/Views Widget，snapshot 始终 null widget。

16秒官方 trace `osr-aura-edges/official-trace/` 包含1131次 ExternalBeginFrame、22次 DrawAndSwap/Skia SwapBuffers；无 DXGISwapChainImageBacking Present、NativeViewGLSurfaceEGL Present/PostSubBuffer scope。通用 Skia SwapBuffers 是离屏纹理路径的 swap/ACK，不能据名称误判为屏幕 Present。

旧路径 pair 的窗口枚举另有可见 source 页面窗（坐标在屏幕外），且实际命令带 `--remotekit-render-host=window`。新路径四个 Session 的 host-snapshots 和窗口枚举分别保存，确认没有误把两个模式跑成同一路径。

## 有界性能对照

同新 browser/service 二进制，默认60fps；1/4×1080、d1/TU1/VBR、snapshot、capture cap/gate off、每 peer24Mbps/RTT10ms、marker1Hz、5秒暖机+20秒采样；DComp/host scale auto；0002/0003/0004、官方及媒体/server trace 均关闭。没有其他 GPU 实验或构建并发。

| 负载/宿主 | source RAF fps | GPU atlas copy fps | encode/decode fps | 实际 canvas fps | marker p95 ms | GPU3D均值 |
|---|---:|---:|---:|---:|---:|---:|
| 1×1080 window | 32.0 | 32.0 | 32.0 | 31.6 | 186 | 69.8% |
| 1×1080 offscreen | 36.4 | 36.4 | 36.4 | 29.3 | 155 | 68.6% |
| 4×1080 window | 18.0–18.6 | 17.8–18.3 | 11.2–11.9 | 7.0–7.8 | 976–1196 | 99.2% |
| 4×1080 offscreen | 32.6–34.3 | 19.5–21.4 | 11.0–11.9 | 5.9–6.3 | 1377–1435 | 99.8% |

1租户 pair 为 `osr-perf-1x1080-{window,offscreen}`，同 Client index-xQ5vfaPv.js SHA256 3ba9ed15ae27514e1c027a81a4d728e441a9edf4728f3efcebcf83a8208f1ef4。offscreen 页面 timeOrigin 为04:56:53 UTC，最终 Client build 到04:57:28 UTC才写入，因此两页已加载同旧 bundle，采样中无 pointer 操作/错误。

4租户 pair 为 `osr-final-4x1080-{window,offscreen}`，同最终 Client index-Bsj1jkWQ.js SHA256 682c9bfa08d6c9e208641d83843b2ea5d4df03389aedbde99c40d14ad84c361c。跨 Client 版本不配对。额外完成的 `osr-final-1x1080-window` 是未配对样本，不纳入上述结论。

marker 读回也占共享 GPU/CPU：单租户 readback p95为16.1/17.9ms；四租户 window 为396–447ms，offscreen 为296–496ms。四个同机客户端的读回显著拖慢 callback，结果代表这套实际测量条件，不能把全部 p95 余量归给 source。全部客户端报告 visible，relay无丢包、receiver PLI/loss增量0。

关闭诊断 profile 后 capture callback 单独 FPS 未采样，表中 GPU atlas copy 是最终共享输出的帧率，不能冒称原始 capturer callback。source RAF/实际 render、copy、encode、decode、canvas 原始字段分别保留在 summary/metrics 中。通用 matrix 工具遗漏 paint 字段，本表取真实 `metrics.displayFps`。

四租户 source renderer CPU0.84→1.25核、source GPU进程0.88→1.17核，最终 encode 未增加。新宿主消掉页面 Present 后允许更多源提交，GPU仍满载，最终延迟更大。该结果支持继续研究真正的源提交预算/帧率与输出吞吐关系，不能据此声称 OSR 已完成性能优化。按主 Agent 指示没有追加矩阵。

## 构建、边界与收尾

统一增量构建 browser/demo/SDK 成功，Endpoint Release package 成功，SDK 已重新导出；patchset四项均 applied，默认 Feature 状态未变，diff check通过。未 commit/push。

真实拖出 canvas 后松开被 Host Playwright 的 Input.setInterceptDrags 命令阻塞（Chrome89没有该命令）；真实 touchCancel没有使用附加 CDP触控，因此这两项保持为 Client单元/协议覆盖，不能写作真实硬件通过。真实 touch start/end、右下输入和远程中文 composition 已有视频证明。当前 Client边界修补由delivery负责，不修改browser校验。

所有本次 source/endpoint/Chrome89与fixture辅助进程均已按本case身份清理。最初停止+启动组合命令被自动审批拒绝；后来独立核对PID/父进程/创建时间/完整路径与命令，再单独使用PowerShell清理成功，无残留。原始数据保留。
