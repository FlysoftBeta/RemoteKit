# 移动输入与尺寸过渡状态机

2026-11-05。Client的键盘意图、远端编辑授权、浏览器几何和视频呈现分别维护状态；resize不结束编辑会话。

## 浏览器行为与模拟模型

Android Chrome 108起默认只缩小visual viewport，89默认同时缩小layout viewport。两者均不能把高度变化解释成DOM blur；offset是caret平移，不是新的页面尺寸。[Chrome官方说明](https://developer.chrome.com/blog/viewport-resize-behavior/)。

Android Back可以隐藏输入法但保留编辑焦点。候选面板、输入法自己的窗口和InputConnection更新也不是远端输入框失焦。[Android输入法可见性](https://developer.android.com/develop/ui/views/touch-and-input/keyboard-input/visibility)。固定Chromium源码`ImeAdapterImpl.updateState`将节点/类型变化的restartInput和show/hide分开；`onWindowFocusChanged`特意避免因输入法语言对话框夺走窗口焦点而hide。具体源码依据见[Android核对记录](../develop/docs/mobile-ime-behavior-20261105.md)。

正式模拟器`tools/test-keyboard-recovery.mjs`使用隔离Viewer、Control与真实Native H.264。远端页面有两个标签和不会主动换代的输入节点。本地DOM focus/blur和inputmode决定模拟系统键盘显隐，并反馈到视口；这种闭环可以自行重复，不预先写死循环次数。另模拟候选面板高度变化、caret平移、Back保留焦点、IME窗口焦点变化；157用CDP驱动Blink真实composition与commit，另注入Android风格229按键。89运行layout/visual同时缩小模式，使用直接文本路径。

这些是Android行为模拟及真实串流验证，不包含Android系统InputConnection或实体IME。

## 状态归属

| 状态 | 权威输入 | 允许的动作 |
| --- | --- | --- |
| 文档身份 | 非零generation的布局中的session/view/instance/document；断链、授权与产品组件生命周期 | 换文档、删除、切tab/Window失活、锁定结束旧会话 |
| 远端编辑目标 | 有序input.editable、精确focus ACK | active目标授予编辑；NONE立即撤销；未知不冒充NONE |
| 键盘意图 | KeyboardSession的armed/attached/dismissed | 用户激活、文档切换、恢复自动策略可授予一次open；媒体ready只执行已有请求，不新建请求 |
| 本地输入连接 | textarea实际DOM焦点及composition事件 | 保持同一代理；真实blur结束本地输入，窗口blur仅释放按住的键鼠/触点 |
| 可视区域 | visualViewport、innerHeight、ResizeObserver | 更新内容bounds、遮挡观测和peek；不调用focus/blur |
| 画面与输入坐标 | 精确layout、presentation ACK、当前RTP帧、最终DIP | 新旧画面交接；旧布局和快照从不授予输入 |

`generation:"0", views:[]`表示输出不可用。无论有无`reconfiguring`，它都不能证明文档销毁。`MobileEditingState`独立保留最后确认的文档目录，暂停严格输入并等待新布局/编辑反馈；非零generation中实际缺失的view、文档换代和连接/授权重置才撤销目录。

`active A→B`可保持本地键盘，但立即废弃A的composition、held keys和暂存。NONE只给UI最多200ms的快速节点替换宽限，不给输入宽限。用户隐藏/系统收起消耗打开意图，重复反馈或恢复媒体不能重开。候选文本有界暂存仍绑定完整target身份，最长3秒；只向同目标的新有效租约发送。

## resize事务

1. 本地内容bounds开始变化，或者Transport即将撤销旧帧时，同步抓取最后合法ROI；后者在ready、RTP和layout信息被清除之前通知。
2. 每个viewport最多保留一张4Mi像素快照，不做逐帧copy。键盘引起的过渡采用顶部等比裁剪，其他resize模糊拉伸。
3. 过渡原因贯穿整个事务，visual viewport和内容ResizeObserver先后到达、跨帧到达都不丢失peek。短settle仅用于等待动画停止，不作为快照或编辑会话寿命。
4. 快照一直保留到新布局真实呈现且匹配最终DIP；不再在1.8秒后销毁。文档/连接边界和组件卸载立即释放。
5. 普通resize不显示页面恢复overlay。连接失败、视频错误和真正的休眠标签唤醒分别显示各自状态。

不改变Control保存产品状态、Endpoint执行页面操作、Browser验证最终target以及WebRTC媒体拥塞控制的边界。
