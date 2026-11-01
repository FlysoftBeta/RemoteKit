# 历史实验与退休选项归档

本页集中保留历史结论；普通Viewer不暴露这些选项，当前工具入口不再推荐退休组合。原始过程报告位于develop/docs、原始metrics位于develop/tmp，只作为证据，不是当前配置说明。

## 已退休的配置表面

| 项目 | 结论与处理 |
|---|---|
| QSV跨Session VDEnc/Hybrid混跑、qsv-low-power-pattern | 三租户未突破3D瓶颈；删除service选择逻辑、专属stats/tests及prepare参数。单一LowPower模式仍可用于硬件控制变量 |
| video callback before/after-work切换 | 未得到稳定收益，MSTP本来也不使用它；删除配置与before-work分支，保留原video after-work行为和只读诊断常量 |
| continuous-rVFC接收候选 | 无稳定性能收益，保持不启用，不作为实验入口或产品建议。上游补丁文件/清单中的记录为可复现历史实现，不是可选产品配置 |
| 旧互动接收档/Marker面板 | 正常Viewer与diagnostics均不再提供；配置下放、MarkerMeasurement和profile底层设施保留 |
| 旧OffscreenRoot名称 | 过去名称与实际feature不一致；工具以CaptureRoot为准，保留参数alias兼容旧调用，不能据旧字符串宣称实际开关生效 |

其他保留的低层诊断不是用户质量选项：例如外部/异步VPP、copy/shared、接收路径或FIFO，它们仍能用于有意义的硬件/链路控制变量。产品只提供三种质量偏好。

## 决策依据

以下是各阶段自己的测量，不拼接为一次配对，也不计算跨组累计百分比：

| 阶段 | 实际canvas FPS | Pixel marker p95 |
|---|---|---|
| 三租户最快全ON | 12.46–12.68 | 852–921ms |
| 两租户源预算 | 35.11 / 31.33 | 91 / 99ms |
| root捕获 | 37.50 / 34.89 | 104 / 108ms |
| 不可变VideoFrame | 39.24 / 42.68 | 108 / 105ms |
| shared BGRA | 46.86 / 48.26 | 83 / 94ms |
| CaptureToAtlas配对开启组 | 46.92 / 46.99 | 85 / 89ms |
| FIFO候选 | 49.632 / 49.988 | 94 / 103ms |
| 最终headless接收组 | 51.6926 / 51.7349 | 76 / 79ms |

更早四租户长期受3D饱和限制；优化ready等待、capture pending、单会话VPP、单plane client direct和提高源准入帧率未各自形成稳定整体收益。编码单引擎占用不能解释全部GPU负载，Renderer/Viz、复制、接收显示和CRC读回都曾占用同一UHD630。

后续有效路径保留了直接离屏目标、真实GPU租约、减少中间复制、不可变帧、FIFO和异步CRC。RDP动态显示链造成的额外DWM/WUDF开销经headed/headless同binary配对分离。实际默认与测量口径见[当前状态](current-state.zh-CN.md)和[实验设施](streaming-experiments.zh-CN.md)。

## 证据索引

[三租户矩阵](../develop/docs/three-tenant-fast-mixed-runtime.md)、[源预算](../develop/docs/source-budget-runtime.md)、[GPU执行计时](../develop/docs/viz-gpu-timing.md)、[root捕获](../develop/docs/root-capture-runtime.md)、[不可变帧](../develop/docs/immutable-frame-runtime.md)、[共享输入](../develop/docs/shared-atlas-input.md)、[直写atlas](../develop/docs/capture-to-atlas-runtime.md)、[FIFO](../develop/docs/client-fifo2-runtime.md)、[Worker CRC](../develop/docs/async-marker-runtime.md)、[RDP环境](../develop/docs/gpu-environment-audit.md)、[最终目标组](../develop/docs/headless-receiver-runtime.md)。
