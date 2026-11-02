# 当前问题与收尾记录

由root维护。最新已发布基线1e13f11，取件码353287；本批逐模块审阅、重构和规定范围新增路径验证已完成，不重复历史性能组。旧全库审查依据见[审查报告](post-release-astra-review.md)。

2026-11-03进度：产品重构14859f6及工具修正1e13f11已提交推送，新streaming包通过startup、包内WebRTC操作、逐文件/ZIP校验后上传。跨机管理、DC常规操作/文件、收据同步、独立时钟、移动编辑/Client手势的契约和证据见[本轮架构记录](robustness-contract-20261103.md)。下列问题按对应源码、CPU和真实证据关闭；实体设备与尚未装配能力仍见当前状态，不能宣称整个浏览器无任何缺口。

## 本批运行发现与待验收项

| 项目 | 当前证据与进度 |
|---|---|
| V4 split长时白屏 | 布局候选缺clientGestures而已发布layout含该字段，每Tick误判变化；2.375秒重复1000次prepare，Client反复取消两rAF导致ACK饥饿。已修完整布局比较及两端事务幂等；157/DPR2原场景实际复验580ms恢复，两plane裁剪正确，无flood |
| V5 窄屏误退canvas | 隐藏旧Window current=false却累计retry到3触发全局fallback。已修watchdog仅统计当前有效未ready plane；定向/生产构建及89/DPR1、157/DPR2实际split→1100→390约6秒→split通过，隐藏重试0、可见ready、返回各自新帧/坐标正确，媒体身份保持且稳态MSTP/draw0 |
| S1 快照组合字节上限 | 已限制最终URL字节与accept提示预算；Browser响应超限改有界语义错误而非关闭健康通道。Control、Browser真实生产helper probe与Endpoint语义错误回归通过；不宣称任意巨型页面状态已支持分页 |
| N1 首导航失败遮蔽错误页 | 已分开真实primary documentCommitted与failed收据；已提交仍remote，未提交回start并hide-only残留Native。CPU、生产构建及89/157实际错误页/首导航取消恢复通过 |
| N2 receipt被当workspace解包 | 已收紧receipt类型并去掉state.workspace读取，pending/unknown语义保留。CPU/构建及157实际前进后退无原异常banner通过 |
| N3 Browser错误文档空白 | 已补embedder PrepareErrorPage静态中文HTML，动态文本转义、无JS/外部资源；生产helper/构建及Astra设计审阅通过，Sol实际89/157错误页标题/URL/net错误可读、remote+rejected正确 |
| N4 start首导航stop丢回滚归属 | stop保留独立收据、不占原导航owner；即时终态同步活动对象，finally不回退applying。明确回start清loading。CPU/构建及89/157真实首导航stop回start/Native隐藏通过；最后157补验loading=false、stop按钮0/refresh1/progressbar0，无SDK5重试，remote stop保留原URL |
| G1 首tap致命退出 | 已修生产候选touchscreen设备类型，probe实际执行filter输出→Blink转换；157首tap真实复验恰一次click、terminal processed通过 |
| G2 拖动转惯性丢位移 | production ScrollPredictor CPU与真实轨迹证明服务端二次预测在相位转换时丢/增尾差。正式离屏Browser固定关闭该重采样，保留原始事件/权限仲裁且不影响demo/Viewer。默认新产物DOM510对Client509.815，延迟轨迹510/509/510通过 |
| F1 Viz BeginFrame完成时序 | 已用真实Scheduler/Mojo CPU复现早NAK留下的旧interval完成污染新callback；0011只接受精确退役ID，有界8项满则背压，保留未知/重复完成CHECK。生产构建、正反例及11补丁撤回/重放通过；最新89/157常规手势组无此前CHECK/GPU崩溃/Browser重启 |
| F2 Native输入未来时间 | arrival fallback首包原点叠加后包source elapsed产生约57ms未来时间。已分离source elapsed与非未来、非递减Native dispatch timestamp，生产helper/probe通过；新版89/157延迟轨迹位移一致且未出现旧reporter断言 |
| G3 child销毁后输入锁定 | 已修有界精确token+sequence退役证明，未知/超时仍unconfirmed，正常cancel仍等canonical ACK。279项Control/原生构建通过；89/157真实owned child销毁→明确invalidated→同doc新tap通过、无误投及遮罩，旧回执不清新held owner |
| F3 正常停止丢弃未交付atlas帧 | 已修StopAndResetConsumer跨Mojo pipe丢排队帧：正常退役转drainer，仅对producer实际写完但应用未读帧Done；已交付lease保留consumed Fence、未知断开仍隔离。生产构建、真实Mojo5例/池13项及11补丁撤回重放通过；89/157专项自然generation1→17无atlas fatal/CHECK/重启 |
| 新路径功能覆盖 | 规定范围验收完成：89/157布局/文档失效、触控/滚轮/scrollbar、bounds与DPR坐标、无原生媒体入口；双Tenant管理断链保持媒体；DC文件/拍照字节、实际PCM、搜索持久化、模拟IME/键盘resize；真实popup opener/关闭、Sol清洁效果图。实体移动键盘/NVIDIA/真实摄像头效果仍是明确硬件边界，见当前状态与各运行报告 |
| P1 发布smoke契约过期 | 1e13f11已同步CLI startup/auth/assets/WS/clock及拒绝旧产品入口，修复父子Unicode失败证据；新包startup通过。独立包内host-managed WebRTC真实建窗/导航/点击/wheel、默认video及包内Browser路径通过；560逐文件hash与ZIP CRC/hash通过，已上传353287 |

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
