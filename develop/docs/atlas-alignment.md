# QSV候选路径：实际atlas物理对齐与CLI

按主 Agent 的 `qsv-async-integration.md` 边界实施。本子任务只处理atlas分配、入口选项及CPU测试接入，不修改QSV/worker/backend实现。

## 行为

- `--qsv-vpp=external|async` 默认external；async要求`--encoder=qsv`，禁止auto/NVENC静默fallback。
- `--atlas-alignment=1|16` 未指定时external取1、async取16；async显式1拒绝。
- 1表示不增加16对齐，保留既有偶数取整。实际计算为`AlignUp(ceil(DIP × scale), max(2, requested))`。使用共用纯CPU `AtlasAllocationDimensions` helper，browser与Endpoint使用同一校验。
- `GeometryConfig` 传browser字段`allocation_alignment`。browser默认1，只能在输出关闭时改变alignment；无效字段或超出资源预算在状态变更前拒绝。rate-only配置省略几何/alignment时仍工作，不重建输出。
- 真实分配宽高用于GpuAtlas构造，因此共享纹理desc、共享帧metadata、SDK导出尺寸、Endpoint的source尺寸和媒体采样尺寸一致。网页viewport、DPR、MaxRects排布和plane像素矩形保留；新增padding不改变输入DIP。
- 对齐后再检查单边≤8192、总像素≤16777216。Endpoint在DesiredGeometry与实际GeometryConfig均检查，包含过渡扩容；browser独立重复验证防止绕过Endpoint。
- 配置回包包含`width_pixels/height_pixels/allocation_alignment`；output.status增加alignment。Endpoint stats增加`qsvVpp/atlasAllocationAlignment`，原`sourceAtlasWidth/sourceAtlasHeight`继续来自真实metadata。

## 边界示例

下表尺寸为Endpoint既有逻辑atlas（含原padding）乘采样比例后的分配；plane矩形不随allocation扩张。

| 场景 | 逻辑atlas / scale | alignment1实际 | alignment16实际 |
|---|---|---|---|
| 单1080页面 | 1928×1088 / 1 | 1928×1088 | 1936×1088 |
| 非整数缩放边界 | 129×127 / 1.25 | 162×160 | 176×160 |
| tablet820×1180@2 | 828×1188 / 2 | 1656×2376 | 1664×2384 |
| desktop1920与tablet820双plane、共同atlas比例2 | 2756×1188 / 2 | 5512×2376 | 5520×2384 |

4096×4096@1恰好符合像素上限；4097×4090@1在旧偶数分配下仍符合，而16对齐后的4112×4096超出预算，必须拒绝。8191×16@1可以对齐到8192×16；8192×16@1.25因单边超限拒绝。NaN scale及非1/16 alignment拒绝。

`tools/prepare-streaming-case.ps1` 新增`QsvVpp/AtlasAlignment`，记录effective选项到config.json并传Endpoint CLI。外部16对照：`-QsvVpp external -AtlasAlignment 16`；候选：`-QsvVpp async -AtlasAlignment 16`。两者保持相同viewport、输入及marker条件。

## CPU测试接入

`endpoint/tests/core_tests.cpp`增加共享分配helper的默认行为、非整数scale、单/双plane/DPR、对齐后预算、8192边界和无效参数用例。

已提交的`media_feedback_tests.cpp`、`encoder_stats_tests.cpp`接入正常CMake/CTest：BUILD_TESTING开启时默认构建`endpoint_media_feedback_tests`、`endpoint_encoder_stats_tests`，注册`endpoint_media_feedback`、`endpoint_encoder_stats`。后者只调用stats Snapshot，不创建EncoderWorker/GPU device；链接正式media库，复制runtime VPL DLL供正常加载。构建与测试不依赖develop文件。

`tools/build-endpoint.cmd verify-media`的显式target清单同步包含两项新CPU测试，避免新输出目录执行CTest时缺少测试exe。

## ApplyView失败回滚

独立审阅发现既有问题：扩容GeometryConfig已成功后，view.configure被拒绝，Endpoint过去只恢复desired，实际atlas留在扩容尺寸。现在保存旧DIP geometry与scale，失败时先保持输出关闭，再回滚旧geometry，成功后恢复媒体循环。回滚或恢复失败同时保留原错误与rollback错误到Stats/error和响应，清空输入可用状态、停止输出，不吞掉失败。

browser的view.configure先复制spec并校验device、viewport、DPR和layout，全部通过才提交specs；因此明确拒绝分支没有部分修改源view。源RPC已经成功、但后续GeometryConfig/Save/Resume失败是另一种情形：这次不假装源已经回滚，保持停止并报告`source view already changed`。创建后强制删除会tombstone该ID；旧DPR缺省/inherit也不能通过现有configure字段准确重建，所以未引入通用事务。

当前上层对账不能承诺自动恢复该后一分支。Control只在configuration缓存与目标JSON不同、或view不存在时再次发配置；Endpoint本身相同desired配置也会提前返回。若源实际已等于Control目标而cache不触发，停止的输出可能保持停止。Save成功而后Resume失败也可能留下持久化状态与恢复后的desired不同。这是待统一处理的既有恢复缺口，本轮只明确暴露，不增加自动重启策略。真实RPC拒绝后的旧几何恢复负例仍需后续服务实验。

## 统一构建与CPU验证

客户端与QSV作者均释放源码/硬件窗口后，作为唯一构建owner实际执行：

1. Chromium patchset status：4项 applied；`chromium.py stage`完成。
2. 同次增量构建`remotekit_browser`、`remotekit_browser_demo`、`remotekit_sdk`通过。SDK未发生源码变更，target由增量构建复用；没有执行清理或全量构建。
3. `export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev`通过。
4. `tools/build-endpoint.cmd`：Debug编译链接通过，正常CTest 3/3通过（core、media_feedback、encoder_stats）。
5. `tools/build-endpoint.cmd verify-media`：Release默认媒体/原生目标编译链接通过，同样正常CTest 3/3通过。未执行encoder smoke程序或QSV probe。
6. prepare脚本PowerShell AST语法解析通过；六组无效CLI组合全部在Options阶段返回exit1并给出对应错误：未显式QSV的async、auto+async、NVENC+async、async+alignment1、无效VPP值、alignment8。
7. `git diff --check`通过。原有oneVPL匿名union/枚举转换、共享mapping padding、getenv/u8path警告仍在，没有编译错误。

SHA256：

| 产物 | SHA256 |
|---|---|
| out/dev/remotekit_browser.exe | `159a54cf70c2ea14289f6243f4edefd29463b643b01bce1bdab5a68f7b82c91b` |
| out/dev/remotekit_browser_demo.exe | `3bc816288819320ccca548fa0b13c37dc414442e4e0eaacfc4cace7d538673a4` |
| out/dev/remotekit_sdk.dll | `91433dd933a89557108b590093bac751e6d583bc66775d569fbfe4d074b19922` |
| build/endpoint/endpoint/endpoint_service.exe | `98c0e87766bbefbd805a3bb112b731886dee9e08691140e32222e802a8764e31` |
| build/endpoint-package/endpoint/endpoint_service.exe | `04adb3e89e09eb51d5a5908db10b263709d8bca5cf24790fd0d02a899b8aad09` |

没有启动GPU、browser服务、Chrome或实播。真实desc/metadata、白边/颜色、单/双plane/DPR、rate-only代次稳定、失败回滚，以及同尺寸external16/async16对照交给下一硬件窗口；编译通过不代表异步媒体链已经运行通过。
