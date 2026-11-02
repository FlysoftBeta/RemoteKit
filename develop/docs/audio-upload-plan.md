# 音频与文件上传下一轮

上一批f1b2638已上传：609418，链接https://airportal.cn/609418/26UlLdclxy，2026-11-03 15:58 UTC+8过期、2次。ZIP与交付记录在develop/tmp。该批代码已push且包内检查通过。

## 后台调查：用户机器偶发Browser启动失败

用户日志为browser control connect failed 7、producer not confirmed stopped、session.sitePreferences超时。7已确认是SDK_CHANNEL_CLOSED，不是Windows码或超时码。本机发布目录与仅Windows PATH的真实smoke均通过；未定位用户机器根因。后台调查已完成并交付诊断包，后续新增证据由新的专项代理接续。

已确认排队风险：Control Endpoint请求20秒包含全局dispatcher排队，C++启动/维护或此前已经超时仍在执行的请求可阻塞后续sitePreferences。同Tenant Control.serial会串行化，不能只凭多次启动日志认定具体超时顺序。sitePreferences自身不启动Browser；Alive且control有效才RPC，否则保存并返回。不要仅调长超时掩盖启动失败。

用户随后确认当前已启动成功：成功时browser.log存在但为空；自述Win10 24H2/i5-8400/UHD630，前版也偶发。用户要求后台调查，root已恢复新功能实施。诊断commit ba0deec已push，小型覆盖包342375已上传；它是可观测性增强，不是根因修复。三次本机新Profile启动约203–250ms、日志创建前447–450模块、成功日志0字节；未清文件缓存，不能当用户冷盘证据。

独立发现Job assignment失败时未入job的自建悬挂Browser无法由TerminateJob清理，已交音频native owner在同一service.cpp中最小修复；下一次Browser构建补有限启动里程碑。不能将该不同错误路径冒充用户错误7根因。

## 当前实施归属

- 前一实施milestone已收尾：native/SDK/文件helper构建与11套CPU通过，Control168项与生产构建曾通过；最后文件单选小修尚需进入dist。旧代理的跨任务复用不符合用户最新明确要求，均已结束并写交接。
- 全新audio_files_runtime_qa已完成最小157/89音频/文件功能与视觉组，生产build/smoke包含单选修复；证据audio-files-runtime-qa2.md。已关闭自有进程并结束milestone。
- 全新camera_capture_optimization已完成：157/89首次冷burst同步p95为1.5/5.35ms，0长任务，取消清理与视觉通过；最后fallback同步throw防错需包含在发布build。证据camera-bitmap-worker-optimization.md。
- 全新video_clip_runtime_evaluation已完成4×12秒对照并释放资源；video降低3D占用但无帧率优势，动态布局生命周期尚需设计，不更换产品后端。报告video-clip-evaluation.md。下一步新Sol执行统一Control验证/最终build与发布，root commit/push。
- root：核心契约、状态/文件生命周期、资源窗口、文档、commit/push与发布。Astra设计已完成，不等同于全盘接受所有建议。

## 新增FPS报告

用户Chrome138、单窗口、自动、1936×816，旧最高decode/paint46/20，新f1b约12/12，编码FPS上限50。单窗两版均canvas2d，不能说由WebGL降级，也不能用4K高画质解释。codec ceiling50排除直接codec=12，但Endpoint adaptive render预算仍可能12。新增stats暴露render target/applied、effective ceiling、RAF反馈/年龄与source间隔；根因尚未确认，未改策略。

旧版独立RAF采样并非paint驱动，但只代表回调节拍，不是物理刷新率；Control缓存估计可被新延迟样本续期是存量风险。f1b开始把policy_fps接到真实capture周期，可能放大低预算影响，不能只据反馈代码原有就排除行为回归。只读取证脚本tools/viewer-diagnostics-console.js不导出SDP/token/URL/身份。用户要求的video+clip成本评估不能冒充本问题已修复。

## 用户授权范围

- 音频必须接入Chromium播放target，不走系统hook/capture。
- 声道选择是整个Viewer统一，保存在Control；更多菜单紧凑一行放左右多选Switch与“不播放”（清空）。
- 网页文件上传自定义dialog：设备文件、摄像头拍照。摄像头通过getUserMedia而非capture input。
- 短时间序列挑几张清晰帧；允许客户端、MediaRecorder远程或WebRTC远程方案，重点避免端侧卡顿。
- UI设计Astra6 Medium，已有audio-upload-ui-design.md；实现/实验/视觉Sol6.1 Medium。root决定架构并提交推送。

## root选定的音频方向（已实现）

真实扩展点为ContentBrowserClient::CreateAudioManager/OverridesAudioManager，启用后AudioService自动在Browser内运行，无需为此修改Chromium tracked源码。服务构建实现AudioManagerBase与真实AudioOutputStream；demo保留系统音频。虚拟输出目标稳定48kHz stereo、480 frames/10ms，输入设备不开放。

Session内所有输出流共享逻辑消费时钟，使用Chromium AudioConverter做必要的格式转换/混音，正确处理Stop后禁止callback和Close释放；不能把多个流的PCM简单串接成一个音轨。输出目标不依赖宿主音频硬件。Browser→Endpoint采用有界PCM环与建立/销毁控制消息，音频线程不得等待网络；具体结构/序号/间断策略在实施前固定。

已固定PCM v1：48kHz/stereo/S16/480frames、8槽，generation/session/sequence/sample-index/首样本QPC与discontinuity，64位原子对齐与读前后校验；Endpoint创建mapping，audio.open给Browser绑定，稳态无逐帧Mojo。短gap至多80ms补有界静音块保持RTP时间，不补旧声音；长gap/换generation明确重启sender一次恢复时钟，不新增WebRTC tracked patch。需分别测试并报告间断，不能只计丢帧而压缩RTP时间。

SDK使用自有AudioSourceInterface→CreateAudioTrack→AudioTrackSinkInterface::OnData直接提交PCM，接入Opus发送；不用ADM假录音。现有SilentAudioDevice、EmptyAudioEncoders和拒绝所有audio SDP需相应调整。只允许客户端recvonly/inactive音频，继续拒绝上行音频；视频-only老客户端继续兼容。C ABI固定PCM格式、时间戳与有界所有权。Endpoint音频消费不能被视频编码等待阻塞。

同一PeerConnection/stream ID提供同步基础，但Viewer最终是canvas，需实际闪光/声脉冲检查音画终点，不能仅据同PC宣称已同步。声道选择在Viewer统一输出路径应用，默认左右开启；浏览器autoplay阻塞是本地临时状态，不得篡改Control偏好。具体单声道/左右映射按全局声道开关语义固定，避免误做每Tab路由。

## root选定的文件方向（已实现）

Browser已有RunFileChooser和真正FileSelectListener回填，继续复用；产品新增独立fileRequests，不把paths塞到普通JS dialog接口。请求绑定tenant、browserIncarnation、view/instance/document、browserRequestId，客户端只见opaque id。

采用begin→按file ticket流式application/octet-stream HTTP上传→commit；不自行写multipart parser，不用JSON/base64搬整文件。HTTP需cookie鉴权、Origin与当前Viewer lease；控制面持久化只存产品关系，不把客户端路径当服务器路径。Endpoint Session托管暂存与已选文件，Control负责同机传输写入；这一轮不声称支持远程分布式文件存储。

专用Endpoint文件接口重新检查真实pending chooser、Browser身份且不得Start Browser。内部文件描述为path+displayName，保留网页File.name；磁盘名由服务器生成。单选/多选和accept按浏览器语义处理，目录上传保持明确不支持。配额、流式边界、文件完成后的异步Browser验证都要有状态。

未commit文件在断线/接管/取消/超限后清理；Browser pending chooser可在新Viewer重现，旧ticket不继承。已selected文件可能被页面延迟读取，不能在selected或导航时删除；保留到确认Browser incarnation退出，设置Session总配额。无法确认旧Browser已停止时保留，不用TTL假装引用释放。

## 摄像头实验与UI

Astra设计只是一份方案，root尚未把其中每项建议定为实现要求。设备文件/拍照候选在明确确认前不离开客户端；摄像头需显式启用，取消/导航/失去lease/页面隐藏必须停流并释放位图/Worker。

先做固定素材、固定参数的有界实验：低分辨率灰度Tenengrad与Laplacian评分、曝光与噪声惩罚、时间去重；评分与最终照片必须来自同一个快照。Worker最多一个任务在途，忙时跳帧，完整候选最多3张且有像素内存上限。比较低成本客户端处理与必要的远程原型，不要求为枚举方案全做产品实现。测主线程长任务、snapshot成本、评分排序、持有内存/位图数和取消清理；Chrome89与现代客户端都做能力fallback。不给用户暴露算法参数面板。

## 调查证据入口

- 音频：content/public/browser/content_browser_client.h:1634；content/browser/browser_main_loop.cc:1639；content/browser/audio/audio_service.cc:53；media/audio/audio_io.h:70；media/base/audio_converter.h。
- 直接PCM发送：pc/audio_track.cc:68→pc/rtp_sender.cc:1449→media/engine/webrtc_voice_engine.cc:1052；时间戳契约api/media_stream_interface.h:217。
- 文件：browser/page_requests.cc:313；Control collectDialogs当前仅JS dialogs；Endpoint view.page.reply的dialog_only门禁；Chromium file_chooser_impl.cc:246只GrantReadFile、不复制托管。
- 可复用Worker所有权/指标：control/public/benchmark-marker-readback.js及对应测试；请求生命周期测试control/test/reply-lifecycle.test.ts。
