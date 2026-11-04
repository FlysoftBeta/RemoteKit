# 高级认证交付记录

## 版本和发布包

功能源码`ba667bfe5675e4aa9bf2fc973b1b269ae65068f5`已提交并推送到`FlysoftBeta/RemoteKit`的main。包含空白序列锁屏、密码/PIN/人脸及自动锁定设置、Control挑战与权限管理、Endpoint RGB24摄像头协议和YuNet/SFace、MiniFASNet V1SE/V2推理，以及锁屏暴露的RenderChannel析构重入修复。此前单独未发布的Rend Wake优先发帧也包含在内。

- 文件：`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-080340.zip`
- 大小：504933129 bytes（481.5 MiB）
- SHA-256：`3314e13738f6cf473334f6d895ce6b2c56fc1a3530ac276ca17344f00cd0a8dc`
- manifest源码：`ba667bfe5675e4aa9bf2fc973b1b269ae65068f5`，`remotekit_source_dirty=false`
- 包内包含Node/Control生产runtime、Endpoint Release、匹配Browser/SDK、四个ONNX模型及许可。README说明纯黑入口的方向序列。没有凭据、模板密钥、开发Profile、数据库、日志、PDB或构建输入。

2026-11-04 08:09:29（Asia/Singapore）核对AirPortal成功回执“文件已成功发送”。取件码[316234](https://airportal.cn/316234/d99cU47GIx)，页面显示24小时、可下载2次、无密码。没有通过下载消耗领取次数。

使用本机已安装Playwright MCP的独立无头会话上传。原host-managed Edge profile被占用，保留原进程；本次自有MCP及浏览器上传后关闭。凭据未写入发布包或源码，交付证据仅保留脱敏回执。

## 校验与实际运行

正式`tools/package-runtime.py --smoke`通过，包含Endpoint管理链路、模型可用性、有Cookie重附着锁定及密码恢复。571项manifest逐文件大小/SHA-256、ZIP CRC/解压后SHA-256、校验和sidecar及11项人脸运行资产全部通过。

独立Chrome157包内产品检查通过真实H264、锁屏期间无新产品快照、旧输入拒绝、PIN解锁和同peer/两个DataChannel保持。进程加载的Endpoint、Browser、SDK均来自该包，hash与manifest匹配。没有FATAL/CHECK/GPU退出，自有客户端/服务已退出。

证据位于忽略目录`develop/tmp/advanced-auth-build-20261104/`的`package-final.log`、`package-verification.json`、`package-product-smoke.json`，以及`develop/tmp/advanced-auth-qa/packaged-RemoteKit-win-x64-streaming-qsv-nvenc-20261104-080340/`。

完整源码验证另见[构建记录](advanced-auth-build-20261104.md)与[Chrome157/89运行记录](advanced-auth-runtime-20261104.md)：Control314项及后续transport17项、Endpoint19项、SDK/RTC/audio smoke3项和新增生产Mojo生命周期probe通过。两版保持同peer/DC/接收track锁定及密码/PIN恢复，RGB24实际5帧传输和取消停发通过；89实际15秒页面闲置与重附着默认锁定通过。官方T1合成摄像头组跑通登记、AES-GCM模板、锁下匹配解锁与空帧离开锁定。

## 识别评测与保留边界

固定阈值0.50，LFW官方6,000对的识别阶段准确率81.07%，异人误接受0/3,000，同人误拒绝37.87%。双方成功提取特征的4,130对准确率95.62%；主要拒绝来自多人脸/质量门禁。未调整阈值或剔除样本，详见[完整评测](face-public-benchmark-20261104.md)。

合成摄像头和LFW均不能代替实体摄像头、真人与活体抗伪造效果。两个headed浏览器的第二tab探针未产生可信hidden，真实后台触发、系统锁屏和物理关屏仍待设备验收。本次没有重复旧性能矩阵或全库两阶段审查。
