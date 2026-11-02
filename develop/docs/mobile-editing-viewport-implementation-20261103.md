# 移动编辑与 visualViewport resize 实现记录（2026-11-03）

本批是生产客户端实现与 CPU 验证记录；没有启动 Native 构建、GPU 实验或实体手机。不能把隐藏 textarea 的 DOM focus 视为手机软键盘已经弹出。

## 状态与生命周期

`input.editable` 是独立 DataChannel 消息，不改变 layout、媒体 ready 或视频屏障。每个 peer 保存一个递增 decimal revision 水位和至多一个编辑状态。匹配 session/view/instance/document/focus 后才启用键盘；焦点 ACK 之前早到的同文档 focus 候选最多保留 1.5 秒，在 layout/ACK 到达时重评，不凭 editable 修改 token。换文档、实例或 peer 清候选，旧 revision 不能复活已 blur 的状态。没有传回、缓存或持久化远端正文、密码或 surrounding text。

类型映射核对固定 Chromium `ui/base/ime/text_input_type.h`：NONE=0，TEXT=1，PASSWORD=2，SEARCH=3，EMAIL=4，NUMBER=5，TELEPHONE=6，URL=7，TEXT_AREA=14，CONTENT_EDITABLE=15，NULL=17。非编辑 sink 使用 `inputMode=none`；触控未获确认 editable 时不 focus textarea。桌面仍可 focus sink 发送页面快捷键。远端 inactive/null、真实本地 blur 和 owner 失效会清本地 composition，并在仍是同一远端 owner 时尝试 cancel，不把旧 end 或 cancel 套到新焦点。

确认 editable 后尝试设置对应 inputMode 并 focus；紧凑“打开键盘”按钮提供明确的本地用户激活入口。Android/iOS 对异步 focus 的限制仍需实体设备验证，不能保证所有浏览器自动弹出软键盘。代理不含远端正文，自动纠错 replacement 仍由编辑模块明确报告不支持。

同文档 resize 保留 composition owner。媒体屏障期间仅将已确认 editable owner 的编辑事件暂存，最多 32 项、64 KiB UTF-16 字节、3 秒；只合并相邻可替换的 ime_set，commit/删除/Enter 保序。匹配 owner 的新 ready 后消费一次；文档、peer、焦点或真实 blur 变化丢弃。预算、超时和发送失败会显示输入未送达提示。旧坐标 pointer 不进入该队列。

## Resize 事务

WindowFrame 与 RemoteViewport 都取客户端内容 rect 和 visualViewport width/height/offset 的交集。WindowFrame 上报 desired DIP 尺寸，RemoteViewport 只在该可见区域呈现。内容父节点 ResizeObserver 与 visualViewport resize/scroll 分开处理，不能因为 layout viewport 没变而漏报软键盘遮挡。

`ViewportTransition` 分离 desired bounds、最后 confirmed presentation bounds 和冻结状态。visualViewport 尺寸变化时，仅从仍 ready、同文档的已呈现 ROI 做一次 canvas copy，固定在旧 confirmed bounds；它不参与媒体 FPS，诊断单列 `freezeCopies`。该临时层 pointer-events=none，最多 4,194,304 像素（RGBA 约 16 MiB），最长 1.8 秒。动画末次 visual 变化后至少 120ms 且真正 ready 的 layout 尺寸匹配最后 desired bounds，才去掉冻结层。peer/doc 变化立即释放，普通稳态 video 不增加 MSTP 或逐帧 2D 绘制。

等待期间 CSS 同时隐藏 live video/canvas，客户端撤销坐标输入；Endpoint 原 presentation barrier 保持独立。抓取失败或超预算时展示正常恢复状态，不伪造 ready；超时释放旧图后仍等真实新画面。只有 offset 变化而尺寸不变不需要远端布局，也不复制旧图。

WindowDivider 的 pointercancel/lostcapture 与 window.layout action 失败会恢复当前 Control 权重到 DOM flexGrow，保留正常拖动预览、键盘调整和新建起始页行为。

## 已验证与待验

相关 27 项 CPU 测试和 TypeScript 检查通过，覆盖 production helper 的旧 revision/旧文档拒绝、early ACK 候选、blur/owner 清理、同文档 composition、暂存 set→commit→删除顺序/重复 ready/期限、visual offset 交集、单次 freeze/期限/预算/新 ready，以及 transport editable 不改变 layout/RTC/输入 ready。未跑性能矩阵。

真实 QA 应以 Chrome89 和 Chromium157 正式 video 路径模拟 visualViewport 尺寸/offset、多段 keyboard 动画、layout/IDR 延迟、DPR2、导航/重连和 divider cancel/失败；确认 live 视频、srcObject、RTC 身份不变，freezeCopies 有界且不计 FPS，等待期间输入无旧坐标。应同时记录远端值与 selection，覆盖 resize 期间 composition end、Backspace、Enter 与新 doc 的晚 end。

Android/iOS 实体键盘自动弹出/关闭、中文候选、系统地址栏动画、触控滚动与实体设备 visualViewport 时序尚未验收。DOM focus 和桌面模拟只能证明代码接线，不能替代这些结果。
