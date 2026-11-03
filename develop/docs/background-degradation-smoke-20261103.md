# 后台降级实现与smoke

## 实现范围

Control在线与Viewer离线共用BackgroundPolicy：以本地单调时间累计持续满足Browser canDiscard资格的隐藏时间，30秒freeze、120秒discard；冻结pending暂停累计，恢复显示清零。媒体、采集、导航、页面请求、关闭/恢复、实例变化及超过15秒观察间断重置资格窗口。Endpoint放行freeze，Browser执行点与discard共用资格复查，避免快照之后新页面请求被自动冻结取消。不新增测试文件，不打包上传。

Chrome157 MemorySaver采用隐藏计时、重访保护、LiveTicks和回收资格，没有通用tab CPU/RSS加权评分。本次借鉴分层机制与安全计时，没有搬入Chrome PM，也没有照搬2至6小时等待和累计重访后长期免回收。正式设计见[Control](../../docs/control-plane.zh-CN.md#可见性与memory-saver)；调查记录已从正式docs移至develop/docs。

## 构建

- 当前Control：生产build通过，含类型检查、Vite、server bundle与production startup smoke。
- 当前stage的Browser harness：从Ninja提取原clang-cl命令，单object编译通过。
- 当前Browser全链接未完成：WebRTC registered_field_trials生成器因POLICY_EXEMPT_FIELD_TRIALS_DIGEST不匹配停止；未修改并行Comp/Rend工作。
- 当前Endpoint全目标未完成：service.cpp遗留publication_epochs引用未声明；未擅自修复并行重构。
- 为独立验证本任务，临时构建HEAD96fc14b Endpoint/SDK/protocol加本次freeze白名单，32/32完成。临时CMake只将依赖指向现有build/dependencies；无Chromium新out或clean。
- 临时Endpoint SHA256：`e24b1c34e91b9dcb5ff88905778afacecae46ad4b4270c0d9450354468835dc4`。

日志与临时源码位于`develop/tmp/background-degradation-20261103/`。临时基线Endpoint+旧70e4243 Browser/SDK用于隔离生命周期验证，不能作为Comp/Rend新路径运行验收。

## 已取得真实运行证据

- 9次三tab轮换：各自前台renderer Normal、后台Idle，产品visible与document.visibilityState一致；Browser incarnation及view instance/document保持。三页使用独立renderer，未覆盖共享renderer聚合场景。API切换未注入焦点，页面可见性独立于focus。
- 原70e4243 Endpoint拒绝freeze（unsupported lifecycle action），由此发现并修复正式Endpoint白名单遗漏；失败证据保留。
- 独立旧Browser控制通道：hide→freeze实际actual=1且JS计数停止；restore保留instance/document/nonce；discard actual=2再restore得到新nonce。此项是底层机制检查，不能单独证明Control30/120秒策略已通过。

证据：`1793718742134/evidence.json`、`direct-1793718923387094600/evidence.json`（相对上述临时目录）。

## Control策略完整链路

当前Control + 隔离基线Endpoint（仅放行freeze）+70e4243 Browser/SDK，实际运行196.1秒。临时probe仅为旧媒体配置补齐targetFps等旧字段，未mock生命周期、资格或snapshot。

- 隐藏约31.2秒后实际frozen=1；显示恢复live=0，instance=1、document=2及页面nonce保留。
- 再次隐藏约121.6秒后实际discarded=2；显示恢复live=0，nonce改变，符合重新加载语义。
- 35秒慢导航在隐藏31.5秒时仍为loading=true/canDiscard=false/live=0，未被自动冻结；加载完成后恢复成功。
- Browser PID25356/incarnation全程保持；未见FATAL/CHECK/GPU退出。自有Browser及renderer已退出。

证据：`1793719027720/evidence.json`、`run-patched-endpoint.log`。新增Browser执行点资格守卫仅取得单object编译证据，未运行该新Browser二进制；不把本组写成当前Comp/Rend全树验收。未新增测试文件或重复性能矩阵。
