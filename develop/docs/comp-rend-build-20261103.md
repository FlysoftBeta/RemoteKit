# Comp / Rend 构建与 CPU 验证（2026-11-03）

## 当前状态

2026-11-04：Browser/SDK 正式增量编译、SDK 导出与外部消费者 smoke 已通过；Endpoint Release 编译、15 项 CPU tests 及 H264 硬能力后续定向检查通过。实际 OSR/WebRTC 产品 GPU 运行由下一 QA 阶段验证，本报告不冒称完成。旧 capture 路径的构建、性能、包验证不作为本批证据。用户最新要求已改为完成后上传；root 后续单独委派上传，本代理此阶段未打包或上传。

构建执行者：`render_build_validation`。仅复用 `C:/src/chromium/src/out/dev`、`build/endpoint-package`、`build/sdk-smoke`；不 clean/full/fresh，不创建 Chromium out，不并发同 out 的 gen/build。CPU 构建期间不运行 GPU 实验。

## 已核对入口

- `tools/chromium.py` 默认所有逻辑 CPU，多个 `--target` 合并为一次 autoninja；build 会 stage 源码并按 GN 变化增量 gen。
- 当前 `out/dev/args.gn` 为 release component build、DCHECK 开启、symbol level 1；保留既有设置与增量产物。
- `tools/build-endpoint.cmd verify-media` 使用 VS18、depot_tools Python、`build/endpoint-package`、Release、BUILD_TESTING=ON，以 `all endpoint_client endpoint_encoder_smoke` 一次构建后运行全 ctest；`all` 覆盖所有当前非 EXCLUDE 测试。
- `tools/verify-sdk.cmd` 复用 `build/sdk-smoke`，以 `sdk/dist/dev` 的公开头、导入库及实际 DLL 构建外部消费者，并运行 SDK/RTC/audio smoke。
- `sdk/rtc-smoke.cc` 已包含本批公开 WebRTC 适配 API 的有效参数与无效参数检查；`browser/sdk:remotekit_rtc_adaptation_probe` 为 CPU-only 生产适配实现 probe。
- `remotekit_begin_frame_probe` 的现有二进制属于旧实现，必须重编；新 OSR probe target/参数等待 viz_osr_backend owner 给出，不运行已删除 capture probes。

## 顺序计划（尚未执行）

1. root 通知实现冻结；确认 patchset owner 已完成 manifest/hash 和可逆重放，确认 Chromium tracked 源码与本批补丁一致。
2. 使用 `C:/src/depot_tools/python3.bat tools/chromium.py stage` 托管 overlay。
3. 一次 `C:/src/depot_tools/python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_rtc_adaptation_probe --target remotekit_begin_frame_probe`，追加 owner 确认的新 OSR/Slot ABI probe targets；只允许同一 Ninja 调用内并行。
4. 执行本次新编的 CPU probes，逐项记录退出码、实际覆盖与参数；CPU-only 不等于 GPU Fence/OSR 真实验证。
5. `C:/src/depot_tools/python3.bat tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev`；核对 header/import lib/runtime manifest 与源输出 hash。
6. `tools/build-endpoint.cmd verify-media`。新 Endpoint pacing/slot CPU tests 及受影响 encoder CPU tests 必须存在并运行；不将 encoder smoke 的 GPU 执行混入 CPU 测试。
7. `tools/verify-sdk.cmd`；至少确认导出 SDK 实际 DLL 的 `remotekit_rtc_smoke`。如 owner 认为跨线程/信令 variants 受影响，使用同一新二进制补跑相应 CPU-only variants，不额外执行 GPU loopback。
8. package 等 root 后续统一信号；上传由 root 后续单独委派。运行阶段单独记录，由 root 安排 GPU 独占。

所有命令 stdout/stderr 和结果放 `develop/tmp/comp-rend-build-20261103/`。此文只保留结论、精确命令、版本/hash 与失败原因，不提交日志/产物。

## 已知待核对事项

准备阶段发现 `verify-media` 原目标列表未覆盖新 CTest 清单中的全部注册目标；tools owner 已改为 `all` 加两个 EXCLUDE 目标，尚未执行验证。旧 build 中仍有已移除的测试二进制，必须依新生成的 CTest 清单判断，不得执行旧二进制冒充新路径。

root 确认上游 7 补丁的 revert/apply/status 已通过；本代理尚未另行执行。Stop/Stopped 最终关闭握手已落地。

## 执行记录

- `tools/chromium.py stage`：exit 0。
- 一次四目标 `tools/chromium.py build`：GN 增量再生通过，Ninja 失败于 `third_party/webrtc/experiments/field_trials.py header`。`POLICY_EXEMPT_FIELD_TRIALS` 内容修改后 digest 未更新，脚本给出应为 `864a5fd0e0c8cba511a89c2b668d1c5a7545eb55`；已交 root 协调 patch owner 修源码、补丁与 hash。尚无本批 Browser/SDK 成功编译证据。
- `clang-cl /nologo /std:c++20 /W4 /WX /c /I. browser/sdk/render_generation_state_probe.cc`：exit 0，编译期静态断言通过。
- 相同参数编译 `browser/sdk/render_slots_abi_probe.cc`：exit 1，第 18 行跨 enum 比较触发 `-Wdeprecated-enum-compare`；已交 root 协调 owner 修正显式数值转换，未弱化警告或删除检查。
- 日志：`stage.log`、`chromium-build.log`、`compile-probes.log`，位于前述独立证据目录。
- slot owner 修 enum 比较后，两项独立 probe 以完全相同 clang 参数重新编译均 exit 0：`compile-probes-retry.log`。
- WebRTC owner 修 field-trial digest、重新记录 0014/hash；Browser owner 补齐历史 pool/DropContents GPU 退休保护。重 stage exit 0。
- 第二轮四目标编译失败于 `rtc_adaptation_probe.cc` 的 Windows `interface` 宏名称冲突，以及 encoder callback lambda 推断 enum 返回值无法转 `int` 函数指针。原 owner 已修为 `source_interface` 与显式 `-> int`，未删除断言。
- 第三轮失败于 SDK RenderReader 的 `memcpy` unsafe-buffer libc-call 检查；slot owner 按前置等长验证补充 `UNSAFE_BUFFERS` 与准确 bounds 注释，同步修 Browser RenderChannel。
- 第四轮失败于 RTC `float max_fps` 与 `INT_MAX` 隐式比较的精度警告；RTC owner 改为精确 double 比较。
- 第五轮已编过 RTC adaptation probe OBJ；失败于上游 `ui/compositor/compositor.cc` 仅有 RemoteKit Mojom forward 声明。upstream owner 增加完整 include 并重录 0013/hash。
- 第六轮四目标构建在 11m56s / 403 条完成后失败于上游 RootCompositorFrameSinkImpl 的额外闭括号，使后续定义落到 namespace 外；upstream owner 已修 Root 与 Display 同类括号残留，更新 0013/hash，7patch status applied。前述失败原始日志均保留为 `chromium-build[-retry[-数字]].log`；未删测试、未降编译警告。
- 构建期间 Browser document/layout 过时 work 门禁及 Idle/Wake 新契约继续集成；为避免同 out 构建时 stage，本代理未复制这些变动到正在编译的快照。下一轮将统一 stage 最新 Browser/SDK/protocol，再完成构建后导出。
- 新增 Wake 后两个独立编译期 probes 以原 clang 参数再次 exit 0：`compile-probes-wake.log`。
- Browser 最终 Idle/Wake、绑定 epoch、Configure 截止与过时 work 门禁均冻结后，第七轮四目标 build 自动 stage 最新源码，日志 `chromium-build-retry6.log`。
- root 授权机械更新 `sdk/smoke.cc`：ABI 检查使用 `REMOTEKIT_SDK_ABI_VERSION`，成功输出打印当前 ABI，替换旧硬编码 1。
- 静态核对发现 `rtc-smoke` 正常路径也创建硬件 D3D11 device/texture；因此其执行等待全部构建结束后的 GPU 运行阶段。其编译、导出验证仍按顺序进行，不能标作 CPU-only runtime。
- 第七轮耗时 17m07s，509 条完成后失败于 Browser 全局 map exit-time destructor。owner 改 `base::NoDestructor`，未降警告。
- 第八轮失败于 `osr_renderer.cc` 新增 memcmp/数组访问的 unsafe-buffer 检查；owner 换有界 byte span/array span。
- 第九轮完整四目标成功，1m22s / 16 steps，含最新 Wake proof、固定 offscreen、epoch、退休保护。实际 CPU adaptation probe 首运行在清理时因 probe 局部强引用 sender 延长至 signaling thread 关闭后而 DCHECK；owner 仅将比较 identity 的局部引用改成不持有对象的 raw pointer，生产 Close 不变。
- 最后一轮相同四目标增量成功，11.86s / 2 steps，重编 adaptation probe；重跑该 probe exit 0。最终日志 `chromium-build-final.log` 与 `rtc-adaptation-probe-retry.log`。
- `remotekit_begin_frame_probe.exe` exit 0，三个实际 scheduler 生命周期组通过（idle/missed、GPU-busy 模型/early NAK、resize/deadline），无真实 GPU。日志 `begin-frame-probe.log`。
- 最终两项独立 clang-cl probes 以 `/std:c++20 /W4 /WX /c /I.` 编译通过，包含新增 LateBeginPreservesWakeProof 静态断言；日志 `compile-probes-final.log`。

## Endpoint 编译与 CPU 检查

等待 Browser 最终冻结期间，root 授权先编稳定 Endpoint。首次 `tools/build-endpoint.cmd verify-media` 在 `service.cpp:819` 报已删除 `publication_epochs` 字段的残留引用；owner 机械删除该旧 cache 清理语句，保留新 geometry 清理。

第二次相同命令 exit 0：VS18 / MSVC 14.51 / Release / `build/endpoint-package`，一次 Ninja `all endpoint_client endpoint_encoder_smoke` 成功，随后新 CTest 清单 15/15 全通过，1.27 秒。包含 production CompPacing 的 Idle/Wake/尾帧/槽深度覆盖、NVENC mock 的 Poll/Drain/Worker 退休、encoder stats、presentation barrier、输入、文件、audio ring、Control 与 atlas plan；无硬件编码执行。

`endpoint_encoder_smoke.exe` 仅构建，未运行。未运行旧 adaptive_fps/atlas_publication/shared_lease_retirement 测试二进制；它们不在新 CTest 清单，旧文件存在不构成本批证据。日志 `endpoint-verify-media.log` 与 `endpoint-verify-media-retry.log` 保留首失败及重试通过。

后续 root 补齐 H264 Table A-1 MB/s 硬能力、固定 offscreen CLI 与 MediaLoop 统一退出排空后，再对既有 `build/endpoint-package` 一次增量构建 `all endpoint_client endpoint_encoder_smoke`，12/12 steps 成功。定向 `endpoint_core|comp_pacing|nvenc_completion|encoder_stats` 初次 3/4，通过的新 production worker mock 覆盖 120→63 FPS 硬上限、60 FPS 保持、0 FPS 暂停恢复。

core 初次失败来自新增 axis 用例算术错误：L51 MaxFS=36864，8192×16 的 512² 小于 8×MaxFS，实际合法，最大 1920 FPS。owner 保留并改正该期望，另增加真正 8688/8689 axis 边界检查，helper 不变。仅重编 `endpoint_tests`、重跑失败 `endpoint_core` exit 0；其余三项未无故重复。日志 `endpoint-final.log` 与 `endpoint-core-retry.log`。

## SDK 导出与真实外部消费者

`tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev` exit 0，SDK ABI 2 / RTC ABI 3。195 项 GN runtime 依赖、4 个公开 header、import lib 均逐文件 SHA256 与 out/source 对应检查通过，195 runtime 也与实际 `build/sdk-smoke` 消费目录匹配。日志 `verify-hashes.log`、结构化结果 `final-hashes.json`。

首次两轮 `tools/verify-sdk.cmd` 在多个消费者 POST_BUILD 并行复制同一 runtime 目录时交替失败，源目标目录均存在。构建执行者机械修改 `sdk/CMakeLists.txt` 与同类 `sdk/rtc-tests/CMakeLists.txt`：单个公共 runtime copy target，消费者依赖它，仍以全部逻辑 CPU 构建。最终正式 `tools/verify-sdk.cmd` exit 0，SDK/RTC/audio 3/3 smoke 通过（1.05s）。日志保留 `verify-sdk.log`、`verify-sdk-retry.log`、`verify-sdk-final.log`。

RTC smoke 此处是实际导出 DLL 的 PeerConnection/SDP/ICE/DataChannel/close barrier 与 D3D texture 运行，**不是**产品 Browser OSR、Fence 合成、H264 硬件编码或 Viewer 验收。执行前所有 CPU 构建结束，GPU 阶段获 root 明确授权；测试结束未留自有进程。已经向 root 交还 GPU 槽位，后续不运行构建或 GPU，等待单独 package 指令。

## 交接关键 hash

此表已更新至下述 Display scope 修复快照；此前原始 hash 均保留，最新结果为 `qa-display-scope-hashes.json`。

| 文件 | SHA256 |
| --- | --- |
| out/dev/remotekit_browser.exe | `64f1797e0d5e00af36b69178c8faf61a25a797dd3eb0a82cece0f884e56804bb` |
| out/dev/remotekit_sdk.dll | `197b36c8b5099d5f454b22a2164df612df5bf695319a1fe8cd6e3f532d0de1d9` |
| out/dev/components_viz_service.dll | `a0f7acb1b5d91e658211d015c494753738cb5b984d960403a3b84c5b08c49c57` |
| out/dev/content.dll | `f39acb5a7b01effe427f2faddec9c3448b2b8cd3914b67c544b21687c84e8b98` |
| build/endpoint-package/endpoint/endpoint_service.exe | `fc323d3a57283c003a0ef7591540cfbe79038b806fb7af7c95d919a0d77dfaec` |

## 首轮产品 QA 的 output.open 契约修复

首轮产品 QA 在首 frame 之前失败。root/owners 确认 Browser harness 的旧 `output.open` 仍强制要求 fps，但新 SDK 按新契约不发送 fps，因此 `invalid_output_fps` 在 OsrRenderer 创建前拒绝，随后出现 SDK4 / `output_not_open`。这是真实运行新发现的问题，不能用之前编译或 SDK smoke 的通过覆盖。

Browser owner 删除旧 fps 验证入口及无效 `output_fps/SetFps` 参数链；SDK owner 为 open/describe 的首次非 pending 错误增加精确 literal 白名单、<=96 字节的受控首因诊断，不输出回复、句柄或载荷，不改 ABI。两位冻结、QA 清理所有自有进程后，构建执行者按 root 授权同次 `tools/chromium.py build --target remotekit_browser --target remotekit_sdk` 自动 stage + 最小增量成功，30.48s / 8 steps；日志 `qa-open-fps-build.log`。

随后导出 SDK、正式 `tools/verify-sdk.cmd` 全通过：SDK/RTC/audio 3/3（0.98s），无并行 CPU 构建或其他 GPU 工作。195 项导出/消费者 runtime、4 header、import lib hash 再次匹配；ABI 仍 2 / RTC 3。日志 `qa-open-fps-export.log`、`qa-open-fps-verify-sdk.log`、`qa-open-fps-verify-hashes.log`。

未重复无关 Endpoint/Control 测试或无变动 probes。自身构建/smoke 进程全部退出，GPU 槽再次交 QA。**产品 OSR 首 frame 是否恢复须由接下来的真实 QA 证明，本报告仅确认修复已编入和 SDK smoke 通过。**

## 第二轮 QA 的单 Isolated 连接修复

第二轮 QA 未恢复首 frame：root/owners 确认新增 Render `IsolatedConnection` 会替换同进程原 Control link，触发 output Stop，53 个 Begin 全 RejectStopped。root 改定为经原 Control 一次性传递真实 Mojo message-pipe endpoint，后续独立 render FIFO；`render_channel` 为本地 opaque 一次性 token，ABI/签名不变。Browser 与 SDK owners 冻结、QA 清理 GPU 后，执行最小同 out 四目标增量：

```text
tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_control_payload_probe --target remotekit_sdk_control_lifetime_probe
```

现有 SDK 扩展 probe 的正确 GN 名为 `remotekit_sdk_control_lifetime_probe`。新 `browser/sdk/render_endpoint_pending.h` 已经正式 stage，源与 overlay SHA256 均 `4253c083a0552efbb17acaadfd62db47c1f6b7a5d9ea0cc2ce69a9fac5b14de4`。

首编译因 `control_payload_probe.cc` 新增 `DictValue::Set` 链式调用不适配当前返回类型失败；Browser owner 机械拆成两条 Set，断言不变。重试 19.87s / 13 steps 成功。日志 `qa-single-isolated-build.log` 与 `qa-single-isolated-build-retry.log`。

两个无参数 CPU probes 的完整 main 全部通过：

- `control_payload_probe`：原回复标记、oversize/error 附件门禁及既有 payload 检查。
- `sdk_control_lifetime_probe`：并发渠道、同渠道串行/queued close、0/1/2 附件与类型门禁、token 一次 claim、unclaimed Control close 清理、raw Control 拒绝附件、claimed render 与 Control 独立关闭及 shutdown lease。日志里的两条 `invalid_render_endpoint` 对应 0/2 附件反例的预期拒绝，不是忽略的失败；未弱化 CHECK。

随后 SDK 重新导出，正式外部 SDK/RTC/audio smoke 3/3 通过（1.05s）。195 runtime 的 out/export/consumer 三方 SHA256、4 个 header 与 import lib 再次匹配，SDK ABI 2 / RTC ABI 3 未变。日志为 `qa-single-isolated-control-payload.log`、`qa-single-isolated-sdk-channel.log`、`qa-single-isolated-export.log`、`qa-single-isolated-verify-sdk.log`、`qa-single-isolated-verify-hashes.log`。

所有自有构建/probe/smoke 进程计数为 0，GPU 槽已再次交 QA。未重复 Endpoint/Control、无变化 performance/probes，未打包或上传。实际连接共存与产品首 frame 是否恢复仍交下一真实 QA。

## 第三轮 QA 的 Display GPU 调度合法域修复

第三轮 QA 在实际 OSR Configure 路径触发 GPU 调度 DCHECK。root 与 upstream owner 确认 Display 的 Mojo 入口直接排 GPU task/Flush 时缺现有合法 `ScopedAllowScheduleGpuTask`。owner 仅在 Windows 且真 RemoteKit OSR 的 Configure/Begin/Finish 分支加入该既有 scope，不改全局 Scheduler/DCHECK、不移除 GPU FIFO；其他平台/非 OSR 明确拒绝。0013 实际 SHA256 为 `862f7fcd754e336387a13f872f497acaba8256aefa65866ba1336c1c9d4aa2fa`，7patch status 由 owner 通过。

QA 清理 GPU 后，root 授权 `tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_begin_frame_probe` 同次增量；19.67s / 2 steps exit 0，仅重编 Display、链接 `components_viz_service.dll`。Browser EXE/SDK DLL hash 保持不变，新 Viz DLL 见上表。日志 `qa-display-scope-build.log`。

既有 begin_frame CPU probe 三组通过；SDK 重新导出，195 runtime、4 header、import lib 与 out/consumer hash 均匹配。SDK本身未改，按 root 要求未重复三项外部 SDK smoke 或 Endpoint/Control。日志 `qa-display-scope-begin-frame.log`、`qa-display-scope-export.log`、`qa-display-scope-verify-hashes.log`。

所有构建/probe进程计数 0，GPU 槽已交回 QA。CPU scheduler 模型不覆盖真实 GPU Configure 合法域，后续真实 QA 仍是该修复的验收边界。

## 证据边界

| 层级 | 本批状态 |
| --- | --- |
| 源码与补丁 | owners 冻结；upstream 7patch applied/replay 由 owner 核对，本代理未冒充自行执行 |
| Browser / SDK 编译 | 最新快照正式增量成功 |
| Endpoint 编译 | Release all、client、encoder smoke 通过 |
| CPU probes | generation/slots ABI 静态断言、adaptation 生产 probe、3 scheduler 组、15 Endpoint 组及硬能力后续定向检查通过 |
| SDK 外部消费者 smoke | SDK/RTC/audio 3/3 通过；RTC 含 D3D texture，不冒称纯 CPU |
| GPU Fence / OSR / 产品运行 | 尚未由本代理执行，交 QA |
| 本地包 | 未开始 |
