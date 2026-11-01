# 完成观察任务为何迟到：CrGpuMain被DXGI Present占住

2026-11-01，在已保存的新boot trace中定向复核3个慢request，没有重跑GPU实验或修改策略。

**独立高优先级同线程观察任务不能解决本次主要阻塞。** 到期到执行之间几乎全被已有CPU任务scope覆盖，长scope内部是DXGI Present；优先级不能抢占已经执行的驱动调用。下一对照应优先移除串流source browser的本地DirectComposition呈现路径，而不是调整surface的2ms轮询。

## 同request证据

样本均来自 `develop/tmp/copy-profile-reboot-1080x4`。精确task flow连接post/run，以requested delay计算due；统计同PID/TID现有RunTask scope与due→run区间的交集，scope互不嵌套。thread_name明确为CrGpuMain。

| Session/counter | 到期→执行 | 由RunTask覆盖 | 最长RunTask墙钟/线程CPU | 内部DXGISwapChainImageBacking::Present墙钟/线程CPU |
|---|---:|---:|---:|---:|
| S2/341 | 87.710ms | 87.590ms | 86.845 / 2.879ms | 84.290 / 0.376ms |
| S3/255 | 153.504ms | 153.408ms | 152.501 / 5.909ms | 147.837 / 1.380ms |
| S4/229 | 137.464ms | 137.361ms | 137.040 / 5.522ms | 131.914 / 0.465ms |

S4长任务为 `gpu/command_buffer/service/scheduler.cc:654` 的RunNextTask，内部是Scheduler::RunTask → SkiaOutputSurfaceImplOnGpu::SwapBuffers → SkiaOutputDevice->ScheduleOverlays（num_overlays=1）→ DXGISwapChainImageBacking::Present（dirty_rect=6,6 2880x1620、has_alpha=true）。最晚观察任务在它退出后运行。

这证明deadline期间GPU主线程逻辑上忙于已有任务，CPU时间远小于墙钟，符合驱动/同步阻塞或该scope内线程被换出的情况。原trace没有同区间CSwitch/ReadyThread，不能单靠tdur把这些时间全部断言为驱动sleep；但已无需用“消息队列失去唤醒”解释主要137ms。原ETW是另一boot/另一组，不作为这里的线程调度证据。

精确scope、CPU时间和覆盖数据保存于 `observation-task-queue.json`；提取脚本为 `develop/tmp/inspect-observation-queue.py`。

## 调度与完成调用链

源码根目录 `C:/src/chromium/src`：

- `gpu/ipc/service/command_buffer_stub.cc:130–139`：命令IPC有SchedulerTaskRunner，但delayed-work timer用 `channel_->task_runner()`。
- 同文件 `240–280`：ScheduleDelayedWork在已有timer运行时Stop/Start，使用PRECISE绝对deadline；它只在pending query/idle/poll工作存在时保持timer，deadline不是抢占保证。
- 同文件 `190–228`：PollWork→PerformWork→MakeCurrent→idle work→ProcessPendingQueries(false)→PerformPollingWork，最后安排下次工作。
- `gpu/command_buffer/service/raster_decoder.cc:1101`：RasterDecoder MakeCurrent使用对应SharedContextState并维护Skia状态；`1349–1356`：ProcessPendingQueries先调用该context的Skia checkAsyncWorkCompletion，再处理query manager。这是PerformWork内可以完成本次Ganesh请求的一条直接源码路径；本次trace没有decoder身份，因此不把它写成唯一实测入口。
- `third_party/skia/src/gpu/ganesh/GrDirectContext.cpp:527` → `gl/GrGLGpu.cpp:4620` → `gl/GrGLFinishCallbacks.cpp:31`：检查真实GL sync，只有testSync成功才消费callback；本任务没有改变这个完成条件。
- `components/viz/service/gl/gpu_service_impl.cc:216,520`：channel runner来自GPU主线程当前默认runner；`content/gpu/gpu_main.cc:310–316`在Windows创建DEFAULT SingleThreadTaskExecutor。
- `base/task/single_thread_task_executor.cc:43–58`：默认queue。`base/task/sequence_manager/task_queue.h:138–142`的默认priority settings仅一个Normal级别。因此添加真正base高优先级queue还要在executor/SequenceManager创建层扩展priority设置和向下传递runner，不是改一个PostTask优先级；GPU Scheduler的sequence priority是另一层，不能抢占正在运行的任务。

若将来测试独立capture观察器，必须留在持有GrDirectContext的GPU线程/序列，MakeCurrent正确，按pending计数有界唤醒且取消生命周期受控，继续依赖真实sync判断。新线程直接访问当前GrDirectContext或跳过MakeCurrent不可行。但就本次证据，这不是优先实施点。

## Present范围和backing来源

`gpu/command_buffer/service/shared_image/dxgi_swap_chain_image_backing.cc:240–290`：

1. Present1的interval固定0，tearing flags来自现有配置；并非代码显式要求等待vblank。
2. Present1之后，first_swap分支EnqueueSetEvent并同步event.Wait，以避免首次DComp呈现黑闪。
3. 当前外层Present trace覆盖两段，缺first_swap/mailbox标识，不能区分Present1阻塞、首次等待或反复重新分配backing。

最小诊断改动是分别给Present1与first-swap Wait加scope，并记录mailbox/size/first_swap/flags/HRESULT，保持参数和生命周期不变。

`components/viz/service/display/skia_renderer.cc:3737–3757`对普通scanout render-pass/root backing添加SCANOUT_DXGI_SWAP_CHAIN；`gpu/command_buffer/service/shared_image/dcomp_image_backing_factory.cc:64–70`据usage创建该backing。当前fixture是canvas动画，慢scope位于唯一root overlay调度链，尺寸2880×1620是本地呈现尺寸，不等于capture输出1920×1080。当前缺mailbox连接，因此不声称已用ID证明具体render-pass/backing。

不能把capture backing直接换成DCompSurface：`components/viz/service/display/overlay_processor_win.cc:55–69`明确在HasCapture时force swapchain，因为DCompSurface不可读回。

## 最小可控对照候选

首选现有标准 `--disable-direct-composition`，只给串流Session source browser传入。`ui/gl/direct_composition_support.cc:720`据此跳过DComp初始化；`components/viz/service/display_embedder/skia_output_surface_impl_on_gpu.cc:2200–2213`表明DComp关闭时可走SkiaOutputDeviceGL常规GPU输出。它没有禁用GPU，也没有直接触及官方CopyOutput/shared-image/Fence路径；是否达到预期必须用真实视频、request阶段和Present scope消失共同验证。此选项是该browser进程范围，原生demo和接收端Chrome89可以保持原配置。

另一个现有feature为BufferQueue：`components/viz/service/display/output_surface.cc:98`要求DCSupportLevel至少DCompDynamicTexture，才接受 `--enable-features=BufferQueue`；SkiaRenderer用纹理buffer queue代替直接root swapchain。它依赖本机能力且会改变缓冲策略，本轮未假定支持、未选定实施。

若之后要收窄产品行为，条件应放在串流source browser的GPU输出初始化/选择点，或capture专用可读backing策略，不能在Present内跳过首次同步、强行DO_NOT_WAIT或破坏swapchain提交生命周期。先由主Agent选定一个有界对照，再实施。
