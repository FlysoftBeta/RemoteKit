# 当前问题与收尾记录

由root维护。最新已发布基线8423204；旧全库审查依据见[审查报告](post-release-astra-review.md)。本轮不重复性能组，只检查用户报告的连续交互与媒体生命周期。

## 8423204发布后输入与video回归

此前默认video验收覆盖点击坐标，未覆盖连续滚轮和真实滚动条拖拽，不能据此声称输入全面通过。root承担方案审阅和验收范围不足的责任。

| 项目 | 证据、决策与进度 |
|---|---|
| V3 focus/导航看似重连 | 89/157旧版实际peer/connectionId/track不变，但video与srcObject反复重建。根因是React注册effect依赖surface对象。改为可见viewport稳定持有renderer/video；focus仅更新输入身份，document/epoch改变仍隐藏并验证新ACK和该元素自身RTP。Control182项/生产构建与89/157连续运行通过，focus/导航/resize均保持媒体身份 |
| I1 滚轮无效 | 存在焦点和派发两个缺口。Client补ensureInputFocus/非passive监听后，实测仍是input.result ok而DOM无wheel。根因是直接RouteMouseWheelEvent的phase=None，router未建立hit-test目标。已复用Aura已有MouseWheelPhaseHandler补begin/sequence/end再路由。89/157实际失焦、burst、间隔重开、nested、跨窗、resize/reload后wheel均通过；不能把AcceptInput成功当网页消费 |
| I2 原生scrollbar拖拽取消 | Browser把move的changed-button=0直接转成Blink NoButton，Chromium主线程和compositor均据此取消drag。adapter现从held modifiers生成move.button，down/up保留changed button语义；7项编译期断言与Browser增量通过，89/157均实际页面scrollY 0→2739、nested 0→903 |
| D1 多video是否重复解码 | Chromium157源码确认同remote track共享receive stream decoder，解码后VideoFrame分发给各sink；每元素仍有独立player/compositor及可能的转换成本。不能相加各元素webkitDecodedFrameCount声称重复物理解码，亦不把157源码结论扩写成所有浏览器保证 |

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
