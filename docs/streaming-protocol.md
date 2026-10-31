# 串流管理与客户端接口（实施契约）

这是 2026-11-01 接入任务的接口决定；各方法实际实现状态见当前状态文档。

## Control 与 Endpoint

Control 启动独立 `endpoint_service`，用 stdin/stdout UTF-8 JSONL 管理。stdout 只输出协议，日志走 stderr；请求带唯一 `id`，回复 `{id,ok,result}` 或 `{id,ok:false,error}`。消息最多 1MiB，超时不复用旧 id。Endpoint 退出后 Control 重新启动并按数据库期望状态对账。这个链路通过父子进程句柄权限授权，不暴露未认证的网络管理端口。

管理命令统一 `{id,method,tenantId,...}`，租户身份从已认证 Control 会话产生，绝不从客户端任意 JSON 直接信任。

| method | 内容 |
|---|---|
| session.ensure | tenantId，idempotent；启动或取得该 Session |
| session.snapshot | 返回本租户 WebView 清单与运行状态 |
| view.ensure | 稳定 viewId、url、width、height、device 配置；创建幂等 |
| view.close | viewId、force；返回 closed 或 pending/requestId，用户关闭与 orphan 清理区分 |
| view.close.reply | viewId、requestId、accept；转给 browser 的 beforeunload 回复，不用 force 替代正常确认 |
| view.navigate | viewId、url |
| view.configure | viewId、viewport/device/visible |
| rtc.offer | tenantId、connectionId、sdp；返回 answer |
| rtc.ice | tenantId、connectionId、candidate |
| rtc.close | tenantId、connectionId |
| shutdown | 正常清理所有子进程与编码/网络资源 |

Control 每1.5秒对账，以自己保存的 WebView 引用为准；只有配置改变才发送配置，防止周期对账打断输入。重启丢失时用产品地址和设备配置重建，不伪造完整导航恢复。Endpoint 应保存自己的 Session 恢复信息，并在仍有恢复数据时优先使用。

## 浏览器客户端

`GET /api/state` 在首次访问分配独立租户与随机 HttpOnly、SameSite cookie，SQLite 保存会话。后续请求通过 cookie 绑定租户；写操作检查 Origin。允许测试用不同 browser contexts 产生 1/4 租户。没有客户端任意选择 tenantId 的接口。

state 为 `{tenantId,tabs:[{id,title,url,webviewId}],activeTabId,splitTabId,device:{mode,width,height,deviceScaleFactor}}`。`POST /api/actions` 接受 tab.create、tab.close、tab.navigate、tab.activate、split.set、device.set，返回新 state。Control 保存配置后驱动对账；失败需明确展示，不能把未执行动作说成成功。

`POST /api/rtc/offer` 接受 `{sdp,type:"offer"}`，返回 `{sdp,type:"answer",connectionId}`。每次 offer 绑定当前租户，替换旧连接有界清理。`POST /api/rtc/ice` 携带 connectionId/candidate。优先支持完整 gathered SDP，同时保留 trickle 扩展。

DataChannel 名称 `remotekit`，ordered/reliable。64位ID与代次统一十进制字符串。

- layout: `{type:"layout",generation,epoch,width,height,views:[{id,session,instance,document,focus,x,y,width,height,deviceScaleFactor,mediaScale}]}`。
- input: `{type:"input",view,session,instance,document,focus,outputGeneration,layoutEpoch,sequence,event}`；event 使用本地 control 协议事件结构，坐标为 viewport DIP。
- focus: `{type:"focus",focusRequestId,view,session,instance,document,focus,layoutEpoch,focused:true}`；服务端确认回显请求ID和请求代次。客户端核对当前请求、代次与页面身份后，按确认的token投递排队输入；已聚焦页面的成功确认也可放行，不要求token变化。旧确认与拒绝不能放行输入。
- frame: `{type:"frame",rtpTimestamp,layoutEpoch}`；RTP时间使用实际发送值，客户端通过rVFC回调匹配显示代次后才呈现和命中输入。
- stats: `{type:"stats",...}`；缺测指标为空，客户端不得用默认零值冒充测量结果。

新授权帧立即驱动各可见平面绘制；尺寸变化可重绘同帧，但不增加呈现FPS。Pixel marker使用对应RTP的画面及选中平面实际绘制时刻，CRC处理耗时单列；输入响应待测期间逐帧识别，其余时间按配置抽样。解码FPS、rVFC与实际绘制FPS分开统计。

`focusRequestId`是连接内唯一字符串；成功和拒绝确认均回显原`layoutEpoch`。新版客户端要求这些关联字段，必须与新版Endpoint一起部署。

只打包当前可见页面，后台 Tab 保留逻辑对象；分屏保留各页配置的 viewport 和网页 DPR。视频采样分辨率与网页设备特征分开：Endpoint 可在 GPU 转 NV12 时等比缩小，以满足接收端 H.264 level/fps 上限；layout坐标为编码像素，像素转DIP使用deviceScaleFactor×mediaScale。stats显示源atlas、编码尺寸与比例。尺寸变化重建输出，重排提升 focus token，使旧输入失效；分屏裁切同一 H.264 视频。Chrome 89 兼容优先：feature-detect requestVideoFrameCallback，诊断 pixel marker 用实际接收视频像素，禁用以网页本地动画伪造远端FPS/延迟。
