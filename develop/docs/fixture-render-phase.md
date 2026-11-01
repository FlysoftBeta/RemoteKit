# Fixture绝对渲染相位

本轮仅修正两个测试fixture的目标帧率调度，属于新的实验负载版本；不能把它产生的FPS变化归入此前产品atlas发布节拍修复的A/B收益。

旧逻辑每次成功绘制后执行`last=now`，再等待至少目标周期减1ms，RAF抖动会把迟到叠入以后相位。新逻辑从本次页面初始化的start建立固定nextRender：首deadline为`start+半周期`，RAF使用半周期就近量化容差，每次RAF最多调用一次render。成功后按完整周期推进，跳过已经过期的deadline，不追赶burst、不用本次now重设后续相位。

首deadline的半周期偏移与相同容差配合，使第n个可用slot的门限为`start+n*period`；因此RAF计划绘制总数不超过`elapsed/period+1`。迟到会跳过slot，不产生补画。输入、touch、activation marker仍可立即触发额外render，保留原测试响应语义，不把用户输入挤进动画预算。

static仍只计划绘制一次；change-stop到期后保留一次最终绘制并停止，compositor fixture仍暂停CSS动画；独立输入marker仍有效。URL参数/页面加载重新建立phase。没有增加动态模式切换接口，视觉内容、像素尺寸、质量及source-probe的`function render(now){`插桩锚点均未变。DOM compositor的render仍指marker更新，CSS合成独立运行。

| Fixture | 旧SHA256 | 新SHA256 |
|---|---|---|
| test-pattern.html | bee998b6276a4a3df0320d55f302be5dbcab60a7a79599170bbd5554dcc021c0 | 4cb517d8bd239e64c79c6d26d66e8fa0e374062046b43ef9813089a2874585f1 |
| compositor-pattern.html | 099400e36c57128ffd39e472c49bdbc05cc475684e6484f4c2d8adde0c23b5ea | c042b5cfcafe9f5e31d13cbc7f57a928f2cccb597a7cbe2e897a113b9e08d6b1 |

分别提取嵌入module script用node --check通过，git diff --check通过。正式Control build（含typecheck）和生产startup smoke通过，dist中的两个fixture hash与源码一致。没有新增镜像测试，也没有运行浏览器/GPU；实际RAF/render的恢复幅度由下一批明确标注新fixture版本的实播验证。
