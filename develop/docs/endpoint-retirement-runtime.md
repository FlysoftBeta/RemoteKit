# Endpoint退休定点修复：故障诊断

2026-11-01。新Endpoint能够独立完成健康后代退休，旧故障pool保留的具体原因已经定位：**producer ready fence返回UINT64_MAX，无法建立有效terminal_ready证明**。refs、consumer本地done与进程退出证明均已满足；后续空闲和再次Open/Close没有改变这一状态。没有将保守保留写成提前释放违规，也没有强制ack。

## 版本和范围

案例`develop/tmp/capture-to-atlas-retirement-diag`，Endpoint SHA256 `16A5E60EAAABEEDB26B35CCAAF2F0151C23EDF9A207324BDDB29D8BEFB589B3D`。Browser/SDK/Control仍为D2功能与性能使用版本；source整套out/dev原位组件，feature CaptureRoot+CaptureToAtlas+SinglePlaneDirect。单租户、1920×1080/DPR1、1936×1088、CRC、shared、TU7/LPon/VBR36max44Mbps/depth1/external/alignment16、source52、48Mbps/RTT10，receiver157 fake60 MSTP immutable snapshot/after-work。功能阶段开启browser/server/resource trace，没有跑性能，也不复用新Endpoint改写旧性能结果。

## 过程和恢复

- 初次CRC6000成功。
- 只停止本case source20348的GPU2552。15秒前后connection不变、RTP3957931724和canvas1055完全不变、displayReady仍true；显式RTC重连后generation2、CRC8001成功。
- 停止同一source Browser20348。Viewer在等待上限30秒内自动换RTC恢复，source变为18900、generation1、CRC8002成功。
- 显式close，空闲3秒，再Open并CRC8003成功（generation2），最后close再空闲3秒。两次close均HTTP200，Viewer ownersHeld/pending/displayed/retiring全0、readyfalse。

PID和时刻保存于gpu-fault.json/browser-fault.json；逐阶段和15秒观测在metrics/client-metrics.jsonl。只操作上述自有PID，无系统级GPU reset或其它进程操作。

## 旧pool的决定性快照

Browser退出后的`atlas_pool=2 generation=2`：

|字段|值|
|---|---|
|stage|terminal_prefix|
|terminal_observed / target / ready|1 / 764 / 0|
|ready_completed|18446744073709551615（UINT64_MAX）|
|retired_prefix / observed_prefix / last_fence|764 / 764 / 764|
|active_refs / leased_slots / slot_refs|0 / 0 / 0,0,0|
|done_completed / done_target|762 / 762|
|publication generation/status/frame/ready|2 / 1(Running) / 764 / 764|
|producer_exited / untracked_read / consumer device_reason|1 / 0 / 0|
|publication_snapshot|stable|

同一快照在自动恢复后、显式Close、空闲和再次Open/Close后仍出现。producer退出可以接受稳定Running终点，但不能把UINT64_MAX解释为ready完成；consumer device_reason0也不能代替producer ready证明。最终consumed前缀已提交到764不意味着terminal_ready成立。已确定“缺哪条证明”，不依靠无限等待推断永久性。

首次GPU故障时另有pool1的publication失败快照：status4、frame/ready1167、ready_completed1167、retired_prefix1166、active_refs1、slot_refs0,0,1、done1164/1164、producer_exited0、device_reason0。随后显式重连正常。没有pool1 terminal卡住日志，但其早期逐帧trace被环形buffer覆盖，不能据此宣称完成全部pool1 lease审计。

原始决定性日志为control.err，抽取副本retirement-errors.log；source GPU退出日志在sessions/sessions/2/browser.log。

## 健康后代独立退休

|atlas_pool / generation|borrow|refs归0|retire记录|末借fence|末consumed提交/实际完成|
|---|---:|---:|---:|---:|---|
|3 / 1|1397|1397|1397|1399|1401 / 1401|
|4 / 2|101|101|101|103|103 / 103|

Source18900对应最终published1401/103，三种browser copy全0。pool3末publication1401没有被借用，末借1399，但terminal prefix实际完成到1401；pool4也实际完成103。旧pool2没有阻塞后代清理。pool身份避免把Browser重启后的generation1/2与旧资源混为一代。

server-23716-session-2.jsonl容量65536、total100343、overwritten34807；pool2开头也有覆盖，所以pools-summary.json中的pool2 borrow734、release/retire735不能作为总数守恒校验。pool3/4后段完整，以上表只使用它们。browser cadence在Stop时写出，未将其截点Done计数当最终完成。

## 交付与清理

没有源码修改、重编、额外故障循环或性能矩阵。保留config/run/fingerprints、pools-summary/source-summary、全部失败日志和metrics。所有自有receiver/context/browser、case服务与host browser_close完成，3001/3013无监听、无remotekit_browser残留；GPU已释放并通知主Agent可安排构建。

## 等值历史证明修复后的独立回归

新case `capture-to-atlas-retirement-equal` 使用Endpoint `1607E34B1EBD08F489B89F1DB978BD6DC95CA360E1D413366939426B9ADCE14C`，Browser D2不变；不改写上述16A5诊断或历史性能。GPU kill后显式重连CRC8101通过，Browser kill后30秒内自动恢复CRC8102通过，final close200、owners0，空闲后无terminal incomplete/pool close错误。

三个pool的borrow/refs0/retire数量分别1030/178/717，全部守恒。pool1/gen1最终prefix1032、completed1032。Browser退出的pool2/gen2末借/末prefix180，当前fence查询MAX，但同State历史已经CPU-ready观察到180，因此等值终点可封口；不是把MAX当新的完成证明。后代pool3/gen1末借719，最终prefix720、completed720，覆盖未借尾帧。没有观察到未知更高终点，无需也没有强制释放。

该case证据在pools-summary.json、GPU/Browser故障PID文件及完整server/browser trace。自有case与receiver已关闭，随后进入独立FIFO候选实验；新Endpoint不复用旧性能数。
