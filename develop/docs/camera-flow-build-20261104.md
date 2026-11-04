# 相机与彩色扫描构建（2026-11-04）

- Endpoint 复用 `build/endpoint-package` Release，保持 `BUILD_TESTING=ON`。一次增量 Ninja 构建 12 步并成功链接服务。首轮定向 CTest 中 file_upload、dc_file_services、file_library 通过，photo_processing 在模糊帧被清晰帧替换的断言失败，已交原生处理负责人定位。[首轮日志](../tmp/camera-flow-endpoint.log)
- Browser 与 SDK 沿用配套的 Chromium `out/dev`，本轮未改对应源码，无重建。

- Endpoint 第二轮包含 `asset.describe`、新分析尺度早停阈值及分析图预算测试修正。Release 重新链接，四项定向 CTest 全部通过。[通过日志](../tmp/camera-flow-endpoint-final.log)
- Control 首轮集中生产构建通过 TypeScript、Vite、运行库验证和启动 smoke。采集/DC 负责人定向测试 12 项通过，UI 负责人篮子排序及文件选择定位 5 项通过，Control 文件库负责人 6 项通过。低质量提示及失败重试、内存释放收尾后重新构建。[首轮日志](../tmp/camera-flow-control.log)
- Control 收尾版再次通过生产构建及启动 smoke。Vite 保留现有主资源块超过 500 kB 的警告。交接运行验收时，集中构建已退出。[收尾日志](../tmp/camera-flow-control-final.log)
- 运行首轮后修复相机 video ref、全屏 paper、文字对比度和窄屏篮子边距。Control 生产构建及启动 smoke 通过，再交接运行复验。[修复后日志](../tmp/camera-flow-control-postqa.log)
- 错误提示及会话视口收尾后的发布候选再次通过 Control 生产构建及启动 smoke。[发布候选日志](../tmp/camera-flow-control-release.log)
- 最终窄修使用同一次发布候选构建，修复视口边界变化时的选择器定位和相机失败提示。此前篮子排序及文件选择定位定向测试 5 项通过，最终窄修未重跑定向测试。最终窄屏、平板和 Chrome 89 活跃页由独立运行验收覆盖。
