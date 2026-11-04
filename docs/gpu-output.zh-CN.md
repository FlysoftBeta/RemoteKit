# Windows OSR GPU输出与资源寿命

新实现遵循[Comp / Rend契约](rendering.zh-CN.md)。编译、CPU检查与硬件运行状态分别见[当前状态](current-state.zh-CN.md)，旧capture实验不能作为新路径验收。

## 渲染与合成

每WebContents保持独立Aura/null-widget compositor。Endpoint选择空闲Slot发Begin，Browser经BeginFrameSource驱动root；Browser查询Fence的定时任务只退役资源，不产生Begin。

专用SkiaOutputDeviceRemoteKit通过DXGI SharedImage直接绘制plane目标，目标选择先于paint，轮换目标保留完整画面。无Capture、CopyOutput桥接或本地屏幕Present。每plane最多五个目标，最新内容与合成读租约分别保护，不能覆盖仍被读取的目标。

Skia Submit及EndPaint之后，ANGLE实际D3D11 context4在对应目标Fence上Signal。Browser合成context先Wait各plane Fence，再按atlas矩形缩放拼接并清除padding，最后Signal指定Slot的ready Fence。设备必须同adapter LUID。

串流服务由Endpoint Comp在启动Browser前探测硬件H.264编码器，确定编码后端和DXGI Adapter LUID，并将LUID通过 `--use-adapter-luid=<high>,<low>` 传给Browser。Rend每次创建输出都按指定LUID创建设备，Chromium把同一参数传给GPU进程的ANGLE D3D11。Comp在导入每一代共享资源前核对返回的LUID，Viz也校验绘制设备的LUID。设备不可用或标识不一致时报告错误。同一Browser运行期间固定适配器。

## Slot与编码租约

输出最多四个Slot，各有独立纹理、ready/consumed Fence和seqlock帧记录。全局快照只描述布局。metadata先发布，再排真实Signal；CPU发布不是GPU完成。

Comp核对generation/slot/value与真实ready完成，按请求value顺序交付。SDK Native buffer和硬件编码器分别持有租约；最后租约结束后Endpoint排consumed Signal，实际完成才可复用。其他Slot的高Fence值不能释放它。

内容frame_id与Slot Value分开：force重拷静态内容保留内容身份，请求Value仍变化。尾帧重新取得合法Slot，不永久持有latest租约堵住深度1。

## 停止与错误

Control与render使用不同pipe，control关闭回复不证明Begin已处理。render同FIFO的Stop/Stopped确保之前请求都有Reject或已经排Signal。Endpoint处理前序Reject后关闭通道；成功请求仍等GPU及编码租约。

Stopped不代替Fence。超时、未知断链或失败提交不得伪造Reject/consumed。旧generation独立保留；device removal的UINT64_MAX是故障，不是正常完成值。正常host销毁也必须保留仍有GPU写入的backing。

NVENC任务/EOS保留有界等待与隔离，未知完成保留实际输入资源。当前无NVIDIA硬件，CPU/编译证据不代替NVENC运行。

## 几何与测量

页面DPR、DIP、plane实际pixel、atlas矩形与编码采样分别记录。WebRTC只缩放完整atlas，mediaScaleX/Y传播轴向取整，布局/输入/marker/caret使用对应比例。换代经过Client屏障，旧编码结果不能使用新布局身份。

新路径暂以capture_time_us=0表示未测完成时戳，不以提交、Flush或ACK伪装GPU完成；对应延迟样本省略。Pixel marker、编码时间和客户端呈现可独立测量。

显式原生demo保留native窗口呈现；旧capture fence demo不再支持，不自动回退。正式streaming包使用新OSR/Fence路径。
