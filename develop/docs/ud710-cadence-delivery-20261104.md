# QSV 发送积压修复交付

源码 `d275b28ba0c0876ff2e2324bbae403c235622f9c` 已推送。成品使用干净源码，包含QSV观测帧率去抖与到期收敛、WebRTC原生超发保护、Stats指标更名及占位标签导航门禁。固定时基、BRC-only和CBR实验没有进入产品。

- 包：`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-224459.zip`
- 大小：505530668 bytes
- SHA256：`4ef242677b43261f24eaec583e734567322917c2f6877982ceac19168547770c`
- Endpoint：`eababcfe52eac4b0d15e003be4d8ff808df5d20dfc7ca6c1fa6d1108519d2e67`
- SDK：`15c3acf396eaaa0376a2b4d620e5be52b6ea0b9d2bdd48c2949045d32b06e1f8`

`tools/package-runtime.py --smoke`通过包内Node/认证/Control/Endpoint管理启动检查；manifest的570项运行文件与ZIP的571项（含manifest）逐项大小、SHA256和CRC核验通过，实际Browser、SDK、Endpoint和Control产物与已测试版本匹配。没有把打包启动检查称为包内RTC性能复验。真实157/89和实验结果见[本地记录](ud710-local-repro-20261104.md)，原始验证文件在忽略目录`develop/tmp/ud710-package-verification.json`。

按[上传流程](../../docs/upload/README.md)操作。共享Playwright MCP的Edge Profile被占用，使用已经安装的Playwright MCP启动独立无头、隔离会话，不使用用户桌面/Profile。凭据不进入构建包和Git。

2026-11-04 23:19:43（北京时间）按用户“停止上传”指令，在82%时点击“终止”，确认“正在上传”状态消失、返回首页，随后关闭本次隔离浏览器。本次没有上传成功或取件码，不再重试；本地ZIP与验证记录保留。后续实验准备另见[音频隔离计划](ud710-av-experiment-20261104.md)，其SDK音频发送统计增量不在这个包内。
