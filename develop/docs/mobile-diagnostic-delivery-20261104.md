# 诊断收集与全屏增量交付

用户重新授权上传后，以干净提交 `dd6d850` 生成串流成品。功能来自 `d94c765` 的诊断收集和 `c7308c0` 的全屏支持；`dd6d850` 只补充成品README中的诊断入口与存储说明。

2026-11-04 21:13:04（北京时间，UTC+8）AirPortal确认“文件已成功发送”。取件码[761470](https://airportal.cn/761470/EXGZc1IoQx)，有效24小时、可下载2次、无密码。没有通过下载消耗次数。上传沿用仓库流程，因共享Edge Profile已被占用，使用独立Playwright MCP实例完成；成功证据在 `develop/tmp/diagnostic-release-upload-state.yml`。

## 成品核验

- 文件：`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-205438.zip`。
- 大小：505528984 bytes。
- SHA256：`519c4a178bd4343f181425d76c84bfa3433734618c571d427a4afc11b5ea19a0`。
- `tools/package-runtime.py --smoke` 生成；manifest源码干净，571个ZIP文件逐项大小、SHA256与CRC核对通过。包内Node24.22.0支持Zstandard，关键Browser/SDK/Endpoint/Control产物与已验证构建一致；启动、认证和Endpoint管理smoke通过。
- 诊断功能的157/89真实H.264设置开始→悬浮停止→归档ID、媒体连接保持、逐帧RTP匹配、157重启查询见[运行记录](mobile-diagnostic-runtime-20261104.md)。打包后以产物哈希核对衔接，未重复性能矩阵或宣称重新运行包内媒体验收。

## 使用与范围

在更多→设置→诊断中开始，复现卡顿，再点击悬浮“停止数据收集”。服务端生成tar.zst后，客户端显示诊断ID。归档默认位于Control数据库同级的 `diagnostics/<租户hash>/<ID>.tar.zst`；详情见[诊断契约](../../docs/diagnostic-collection.md)。

包同时包含此前尚未上传的Viewer自动全屏和内部网页全屏功能，范围见[全屏运行记录](fullscreen-runtime-20261104.md)。UD710/Brave138的卡顿仍待实体设备诊断，未排除网络，也没有将本批设施宣称为卡顿修复。
