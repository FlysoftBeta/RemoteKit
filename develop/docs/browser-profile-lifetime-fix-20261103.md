# Browser Profile与退出修复（2026-11-03）

本文件描述本批源码变更与功能验证。root统一out/dev构建Browser/SDK及两项probe已通过；下列真实组使用该构建，不重跑性能矩阵。

## 归属与关闭

每Tenant的服务Browser进程安装Chromium官方`headless::SetHeadlessClipboardForCurrentThread()`，底层为`ClipboardNonBacked`。UI在线程/服务启动之前安装，由`BrowserMainLoop`最后销毁；Windows IO线程在`PostCreateThreads`最早派发安装任务，其DestructionObserver直到IO loop终结才销毁实例。ClipboardHost绑定仍使用Chromium官方UI链路，Windows潜在IO clipboard访问也拥有本地后端。退出前不移除后端，避免晚回调重新创建ClipboardWin。显式native demo不安装此策略。

剪贴板归属当前是Tenant/Session Browser进程，进程内多个Window共享，Browser重启后清空。它不属于网站origin或Profile；未来单Session多Profile不应自然假定不同Profile具有独立剪贴板。跨端剪贴板仍未实现。本批没有操作、读取或预填宿主Windows剪贴板。

`PostMainMessageLoopRun`在部分启动失败后也会被Content调用：先设置shutdown门禁、停维护timer和Control/GPU生产者，解绑正式页与pending popup的委托并取消请求，再清pending popup，解除native WebView的WebContents引用、移除WindowObserver并关Widget，随后销毁正式WebView。必要deferred compositor删除在BrowserContext和虚拟Screen仍存活时排空。最后销毁Context和Screen。State析构只检查这些资源已经清完，不再依赖成员析构顺序处理popup。

## Profile网络状态

`BrowserContext`持有`ProfileNetworkState`，在`GetDownloadManager`首次触发StoragePartition前创建，并在全部StoragePartition关闭以后才销毁。它使用官方157独立组件：

- `os_crypt_async::RegisterLocalPrefs`、`InitWithExistingKey`/`Init`。
- `DPAPIKeyProvider` → `OSCryptAsync` → `CookieEncryptionProviderImpl::BindNewRemote`。
- `NetworkContextFilePaths`的`data_directory`、`cookie_database_name`及Windows network sandbox migration/checkpoint权限流程。

每Profile单独生成随机AES key，只有DPAPI包裹后的key和audit标记保存在其`NetworkKey.json`，用`ImportantFileWriter`同步原子写入；不读取宿主Chrome Local State或其他Tenant数据。文件在`Network`目录外，sandbox获得的网络目录权限不包括key文件。现有文件读取、格式、DPAPI解密、AES provider或写入失败直接终止Browser初始化，不轮换现有key，不落明文、不退内存cookie。已存在默认Network目录而key文件丢失时同样拒绝生成替代key。

默认partition的cookie位置为`<Profile>/Network/Cookies`；非默认partition为`<Profile>/<relative_partition_path>/Network/Cookies`，拒绝绝对路径和父级跳转。`in_memory`保持无磁盘参数。网络服务路径迁移仅限自己的partition目录，`trigger_migration=true`触发官方Windows ACL与checkpoint流程，未改sandbox开关。

Max-Age/Expires persistent cookie跨Browser重启保留；session cookie保留官方进程会话寿命，`persist_session_cookies=false`、`restore_old_session_cookies=false`，不因导航恢复扩大寿命。正常退出在页面/下载停止后对所有loaded partition调用`FlushCookieStore`，最多等待5秒；断连/超时明确记ERROR，不能算成功flush。异常进程被杀时以此前已完成磁盘提交为准。

## 可见性事务

`output.configure`在任何配置/geometry/焦点token变动之前检查全部待显示页：实际contents存在、model live、无pending lifecycle且adapter非uncertain。混合live/unloaded或discarded的批次整体拒绝`restore_required_before_show`；调用者完成restore后重试。普通hide仍允许unloaded页。`ApplyLayout`检查`SetVisible`返回值，不把失败当成功提交。

## 验证入口与待办

CPU目标`remotekit_profile_isolation_probe`：真实DPAPI/OSCrypt provider生成→销毁→重开解密；其他Profile密钥不能解密；default/nondefault/in-memory参数隔离；NonBacked clipboard类型检查、写入与实例销毁后清空。它不创建Browser、网络请求、GPU或Windows clipboard。构建后运行其exe，退出0才是该组通过。

功能脚本（不建立Endpoint/Viewer媒体peer、不跑性能矩阵）：

```text
C:/src/depot_tools/python3.bat tools/test-browser-profile-lifetime.py
```

它用本机临时HTTP站和仅自身创建的Browser进程验证真实persistent/session cookie重启、SQLite加密字段、另一Tenant无cookie；live+unloaded批次拒绝后尺寸、visible及input token不变，restore后同批配置成功；两个Tenant复制粘贴文本/HTML保持各自内容，同Tenant两个Window共享，覆盖page.command与真实Ctrl+C/Ctrl+V；真实鼠标手势创建popup，保持未收养时正常shutdown，检查退出码。只在输入/clipboard/popup组打开Browser源atlas capture并等待capture callback就绪，不建立媒体peer。证据在独立`develop/tmp/browser-profile-lifetime/<run>/`，不打包/提交Profile或key。

最终脚本全组通过，证据`develop/tmp/browser-profile-lifetime/1793637288645388000`，返回`passed=true`，约4.4秒；所有自建Browser正常退出，cleanup-errors为空。此前只有page.command的clipboard版本也通过，最终版补入Ctrl组合输入后重新完整运行。日志未出现cookie flush/DPAPI失败或dangling Context诊断。没有读取或改写宿主Windows clipboard。

首跑cookie重启失败是测试夹具持有SQLite句柄：Python`with sqlite3.connect(...)`仅管理事务，不关闭Connection，阻止Windows Chromium cookie DB的独占文件锁；改为`contextlib.closing`后，在同一已构建Browser上立即重启通过，无cookie生产代码回退或修改。另一个夹具问题是不开源render demand时输入路由未绑定；现在显式打开源capture并等待就绪。清理路径先尝试服务shutdown，失败时只杀自建Browser，保存原始断言及RPC/netlog/HTTP观察证据，不再以cleanup超时覆盖错误。

真实Viewer运行QA还需在构建后覆盖以下小组：

1. 上述A/B隔离、同Tenant双Window文本/HTML及Ctrl组合键已由最终脚本通过；测试页允许的异步clipboard路径仍待覆盖。只通过页面读写服务clipboard，不读取/改写宿主clipboard。
2. popup未收养→退出、popup导航/标准dialog中→退出、收养完成后→退出；在Browser日志中检查无dangling RPH/Context诊断。用非法atlas尺寸在Context创建之后触发启动返回2，确认共享关闭路径正确，不称为正常启动成功。
3. 正常重启与网络服务重建分别检查带有效期cookie；删除测试副本的NetworkKey或写坏DPAPI密文后启动须明确失败。只操作测试副本，不动用户Profile。非默认partition的真实cookie隔离仍需独立运行组，CPU参数检查不代替它。

本批不重新执行已取消的性能矩阵/稳定性复验。
