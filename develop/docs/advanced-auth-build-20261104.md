# 高级认证构建记录

以下首轮构建和测试覆盖早期 VP8 摄像头方案。用户随后要求同一 Peer 的独立认证 DataChannel 传输未压缩 RGB，服务端协商 5 FPS。新路径构建与运行验证分别记录。

## Chromium / SDK

开发机构建沿用 Chromium 官方 157.0.8103.15、固定基线 `1aa07b638799e59656559ae6c6649d4b197f555e` 和 `out/dev`。

```powershell
& 'C:\src\depot_tools\python3.bat' tools/chromium.py stage
& 'C:\src\depot_tools\python3.bat' tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_rtc_adaptation_probe
```

首次增量构建退出码 0，Siso 完成 4 步（17.74 秒）。在数据通道与音频门禁变动完成后，重新运行上述两条命令，最终增量构建退出码 0，Siso 完成 4 步（15.00 秒）。日志位于 `develop/tmp/advanced-auth-build-20261104/chromium-build.log` 和 `chromium-final-build.log`。

```powershell
& 'C:\src\depot_tools\python3.bat' tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
& 'C:\src\chromium\src\out\dev\remotekit_rtc_adaptation_probe.exe'
```

SDK 导出和 RTC adaptation probe 均退出 0。Probe 包含 sender active 门禁切换与旧帧完成丢弃检查；实际摄像头和浏览器产品路径另行验证。

## 打包工具

```powershell
& 'C:\src\depot_tools\python3.bat' tools/test-package-runtime-layout.py
node --check tools/smoke-streaming-product.mjs
```

布局检查 3 项和 smoke 脚本语法检查通过。正式 `tools/setup-face-auth.py --verify` 验证 10 个运行时文件。实际打包复制函数将这些文件写入隔离临时目录，逐项数量和 SHA-256 一致。包内启动和模型可用性仍需运行验证。

## Endpoint Release

```powershell
tools\build-endpoint.cmd verify-media
```

首次构建因测试源的换行字面量错误退出 2，Face 库及 Endpoint 服务源编译通过。修复测试后复用 `build/endpoint-package`，16 个增量构建步骤成功，CTest 18/18 通过，人脸模型测试 5.96 秒。该轮使用 OpenCV 4.11.0 动态库，现已改用静态链接方案以满足项目 DLL 边界，最终静态路径需重新验证。日志为 `endpoint-release-verify-media.log` 和 `endpoint-release-final.log`。

## 未压缩 RGB 方案

SDK 独立认证 DataChannel 源码冻结后，复用 `out/dev` 按上述三目标重新 stage/build。Siso 完成 4 步（16.67 秒）。SDK 导出和 RTC adaptation probe 均退出 0，probe 新增超长认证消息拒绝检查。日志为 `chromium-rgb-build.log`、`sdk-rgb-export.log` 和 `rtc-rgb-adaptation-probe.log`。此 probe 不覆盖浏览器摄像头到 Endpoint 推理的链路。

静态 OpenCV 对应的正式打包资产清单共 11 项，包含四个 ONNX、模型许可和来源清单，以及 OpenCV、Protobuf 和 zlib 许可。对实际清单运行打包复制函数，隔离目录内的文件集合及逐项 SHA-256 一致。CPU 布局检查 3 项通过。

`tools\build-endpoint.cmd verify-media` 首次配置因 OpenCV CMake 导出目标引用错误的安装前缀失败。修正后原目录增量完成 27 步，CTest 19/19 通过（6.69 秒），包括 `endpoint_raw_camera`、`endpoint_product_authorization` 和 `endpoint_face_auth`。对最终 `endpoint_service.exe` 执行 `dumpbin /DEPENDENTS`，确认无 OpenCV DLL 导入。日志为 `endpoint-rgb-static.log`、`endpoint-rgb-static-final.log` 和 `endpoint-rgb-imports.log`。

在 `control` 执行 `npm.cmd run build`，TypeScript、Vite、Node ABI 137 生产 runtime 和生产启动 smoke 均通过。Vite 报告主 chunk 为 763.61 kB，超过默认 500 kB 告警线。完整 `npm.cmd test` 314/314 通过（约 8 秒）。日志为 `control-rgb-production.log` 和 `control-rgb-tests.log`。

CPU 构建和基准停止后执行 `tools\verify-sdk.cmd`，复用外部 SDK 消费者构建目录，8 步增量成功。实际 SDK、RTC（含 D3D）和 audio smoke 3/3 通过（1.05 秒）。日志为 `sdk-rgb-smoke.log`。

为了定位实际锁屏验收中的同 Peer 异常断开，QA 释放资源后执行 `tools\build-endpoint.cmd package`，含诊断记录的 Endpoint 增量构建 2 步通过。同时重新构建最新 Control 客户端和服务端，Vite 及启动 smoke 通过。日志为 `endpoint-diagnostic-build.log` 和 `control-diagnostic-production.log`。诊断结果由 QA 独立记录。

发现 Browser OSR RenderChannel teardown 生命周期问题后，运行正式 stage，并在同一次 Ninja 调用中构建 `remotekit_browser`、`remotekit_sdk`、`remotekit_render_channel_lifetime_probe`。Siso 5 步（26.65 秒）通过。新 probe 退出 0，SDK 导出完成。Control 定向 `tsx --test test/transport-control-rpc.test.ts` 17/17 通过，包含锁定/解锁保持同一 peer 与两条 DataChannel。日志前缀为 `chromium-lifetime-`、`sdk-lifetime-`、`render-channel-lifetime-probe.log` 和 `control-lifetime-transport-tests.log`。
