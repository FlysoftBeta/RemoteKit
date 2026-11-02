# 音频输出与文件上传

音频和文件属于Endpoint Session。Control管理用户偏好、页面对应关系与当前Viewer租约，客户端不持久化这些设置。

## 网页声音

Browser使用自己的AudioManager/AudioOutputStream作为网页播放目标，不录制系统扬声器，也不依赖宿主声卡。Browser将本Session的流重采样、混音为48kHz双声道S16 PCM，每块480帧。独立共享音频环有8槽，包含generation、序号、sample index与首样本QPC；不通过逐块Mojo搬PCM。

Endpoint独立音频线程消费音频环，通过SDK的AudioSource送入Opus，与H264使用同一PeerConnection。音频线程不等待视频编码。短缺口最多补80ms静音；更长缺口或新代次重新建立发送时间线，避免把旧声音挤到当前时间。没有音频接收能力的旧video-only offer仍支持；产品没有上行麦克风传输。

更多菜单的左/右声道开关作用于整个Viewer，默认均开启；“不播放”清空两者。设置由Control保存。接收端保持远端音频时钟运行，WebAudio分别控制左右输出，静音不积攒声音供恢复时补播。当前浏览器需要一个volume=0的audio元素激活远端解码，实际声音经MediaStreamAudioSource输出，避免双重播放。自动播放权限和AudioContext恢复属于本地临时状态，不修改用户声道选择。

## 网页选择文件

Browser真正的RunFileChooser请求经Control的fileRequests呈现自定义dialog，最终回填Chromium FileSelectListener。它不是对网页input.files的脚本赋值。请求身份包含Session、Browser incarnation、WebView实例与文档；客户端只看到不透明请求ID。

流程为WS `files.begin` → 按ticket进行HTTP流式上传 → WS `files.commit`。上传到`/api/files/{ticket}`，请求体为原始文件字节；HTTP完成只表示传输完成，页面选择成功要等Browser异步确认。提交状态可幂等查询，结果不明时重试同一uploadId。取消调用`files.cancel`，旧请求不能被新页面复用。

HTTP检查cookie、Origin、当前Viewer租约和ticket身份。Endpoint检查真实待处理请求，托管Session内的随机暂存路径；Control在同机写入这些文件，不把路径发给客户端。网页File.name保留用户文件名，磁盘路径由服务端生成。accept是浏览器选择提示；目录上传尚不支持。

每文件256MiB、每批512MiB/64个、每Session1GiB/4096个文件。声明配额在上传前预留，重启后结合实际文件核算。无法识别的旧目录不作为可随意删除的缓存。

断线、接管或取消撤销未提交ticket并清理暂存；原网页请求可在新Viewer重现。已选择或结果未知的文件保留到确认对应Browser incarnation退出，供网页延迟读取。页面导航不是文件引用释放的证明。

## 拍照

拍照使用getUserMedia，需要HTTPS安全上下文或localhost；TLS配置见[Control说明](../control/README.md)。在客户端短时间序列中选择最多3张候选。低分辨率Worker评分结合清晰度、曝光和噪声；评分与照片必须来自同一个快照。最多一个任务在途，忙时跳帧；候选像素与在途资源有上限。用户确认前不上传照片。取消、导航、租约失效或页面隐藏停止摄像头并释放Worker和图像资源。

完整快照通过不可变ImageBitmap交给OffscreenCanvas Worker处理；缺少相应能力时回退同一canvas快照的评分/编码。增强路径已在89与157运行验证。功能和性能的已验证范围统一见[当前状态](current-state.zh-CN.md)，实体设备拍摄效果另行验证。
