# Root捕获候选：合并页面与最终离屏pass

状态：默认关闭的RemoteKitCaptureRoot候选已实现。结构trace确认两个pass合并为一个root pass，实际1920×1080/sample1、CRC正确；resize、DPR2回退child再恢复root及输入检查通过。profile-off两租户adaptive on为37.50/34.89FPS、p95 104/108ms，仍未达目标；固定55反而饱和。继续保留可选路径，下一对照减少接收端snapshot复制，不将结构改进本身视为性能目标完成。

当前每WebView有独立离屏Aura宿主。捕获器瞄准RenderWidgetHostView子FrameSink，trace每帧出现页面约6quad的独立pass，以及将页面贴到root的单quad pass。捕获请求可能阻止页面pass合并到root；最终root没有物理显示用途。这不等于已证明第二pass昂贵。

候选改动是将该WebView捕获目标切到自己的offscreen compositor root FrameSink，保留现有FrameSinkVideoCapturer、native GPU导出、共享槽、ready/consumed Fence与租约回收。让SurfaceAggregator在可能时把页面quads合并进最终root，输出仍经原捕获链路。相比直接自定义SkiaOutputDevice导出纹理，该方案不改变跨进程像素和同步协议，验证范围更小。

首个实验必须满足：

- 默认关闭，明确报告当前capture target及fallback原因；不得修改原fixture或降低分辨率。
- 先验证DPR1、单WebView独立root，root输出与页面backing像素尺寸一致。页面DPR正确并不证明root像素正确。
- HiDPI/设备模拟可能让页面backing大于DSF1 root；在证明root保留完整像素前不得启用此路径，不能先缩小再放大冒充原分辨率。该场景保留原child捕获。
- 捕获region必须准确覆盖WebView，包括必要的popup/透明区域；输入坐标仍按现有viewport/atlas映射，不能把root物理坐标当页面DIP。
- 新root或FrameSink重建、resize、导航与恢复都要正确重新绑定；不能让旧root画面通过新epoch gate。
- 静态停止、新订阅refresh、tail IDR与背压语义不变，不新增稳态browser↔endpoint逐帧通信。

验证先检查pass数量和实际SkSurface尺寸/格式、完整CRC/几何，再做profile-off同配置性能对照。若仍有两个pass、出现额外缩放或输入偏移，先报告具体原因，不以切换API本身当作优化完成。

其它独立候选继续保留：减少接收端snapshot复制、Endpoint私有BGRA cache复制。不得把几个改动同时堆入首轮对照。
