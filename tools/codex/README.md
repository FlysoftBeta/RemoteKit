# 使用 Codex 委派任务

UI/UX 设计与架构设计之外的探索类、实现类任务可以交给 Codex；设计、审阅、集成、`docs/` 与提交由主对话负责。本文记录怎样用好它。

## 运行

```sh
tools/codex/run.sh <task-dir> <name> [low|medium|high]
```

- `<task-dir>` 放在仓库外（会话 scratchpad 或 `develop/tmp/`），里面写 `<name>.body.md`（任务正文）。脚本把 `preamble.md` + 正文 + `rules.md` 拼成 `<name>.prompt.md`，输出 `<name>.log` 和 `<name>.result.md`（Codex 的最终消息）。只读调查或纯操作任务用不到实现规则时，建一个空文件 `<name>.norules` 跳过 `rules.md`。
- 实际命令是 `codex exec -m gpt-6.1-sol -c model_reasoning_effort=<effort> -c project_doc_max_bytes=0 --dangerously-bypass-approvals-and-sandbox -o <result>`。`project_doc_max_bytes=0` 让它不读 `AGENTS.md`（那里的流程约定是写给主对话的，会干扰它）。
- 强度：实现、调查、真实栈验证用 `high`；上传这类机械操作用 `low`。
- 长任务在后台运行，等完成通知；不要轮询。偶发的 `model at capacity`、TLS 握手失败是服务端问题，原样重跑即可。
- 用 Write 工具写提示文件。Windows 上用 shell heredoc 或 `sed`/`node -e` 处理含反斜杠的路径时容易被转义吃掉，路径一律写成正斜杠。

## 写提示

Codex 会忠实完成字面任务，但不会多想。设计必须由主对话做完，再写进提示：

- **给决定好的目标**：模块划分、类名、状态枚举、错误约定、要删除的东西、行为边界。不要写"考虑一下如何改进"。把架构规格整段内联进提示（规格写成独立文件，用占位符替换进正文）。
- **给根因和证据**：如果是修 bug，写清现象、日志原文、已确认的机制和 file:line，以及期望的修法。先让只读调查任务定位根因，再派实现任务。
- **写清 Owned paths**：允许改哪些文件，并说明哪些文件别人正在改。范围要包含集成点（分发表、组装/接线文件、BUILD.gn/CMake、测试），否则它会改到一半停下并报告"需要别人改"。
- **写清验证方式**：具体构建命令、只跑相关测试、完整套件只在结尾跑一次、不跑 benchmark。需要真实栈时指明运行器。
- **要求简短报告**：改了什么（文件级）、做了哪些未指定的决定、什么没验证。

## 并行

- 按构建域划分：Browser（Chromium `out/dev`/`out/rel`）、Endpoint（`build/endpoint`）、Control（npm）可以同时构建；同一个 Chromium out 目录不能同时构建。需要并行两个 Endpoint 任务时，给其中一个单独的 CMake 目录（如 `build/endpoint-<task>`）。
- 跨组件的契约变更（线格式、错误形状）要么先定接口再分头实现，要么串行；并行时明确告诉双方对方会怎么改。
- 只读调查不占构建资源，可以和构建任务并行；计时测量必须独占 GPU，不和任何构建并行。

## 审阅

- 看 diff，不以它的报告为准。
- 常见问题：
  - 为了让测试通过，把线格式改回旧形状。
  - 在通用层按方法名特判。
  - 用魔数代替已有的枚举。
  - 保守地留下兼容分支、写防御性注释。
  - 改完不重跑受影响的测试。
- 它会把报告写进仓库（如 `develop/docs/`），浏览器自动化会留下 `.playwright-mcp/` 目录，提交前删掉。
- 多个组件分别重构后，必须派一个真实栈验证任务把它们一起跑通；单元测试全过不代表能协同工作。

## 隐私

处理用户的私人数据（照片、日志）时，提示里明确：不得查看图片内容，不得读取 EXIF，不得生成派生图片，不得把数据复制进仓库，只输出数值结果。数据放在仓库外的独立目录。

## 文档

`docs/` 由主对话亲自撰写。Codex 可以搜集资料（只读，输出到仓库外），不负责写设计文档：它的文字偏防御性，堆砌限定语和测试计数。
