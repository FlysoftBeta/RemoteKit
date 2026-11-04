# 键盘与尺寸过渡构建记录（2026-11-04）

本批沿用`out/dev`与`build/endpoint-package`增量产物。项目Browser/SDK源由`tools/chromium.py stage`同步，未修改Chromium tracked补丁；实际串流结果单列在[运行记录](keyboard-viewport-runtime-20261104.md)。

## Control

`npm.cmd run build`通过TypeScript、Vite、生产服务检查和启动smoke。完整`npm.cmd test`通过319项；后续收紧早到编辑租约和键盘/普通布局分类后，16项相关测试与最终生产构建通过。最后的分类负例检查触屏设备在键盘已打开时，仅父内容区改变高度也使用普通模糊拉伸。

## Browser / SDK / Endpoint

Browser与SDK通过同次`tools/chromium.py build --target remotekit_browser --target remotekit_sdk`增量核验。首次失败来自同工作区另一个任务新增的adapter LUID解析触发Chromium安全缓冲区编译检查；该任务修正并提交为`f75c0be`。后续构建由另一个已运行的Ninja持锁完成，本任务等待退出后确认up-to-date。相关项目源及共享头的stage SHA一致。日志：`develop/tmp/keyboard-native-build.log`。

集成审阅发现`f75c0be`暂存补丁把GetDesc1留在LUID比较之后，实际构建工作树已有正确顺序。root以独立提交`33755d8`收录“先读取adapter描述再比较LUID”的一行移动，使提交源码与本轮实际成功产物一致；未把此遗漏混为键盘根因。

`tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev`成功，导出的SDK运行DLL与构建DLL一致。日志：`develop/tmp/keyboard-native-sdk-export.log`。

`tools/build-endpoint.cmd verify-media`完成33步Release增量，首轮CTest18/19通过。`endpoint_direct_services`失败是新测试少计了一次已合并发送但仍递增revision的更新；预期修正为2→3→4后，仅重建该测试并定向CTest1/1通过。19项测试至此全部完成，不把两轮写成一次全绿。日志：`develop/tmp/keyboard-native-endpoint.log`、`develop/tmp/keyboard-native-endpoint-retest.log`。

## 交给运行验收的产物

| 产物 | SHA256 |
| --- | --- |
| `out/dev/remotekit_browser.exe` | `92ba33c319ac2b5d6eb4160ac0acb6f3dae3930d57253d085eeac053e63e2b83` |
| `out/dev/remotekit_sdk.dll` | `12a961153c50a405c64eb2c7446a7504f7855a377780566ccdc78911fa5205ef` |
| `build/endpoint-package/endpoint/endpoint_service.exe` | `7ebdcfeb7dbfc80fc204ff3d32d8df5101ef3e71f490751f4e82e0246ec207fd` |

SharedRenderMapping升为版本2/38784字节，`SharedAtlasTextInput`新增稳定target，Browser/SDK/Endpoint须整套更新。控制/渲染C ABI仍为2、RTC ABI仍为4。没有追加历史性能矩阵，也没有实体移动键盘验收。
