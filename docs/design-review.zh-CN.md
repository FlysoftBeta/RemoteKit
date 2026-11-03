# 架构选择与保留差距

| 选择 | 理由与实际边界 |
|---|---|
| 独立content embedder+C ABI SDK | 保留Chromium执行/合成，避免整套Chrome产品对象图及跨工具链C++ ABI |
| Control产品真相、Session恢复数据 | 产品无需理解PageState；故障恢复可用完整内部数据或有限URL分别处理 |
| 每Session独立Browser/atlas | 隔离存储与像素；当前一个Profile，不把这个限制当最终层级 |
| 无页面HWND的Aura离屏目标 | 复用输入/OOPIF/IME，不经过本地Present；进程辅助HWND仍存在 |
| Comp主动Begin与最多四个atlas Slot | 活动深度可调，逐Slot真实Fence及编码租约共同控制复用；Browser专用OSR目标再合成为atlas |
| 请求身份与共享内存元数据 | IPC携带generation/slot/value，每Slot Fence使用请求value；元数据提供一致布局/帧快照，不能代替GPU完成 |
| WS产品控制+直连WebRTC | 用户/租约与媒体生命周期分开；同用户当前单活跃Viewer是实现选择 |
| MUI多Window与真实viewport | 多窗口有独立tab归属，窄屏改变显示集合；平板UA不伪造屏幕尺寸 |
| WebRTC原生媒体适配 | 三档对应DegradationPreference，SetRates及source adaptation决定码率、媒体尺寸与限制；页面DPR不随网络改变 |
| QSV最快预设与较高码率 | 本机UHD630的已验证部署选择；NVENC不继承QSV私有设置，真实NVIDIA检查仍缺 |

原生popup widget像素/命中、完整IME replacement/span、多Profile、跨Browser sessionStorage、目录上传、认证/证书、跨端剪贴板、PDF/打印等差距仍保留。音频继续使用Chromium播放target与独立Opus管线；本次质量偏好只更新video sender。不能把缺少产品UI或旧demo拒绝行为当成用户放弃。

首版后Astra审查已推动恢复状态机、确定性几何规划及原子提交、反馈流身份分离三项有界重构，并修复关闭/回复和token作用域逻辑。实际结果统一写[当前状态](current-state.zh-CN.md)，不在这里追加实验时间线。[系统设计](architecture.zh-CN.md)与[Control设计](control-plane.zh-CN.md)记录当前功能逻辑。
