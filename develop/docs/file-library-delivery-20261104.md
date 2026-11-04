# 文件篮、我的文件与Endpoint照片处理交付

功能源码为 `7ab9b62bf078052fc47fee7eb8889b08eab4f08b`，已推送至origin/main。包内manifest记录该干净提交；交付结果文档后续独立提交，不改变包内程序。

## 包与核验

- `develop/tmp/RemoteKit-win-x64-streaming-qsv-nvenc-20261104-170701.zip`
- 505,436,504 bytes。
- SHA256 `2da620a88e72d12f9f5881687f96373020bb64d4577f7fe51c262201e8cafa0c`。
- 正式 `tools/package-runtime.py` streaming包，包含Node/Control生产runtime、Browser/SDK与Endpoint；解压运行`run.cmd`。
- 570项清单文件、571个ZIP文件CRC及逐文件hash、11项人脸资产与整包SHA256旁文件校验通过。包内启动、认证与Endpoint管理smoke通过。实体凭据、Profile、日志和PDB不随包提供。

## 功能与证据

Endpoint负责短连拍评分、近重复过滤、文档矫正和扫描增强，只有需要人工比较的槽位展示候选。全屏连续拍照后统一检查、原位重拍和移除。文件与照片共用有序文件篮，图片为主采用可整卡拖动的横向卡片；普通文件明显居多时使用手柄列表及直接操作按钮，可手动切换。我的文件是独立tab，按时间显示、分组、上传和加入文件篮；内容按Session内SHA-256存储，经既有RTC传输。

配套原生和Control构建、文件定向测试通过。Chrome157/89真实H.264/QSV整链验证原生FileList字节与顺序、选择成功才出篮、分组、连续拍照和候选门禁、后处理、鼠标/触屏/键盘排序、过期排序回滚、刷新后缩略图、动态输入位置撤销及授权换代。此前发现的QSV低FPS Reset -14已修，UHD630独立硬件与两版解锁恢复通过。

最终包使用包内Node、Control、Endpoint和Browser/SDK运行Chrome157整组通过，证据为`develop/tmp/file-library-package-157`。审阅大图、候选对比和窄屏我的文件均通过图片边界几何断言与Sol截图复核；文档底边/文字行完整，列表提示准确，无阻塞视觉问题。该组实际触发1FPS、37.929Mbps的QSV Reset -14，同encoder完成reinit后继续运行和解锁，peer/DC/轨道保持；自有测试进程已退出。

## 上传

按仓库上传流程，通过隔离Playwright浏览器上传上述同一ZIP。2026-11-04 17:33:57（UTC+8）观察到AirPortal“文件已成功发送”回执，公开取件链接由页面复制按钮取得：[162141](https://airportal.cn/162141/wiVzM0mMmp)。发送表单显示有效24小时、最多下载2次、密码留空；未额外下载消耗额度。凭据未写入仓库或运行包。

[构建](file-library-build-20261104.md) · [运行与视觉](file-library-qa-20261104.md) · [QSV定位](file-unlock-investigation-20261104.md) · [正式契约](../../docs/file-library-contract.md)。

合成摄像头验证采集接线和状态机，未替代实体摄像头、运动及复杂光照效果。Browser选择完成表示原生FileList交付，不代表目标网站后端收到上传。结果真实未知时保留文件和引用，不盲目重交。子框架input当前回退Dialog。
