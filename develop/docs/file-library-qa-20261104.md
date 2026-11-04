# 文件篮、我的文件与拍照运行 QA

验收脚本为 `tools/test-file-library.mjs`。需要 Node、既有 Playwright 本地模块、Chrome 157 或 Chrome 89 可执行文件、Control production dist、配套 Endpoint package 与 Browser/SDK。脚本使用独立的未创建输出目录、临时账号、Viewer Profile、Control DB、Endpoint data path 和两个空闲 loopback 端口。配套程序使用 QSV/Fence 正常产品路径。不要与 GPU 计时实验并行。

```powershell
node tools/test-file-library.mjs <playwright-module> <chrome.exe> <endpoint_service.exe> <remotekit_browser.exe> <new-run-dir> <port> [Control server.mjs]
```

- 脚本生成同源 remote HTML、确定性 37,019 字节与空文件、文档 PNG、虚拟摄像头 Y4M。真实 native 文件回调由 remote Document 读取 FileList、计算 SHA-256 并回报，浏览器长期持有 File 的再读也由同 Document 验证。
- 通过现有产品 socket 和授权 RTC 发送真实请求，核对多块偏移与哈希、操作重放、分组改名/移动、篮子插入/顺序/去重/归档、单选数量门禁、多选顺序、native 提交收据的幂等与媒体对象身份。真实隐藏 input 由可信 remote 点击触发，随后测试连续拍摄、停止 track、取消重拍、移除、继续拍摄和分组确认。准备后跨文档退役选择，篮子必须保留且不得调用 change。正常退役不能证明回调结果真实未知时的断电恢复。
- 正常虚拟摄像头为可重复固定帧，核对相同帧不会要求强制选择。另用交替色彩的合成 MediaStream，经同一产品拍摄和 RTC 分析流程检查不确定槽位禁用保存、对比候选与保留当前图后解除门禁。校正/扫描验证真实 RTC 输出的尺寸、哈希、原图保留与空图失败。实体摄像头及运动场景另验。
- 锁定后直接测试旧 RTC 代次和 Control library 拒绝，解锁后测试旧 draft 无法续写及 peer/DC 保持。另一个独立 draft 在 Viewer reload 时断开，重连后不能续写。该 reload 验证 Control 持久化，不验证 Endpoint 进程重启。我的文件为同一 Window 内的单例 native tab，验证可转回 remote。
- Anchor 组观察真实可见 input 的 Browser→Control 带代次矩形和 Viewer 固定定位，对照由脚本触发的隐藏 input 回退。另在选择期间由 remote Document 隐藏真实输入控件，核对矩形撤销、回退、画面 bounds 保持与取消。
- 保留 JSONL 和桌面 chooser、拍摄、审阅、我的文件与窄屏截图；人工检查前只将截图标记为已采集。失败时输出失败阶段与 screenshot。通过 Control IPC 断开和 Playwright close 结束自有运行树。

## 实际运行

运行用 Playwright 1.62.1、Chromium 157.0.8103.15 `out/rel/chrome.exe`、Google Chrome 89.0.4389.90 和配套 `out/dev/remotekit_browser.exe`。桌面 Viewer 1152×820，窄屏 390×844，真实 H.264/QSV。证据放 `develop/tmp/file-library-qa-*`。

初版 157 第 7–9 次完成的阶段分别记录在各自 JSONL。RTC 3 块共 37,019 字节与空文件哈希精确，单选后同 Document 持有 File 仍可读取，多选按空文件、6 字节文件顺序交付；Browser 可见 anchor 为 (16,16) 290×45、DIP 1152×732，隐藏 input 居中回退。照片校正和扫描均为 221×187 JPEG、哈希不同，原始 PNG 字节保持。固定摄像头连续两张无需候选，交替合成流真实返回两张候选且保存门禁有效。候选缩略图 140×100、原图 520×400 可读，两层弹窗动画结束后复核。第 8 次覆盖删除、持久文件篮、旧 draft 拒绝、文件 tab 转 remote；390px 我的文件无横向溢出。真实页面收到文件只证明本地 native FileList 交付。

初版阻碍和测试修正：Viewer `out/dev/chrome.exe` DLL 不匹配，改用已验收的 `out/rel`；Endpoint 照片解码只接受 PNG/JPEG，测试由 BMP 改为 PNG；修正隐藏控件 CSS、认证门禁点击、MUI role 和鼠标命中、文档/viewport 对应。第 9 次初版锁定后解锁成功响应，但静态网页显示「正在恢复页面」超过 12 秒，第 7–8 次恢复通过；该次证据保留，最终脚本增加 auth/RTC/布局失败探针。未提交而退役的选择初版返回 unknown 且保持文件篮，最终版期待 cancelled。

最终 89 整组通过。未提交且跨文档退役的选择返回 cancelled，文件篮保留。固定摄像头与交替合成流完成真实采集链路；解锁回原 peer/DC；重附着后拒绝旧 draft。已渲染的可见 input 在 chooser 打开 3 秒后由 fixture 隐藏，Browser anchor 撤销，Viewer 回居中 Dialog，内容 bounds 仍为 (0,88) 1152×732，取消后无残留请求。检查 8 张最终截图，禁用「完成（0）」对比度修复可见，候选原图可读，窄屏文件清单操作换行完整。

最终 157 通过 native/照片/连续拍照与不确定候选阶段，未提交退役同样返回 cancelled。锁定后旧 RTC epoch 无结果、Control library 拒绝。解锁后问题再次出现：20,700ms auth 为 unlocked、peer epoch 3，peer/两个 DC/接收轨道保持，tab 为 live、restoring=false。21,257ms 收到 layout 16（1 view），21,259ms 收到 prepare。至 32,373ms 约每秒发送 refresh 共 12 次，未收到 epoch 3 的 frame metadata，Viewer 保持 no-frame；采样累计 43 decoded frames、16 keyframes、1,719 packets。最后一次已观测 frame metadata 在解锁前的 epoch 1。同期 Endpoint QSV encoder 3 初始化及 Reset 有日志，未见 FATAL/CHECK。该运行未达到最终 157 My Files 重附着和动态 anchor 阶段，未重复整组。两版自有运行树已退出。

尚未覆盖真实摄像头、站点后端收到上传、Endpoint 进程强制退出后的已提交未知选择恢复，以及浏览器崩溃时 staged 副本磁盘清理。

## 双模式与 QSV 修复后的运行

157 `develop/tmp/file-library-redesign-157-3` 与 89 `develop/tmp/file-library-redesign-89-2` 均通过整组，H.264/QSV 实际解码。三个普通文件自动使用列表，手柄和插入/移除按钮均可见。鼠标拖手柄排序，再切卡片通过整卡拖回。点击卡片只开菜单，Radio 保持未选。横滑可滚动且未开菜单或启动拖动，长按后拖动只保存一次顺序。键盘 Escape 不发送排序，Enter 提交；暂停在途 CAS 后先提交竞争版本，拒绝旧版并回滚到服务端顺序，手动卡片模式仍保留。

连续拍照经取消重拍和成功重拍保持原 slot ID，键盘可调整审阅顺序。不确定槽必须确认候选才放开保存，候选卡切换上方预览，再进入 520×400 原图。Viewer reload 后观察到 Endpoint `photo.thumbnail` 及其派生资产读回并实际加载，未读取被测扫描原图。两版解锁后恢复画面、peer/两个 DC/轨道保持，动态隐藏 chooser input 均撤销 anchor。

初轮测试定位与事件修正：拖动后待 DnD click 抑制解除，键盘启动后等待 sensor 接管；Chrome89 用标准 CDP `Input.dispatchMouseEvent`，避免新 Playwright 使用旧浏览器不存在的拖动拦截命令。人工截图检查发现宽预览底部被裁切、列表单选提示误写卡片右上角；这两处随后修正，干净包复验见下。

## 干净包运行

`RemoteKit-win-x64-streaming-qsv-nvenc-20261104-170701.zip` 对应干净源码 `7ab9b62bf078052fc47fee7eb8889b08eab4f08b`，SHA-256 `2da620a88e72d12f9f5881687f96373020bb64d4577f7fe51c262201e8cafa0c`。使用解压包自带 Node、Control、Endpoint、Browser，隔离 Chromium 157 完整组通过并退出 0。证据为 `develop/tmp/file-library-package-157`。浏览器重载后扫描图缩略图真实加载 221×187、8,365 字节，没有读取原图。静态期间实际触发同编码器 QSV Reset -14（1 fps、37.929 Mbps），重建后初始化返回 0、随后的 3 fps Reset 返回 0，并通过同 peer/DC/轨道的解锁恢复。

复查包内列表单选文字、拍照审阅大图、候选大图与 390px 我的文件卡片。照片纸张底部与候选全部 12 行均可见，图片矩形位于各自容器内且 `object-fit: contain`；窄屏文件网格无横向溢出。没有遗留本次自有进程。
