# 全屏构建（2026-11-04）

- Chromium 复用 out/dev。先用 `tools/chromium.py stage` 管理源码，再在同一次 Ninja 中构建 `remotekit_browser` 和 `remotekit_sdk`。Browser 增量编译两项并链接，22.70 秒成功。SDK 无需重编，DLL 和 import library 的 SHA256 均与现有 `sdk/dist/dev` 相同。已核对本批 Browser 文件与 overlay 内容一致。[构建日志](../tmp/fullscreen-chromium-build.log)
- Endpoint 通过 `tools/build-endpoint.cmd package` 复用 `build/endpoint-package` 的 Release 产物，四步增量构建完成。定向重新编译 `endpoint_direct_services_tests` 后，CTest 1/1 通过。第一次从未初始化 Visual Studio 环境的 shell 启动该测试编译，MSVC 未找到标准头 `cstddef`，使用 `VsDevCmd.bat` 的 x64 环境后通过。[构建日志](../tmp/fullscreen-endpoint-build.log) · [定向测试日志](../tmp/fullscreen-endpoint-tests.log)

- Control 的 `npm run build` 通过 TypeScript、Vite、Node 生产运行库验证和生产启动 smoke。Vite 保留主资源块超过 500 kB 的警告。生产构建完成后交给独立运行代理执行真实全屏组。[构建日志](../tmp/fullscreen-control-build.log)
