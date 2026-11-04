# 文件库增量构建（2026-11-04）

- Endpoint 复用 `build/endpoint-package`，Release，开启 `BUILD_TESTING`。首轮 MSVC 检出文件库字符串字面量损坏及 JSON 请求 ID 与字符串比较失败，修复后编译通过。包含上传草稿授权换代、选择收据和隔离补充的最终版本重新链接 `endpoint_service.exe`。定向 CTest 4/4 通过（file_upload、dc_file_services、photo_processing、file_library）。[最终日志](../tmp/file-library-endpoint-final.log)
- Chromium 管理补丁 0016 刷新清单 SHA256，由补丁负责人验证九项应用状态和反向检查。RemoteKit 源码使用 `tools/chromium.py --out dev stage`。复用 `C:/src/chromium/src/out/dev`，Browser 与 SDK 在同一次增量 Ninja 构建。前三轮依次修复 Chromium 内联虚函数风格、Blink API 和 raw_ptr 规则、JavaScript 对话框的 Reply 绑定实参。最终完成 129 步，用时 5 分 18 秒。现有 SDK DLL 与 `sdk/dist/dev` 副本的 SHA256 一致，Endpoint 从 Browser 所在目录加载 DLL。[最终日志](../tmp/file-library-chromium-retry3.log)
- Control `npm run build` 在删除和候选大图功能合入后通过 TypeScript、Vite、服务端产物验证和生产启动 smoke。Vite 报告主资源块超过 500 kB。[最终日志](../tmp/file-library-control-final.log)

以上为编译、定向 CPU 测试和 Control 启动 smoke。真实 Viewer、摄像头与浏览器文件选择路径由独立运行验收记录覆盖。

Chrome157 首轮运行验收后的补充版本继续复用同一 Endpoint Release 输出及 Control 生产构建目录。Endpoint 加入仅撤销未提交选择的保护后，定向 CTest 4/4 通过。Control 相机对比度及对话框名称更新后的生产构建与启动 smoke 通过。Browser/SDK 沿用上述产物。日志为 develop/tmp/file-library-endpoint-postqa.log 与 develop/tmp/file-library-control-postqa.log。

双布局与服务端缩略图合入后，同一 Endpoint Release 构建包含 QSV 修复及新缩略图路径，定向 CTest 4/4 再通过。Control 最终双布局、拖放及菜单焦点版本的 TypeScript、Vite、生产运行库验证与启动 smoke 通过。日志为 develop/tmp/file-library-endpoint-thumbnail.log 与 develop/tmp/file-library-control-dual-mode-final.log。

157/89 双布局验收后修正缩略图裁切和单选提示。修正版本的 Control 生产构建及启动 smoke 通过，日志为 develop/tmp/file-library-control-visual-final.log。

## 本地串流包

用 `tools/package-runtime.py --out dev --smoke` 从干净源码 `7ab9b62bf078052fc47fee7eb8889b08eab4f08b` 生成 `RemoteKit-win-x64-streaming-qsv-nvenc-20261104-170701.zip`，505436504 bytes，SHA256 `2da620a88e72d12f9f5881687f96373020bb64d4577f7fe51c262201e8cafa0c`。逐项核对 570 个 manifest 文件、571 个 ZIP 文件的 CRC 和内容、11 项人脸资产及整包 SHA256。包内启动、认证与 Endpoint 管理 smoke 通过。日志为 `develop/tmp/file-library-runtime-package.log` 与 `develop/tmp/file-library-runtime-integrity.log`。
