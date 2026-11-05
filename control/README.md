# RemoteKit Control

Control 服务端（`server/`）、Viewer 前端（`client/`）与二者共用的契约（`shared/`）。设计见 [Control](../docs/control-plane.md)、[系统架构](../docs/architecture.md#代码结构)；环境变量与部署见 [构建与发布](../docs/build.md#运行)。

```powershell
npm ci
npm run dev      # 服务端（tsx）
npm run client   # Vite 开发服务器 5173，代理 HTTP/WS
npm test         # 单元与集成测试
npm run build    # 类型检查、Vite、服务端 bundle 与最小运行时、生产启动检查
```
