# QSV同session异步VPP→Encode可行性

2026-11-01，完成只读调查后，按主Agent后续选择新增独立probe并完成CPU构建及独占硬件验证；未改生产媒体代码或尺寸语义。当前设备为UHD630、驱动30.0.100.9805，dispatcher 2.17.0实际加载legacy API1.35（`docs/streaming-experiments.zh-CN.md:3`）。主Agent负责正式管线是否采用及接口选择。最新运行结论见[qsv-vpp-probe-results.md](qsv-vpp-probe-results.md)：三主要组各120帧的无缩放/完整宽/缩放链全部通过；下文能力未知点为运行前的调查依据，正式集成生命周期边界仍适用。

## 结论

**同一MFX session内，VPP输出surface直接交Encode，最后只Sync编码结果，是官方支持的异步依赖链。** 它可以替代“外部D3D VideoProcessorBlt→CPU等待fence→Encode”中的中间CPU等待，不需要猜测同device的外部写入排序。前提是改为由MFX自身提交VPP，保留相同surface结构地址和全部输入/输出所有权；不能直接删除现有converter的wait。[Intel异步管线说明](https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_transcoding.html)

当前正式atlas不能不改尺寸管理就直接包成合规legacy RGB4输入：BGRA texture宽1928，API1.35规定FrameInfo.Width为16倍数。第二个未知是RGB4转换同时缩放：legacy支持表中RGB4的Resize项为空，不能从新版VPL能力表推断本机必支持。建议先做独立小probe回答这两点，再决定正式接入范围。[API1.35参考文档](https://github.com/Intel-Media-SDK/MediaSDK/blob/master/doc/mediasdk-man.md#mfxFrameInfo)

VPP是否使用VEBOX/SFC而降低3D占用没有API级普遍保证。`LOWPOWER`是可查询的缩放策略，不等于本机RGB4整条链强制走VEBOX；现代header出现vendor VEBOX枚举也不证明legacy1.35支持它。

## 本地精确证据

已读仓库实际依赖`build/dependencies/libvpl-2.17.0/`：

- `api/vpl/mfxvideo.h:735–919`：VPP Query/QueryIOSurf/Init/Reset/Close/RunFrameVPPAsync均是API1.0接口，legacy1.35可用这些入口，不依赖2.x内部surface/import API。
- `doc/spec/source/programming_guide/VPL_prg_transcoding.rst`及`snippets/prg_transcoding.c`：同session `RunFrameVPPAsync(...,vout,...,sp_v)`后立即`EncodeFrameAsync(...,vout,...,sp_e)`，最终Sync(sp_e)；依赖比较的是**surface结构指针**。不是用两个内容相同但地址不同的mfxFrameSurface1包装同一texture。
- `doc/spec/source/programming_guide/VPL_prg_frame.rst`：legacy Locked由runtime管理，非零不能改/移动/销毁surface；Locked的访问政策与COM/应用lease的生命周期是两件事。
- `api/vpl/mfxstructures.h:170`：RGB4/BGRA对应字节BGRA；现代别名BGRA就是RGB4，不可误用BGR4（RGBA）。
- `api/vpl/mfxstructures.h:3630–3662`：`mfxExtVPPVideoSignalInfo.In/Out`，BT709枚举1，full0–255枚举1，limited16–235枚举2。它控制实际VPP变换，现有Encode的`mfxExtVideoSignalInfo`只负责bitstream VUI，不能代替它。
- `doc/spec/source/programming_guide/VPL_prg_hw.rst:145–231`：先SetHandle(D3D11 device)和SetFrameAllocator，device持续到MFXClose；外部video memory的surface类型由QueryIOSurf确认。每session只有一个VPP和一个Encode实例，见`VPL_prg_session.rst` Multiple Sessions。
- `examples/api1x_core/legacy-vpp/src/legacy-vpp.cpp`：legacy VPP的MORE_DATA/MORE_SURFACE/DEVICE_BUSY/drain和先Close组件再释放surface的示例；该示例是系统内存输出到文件，示例中每帧Sync不能直接当成VPP→Encode的正确最短路径。

## 1928宽：合法路径与真实代价

API1.35官方`mfxFrameInfo`说明要求Width为16倍数，progressive Height也为16倍数；当前1928×1088只满足高度。最新2.17 header把最小alignment改为8并要求Query，不应倒推旧runtime放宽。[API1.35尺寸定义](https://github.com/Intel-Media-SDK/MediaSDK/blob/master/doc/mediasdk-man.md#mfxFrameInfo)

**不能**把1928 texture的Info.Width填写1936；CropW1928只定义有效内容区域，不会给底层D3D纹理补出8列。allocator GetHDL只返回texture/subresource，也不会改变物理尺寸。D3D row pitch/硬件内存tile可能有padding，不等于D3D texture逻辑宽度更大。

可选实现范围：

1. **atlas物理分配对齐**：browser共享atlas和Endpoint cache实际都分配到1936（或Query要求的更大对齐），页面viewport/content1920保持。布局与sampling必须使用真实atlas尺寸，不能仍声称媒体是1928。所有plane位置不变，增加的是空白padding；检查receive level/编码尺寸和input坐标映射。范围含atlas尺寸配置，不能只改QSV文件。
2. **利用现有那一次private copy完成对齐**：AtlasPool仍接收1928 shared texture，把private BGRA分配1936，现有CopyResource改成CopySubresourceRegion拷1928×1088。预先初始化右侧padding，MFX输入Info.Width1936、CropW1928。copy次数仍是原有一次，没有新增一遍全幅copy；其真实分配面积及source crop要另报。
3. **独立probe或临时兼容方案额外pad copy**：worker另建aligned BGRA并copy。这合法但多一次全幅BGRA copy，必须计入预算；不适合把“取消CPU wait”收益与“零额外copy”混称。

第二种的接入代价容易遗漏：当前`service.cpp`会把`remotekit_rtc_frame.width/height`改成协商编码尺寸，worker原来从texture desc得源尺寸。private纹理变宽之后，它不能从1936推断有效crop1928。需保存并传递每texture的不可变source有效尺寸；该信息可以通过明确的内部source-geometry接口实现，但必须覆盖旧generation被SDK继续持有的情况，不能只读当前latest全局geometry。NVENC旧converter若仍按整1936宽缩放会把padding也混入画面，需保持旧分配路径或同步扩充source-crop输入。正式接口由主Agent决定。

probe可Query原始1928输入，但若runtime静默校正到1936，应报告该更改并使用真实1936纹理；即使1928某次Init成功，也要以正式对齐规则和真实运行校验决定是否支持，而不是依赖未文档化的偶然接受。

## RGB4、缩放与颜色

API1.35的RGB4→NV12列为limited支持；只包含必要格式转换滤镜，optional滤镜可能跳过，Resize支持表的RGB4项未标支持。因此第一probe必须分别测“等尺寸RGB4→NV12”和“RGB4→NV12+缩放”，保存Query、Init、GetVideoParam以及过滤器列表/警告，不能让当前通用`Status(status>=0)`吞掉FILTER_SKIPPED或参数修正。[API1.35 VPP能力说明](https://github.com/Intel-Media-SDK/MediaSDK/blob/master/doc/mediasdk-man.md#video-processing)

所需VPP输入为RGB4、progressive、源有效crop；输出NV12、YUV420、progressive、16对齐allocation及协商crop。In/Out frame rate相同，不加FRC/DI/denoise。VPP颜色扩展In nominal full、Out BT709/limited；Query/GetVideoParam确认采用配置。Encode继续保留现有BT709 limited VUI和CheckSignal。[VPP颜色结构](https://intel.github.io/libvpl/latest/API_ref/VPL_structs_vpp.html#mfxextvppvideosignalinfo)

量化校验必须对黑/白/R/G/B/灰阶及小字号彩边读回NV12并软件解码H264，检查Y黑16/白235与709色值，不以VUI正确代替像素正确。只为probe读回，正式管线不增加CPU像素回读。

如果单次RGB4 CSC+缩放不支持，不能在同session同时Init两个VPP对象来构造“RGB4→NV12→resize”：每session仅一个VPP。两段需要第二个MFX session并明确join/device/allocator/依赖，或同步边界外的其他缩放，范围明显增加。可以先支持不需缩放且分配对齐的QSV实验，不能让正式高DPR/接收上限场景悄悄裁掉内容或降低viewport。

当前converter还负责等比fit和黑背景，不是无条件把源拉伸填满编码画面。MFX probe需复现相同content destination/crop与背景，特别是偶数取整产生的边缘留白；普通缩放不自动等于现有letterbox行为。`mfxExtVPPColorFill`只控制allocation与Crop边界外填充，不能凭它声称所有任意目标背景都等价。

## allocator和surface生命周期最小状态机

现有`qsv_encoder.cpp:18–89`的Memory持有texture+array index；GetHDL返回借用的mfxHDLPair，外部输入Task.memory也走同一cast。这一机制能包装**同device、真实GPU-ready的**BGRA texture，无须系统内存Lock/Upload。当前AtlasPool在private done fence完成后才交SDK，因此MFX输入已有真实完成边界；这个边界继续保留。

现有Allocate只接受NV12且一律DECODER bind/array，接入VPP必须按request FourCC/Type分流RGB4/NV12及VPP output/internal/encoder需求，不能只放开格式判断。Intel官方D3D11 allocator把RGB4映射B8G8R8A8_UNORM，把RGB4和VPPOUT映射RENDER_TARGET，并限制其某些texture array用法；已有private cache单texture RT|SRV接近需求，仍需本机RunFrame实际验证。[Intel D3D11 allocator源码](https://github.com/Intel-Media-SDK/MediaSDK/blob/master/samples/sample_common/src/d3d11_allocator.cpp)

建议每个被backend接受的job有固定地址的Task，持有：BGRA输入Memory/surface、NV12输出Memory/surface、VPP sync、Encode sync、cookie/时间戳、bitstream存储、明确状态。VPP输出与Encode输入必须是这个Task的**同一个NV12 surface对象**。Task放unique_ptr，不能vector移动surface地址。BGRA的应用pool lease继续由worker保持到完整job completion；第一实现不追求提前归还源，以减少独立source完成通知接口。

状态应区分：

- VPP未接受：DEVICE_BUSY可重试；未提交GPU工作的job才可以被上层pending替换。
- VPP已接受、Encode尚busy：backend已经拥有GPU工作，不能返回普通busy让上层替换并release BGRA。应该对worker返回accepted，backend内部持有待Encode状态，Poll负责重试Encode，**不重新运行VPP**。
- VPP MORE_DATA：不能当丢帧；输入可能被runtime持有。保存input Locked/所有权，直到产生输出或drain。配置期望无时域滤镜1:1，但仍需有明确处理，不能把d1唯一slot永远留住等待不存在的第二job。
- VPP MORE_SURFACE：已有一份输出可交Encode，同时要求额外输出surface；不要因为status<0统一当fatal或release输入。简单1:1配置若出现它，应记录并安全drain，再决定该配置不支持或实现多输出映射。
- Encode MORE_DATA：沿用现有held概念，保存对应BGRA/NV12/控制buffer直到以后timestamp匹配的输出完成。cookie不能假定每次API调用都立刻返回相应bitstream。
- 最终Encode Sync成功且对应surface不再Locked后，释放NV12槽、BGRA COM及应用lease。若同步返回ABORTED，保留VPP sync以继续定位上游错误；不能把ABORTED当安全完成。

QueryIOSurf同时查询VPP input/output和Encode input需求。共享NV12池建议数按官方示例`VPP_out.NumFrameSuggested + Encode.NumFrameSuggested - AsyncDepth`计算，再检查最小值。AsyncDepth1不等于所有input/internal/output总共只需一个面；保持当前对照的d1策略，不能把默认d4收益混进VPP实验。

## Reset、取消和NVENC分离

普通码率SetRates继续只ENCODE Reset、StartNewSequence=OFF，前提是**所有VPP待提交/已提交及Encode held/tasks均已drain**；当前只检查Encode tasks/held不够。码率变化不应重新Init VPP、触发额外IDR或更改源采样时间基。

源crop/物理尺寸/输出尺寸变化时先停接收并完整drain，再Query VPP Reset可否复用内存；INCOMPATIBLE需要Close/Init并重分配，不能静默用旧crop。VPP输出全部交Encode后，Encode按NULL input drain到MORE_DATA；最后同步所有可同步任务，先关闭Encode/VPP组件和session，再销毁仍可能被runtime引用的surfaces。设备丢失/timeout路径以真实失败与组件/session关闭作为取消边界；不按CPU超时提前归还正在读取的source。

NVENC不接MFX VPP→Encode依赖。它继续现有外部converter+真实fence完成后Submit；把MFX生成的NV12交NVENC属于跨非MFX组件，官方要求显式完成同步。QSV异步链应通过backend明确输入能力/setting选择，不能全局删worker Convert或改变NVENC假设。[跨组件同步规则](https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_transcoding.html)

## 是否会转移到VideoProcessing/VEBOX

本机现有资源数据已经有Endpoint VideoProcessing占用（约9.38%旧组），同时Endpoint 3D约19.9%，所以不能把整个Endpoint 3D都归给外部色转。它还包含atlas copy、driver/encoder内部工作，Windows engine名字也不能逐API对应。

MFX VPP让runtime选择CSC/scale实现，硬件可能使用VEBOX/SFC或EU。现代header的`MFX_SCALING_MODE_INTEL_GEN_VEBOX`明确描述SFC+VEBOX，`COMPUTE`描述EU；但API1.35参考只列DEFAULT/LOWPOWER/QUALITY，现代枚举不是legacy能力证据。LOWPOWER最早API1.19，语义仍是实现定义算法，不是固定硬件engine契约。[缩放枚举语义](https://intel.github.io/libvpl/latest/API_ref/VPL_enums.html#scalingmode)

probe分别Query default/lowpower，保存actual settings；若尝试现代vendor枚举必须作为独立能力探测，unsupported/被修正需明确记录。只跑CSC、CSC+scale、VPP→Encode三个隔离组，使用相同分辨率和PTS、采集同LUID/physical engine各PID counters或ETW，再和外部D3D VPP对照。只有真实3D下降、VideoProcessing变化及总吞吐/延迟改善，才能说本机调度受益；即使Query保留LOWPOWER，也不能单凭名字说已走VEBOX。

## 最小改动边界与独立probe

第一步可仅新增显式构建的`endpoint_qsv_vpp_probe`及`endpoint/CMakeLists.txt`入口，调用现有device helper和dispatcher，在独立进程创建已完成初始化的测试BGRA，**不改运行服务**。每次120–300帧、单任务/固定超时；输出JSON记录runtime/adapter/format/真实texture尺寸/Query修正/Init/GetVideoParam、alloc request、所有status与Locked变化、VPP/Encode sync耗时、完成帧数和图像误差。失败必须关闭session并保留有效生命周期，不继续无界重试。这个任务后续需主Agent分配GPU窗口，本次没跑。

probe依次回答：

1. 真实1936×1088 BGRA、crop1928×1088，等尺寸RGB4→NV12能否完全硬件初始化？原1928的Query如何修正？不用假尺寸RunFrame。
2. 1928→1280等比采样，以及实际高DPR→接收level上限的缩放是否被采用，黑背景/范围/色值是否正确？若RGB4 scale不支持，明确停止合并方案，不偷偷加copy/第二VPP。
3. 同一NV12 surface指针VPP→Encode，未Sync VPP、仅Sync Encode，逐帧pattern/cookie连续且没有旧帧、错误Locked或释放后读取？d1与d2/d4只作独立诊断。
4. VPP/Encode分别busy、MORE_DATA/MORE_SURFACE、码率Reset、输入结束后drain、主动Close和device loss时，全部texture及应用lease能否正确收尾？
5. 与现有D3D VPP相同图案/尺寸/输出码率对比总GPU工作和吞吐；再判断是否值得正式四Tenant端到端A/B。

正式接入最少触及`qsv_encoder.cpp`（VPP配置/allocator/pool/状态机）、`hardware_encoder.hpp`（输入能力与有效source geometry契约）、`encoder_worker.cpp/.hpp`（QSV分支跳过外部converter、接受后lease保持）、必要的`service.cpp`开关/统计和尺寸来源。选private-pad方案另需`atlas_pool.cpp/.hpp`及有效尺寸传递；选atlas分配对齐则是browser输出尺寸/Control geometry链的另一项改动。`gpu_device.cpp`的现有NVENC converter wait保留。SDK/Browser-Endpoint fence协议无需因“同session异步VPP”本身变化。

官方证据支持异步依赖机制，随后本机probe验证了本文指定1936分配、1928crop及1280×720缩放的RGB4→NV12→Encode。它不覆盖全场景转换/letterbox，也未证明正式无额外copy对齐接口或VEBOX收益；下一步是主Agent固定正式集成接口及生命周期。

## 独立probe使用说明

正式源码`tools/qsv-vpp-probe.cpp`，显式非默认CMake目标`endpoint_qsv_vpp_probe`。`tools/build-qsv-vpp-probe.cmd`使用REMOTEKIT_VS/REMOTEKIT_PYTHON覆盖和现有libvpl依赖，独立`build/qsv-vpp-probe`输出，不操作streaming实验使用的endpoint-package或Chromium out。MSVC Release编译链接通过，仅有依赖header既有C4201匿名struct警告；`--help`走CPU参数分支，不创建D3D device。

运行安排由主Agent给GPU窗口，建议每条命令使用新的独立输出目录：

```powershell
build/qsv-vpp-probe/endpoint/endpoint_qsv_vpp_probe.exe --output=develop/tmp/qsv-vpp-noscale/report.json --case=noscale --frames=120
build/qsv-vpp-probe/endpoint/endpoint_qsv_vpp_probe.exe --output=develop/tmp/qsv-vpp-full/report.json --case=full --frames=120
build/qsv-vpp-probe/endpoint/endpoint_qsv_vpp_probe.exe --output=develop/tmp/qsv-vpp-scale/report.json --case=scale --frames=120
```

noscale真实BGRA1936×1088/Crop1928×1088→NV12 allocation1936×1088/Crop1928×1088；full有效宽1936；scale有效1928→1280×720（这项是独立缩放能力测试，不声称复现正式等比letterbox）。默认只跑noscale，`--case=all`遇首个失败立即停。case上限60秒，单次提交/Sync上限5秒，每组120帧按60Hz上限节拍；VPP Query/Init警告明确作为失败记录，不被通用status>=0吞掉。MORE_DATA/MORE_SURFACE超出本probe期望1:1时停止并Close，保留surface与bitstream/control所有权到session关闭；正式服务的完整多输出状态机没有在probe里伪装实现。

每帧source upload之后用显式GPU fence完成准备，再调用VPP；这属于外部源准备边界，单独记`externalSourceUploadAndReadyMs`。chain分支**不Sync VPP**，把同一个NV12 surface地址交Encode，最终仅Sync Encode；`--stage=vpp`是另外的VPP独立归因组，明确Sync VPP。只要busy就重试相同阶段，VPP接受后不会重新转换；后台记录本PID完整LUID/physical engine counter实例，不把Windows标签当API保证。

默认最终Encode Sync后显式读回NV12：校验709 limited黑/白/R/G/B/灰/黄、每帧8bit marker/cookie、Locked归零。source有效区右16列/顶部16行固定白色，真实source padding8列品红；记录NV12最后16有效列及所有coded padding列的YUV，暴露crop混入padding。coded padding在本probe未预填，记录为unspecified，不冒称已初始化。主Agent新发现off/on同样右侧偏绿问题作为现有VPP/编码边缘问题跟踪，此probe没有生产修复它。

H264保存为case对应文件，bitstream timestamp连续匹配cookie；NV12正确不等于有损编码后边缘正确，后续仍需软件解码产物核对实际白边/marker。本机PATH未发现ffmpeg/ffprobe，因此本轮没有增加或执行一个声称完成软件解码的空检查。需要隔离GPU归因时，在正确性组通过后用新目录`--verify=none`关闭**probe专用读回**，报告中保留该标志；source upload仍属于本PID开销，不能把全进程3D直接归给MFX VPP。主任务Chrome89的marker保持原样，不受probe参数影响。

GPU case已在后续独占窗口完成，成功范围、首轮缓冲失败、源码版本及真实引擎统计集中见`qsv-vpp-probe-results.md`。本节命令仍是可重复入口。

构建指纹：probe exe SHA256 `112dbb33ea060106e27b97be8b5d61fc11ed367d8082d0c195c187d052ebcb1b`。构建日志`develop/tmp/qsv-vpp-probe-build.log`，Ninja记录副本`develop/tmp/qsv-vpp-ninja-log.txt`。本轮一次CPU编译约14:36:43.6–14:37:14.1与throughput的on30窗口14:36:40–14:37:10重叠，主Agent已收到污染报告，该组不能作为正式性能证据，需复跑；没有采集cl/ninja实际CPU counters。后续CPU构建同样等待实验负责人空窗。时间锚点/指纹见`develop/tmp/qsv-vpp-build-evidence.json`。
