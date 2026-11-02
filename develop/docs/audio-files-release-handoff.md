# 音频与文件发布交接

本文件所在提交完成音频播放target/Opus、Viewer声道设置、网页文件上传、Worker拍照、诊断与video+clip对照。尚未生成或上传本批最终包。

## 已完成

- Browser/SDK out/dev增量build并export到sdk/dist/dev，Release Endpoint在build/endpoint-package/endpoint/endpoint_service.exe。native源码此后未改，11套Endpoint CPU及SDK音频smoke通过。
- Control168项全测与生产build/smoke通过；后续文件单选修复已进入dist，并经157/89真实功能组验证。
- camera ImageBitmap/OffscreenWorker优化通过4项模型、tsc、生产build及157/89首次冷burst、视觉/取消清理。最终同步throw进入fallback的小修已包含在release_audio_files_clean的最终生产build中；171/171测试、tsc、Vite/server bundle核验与startup smoke全部通过。
- GPU实验和所有自有浏览器/fixture已关闭。video+clip对照降低3D成本但无帧率优势，不替换产品后端。详见current-state及各专项报告。

## 发布阻碍与续接

先前collaboration反复返回agent thread limit reached，三个旧代理停在pending_init，interrupt未释放额度。随后按Issue #49986，对三个已确认结束的代理各执行一次无工作followup，全部收到final后，成功创建全新release_audio_files_clean。没有将旧代理转去发布。该清理路径已记录AGENTS.md。

额度恢复后新建Sol6.1 Medium、fork none，执行同一连续发布任务：

1. 读AGENTS、docs/packaging.zh-CN.md、docs/upload/README.md。完整Control tests、tsc、生产build/smoke，核camera-score.js入dist；不重复native构建或媒体性能组。
2. 使用当前已提交HEAD生成普通streaming包，含Node/Control、最新audio SDK导出与Endpoint。包放develop/tmp，核manifest、ZIP逐文件hash/禁止项和启动smoke，不把旧ba0deec诊断EXE装回去。
3. 用户已授权上传；按upload README使用host-managed Playwright，不操作桌面，不输出凭据。交付code/link/expiry/downloadlimit/ZIP字节/SHA256及release-HEAD-delivery.json。关闭自有默认host browser，避免profile锁。

root仍负责新增修复后的commit/push。不得将上一批609418或诊断342375取件码冒充本批交付。
