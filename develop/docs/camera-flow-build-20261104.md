# 相机与彩色扫描构建（2026-11-04）

- Endpoint 复用 `build/endpoint-package` Release，保持 `BUILD_TESTING=ON`。一次增量 Ninja 构建 12 步并成功链接服务。首轮定向 CTest 中 file_upload、dc_file_services、file_library 通过，photo_processing 在模糊帧被清晰帧替换的断言失败，已交原生处理负责人定位。[首轮日志](../tmp/camera-flow-endpoint.log)
- Browser 与 SDK 沿用配套的 Chromium `out/dev`，本轮未改对应源码，无重建。

- Endpoint 第二轮包含 `asset.describe`、新分析尺度早停阈值及分析图预算测试修正。Release 重新链接，四项定向 CTest 全部通过。[通过日志](../tmp/camera-flow-endpoint-final.log)
- Control 首轮集中生产构建通过 TypeScript、Vite、运行库验证和启动 smoke。采集/DC 负责人首轮 12 项、最终 13 项定向测试通过，新增项覆盖原图 PNG 与缩略图各自的字节上限，UI 负责人篮子排序及文件选择定位 5 项通过，Control 文件库负责人 6 项通过。低质量提示及失败重试、内存释放收尾后重新构建。[首轮日志](../tmp/camera-flow-control.log)
- Control 收尾版再次通过生产构建及启动 smoke。Vite 保留现有主资源块超过 500 kB 的警告。交接运行验收时，集中构建已退出。[收尾日志](../tmp/camera-flow-control-final.log)
- 运行首轮后修复相机 video ref、全屏 paper、文字对比度和窄屏篮子边距。Control 生产构建及启动 smoke 通过，再交接运行复验。[修复后日志](../tmp/camera-flow-control-postqa.log)
- 发布候选包含「我的文件」相机角标目的地计数、候选/更多面板显式最大高度 560/360px，以及锚点最小可用高度 156px。Control 生产构建与启动 smoke 通过。此前篮子排序及文件选择定位定向测试 5 项通过，最终锚点定向测试 3/3 通过，含 156px 保持锚定和 155px 回退对话框。独立运行验收验证了 191px 可用高度的锚定。[发布候选日志](../tmp/camera-flow-control-release.log) · [锚点测试日志](../tmp/camera-flow-final-anchor.log) · [运行验收](camera-flow-qa-20261104.md)

## 干净源码串流包

从干净提交 `3e7ad7ac6ea2f9d2b639111dedaaafa97d264d73` 执行 `tools/package-runtime.py --out dev --smoke`，生成 [RemoteKit-win-x64-streaming-qsv-nvenc-20261104-194030.zip](../tmp/RemoteKit-win-x64-streaming-qsv-nvenc-20261104-194030.zip)，505,509,847 字节，SHA256 `db7871c74d87332292897d4dbb37a390455a8f2ab59ec1496c1ec0946b5d651a`。包内启动、认证及 Endpoint 管理 smoke 通过。[打包日志](../tmp/camera-flow-package.log)

核对 570 项文件清单、571 项 ZIP 成员 CRC 及内容、11 项人脸运行资产及整包 SHA256。Browser、SDK、Endpoint、libvpl、Node 和 Control 服务端产物路径与来源哈希匹配。清单路径检查未发现凭据、Profile、数据目录或构建中间产物。GPU 及实际 Viewer 操作由独立运行验收覆盖。[完整性日志](../tmp/camera-flow-package-integrity.log)
