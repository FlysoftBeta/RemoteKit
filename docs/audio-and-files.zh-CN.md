# 音频输出与文件上传

音频和文件属于Endpoint Session。Control管理用户偏好、页面对应关系与当前Viewer租约，客户端不持久化这些设置。

## 网页声音

Browser使用自己的AudioManager/AudioOutputStream作为网页播放目标，不录制系统扬声器，也不依赖宿主声卡。Browser将本Session的流重采样、混音为48kHz双声道S16 PCM，每块480帧。独立共享音频环有8槽，包含generation、序号、sample index与首样本QPC；不通过逐块Mojo搬PCM。

Endpoint独立音频线程消费音频环，通过SDK的AudioSource送入Opus，与H264使用同一PeerConnection。音频线程不等待视频编码。短缺口最多补80ms静音；更长缺口或新代次重新建立发送时间线，避免把旧声音挤到当前时间。没有音频接收能力的旧video-only offer仍支持；产品没有上行麦克风传输。

更多菜单的左/右声道开关作用于整个Viewer，默认均开启；“不播放”清空两者。设置由Control保存。接收端保持远端音频时钟运行，WebAudio分别控制左右输出，静音不积攒声音供恢复时补播。当前浏览器需要一个volume=0的audio元素激活远端解码，实际声音经MediaStreamAudioSource输出，避免双重播放。自动播放权限和AudioContext恢复属于本地临时状态，不修改用户声道选择。

## 网页选择文件

Browser真正的RunFileChooser请求经Control的fileRequests呈现自定义dialog，最终回填Chromium FileSelectListener。它不是对网页input.files的脚本赋值。请求身份包含Session、Browser incarnation、WebView实例与文档；客户端只看到不透明请求ID。

正式Viewer经当前RTC的`files.request`上传内容资产，再以不可变selection ID提交原生选择，响应为`files.result`。chunk最多16KiB字节的base64，携带uploadId/offset，Endpoint实际写入后才确认offset；同内容/同offset重试幂等。传输完成不等于选择成功，commit仍等待Browser异步确认；未知结果查询同selection ID，不重复调用选择器。原begin/chunk/commit/cancel/status接口保留兼容，旧HTTP/WS入口也仅保留兼容检查；正式Viewer不通过Control传输文件字节。

Control按当前请求与租约给Endpoint下发不透明ID的授权绑定，Endpoint再检查真实待处理请求、当前peer与文档身份。文件worker属于Session，独立有界队列不阻塞媒体；路径及字节只由Endpoint管理，不要求Control访问其文件系统。网页File.name保留用户文件名，磁盘路径由Endpoint随机生成，不在回复或异常中暴露。accept是浏览器选择提示；目录上传尚不支持。

原生选择暂存每文件256MiB、每批512MiB/64个、每Session1GiB/4096个文件。声明配额在上传前预留，重启后结合实际文件核算。无法识别的旧目录不作为可随意删除的缓存。新文件库另有资产和上传草稿合计1GiB的预算；支持硬链接的卷复用物理内容，其他卷的原生选择使用独立副本，不把两个逻辑预算说成总磁盘1GiB。

文件选择提示按MIME/扩展名语义导出：最多64项，每项最多256个UTF-8字节，整个accept JSON数组最多16KiB。无效、超长及超预算项省略并标记`accept_types_omitted`；Control透传`acceptTypesOmitted`，Viewer显示“文件类型列表过长，显示所有文件”并撤下本地picker的accept限制，避免把不完整提示当成完整允许列表。正常列表保持原提示；这些限制不改变原生pending请求、选择完成身份、上传字节或网页自己的校验，也不自动取消请求。

断线、接管或取消撤销未提交授权并清理暂存；原网页请求可在新Viewer重现。丢begin回复按相同binding返回原draft，取消即使draft已因中断撤销仍能幂等取消原生请求。已选择或结果未知的文件保留到确认对应Browser incarnation退出，供网页延迟读取。页面导航不是文件引用释放的证明；当前不承诺跨peer自动续传。

## 文件库、文件篮与拍照

新契约见[文件库、文件篮与照片处理](file-library-contract.md)。Control持有文件目录、分组、篮子顺序与选择事务；Endpoint持有Session隔离的SHA-256内容资产和暂存。相同字节复用内容，不合并用户文件名或文件条目。文件字节继续通过已有RTC可靠通道，Control不访问Endpoint本地路径。

“我的文件”使用独立产品tab，与起始页一样不创建远端网页；按时间显示已保存文件，支持上传、分组、删除和加入文件篮。文件篮由Control保存，可插入、排序和移除；移除篮子条目不删除已保存文件。显式删除须确认，同时移出篮子；未决选择引用的条目暂不允许删除，共享资产与网页副本不受其他条目删除影响。无引用内容经过2小时宽限再回收，未完成上传草稿30分钟到期。单选input必须由用户明确选一项，多选可使用全部。只有与本次选择ID绑定的Browser终态才能归档并消费对应条目；取消和未知结果不消费，原生已提交回调不重放。

图片为主的文件篮和拍照审阅使用横向卡片，整卡拖拽、点击打开菜单；触屏短滑浏览，长按开始排序。普通文件明显居多时默认列表，使用手柄排序并直接显示操作按钮，用户也可切换视图。放下时按捕获的目录版本提交一次；取消或版本冲突不会覆盖较新的服务器顺序。我的文件保持时间顺序，缩略图由Endpoint按需生成，经RTC读取；客户端仅缓存有界的临时预览。有可靠位置的主框架input使用紧凑锚定选择器，隐藏控件、子框架或位置失效时使用Dialog。

拍照使用全屏getUserMedia，需要HTTPS安全上下文或localhost；TLS配置见[Control说明](../control/README.md)。一次快门对应一个位置，短连拍快照先经RTC发送Endpoint处理，再由用户统一检查。明显较优或近似重复的照片自动选择；质量接近且存在实质画面差异时才显示候选。重拍只替换指定位置，取消重拍保留原图；全组偏弱提示重拍，不把质量分伪装成识别概率。

Endpoint使用OpenCV多尺度/区域细节、曝光和噪声指标排序，WIC解码JPEG/PNG。选择后可进行透视矫正或文档扫描增强；原图不可变，衍生结果为独立资产。自动边界不可信时返回失败，可保留原图，不能把未矫正原图标为成功结果。解码前限制压缩字节、尺寸和像素，批量串行处理，取消/锁定/隐藏/断线停止客户端摄像头和在途工作。

当前算法在最长边768/384像素的灰度图上比较4×4区域细节，结合曝光裁切与平坦区域噪声；24×24亮度/色度签名容忍小位移后用于近重复过滤。最高质量分低于0.23时自动保留相对最佳并提示偏弱；分差不超过0.085且内容有明显差异的候选才进入最多3张的人工比较。这些是实现阈值，不是用户要求或校准概率。每张处理图最多4Mi像素、最长轴8192、压缩数据24MiB；矫正后以JPEG输出，扫描增强包含背景光照归一化与柔和局部阈值，不包含OCR。

Chrome157和89已通过真实H.264/QSV产品链路：资产哈希与原生FileList、分组/消费、连续拍摄与原位重拍、不确定候选、矫正/扫描、两种视图拖拽/触屏/键盘排序、版本冲突、刷新后缩略图和动态anchor撤销。摄像头使用合成帧，实体设备、运动和复杂光照效果仍待验收。旧版客户端Worker评分只保留历史测试工具，不用于生产选片。[构建](../develop/docs/file-library-build-20261104.md) · [运行与视觉检查](../develop/docs/file-library-qa-20261104.md)。
