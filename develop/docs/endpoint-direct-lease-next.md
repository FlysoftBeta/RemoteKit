# Endpoint direct shared-slot lease 可行性

2026-11-01，只读调查；未改生产源码、未构建、未启动GPU。供主Agent选择下一实验。midstream NULL-drain probe仍等待独占窗口。

## 结论

external D3D11 VPP直接读browser共享BGRA槽在设备接口上可行，能省每个新atlas一次全幅BGRA CopyResource；实际共享纹理能否创建VP input view仍要本机验证。**不能把AtlasPool返回纹理换成shared slot，再在Convert返回时无条件Signal consumed。** 现有MediaLoop latest、SDK TextureBuffer和Worker各自持有可再次读取的像素lease，不能只看一次VPP读完。

不改共享ABI、SDK ABI和三槽数量，可以做保守的“所有引用结束后有序归还共享槽”候选；它会把SDK排队、编码完成、latest留存的背压直接传播给browser，不能承诺比现有private pool更快。要达到“VPP读完就归还共享槽，同时尾帧/刷新仍可重读”的目标，需要将最新像素留在Endpoint自己的NV12或按需BGRA快照，并调整Endpoint内部提交/格式/lease边界。这不是只删一个CopyResource。

当前没有Endpoint private copy的独立GPU耗时，不能将Endpoint 23.53% 3D全部算作copy收益。四租户external实测source-gpu 53.22%、source-browser 11.01%、Endpoint 23.53%、receiver 12.00%，总3D 99.76%；源侧仍占大头。源数据见[qsv-async-runtime.md](qsv-async-runtime.md)。

## 当前设备、context和完成边界

| 边界 | 现有实现证据 | 对direct的含义 |
|---|---|---|
| AtlasPool设备 | `endpoint/src/media/atlas_pool.cpp:104–147`：按producer LUID创建device；后续generation复用device和其immediate context；OpenSharedResource1导入三槽 | 不是每槽/每generation新建设备 |
| Worker设备 | `endpoint/src/service.cpp:561`将`encoder_device=pool.Device()`；CreateEncoder约501行传同一对象；Worker Configure约71行传converter | AtlasPool、external converter、编码backend实际收到同一D3D11设备 |
| context | `gpu_device.cpp:34–40` Nv12Converter::Open调用该device GetImmediateContext；AtlasPool也GetImmediateContext | 是同一个immediate context的不同COM接口；没有额外deferred context。`CreateDevice:31`启用multithread保护，但不使多次API组成的命令批自动原子化 |
| 当前shared读完 | `atlas_pool.cpp:230–238`：Wait(ready) → CopyResource(shared→private) → Signal(consumed, source ready value) → Signal(private done) → Flush | consumed当前真实覆盖shared copy读。私有pool refs可以继续存活，不再占browser槽 |
| 当前VPP读完 | `gpu_device.cpp:78–114`：VideoProcessorBlt → Signal(local fence) → Flush → event等待并检查真实completed | Convert成功返回可证明本次BGRA读取完成；不需要等NV12编码结束才能结束这一次shared GPU读 |
| 当前Worker释放 | `encoder_worker.cpp:125–145`：编码最终packet completion后才release frame；busy可能重新入队并重做Convert | 直接共用现有release回调会延迟到编码结束；若提早归还shared却保留同Job重试，可能再次读已覆写纹理 |

共享纹理本身由`browser/gpu_atlas.cc:482–502`创建，BGRA、DEFAULT、单sample、SHADER_RESOURCE|RENDER_TARGET、SHARED_NTHANDLE|SHARED。与private BGRA主要区别是共享标志；现有API路径没有要求先copy到非共享纹理。仍须实际CreateVideoProcessorInputView和色值/边缘验证，不能用同device推断驱动一定接受。

同context还意味着一个真实风险：AtlasPool若提前把尚未ready的新槽GPU Wait入队，可能堵住已经就绪旧帧的VPP。旧ready-gate实验已经观察到这类阻塞。direct方案可在CPU观察ready后才提交VPP，或由单一提交owner统一排序；不能为了零copy把这个等待重新隐藏进去。

## 现有像素所有者，不能只保留COM对象

1. `service.cpp:742–743`：每个fresh frame额外retain成为`latest`，直到下一fresh替换或MediaLoop退出。没有连接、暂停、静态等情况下仍可能长期保留。约755–781行的首次发送、refresh和tail会重新提交latest；TailRefreshLease还转发底层retain/release。
2. `browser/sdk/remotekit_rtc.cc:90–109` TextureBuffer保存原frame和texture，析构时调用release。它经过WebRTC source/encoder队列，到Encode才向Worker借出。队列是否仍会读取不能由Worker一次Convert结束代替判断。
3. `encoder_worker.cpp:86–112` Enqueue有独立retain与COM AddRef。pending只保留最新；busy重试也可回队。Complete或明确取消才归还。
4. `sdk/include/remotekit_rtc.h:44–62`声明texture在release前immutable，编码回调另持GPU lease。这是像素有效性契约；COM AddRef只保对象存在，不阻止browser覆写。

因此“VPP完成，给Worker删掉frame.release，立即Signal consumed”仍留下latest与SDK可读取的旧像素指针；保留一个新的CPU对象或HANDLE不能补足它。反过来若每次只等总refs归零，安全性可以保留，但latest和SDK延迟会挡住累计consumed推进。

## 累计consumed必须按安全前缀推进

browser `gpu_atlas.cc:812–824`用`completed >= slot_values[i]`决定重写槽。value不是单槽独立ack，Signal较大值会同时放行所有更早值。

具体反例：A的value=100仍在VPP或SDK排队，B的value=101尚未提交GPU、被pending替换。若B的release直接Signal(101)，A的槽立即变成可重写，即使A的COM和lease对象仍在。即使A不在GPU中，只要latest/SDK还允许将来读取A，也不安全。跳帧并不能改变这个比较规则。

Endpoint最小有序退役账本应按generation与实际观察的ready value记录：source slot、immutable metadata/cookie、CPU持有数、是否可能再提交读、所有已提交GPU读的完成条件、是否无读丢弃。release只能标记候选退役，不能自行Signal自己的value。唯一owner从最老未退役记录向前检查，只有整段均已不可能再读且已提交读均完成，才Signal最大的安全前缀。未观察的publication可以跳过，但必须证明没有本进程持有的更老未完成记录；producer ready值可能因其他操作有洞，不能假定逐个整数连续。

累计值只能单调增加。早到的B完成等待A，不能先Signal B再补Signal A。多Worker/SDK回调线程只入本地完成队列，generation的State保活与关闭屏障应和当前retired机制一起处理。Signal失败或VPP无确认完成时保留GPU读取与State；不能当普通drop。已开始读的源必须等真实fence完成；从未提交读的pending可放弃，但仍需遵守安全前缀。

实现可在CPU确认VPP fence后Signal consumed；也可在GPU队列中将Signal放在全部较早真实读取后。后一种做法必须统一提交/退役排序并排除未来重读，不能凭同一context且有multithread保护就把跨线程API调用视为整个批次有序。

## 两种边界及最小文件范围

| 接口候选，未作架构选择 | 最小边界与代价 | ABI/槽数 |
|---|---|---|
| 保留现有BGRA frame语义，直接租用shared槽，最后一个真实引用结束后按安全前缀退役 | `atlas_pool.{cpp,hpp}`增加shared lease账本、ready导入/完成/retired生命周期；`service.cpp`加显式实验选择和stats；Worker原有完整lease可保留。共享纹理VP view需要实测。编码/SDK/latest都继续占browser槽，可能降低吞吐 | 不必改SDK/shared ABI；三槽安全但会背压。深度4不可能同时拥有四个独立shared BGRA输入，不能假装仍获得原来private pool容量 |
| VPP后即归还shared槽，Endpoint持有自己的NV12用于SDK排队/编码/latest/tail | 至少`atlas_pool.{cpp,hpp}`, `gpu_device.{cpp,hpp}`, `encoder_worker.{cpp,hpp}`, `service.cpp`。需要在SDK可长期持有的frame建立前完成格式/所有权交接，或建立明确的Endpoint内部NV12路径；Worker不能再无条件把SDK纹理当BGRA重做Convert。最新NV12与encoder inflight有独立引用/重配/关闭边界 | 不天然要求改跨进程共享ABI或增加槽。SDK当前texture字段没有格式枚举，Endpoint内部可以明确识别/约定NV12而保持结构布局，但须更新并核验语义，不能悄悄混用现有BGRA路径；若要求格式通过公开协议声明，再由主Agent决定SDK ABI版本 |

按需保留最新BGRA快照也是局部替代：只要还有latest/SDK可能读，就不能先归还旧shared；快照GPU完成后还必须让后续读明确转到快照。现有SDK TextureBuffer保存固定texture指针，不能靠release_context里的proxy将这个指针无声重定向。它可能减少稳态copy次数，但需要真实的handoff边界，不是当前接口的免费能力。

三槽不是安全问题的根因，增加槽只能缓解等待，不能修复乱序累计ack。反过来，正确有序退役可以在原三槽上工作。single-plane限制缩小实验面，不消除上述生命周期问题；atlas是否只有一个view与slot含完整atlas的事实无关。

## 背压与首帧/静态/输入/重建

现private pool默认`async_depth+4`（上限16），让browser在shared copy完成后尽早继续。移除private BGRA后，browser槽要等SDK排队/VPP/可能编码及旧latest退役；槽满由browser本地backpressure阻止发布。single-plane-direct会只保留最新未提交capture，多plane保留stage，均不需要新增逐帧IPC，但帧丢弃/源准入/节拍会变化。direct browser还保护producer最新base槽，不能把三槽全部当成三个独立可写帧。

如果latest仍长期留shared槽，安全前缀还会使后面的已完成槽一起无法回收；随后看到下一fresh并解除旧latest，才可能推进。这能形成突发停顿。更高async depth不能自动消除它。若SDK旧引用在缺新输入时才释放，还需实际验证队列是否形成互等，不能在只读调查中承诺无阻塞。

验收必须保留首帧、静态最终像素、一次tail和后续PLI/重新连接的重发能力；generation变化须防止旧latest带新layout重新可点击，stale metadata及时传播；pending替换、帧满后最终最新帧、尺寸变化/单↔多/设备重建要同时覆盖。新generation可以导入，旧State必须等所有像素lease与GPU读安全后回收。NV12 latest方案还需处理编码尺寸/level变化，不可用旧尺寸NV12冒充新媒体输出。

## 可节省的量与现有观测边界

只省shared→private一次完整BGRA copy，VPP色转/缩放仍存在。以1928×1088为例：每帧2,097,664像素，8,390,656字节像素；逻辑读+写16,781,312字节。四租户每路30次copy/s对应约2.014GB/s逻辑读写。1936×1088时为2,106,368像素、8,425,472字节/帧，四路30Hz约2.022GB/s。实际copy率低于30时按`copied_frames`同窗增量重算。这不是DRAM计数器，缓存/压缩/driver会改变物理带宽，也不能换算成FPS保证。

现有`atlas_private_copy_submit`在ready Wait之前，`atlas_private_copy_complete`在下一次Poll观察private done后；二者差值包含ready阻塞、前序GPU排队、copy及CPU轮询观察。`atlas_ready_observed`可缩小ready归因但也是CPU观察；`last_copy_ms`相同。`vpp_submit/blt_return/wait_return/complete`能与同cookie关联，但同样不是纯GPU timestamp。已有报告的copy p95约8–14ms或重载55–73ms不能说删copy就节省对应毫秒。

如主Agent安排下一实验，可用现有事件先数清真正copy数、ready未完成比例、同cookie重复VPP与pending替换。要得copy的独立GPU执行成本，需要单独加D3D11 timestamp+disjoint query或ETW GPU packet关联；PDH角色3D只有进程占用，无法单独分出CopyResource。正式收益仍须相同binary、同atlas尺寸、相同采样条件下external基线A/B，同时检查发布/编码/canvas/marker p95及GPU；本报告不为调查启动新profile组。
