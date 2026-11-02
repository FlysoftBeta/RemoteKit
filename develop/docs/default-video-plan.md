# 默认video呈现

用户在c379f6c发布前要求改为默认video。旧包尚未生成或上传，发布已停止。用户进一步明确：显示布局来自客户端bounds；不要原生controls、画中画与多余媒体功能。仅本次发布允许GitHub推送尽力而为，以包上传为优先，长期commit/push约定不变。

## root选定边界

- 每个可见内容区域用自己的video共享同一接收track，不clone；客户端实际内容bounds决定目标位置和尺寸，atlas矩形仅决定源裁剪，DPR/mediaScale保持现有坐标关系。
- video muted/playsInline、无controls、禁PiP和remote playback、无tab焦点/拖动/原生额外交互；声音继续独立的Viewer音频管线。默认路径不同时运行MSTP与canvas绘制；canvas为能力/协议失败回退。
- 自主video不能像canvas逐帧拦截。Endpoint在新布局的真正encoded发布前设屏障，等客户端隐藏旧画面并确认后再允许新布局；不能只靠metadata消息提前发送或rVFC事后发现。
- Client DC协商media.presentation(version1, backend video/canvas)。Endpoint新peer/video启用或outputGeneration/layoutEpoch变化先发原layout，再presentation.prepare(version1, barrierId, outputGeneration, layoutEpoch)，均为字符串身份。Client撤销input ready、隐藏video，跨两rAF后回presentation.ready完整相同key。仅当前peer和最新ACK放行并请求一次关键帧。
- Endpoint建立gate后用presentation.mode确认video支持；旧端无确认回canvas。切canvas取消gate恢复旧行为，peer关闭清空。隐藏页可持续hold，不超时强行放行。
- gate须覆盖旧inflight编码结果，旧source epoch只drop、不倒退布局。必须正确释放编码/纹理/TailRefresh资源；旧canvas客户端、音频、稳态Fence和帧率策略不变。源epoch与实际发送路径的约束由native实现代理核实，疑问交root。
- 首个真实RTP/epoch匹配才恢复显示和输入。统计区分canvas JS提交和video compositor提交，不能以rVFC回调数直接当呈现帧数；marker仅在测试显式采样，不添加正常逐帧copy。

## 执行顺序

新native代理实现gate与CPU乱序/旧inflight验证；新client代理实现video布局/回退/协议与局部模型；最后新Sol完成89/157的单窗/split、客户端resize、布局换代/旧ACK、输入坐标、无原生媒体入口、音频共存与截图。只做有意义短组，不重复旧性能矩阵。最后统一build、root commit并尽力push、全新Sol打包上传。

c379f6c已过最终171/171 Control、tsc/build/smoke；native已过11 CPU。新变更后按实际范围验证，不沿用这些结果覆盖新video行为。
