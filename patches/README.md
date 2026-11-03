# Chromium patchset

有序清单与SHA256以manifest.json为准。基线为官方157.0.8103.15，HEAD 1aa07b638799e59656559ae6c6649d4b197f555e。2026-11-03重组为七补丁，旧capture、CopyOutput profile、capture rate和synthetic VSync实验已删除。

| 补丁 | 归属 |
|---|---|
| 0003-offscreen-root | 显式offscreen root适配；正式服务使用null-widget Aura root |
| 0006-continuous-video-frame-callbacks | 持续视频帧回调的既有修正 |
| 0008-touch-injection-dispatch-result | 官方touch受理结果，不替代canonical ACK |
| 0009-headless-fling-physical-metrics | 服务固定逻辑PPI，不读宿主显示器物理指标 |
| 0010-client-gesture-arbitration | touch-action/preventDefault与逐包ACK仲裁 |
| 0013-remotekit-osr-output | 专用OSR、完整token、Begin到GPU顺序、完整画面、真实ANGLE Fence，整合旧0011/12完成保护 |
| 0014-webrtc-screenshare-adaptation | RemoteKit专属screenshare适配门禁与H264 parser组件导出 |

0013由RemoteKitOsrOutput显式启用，直接绘制导入DXGI SharedImage。目标选择先于paint，Skia结束后在ANGLE实际context排Signal。CPU interval和GPU提交结果共同结束内部请求，提交不冒充GPU完成。普通Chrome不启用后端。

0014由SDK开启WebRTC-RemoteKit-ScreenshareAdaptation trial；保持screenshare身份与原生算法/阈值。硬件无QP时用官方Annex B parser。

项目overlay由tools/chromium.py stage管理，不属于tracked patch。修改tracked源码须维护patch/hash并验证完整撤回/重放，不reset/clean其他项目rb/stash/re。record仅适用于此前未被patch拥有的tracked路径，已有路径维护有序diff。

常用检查为tools/patchset.py status/apply和tools/chromium.py stage。新路径编译与硬件验收见docs/current-state.zh-CN.md，不能沿用旧capture结果。
