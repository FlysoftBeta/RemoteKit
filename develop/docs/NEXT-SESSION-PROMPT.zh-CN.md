继续 RemoteKit 项目，工作目录是 `C:\Users\Flysoft\Desktop\remotekit2`。

请先依次读取：
1. `AGENTS.md`
2. `docs/current-state.zh-CN.md`
3. `develop/docs/HANDOFF-2026-11-02-default-video.zh-CN.md`
4. `develop/docs/default-video-plan.md`

然后直接推进实现和发布，不要只回复计划或重复询问已有授权。

目前音频播放target/Opus、Viewer左右声道设置、网页文件上传、Worker拍照选帧已经实现并验证，提交为c379f6c；171项Control测试、生产build/smoke及89/157功能检查已完成。1bc5f40记录了下一步默认video要求，之后还有交接文档提交。请自己核对当前git状态；这些本地提交因网络问题尚未推送。

真正未完成的是：将正式Viewer改为默认video呈现，完成必要验证，再构建并上传新包。此前发布已经停止，没有生成或上传本批最终包，三个video实验工具也不是产品实现。

我的最新要求：
- video显示布局来自客户端内容区域bounds，服务端atlas矩形用于裁剪。
- 不默认启用原生controls、画中画、远程播放和其他多余媒体功能。
- 保留Chrome89、split多Window、正确DPR/输入坐标、布局换代保护及现有音频/上传。
- 本次优先上传；仅本次GitHub推送尽力而为，网络问题我回家处理。以后仍按正常commit/push约定。
- 子代理必须按任务隔离，重要milestone后用新上下文；普通实现/实验/构建/验证用Sol6.1 Medium、fork_turns="none"，视觉验证Sol6.1，UI设计Astra6 Medium。root负责架构、契约、文档、集成审阅与commit，不委派核心架构决策。没有授权root代替所有子代理直接实现。

旧对话的代理槽位多次卡住。我已经让它把 `C:\Users\Flysoft\.codex\config.toml` 的 `[agents].max_concurrent_threads_per_session` 改为128，配置加载验证通过，并准备重启app server。请先确认新会话实际能力，再创建本任务需要的新代理，不要用128个空任务测试，也不要复用旧代理做新工作。若再次出现已结束代理pending_init，可按交接文档做一次无工作final清理，不要忙循环。

默认video的布局屏障是前一root提出的方案，详见计划：Endpoint在真正encoded发布前hold新布局，客户端隐藏旧video并ACK后放行；需覆盖旧inflight结果，不能只靠rVFC事后检查。请核查实际源码后落实或由root调整方案，保证布局和输入对应；不要因为前次实验没有FPS优势就停在比较报告。客户端默认路径不要同时保留无用MSTP/canvas绘制，canvas可作能力/协议失败回退。

禁止读取旧 `C:\Users\Flysoft\Desktop\remotekit`；复用Chromium out/dev/out/rel增量构建，不做全量构建或重复旧性能矩阵。GPU运行组与大构建错开；不抢我的鼠标键盘。已授权host-managed Playwright测试及发布上传。

实现完成后按实际变更验证89/157的单窗/split、客户端bounds变化、布局换代、输入、无原生媒体入口和音频共存，给对应截图。root本地提交后，委派全新Sol6.1按 `docs/upload/README.md` 和 `docs/packaging.zh-CN.md` 构建校验并上传streaming包。最终给取件码/链接、SHA256及Viewer效果图。不要把旧取件码当新发布，不因本次GitHub网络问题拖延上传。
