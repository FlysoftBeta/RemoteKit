# 快速拍照、紧凑文件篮与彩色扫描运行 QA

验收使用 `tools/test-file-library.mjs`，复用独立 loopback Control、原生 Endpoint／Browser、单一 WebRTC H.264 与文件 DataChannel，隔离 Viewer Profile、服务数据与账户。两版 Viewer 分别用 Chromium 157.0.8103.15 和 Google Chrome 89.0.4389.90。运行目录及证据放 `develop/tmp/`。

采样时长从实际快门 click 到按钮解锁的 MutationObserver 回调，包含浏览器调度及 React 提交延迟。实现内部的采样资格窗口为 1000 ms，软糊样本的 UI 观测容差为 900–1100 ms。运行器没有读取内部 CaptureStats，另记录 RTC sample/end 时刻、分析 JPEG 字节数、快照对应 rVFC 的 presentedFrames 与 mediaTime。单次有界至 20 个不同源帧。取景测量使用真实元素矩形，像素比较使用本地 camera video 在独立 Canvas 读回的预期中心 cover 矩形和真实从 Endpoint 读回的 PNG。模拟安全区使用相机 CSS 变量。慢网探针在客户端短时扣住第一项 PNG 资产 begin，分析信道保留真实 Endpoint 响应。

## 原生扫描样例视觉初检

已目视核对独立 C++ 实现 probe 的四份前后对照，证据在 `develop/tmp/photo-pipeline-native-20261104`。裁边样例完整保留了边缘文字和蓝色墨迹，软阴影变平，硬阴影交界仍有窄暗带，深色块边缘有细光晕。公开票据上的印字、火苗和背景颜色仍可区分。公开书本图的页色、装订阴影与背景保留，书脊几何没有变化。四例输出几何均为 unchanged，且最终 Endpoint RTC 路径输出 PNG 与对应独立 probe 的 SHA-256 全部一致。四例 RTC 处理请求到响应分别约 163、167、374、174 ms，包含 loopback RPC，不含资产上传和读回。样例来源与许可见[扫描调查](document-scan-research-20261104.md)。

## 运行证据

`camera-flow-157-5` 全组通过 H.264、既有 RTC 资产和篮子操作、列表手柄、卡片鼠标/触控/键盘排序、CAS 回滚、Native FileList 顺序和 SHA-256、旧 wire 矫正、授权换代和缩略图重载。五个视口（390×844、844×390、320×568、568×320、1280×720）的相机及 video 边界均填满 viewport，快门分别在下中/右中。320×568 与 568×320 模拟安全区测得回退和快门避开设定 inset。已目视核对这七张取景图。

清晰样例在两个方向各采两帧，按钮在 87.1／84.2 ms 解锁。软糊样例没有收到提前停止，19 个样本均有不同源帧元数据，最后一个样本在 burst begin 请求后 957.2 ms 发送。采样 UI 在 1016.2 ms 解锁，burst end 请求在 begin 后 1009 ms 发送。解锁观测包含事件和渲染调度。640×480 源照片读回 221×480／640×295 PNG，四轴像素与预期取景一致，未调用 takePhoto。循环实验使用 60fps canvas stream，19 帧是该配置的实际计数。

已核对第一项上传暂停时仍可拍第二项、容量门禁挡住第三次快门、返回篮子后两项按快门顺序、移除后台项后不复活、旋转中断采样、快门时冻结模式、取消重拍及相机拒绝时保持旧条目、关闭连续后先返篮再上传。候选在同一篮内切换，确认前 UI 与服务端均拒绝发送，确认后自动按冻结的 scan 处理。普通单选经 Radio 明确指定，真实 Browser FileList 回传只消费指定 PNG。390px 照片条高 148px，右侧三枚按钮各 44px。

完整四边合成页的扫描输出 226×191 PNG，几何报告 perspective。裁边彩章页输出保持 1000×700，几何报告 unchanged。红章像素 [160,45,56]，人工查看确认蓝字、红章和淡铅笔字保留，纸面阴影变平。原图字节与哈希保持。

首次打开相机误报 HTTPS 的问题已修复，修后覆盖相机加载及五个视口。最终 Control 窄测 `camera-flow-157-narrow-final` 确认 191px 可用空间仍锚定、更多面板上限 360px、候选展开上限 560px。已目视核对 390px 候选界面。我的文件相机角标从 2 变为 3，文件篮一直保留 1 项。

`camera-flow-157-tablet-final` 用桌面 Chromium 模拟 Android 平板的 1280×800、800×1280 和 1024×768，DPR 2。三种布局分别触摸切换两种模式，1024×768 用触摸快门实际拍照并入篮。相机和 video 都铺满，横向快门右中、竖向快门下中。已目视核对 CDP 输出的 2560×1600、1600×2560、2048×1536 图片。未使用实体 Android 平板、手机、物理摄像头或手持拍摄。

Chrome 89 静态远页组 `camera-flow-89-5` 通过排序、Native FileList、取景和两方向 PNG 像素。清晰样例各两帧，软糊样例 UI 解锁约 1008 ms、19 帧。随后在 390px 静态页重配置和跨文档选择退役期间，QSV 从 2 FPS 转至 1 FPS 时 Reset -14，重建出的实际 level 50 超过协商 level 42，编码停止。RTC peer 与 DataChannel 仍连接，media.refresh 多次未恢复。该媒体故障单独登记。

最终 Control 的 Chrome 89 活跃远页组 `camera-flow-89-active-2` 通过完整功能回归。运行器选项 `REMOTEKIT_QA_ACTIVE_FIXTURE=1` 使远端测试页的 24×24 标记每 80 ms 变化，从而避开上述 1 FPS 静态路径。清晰样例各两帧，软糊样例采 19 个不同源帧，UI 解锁约 1009 ms，最后一个样本在 burst begin 后约 965 ms 发送。真实 Endpoint 返回两个不同的候选，候选选择继续执行 scan，文件选择、授权换代与缩略图重载通过。该组验证活跃远页条件下的 Chrome 89 文件功能，静态 1 FPS 恢复仍未通过。

## 最终成品运行

源码 `3e7ad7ac6ea2f9d2b639111dedaaafa97d264d73` 的 `RemoteKit-win-x64-streaming-qsv-nvenc-20261104-194030` 通过 Chromium 157 窄组，证据在 `develop/tmp/camera-flow-package-157-final`。运行器调用成品 Node 执行 `run.cmd` 所用的原样 `run-control.cjs`，使用隔离数据根及指向成品 bin、control 的目录连接。Windows 进程树确认 Endpoint 和 Browser 可执行文件，Endpoint 的已载入模块确认 SDK DLL，路径解析核对 Node 与 Control server 均来自同一成品。实收 H.264，191px 空间仍锚定，更多与候选展开上限分别为 360px、560px，档案相机角标随真实归档从 2 变为 3，篮子保持 1 项。测试进程均已退出。
