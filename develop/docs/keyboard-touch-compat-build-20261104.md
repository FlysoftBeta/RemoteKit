# 站点兼容设置、键盘与触控构建记录（2026-11-04）

复用 Chromium `out/dev` 和 Endpoint `build/endpoint-package` Release 产物。Browser 项目源通过正式 stage 工具同步。本批未修改 Chromium tracked 补丁。日志保存在 `develop/tmp/keyboard-touch-compat-build-20261104/`。

| 日志 | 命令 | 退出码与结果 |
| --- | --- | --- |
| `01-stage.log` | `C:/src/depot_tools/python3.bat tools/chromium.py stage` | 0 |
| `02-chromium-build.log` | `C:/src/depot_tools/python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_client_gesture_probe` | 0，三个目标同次增量，8 步，SDK 已最新 |
| `03-client-gesture-probe.log` | `C:/src/chromium/src/out/dev/remotekit_client_gesture_probe.exe` | -2147483645，断言失败，见下文 |
| `04-sdk-export.log` | `C:/src/depot_tools/python3.bat tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev` | 0 |
| `05-endpoint-verify-media.log` | `tools/build-endpoint.cmd verify-media` | 0，Release 增量 4 步，CTest 19/19 |
| `06-control-test.log` | 在 `control/` 运行 `npm.cmd test` | 0，333/333 |
| `07-control-build.log` | 在 `control/` 运行 `npm.cmd run build` | 0，TypeScript、Vite、生产服务验证和启动 smoke 通过 |
| `08-stage.log` | `C:/src/depot_tools/python3.bat tools/chromium.py stage` | 0 |
| `09-chromium-rebuild.log` | `C:/src/depot_tools/python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_client_gesture_probe` | 0，两个目标同次增量，6 步 |
| `10-client-gesture-probe-retest.log` | `C:/src/chromium/src/out/dev/remotekit_client_gesture_probe.exe` | 0，原断言通过 |

首个失败在 `browser/client_gesture_probe.cc:53`，待 ACK 记录解决后，下一次 Begin 可立即淘汰该记录，导致 `retired.Find(owner, "awaiting-ack")` 无法返回 `processed`。修复把已解决的记录按完成时刻移到队尾，保留容量 64 及对 pending 记录的保护。重建 Browser 和原 probe 后定向复测。该修正只涉及 Browser 账本，SDK、Endpoint 与 Control 使用前述成功产物。

## 产物 SHA256

| 产物 | SHA256 |
| --- | --- |
| `C:/src/chromium/src/out/dev/remotekit_browser.exe` | `0b75eea139d0da414d4280d53798580f444f8840dc1229acead8291a0f0789f9` |
| `C:/src/chromium/src/out/dev/remotekit_sdk.dll` 和 `sdk/dist/dev/bin/remotekit_sdk.dll` | `12a961153c50a405c64eb2c7446a7504f7855a377780566ccdc78911fa5205ef` |
| `build/endpoint-package/endpoint/endpoint_service.exe` | `554b0f18d1785d22a4ba05126081eebf5219e43a9aa9f2bee37cead47d438c3a` |
| `C:/src/chromium/src/out/dev/remotekit_client_gesture_probe.exe` | `a1d825edf92c9fe81b3df4fda2af72921cea0a135d2a87dd7d923b72df0cc146` |

本记录覆盖增量构建、CPU 回归与 Control 生产启动。实际 H264 会话和实体移动设备验证另行记录。
