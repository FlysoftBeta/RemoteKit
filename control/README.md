# RemoteKit Control

Control保存用户的窗口、标签页、站点UA和设置；Endpoint Session/Browser保存网页执行与恢复数据。媒体、输入、文件和产品操作请求走Client↔Endpoint WebRTC，产品操作由Endpoint转交Control执行并保存收据；已鉴权WebSocket负责Client与Control的状态同步和信令。完整职责及操作流程见[控制面设计](../docs/control-plane.zh-CN.md)，接口见[串流协议](../docs/streaming-protocol.md)。

## 开发与运行

```powershell
cd control
npm ci
npm run dev
# 另一终端
npm run client
```

生产构建使用`npm run build`，发布包使用仓库`tools/package-runtime.py`，最终用户不需要npm。首次打开正常Viewer创建的正式账号自动成为管理员；在更多→管理员面板设置注册口令后，其他用户使用该口令注册自己的账号。注册口令不是登录密码，未设置时不开放后续注册。升级旧数据库时保留账号并将最早的正式账号设为管理员；诊断账号不参与。同账号恢复同一工作区，不同账号隔离。每账号当前只有一个活跃Viewer，新连接接管后旧Viewer不会自动抢回。

默认Control监听127.0.0.1:3001。开发Vite为5173并代理HTTP/WS。服务环境变量以server/main.ts为准：

| 变量 | 用途 |
|---|---|
| PORT / REMOTEKIT_CONTROL_HOST | 端口及监听地址 |
| REMOTEKIT_CONTROL_ORIGINS | 允许的完整Origin，逗号分隔 |
| REMOTEKIT_CONTROL_DB | SQLite文件 |
| REMOTEKIT_ENDPOINT / REMOTEKIT_ENDPOINT_ARGS | Endpoint可执行文件与JSON参数数组 |
| REMOTEKIT_ENDPOINT_NODE_ID / REMOTEKIT_ENDPOINT_TOKEN | 配置一个远端Native节点ID及独立管理Bearer密钥；设置NODE_ID后不启动本地Endpoint |
| REMOTEKIT_ENDPOINT_TLS_PROXY=1 | 网关位于本机TLS反向代理后；仅接受loopback代理且X-Forwarded-Proto=https |
| REMOTEKIT_HTTPS_KEY / REMOTEKIT_HTTPS_CERT | 成对配置TLS私钥/证书 |

局域网部署同时配置监听地址、正确Origin和TLS；浏览器能力会受安全上下文影响。不要把实验配置、凭据或本机Profile放入客户端持久存储。

远端节点主动连接固定`/api/endpoint` WebSocket路径，使用受信证书HTTPS/WSS；可以由本机反向代理终止TLS并开启上述代理配置。loopback明文仅供开发。节点管理鉴权独立于Viewer Origin和用户账号；没有配置NODE_ID时不开放节点注册。当前Control只绑定一个配置节点，不提供多节点调度。管理连接替换/断线立即失败挂起请求，不自动重放变更；重新握手触发snapshot对账。Control停止仅断开远端管理连接，不发送shutdown销毁节点的Session/RTC；默认单包仍启动并管理本地Endpoint进程。

## 验证与诊断

`npm test`验证模型、协议、媒体与策略；`npm run build`执行类型检查、Vite、最小server runtime和独立部署启动检查。真实H264、输入及视觉检查另记，不能由这些单元检查替代。
