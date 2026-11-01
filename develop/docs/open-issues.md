# 当前问题与收尾记录

由root维护。首版506c45e已上传；完整审查依据见[审查报告](post-release-astra-review.md)。本轮不重复性能组，只检查修复行为。

## 首版后修复

| 项目 | 决策与进度 |
|---|---|
| R1 多页恢复阻塞全部Tenant | 改为主dispatcher拥有的有界恢复状态机；stdin只入队，定时维护推进，无请求也能完成；ensure不等导航完成。已完成，定向检查通过 |
| R2 旧token注销踢掉新Viewer | lease绑定认证token哈希；撤销只影响同token，执行排队请求时再验身份。22项相关测试通过 |
| R3 恢复文件漏同文档/PageState变化 | Browser navigation revision、export对应revision；重启清缓存。与R1一起实施 |
| R4 atlas轴/面积/布局限制不一致 | 统一确定性PlanAtlas与共享跨层fixture，真实DIP不变；DPR可低于1，物理尺寸与逻辑extent分开。已完成，定向检查通过 |
| R5 时钟reset使feedback序号回退 | 测量reset保留反馈流序号和已见source身份；首个有效反馈立即接受。9项相关测试通过 |
| R6 Browser关闭墓碑无限进入snapshot | Endpoint durable落盘后幂等ACK Browser完整墓碑；保留当前Browser compact closed-ID集合防旧ID复活，不声称集合常量空间。已完成，定向检查通过 |
| V1 回复跨Browser身份 | 已用模型确认PID/局部数字复用无法保护；增加browserIncarnation及实例/文档/请求绑定，回复不能启动Browser。已完成，定向检查通过 |
| V2 离线缺页误判关闭完成 | 模型已复现Tab误删；关闭只认明确事件/状态/完成响应，离线或换代取消旧待确认请求并保留Tab。已完成，定向检查通过 |

几何切换采用原子viewConfigs事务；横竖最终各自可行而中间max超限的场景真实通过。Control全117项、原生9项CPU suites、Browser/SDK/Endpoint增量和恢复/ACK/几何定向检查通过。审查复核的viewport拒绝提示也已补齐。最终证据：recovery-regression/1793556577736431200、browser-close-ack/1793556555694229500、geometry-regression/1793556819560716400。

## 保留调查项

- 完整gn check曾因Browser/SDK私有头可见性失败；实际编译链接通过。后续明确合理依赖或局部nogncheck理由，不扩大全局可见性。
- 显式实验alignment1旧路径边缘偏绿尚未定位；产品默认使用已验证alignment16。
- ApplyView配置已生效后持久化/恢复失败的事务补偿已修复：保留已提交desired，后台及同参请求重试；故障注入通过。

## 已关闭的早期问题

GPU故障同RTC恢复、逐代retirement终点证明及最后native ref释放后trace访问问题均已有实现与相应记录。旧清单的空布局问题不沿用旧结论，由当前关闭/生命周期检查覆盖。

旧legacy迁移质量模式线索未获足够证据，不列为确认bug。多Profile、跨Browser sessionStorage等保留功能差距统一在正式当前状态中维护。
