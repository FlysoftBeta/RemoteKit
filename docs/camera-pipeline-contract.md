# 快速拍照与彩色扫描契约

本轮替代162141的采集和审阅路径。UI只有文件篮与全屏相机，模式为`photo`（普通照片）和`scan`（文档扫描）。扫描一次包含有证据的几何矫正、保色光照与文字增强；不能把类扫描效果解释为黑白二值化。具体布局见[本轮设计](../develop/docs/camera-flow-redesign-20261104.md)。

## 采集与质量反馈

- 摄像头直接来自本机getUserMedia。video只作本地预览/读帧，不经RTC视频编码、MediaRecorder或远端视频读回。冻结一个源快照后，由同一快照派生分析图和最终输出，不能用一次新的takePhoto曝光冒充已评分的帧。
- 覆盖全取景区域，控件浮层不挤压画面；以同一中心cover源矩形截图，源矩形、方向及本次模式在快门时冻结，旋转使未完成采样取消。最多8Mi像素，不放大源像素；相机请求最高3840×2160、理想30fps，实际能力独立记录。
- 单次采样最多1000ms、20个不同源帧，以绝对50ms时槽及可用帧回调驱动，不等待凑满；Endpoint明确质量够用立即结束。背压、慢设备可以少采，不能重复同一帧填数。等待网络、PNG编码和后处理不延长采样，分别报告时段；采样结束就释放快门忙状态，后台有界任务继续。
- 分析图最长边512、JPEG仅作临时质量分析，最多44KiB。原像素快照保留在本机有界候选池，最多2个保留候选加1个当前帧；每次RPC同时只有1个样本在途，内存不足或网络忙直接跳过时槽。不能把用于评分的有损小图保存成照片。
- 最终仅为选中快照和真正不确定的另一个候选编码无损PNG并上传。后处理PNG输出，原图不可变；缩略图可用JPEG。既有资产上传采用最多4块16KiB窗口，并限制DataChannel bufferedAmount，不能阻塞输入或新增peer。

现有可靠授权files.request/result v1新增临时质量会话（library授权、当前peer/auth代次，单Session最多2个、每个最多20样本、5秒期限，撤权立即废弃）：

1. `photo.burst.begin {requestId:"library"}` → `{burstId}`。
2. `photo.burst.sample {requestId:"library",burstId,frameId,data,availableFrameIds}` → `PhotoBurstDecision`。data是该原始快照对应的≤44KiB JPEG分析图base64；消息允许至61440字节，只扩大此方法的门限。availableFrameIds最多3个，含当前帧及客户端确实仍持有的快照；Endpoint不可选择已淘汰快照。按次序处理，不在文件库落盘样本。
3. `photo.burst.end {requestId:"library",burstId,availableFrameIds}` → 同一决定并释放会话；原请求重试需有有界终态缓存，不能把另一个会话结果错绑。
4. `photo.burst.cancel {requestId:"library",burstId}` → `{cancelled:true}`，幂等。迟到质量回复不能复活已结束的客户端采样。

`asset.describe {requestId:"library",assetId}`返回已授权Session内Asset元数据，供刷新后按持久候选ID读取预览或原图；不返回磁盘路径，不跨Session查询。

`PhotoBurstDecision = {selectedFrameId:string,keepFrameIds:string[],candidates:{frameId:string,score:number}[],uncertain:boolean,stop:boolean,reason:string}`。keep最多2，candidates最多2；完整会话在Endpoint进行评分、近重复判断、质量够用判断及排名，Client仅执行保留/淘汰命令。早停阈值是新分析尺度的实现参数，需用清楚/模糊/暗/近重复样例校验，不套旧768像素绝对阈值、不称概率。无样本的end返回明确错误；end只能从确实仍有的原始帧选。

Photo处理接口保留旧rectify wire兼容，新UI只发scan。输入/输出处理预算提升到8Mi像素、PNG压缩字节上限64MiB；缩略图另有既有上限。所有分配前检查尺寸/字节，按行或阶段检查取消。缺少页边证据走方向矫正或保持几何后继续保色扫描，不视为处理错误。内部结果记录geometry为perspective/deskew/unchanged；没有进行透视就不能在测试中记作透视成功。

## 文件篮与持久状态

Control仍持有已导入目录、分组、顺序和选择事务。相机采样、未导入PNG及后台传输是FileLibrary provider中有界临时任务，退出相机不销毁，锁定/身份变化取消并释放；不写本地持久化。最多2个后台拍摄任务，只有1个当前采样，编码/上传队列有字节预算。按快门顺序串行导入保持顺序；可取消占位，晚到结果不复活。一次快门结束无需经过独立“检查照片/保存”页面。

`LibraryEntry.photo?: {mode:"photo"|"scan",candidateAssetIds?:string[],pending?:"choice"|"scan-error",warning?:string}`；originalAssetId继续在entry顶层。候选最多2个，Control验证存在并保留全部引用，prepare拒绝pending。普通清楚照片直接就绪；不确定照片在篮子当前项内选择后才执行该项冻结的扫描模式。

`library.import`可接收上述photo元数据。新增`library.replace {operationId,entryId,expectedRevision,assetId,originalAssetId?,photo?}`：按revision原位替换asset和照片元数据，保留entry ID、顺序、名字、时间、分组、archived；拒绝未决原生选择引用的条目，资产存在及引用核对和幂等收据与import一致。未提供photo表示清除照片元数据；candidate引用纳入references/prune。扫描失败需要篮内明确使用原图或重试，不能静默标为已扫描。

重拍任务保留旧条目，待新图就绪或候选确认后才调用replace；失败/取消只撤销临时任务，旧图不动。新图等待候选可以显示在原项的临时展开区，刷新后取消尚未完成的重拍而保留旧图。已导入的待选片状态和候选引用由Control持久化。候选、大图、更多和分组均在同一篮子内展开，不再叠加独立审阅主页面。

简易篮子采用紧凑strip与右侧发送/添加/更多三枚纵向图标；发送仍遵守multiple/明确单选、就绪门禁和Browser终态确认后才出篮。高级列表与我的文件复用相同照片动作，目录仍按时间排列。
