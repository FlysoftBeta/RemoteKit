# Windows GPU atlas与资源寿命

服务端无页面HWND，Aura/null-widget compositor直接合成离屏内容。Browser本地external BeginFrame只负责调度；没有屏幕Present，也不把调度ACK当GPU完成。

## 当前路径

| 阶段 | 路径及所有权 |
|---|---|
| 捕获 | 单plane/DPR1等满足条件时，Viz直接写三个拥有CSI的共享atlas目标；不支持的几何使用官方capture/桥接fallback |
| 发布 | 真实GPU finished后才发布可读帧，Browser signal ready；布局/序号通过共享元数据传递 |
| 消费 | QSV/external/depth1的auto输入租用共享BGRA；显式auto encoder及其他不兼容组合用copy/cache |
| 转换与编码 | D3D11 NV12转换、oneVPL异步或NVENC各保留真实lease；硬件完成后释放 |
| 归还 | 只有实际GPU读者完成、租约释放且对应consumed/done证明成立，producer才复用槽 |

Fallback可能包含capture→staging→共享槽copy；single-plane优化可减少中间阶段。它与直接Viz写共享目标是不同路径，不能用配置名称替代实际stats。两个端点使用同adapter LUID。

固定三个输出槽，满时合并/跳过，不无限排队。共享输入不能因编码器异步返回就提前释放；COM引用只保留对象，不防止池覆盖。静态保留最后有效内容，尾IDR最多一次；多plane仅对当前有效布局授权。

## 完成与故障

Capture源lease与共享输出槽是两个完成域。fallback中capture资源须等桥接GPU读取完成再归还；输出槽须等Endpoint完成读取。直接目标在新的绑定/池代次建立新的纹理，不能把旧写入复用到新geometry。

共享映射ABI为`endpoint/include/remotekit/shared_atlas.h`的version2；用seqlock发布一致布局和时间戳，不存像素。ready/consumed值保护实际GPU操作，CPU发布位、提交返回、保留HANDLE及Fence的UINT64_MAX都不代替完成。

按generation独立退役，健康代可以结束而不被另一未完成代阻塞。已经观察过的同State等值真实完成证明可以复用，未知更高终点不能放行。GPU失效与Browser进程实际退出是不同证明；退出清理绑定真实进程对象，不靠可复用PID。

reconfigure、fatal、空内容及暂停立即发新epoch空layout，清Client ready/输入，再按状态关闭/重建输出。正常GPU匿名断连支持有界自动重建，真正fatal保留错误。关闭有等待上限，不能为通过测试伪造consumed。

捕获调度的Oracle计数与GPU完成证明也分开：每次`RecordCapture`对应一次`CompleteCapture`，失败读回、目标换代或进入GPU前取消都必须结算失败。否则pending计数会阻止无新damage的静态刷新，导致resize后一直空layout；失败结算不会发布像素或伪造Fence完成。该修正在0007补丁中统一处理，成功交付与Oracle拒绝也不能双重结算。

正常Stop/销毁与帧交付分属不同Mojo pipe。0007的host在停止atlas consumer时，将尚未派发的receiver交给独立drainer，保留并排空队列，对从未前递给Browser消费者的帧显式`Done`。这些帧只在producer实际GPU finished后才会进入`OnFrameCaptured`，drainer不读写或发布像素，因此没有提前越过GPU写完成。已经前递的lease仍等原来的真实consumed Fence；未知delivery断开仍封存池并报fatal。Viz处理Stop后发送`OnStopped`并关闭consumer remote，或capturer销毁/transport断开后销毁drainer；无响应Viz下不设定时假Done。排空之前消息可持有texture handle等资源，排空后drainer只保留pipe，不持有GpuAtlas State或Endpoint。生产路径CPU回归目标为`remotekit_capture_delivery_probe`；源码修复的构建与真实导航验收结果另行记录。

0011保护ExternalBeginFrameSourceMojo的调度请求归属：early NAK可能先结束A的控制回调，A的Display interval却在GPU恢复B时才结束。迟到的A不能写入B的pending ACK或修改B的sink集合。实现按完整frame ID保存最多8条明确退役记录，满时保持当前请求等待真实调度完成；内部admission序号仅用于回收已有记录，不能据此接受未知ACK。回调前先分离旧状态，防止重入的新请求被旧调用尾部清理；未知、未来及当前请求重复完成仍保留检查。这些是调度生命周期保护，不释放纹理租约，也不构成GPU Fence完成证明。

NVENC任务及EOS有5秒完成等待截止；无法证明GPU完成时，将编码器和实际输入资源留在进程级有界隔离区，禁止后续复用，不伪造consumed。隔离后的NVENC新建会明确失败，需Endpoint重启；正常关闭仍使用厂商API，其内部耗时不能由这些CPU测试保证。当前机器没有NVIDIA硬件，本轮证据限于生产等待/资源持有helper与故障注入。

## 几何、节拍和通信

页面DPR、实际backing、atlas像素、编码采样比例分别报告。默认service atlas按16对齐；显式1保留给控制变量。产品窗口尺寸来自真实CSS内容区，设备UA不改变viewport。Client输入要反算DPR/mediaScale/letterbox，并验证layout epoch与实际wire RTP。

Browser内部捕获和Renderer/Viz/GPU IPC照常存在；browser↔Endpoint仅建立、配置、输入和资源重建走Mojo，没有逐帧ready/present/release。Client帧元数据随WebRTC DataChannel，是另一边界。

Fence保证顺序，不消除排队。capture begin→end包括请求、GPU工作和完成观察；本项目capture_time采用end，capture-end→ready不包括此前捕获阶段。GPU实际执行、CPU等待、编码和呈现分别计量，见[测量](streaming-experiments.zh-CN.md)。

UHD630实际链路已验证；NVENC本机无NVIDIA硬件证据。原生demo独立构建，不能用它的窗口呈现结果覆盖服务离屏路径。[当前状态](current-state.zh-CN.md)集中列验收与限制。
