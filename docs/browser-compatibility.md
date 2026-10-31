# 浏览器兼容表面

UA 和 Client Hints 复用当前 Chromium Release 的 embedder_support，保留版本生成、GREASE 排列、Windows 平台探测和命令行覆盖语义，将产品品牌设为 Google Chrome。Client Hints opt-in 按 BrowserContext 和 origin 保存，当前为内存状态。

`window.chrome` 通过 renderer native bindings 建立，不依赖页面脚本注入。

| 接口 | 行为 |
|---|---|
| loadTimes / csi | 编译官方 `chrome/renderer/loadtimes_bindings.cc`；在每个 frame world 安装 |
| app.isInstalled / getIsInstalled() | false；isInstalled 使用 native getter 与空 setter |
| app.getDetails() | null |
| app.runningState() | cannot_run |
| app.installState(callback) | 后续 renderer task 回调 not_installed；文档替换后不进入旧 context |
| app.InstallState / RunningState | 采用官方 schema 的枚举成员和值 |
| runtime | 不装配扩展框架，因此普通页面不创建此属性 |

app 是无已安装 hosted app 的普通网页 stub，仅安装在主 world。同步方法校验零参数，函数不能作为构造器；installState 当前要求 callback，不提供 Promise 路径。扩展、扩展 worker、app registry、安装服务和跨 realm 行为没有装配。

运行测试覆盖 UA、低熵/高熵品牌与版本、loadTimes/csi，以及 app 的普通网页返回值；完整 Chrome 表面的逐项差分测试尚未建立。
