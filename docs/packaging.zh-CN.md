# Windows 发布包

在仓库根目录增量构建：

```powershell
C:\src\depot_tools\python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk
C:\src\depot_tools\python3.bat tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
npm --prefix control run build
C:\src\depot_tools\python3.bat tools/package-runtime.py --smoke
```

默认输出develop/tmp下的目录、同名ZIP及SHA-256。包含Browser/SDK运行依赖、Release Endpoint/CRT、Node、Control生产bundle、客户端及SQLite依赖；目标机器无需开发工具，硬件编码由Intel/NVIDIA驱动提供。

完整解压运行run.cmd，打开http://127.0.0.1:3001，创建首个管理员账号或登录。管理员在更多→管理员面板设置注册口令后，其他用户才可注册；已有账号登录仍只需要自己的密码。同账号恢复同一工作区，不同账号隔离；当前一个账号只有一个活跃Viewer。设置和产品状态保存在服务器，客户端只持用户token。包首次运行创建data，发布时不带任何开发账号、Profile、凭据或数据。正常入口关闭diagnostics。

运行参数可用--name=value附加到run.cmd，由Node launcher作为数据传递。普通用户在更多→设置选择质量偏好、Client Scale和memory saver，不需要编辑编码参数。监听、Origin及TLS配置见[Control说明](../control/README.md)；远程浏览器所需安全上下文应通过受信任HTTPS提供。

manifest.json记录源码基线、构建参数、backend和逐文件SHA-256；ZIP另有.sha256。打包工具拒绝凭据、Profile、数据、PDB和构建输入。--smoke在包外创建临时数据，检查包内Node/生产静态资源、注册首管理员、鉴权WS状态、SQLite和时钟接口，并确认WS不能绕过WebRTC提交产品动作。此CLI检查不再通过旧WS action创建窗口，runtime_validation明确标记未测试RTC媒体；不能称其已验证Browser页面或产品DataChannel。

正式发布还必须对本次实际包执行host-managed Playwright产品检查：使用包内Node/Endpoint/Browser、独立临时data与端口，真实注册/登录、建立WebRTC、通过产品UI创建Window并导航受控页面，检查默认video与真实点击/滚动，核对Browser进程来自包内路径；关闭本次自有服务后再上传。此步骤补足包内产品/Browser链路，不重复源码阶段已通过的全功能或性能矩阵。2026-11-03音频/Viz崩溃修复包还须在包内Browser实际执行设备枚举（包含首次播放前），确认Browser身份保持、无对应fatal；源码阶段结果不能代替此包内检查。分别记录CLI启动检查、包内WebRTC产品检查和既有功能QA，不把三者混为一项。

## 原生对照包

```powershell
C:\src\depot_tools\python3.bat tools/chromium.py build --target remotekit_browser_demo --target remotekit_sdk
tools\build-endpoint.cmd package-demo
C:\src\depot_tools\python3.bat tools/package-runtime.py --kind demo
```

原生demo只在显式目标包含。run-web.cmd打开指定网页，run-native.cmd明确选择HWND对照；Fence失败不自动回退native。

## 本轮交付顺序

此前两阶段全库审查交付已于2026-11-02完成。后续新增功能按实际修改完成验证、root审阅与本地提交，再由新的发布代理构建、校验并上传，不自动重复全库审查或历史性能矩阵。仅本次默认video发布优先上传，GitHub推送尽力而为；长期commit/push约定不变。上传流程见[上传说明](upload/README.md)，凭据不写入日志、文档或发布包。最终报告附版本、检查结果、包hash、取件码与新Viewer截图。
