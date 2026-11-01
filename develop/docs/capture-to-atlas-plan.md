# 捕获直接写入共享 atlas：实施决策

2026-11-01。主 Agent 根据[源码审计](capture-destination-audit.md)选定下一候选，尚未实现或实测。目标是省去capture输出到browser共享槽的整幅复制；保留CopyOutput的root surface→目标绘制，不宣称完全无capture开销。

## 选定机制

采用一次配置三个DXGI GMB handle、由Viz创建owning ClientSharedImage的固定目的池。新增默认关闭RemoteKitCaptureToAtlas候选，先限Windows、GL/Ganesh、单WebView、root捕获、DPR1。其它布局/DPR在配置前显式选择原Fence capture路径。普通池不变，不自建SkiaOutputDevice，也不使用Viz未实现的ImportSharedImage或Update外部Fence接口。

保留原1920×1080可见像素、1936×1088 atlas和真实布局偏移。专用VideoFrame的coded size为atlas、visible rect为atlas中的WebView区域、natural size为viewport。BlitRequest使用现成目的图像和kLetterbox清padding；不改变resolution constraints去缩放页面。固定池只有三个资源，无空位即背压，禁止另分配第四个。DXGI token在clone后保持，用于回调识别本代slot，不增加逐帧browser↔endpoint通信或修改共享/SDK ABI。

## 生命周期与完成条件

- 可以保留首个普通capture作为adapter bootstrap；它不作为直写成功。拿到device后建立本代新三槽，再一次配置Viz。
- Viz固定pool-generation state持有owning CSI及Context/SII；所有在途FrameCapture和VideoFrame释放回调持有该state。Stop/OnStopped不等于GPU drain，不能用裸pool指针或先释放Context。
- 仅真实成功GPU finished结果可以发布。必须区分正常完成、context lost/abandon、output surface销毁及flush失败；不能只看到回调被调用便算完成。首轮限定GL/Ganesh，Graphite不以忽略CallbackResult的路径启用。
- 正常完成返回browser后，只在现有D3D immediate context排ready Signal和Flush，不做像素Copy。此处成立的依据是Viz写入已经实际完成，随后ready本身也由GPU执行。
- 已发布capture lease保留到Endpoint consumed实际完成才Done；未发布且GPU已完成的结果可直接归还。尾帧、latest和Endpoint共享输入原有所有权不变。
- 禁用专用池的marked-frame resurrection，使用真实新CopyOutput处理必要refresh，先避免额外marked引用占住三槽；普通capture行为不变。
- 每次pool/target/binding替换或直写与fallback切换，必须使用全新的三槽资源与输出generation，即使尺寸相同。旧Viz请求可能仍在写，不能将相同三纹理交给新池或旧copy路径并行重用。旧代保持真实读写所有权直到完成/明确设备移除。
- Viz重连不得自动把旧三槽当全空闲池重放；通知browser失效并重建新代，期间不得普通capture冒充直写成功。

## 实施与验收顺序

实现、patchset管理及增量编译先完成，root审查生命周期后再由独立实验任务实跑。接口涉及capturer Mojo/host wrapper、专用固定池与Context导入、完成成功性、browser GPU atlas；不改Endpoint、Viewer或fixture。Chromium改动生成新的有序patch及hash，验证重放与撤回，复用out/dev，所有CPU cores，不与GPU计时并行。

状态必须区分requested/bootstrap/configuring/active/fallback/failed，记录原因、实际尺寸、token/slot、lease和真实copy/直写数量。运行中失败停止本代并走重建，不静默回退掩盖失败。

功能先验证像素CRC、四角/IME、静止/尾IDR/恢复、慢消费者背压、resize、同尺寸导航/target替换、DPR2及multi-plane往返、GPU进程故障与恢复。特别验证旧代没有写新槽、pool不分配第四槽、Stop不提前归还Endpoint仍读的槽。通过后按原条件fixed52两租户10+45秒，完整测GPU归因/逐环节FPS/同组marker。性能未测之前不计入收益。
