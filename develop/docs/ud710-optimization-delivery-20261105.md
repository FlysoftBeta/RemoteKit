# UD710多轮优化交付

本轮用户重新授权“多改进几轮，之后打包上传”。最终保留原生pacing factor 1.1、QSV实际码控参数诊断及运行时hash校验，并包含此前的超发保护、QSV时基去抖和音频发送统计。LowDelayBRC启用、I=5T/P=2T和pacing1.5已从产品代码移除；接收0/10未采用，默认仍0/50。完整实验见[汇总](ud710-followup-20261105.md)与[最终pacing对照](ud710-pacing-20261105.md)。

## 成品与校验

- 干净源码提交：`002aab58953aed07c417bd470c6531e569e4bac2`，已推送origin/main。
- 包：`develop/tmp/RemoteKit-win-x64-streaming-qsv-nvenc-20261105-071243.zip`，505532753 bytes。
- SHA256：`11598b666bb6f4431de4ebb2812385827a0fad50a046835c61a988ac6852c2b4`。
- 包内SDK：`fc3b1361e6015693aa27adf83fd14130600e15e326b03db1ff0f493b6bbb5f76`；Endpoint：`d3ab34eecd1c9665db4aec4f10ea628ded78f6586f28ae5fdc7e3768a9b0136b`。不是返回基线组临时使用的289E SDK。
- 570项清单文件及571个ZIP文件逐项hash/CRC通过，11项人脸资产与源文件匹配。未包含凭据、profile、日志、PDB或实验二进制。
- `tools/package-runtime.py --smoke`通过包内Node/Control启动、认证、Endpoint管理与人脸资产检查。证据：`develop/tmp/ud710-final-package-20261105.log`、`ud710-final-package-verification.json`。

最终包Native组件与Chrome89.0.4389.90真实H.264组通过首帧、2/15Hz活动与停止、诊断开始/停止/归档，以及1936×816→1136×624尺寸切换；解码182→187、同peer/两条track/两条DataChannel保持。正常Viewer未下载文件，诊断ID只在归档完成后出现。包内SDK日志确认配置1.1、RFC8888未启用和协商transport-sequence扩展。该组使用工作区Control dist，其server/client/runtime与成品逐项校验保持一致；包内Control另由startup smoke验证。证据：`develop/tmp/ud710-final-chrome89/`。这是功能兼容检查，不是额外性能矩阵或实体平板验收。

## 上传

2026-11-05 07:17（UTC+8）确认平台显示“文件已成功发送”。取件码[774805](https://airportal.cn/774805/uFqAoQNWrJ)，有效24小时、可下载2次、无密码。取件页再次显示正确的最终包名，download事件为空，未消耗文件下载。

使用隔离、无头Playwright MCP按仓库上传流程操作，账号资料只用于登录，不写入报告或成品。浏览器输出文件已执行凭据文本脱敏；成品和Git均不包含上传会话。证据：`develop/tmp/ud710-final-upload/completion.json`、`verified-link.json`。最终功能及上传结束后关闭自有测试/上传进程；未操作用户浏览器或RDP会话。
