# Android IME行为模拟与输入/resize重写

2026-11-05。按本轮要求由root独立执行，不委派、不上传。正式契约见[移动输入状态机](../../docs/mobile-input-state.zh-CN.md)。

## 修改前闭环复现

使用修改前Control生产runtime、Chrome157 mobile/DPR2/coarse Viewer、已有配套Native QSV/H.264，创建同Window两个远端tab。远端页面仅普通input和blur按钮，没有resize脚本替换节点、强制focus或定时行为。模拟Android系统由Viewer textarea的真实DOM焦点和inputmode驱动键盘高度1040↔620，反馈给visualViewport。

一次可信tap后6.5秒出现6次打开、6次关闭、12次没有reconfiguring标记的generation0空布局；peer、两条DC、video和track保持。这是自行发生的反馈循环，不是脚本预设6次resize。证据：`develop/tmp/keyboard-rewrite-baseline/{summary,trace}.json`。本组证明多tab正常resize足以触发症状，不声称已经复现用户每个网站/实体IME的全部起因。

原链将媒体空布局解释成文档消失，关闭本地textarea后系统回扩视口，恢复布局又重新授予自动打开。重写不依赖Endpoint是否正确附带reconfiguring，也不需要改动远端输入框。

## Android行为作为设计输入

- Chrome89：layout与visual viewport一起缩小；新版Android Chrome默认只缩小visual viewport。模拟器提供content/visual两种模式。
- DOM focus不是系统键盘可见性的证明；Back可以保留DOM focus。几何变化只更新遮挡观测，不触发blur。
- IME候选栏改变高度，caret可能平移可视区；同一resize的VV和内容RO不保证同时送达。
- IME自己的窗口可能夺走window focus；textarea仍为activeElement时只清理held keys、鼠标和触点，不结束候选、不发远端focus=false。
- 157以CDP驱动真实Blink候选/commit并模拟229外层按键。89只验证直接文本，不声称运行其原生composition。

来源为Chrome官方viewport说明、Android输入法可见性说明和固定Chromium157 `ImeAdapterImpl`源码，链接保存在正式契约和此前Android核对记录中。

## 实现

删除KeyboardVisibility，改为KeyboardSession显式消费armed/attached/dismissed意图；DOM聚焦与系统隐藏提示独立。媒体ready不产生新的打开请求。MobileEditingState拥有独立文档目录和active/inactive/unknown观测，所有generation0输出屏障暂停投递而不删除编辑会话；明确NONE仍立即撤销输入，同文档快速替换只给UI200ms宽限。

尺寸过渡改为“旧合法画面→保留预览→新匹配帧”事务。Transport在撤销ready/RTP之前通知快照消费者；每viewport最多一份4Mi像素快照，取消旧1.8秒销毁定时。peek原因保留到实际交接完成，不因VV/RO到达间隔丢失。普通resize不再显示“正在恢复页面”；真正连接失败、视频错误和休眠唤醒有独立状态。锁定/切文档/断链/卸载仍清理快照和输入，不放宽旧坐标门禁。

## 验证与失败记录

| 范围 | 结果与证据 |
| --- | --- |
| 最终定向CPU | 97/97，键盘会话、编辑目标/候选隔离、输入暂存、尺寸事务、video门禁、touch与授权；`develop/tmp/keyboard-rewrite-tests.log` |
| 最终生产构建 | TypeScript、Vite Chrome89 target、服务端bundle、生产启动smoke通过；`develop/tmp/keyboard-rewrite-build.log` |
| 最终157闭环与IME | `keyboard-rewrite-final-check`：1次打开、0次关闭、仍实际收到普通空布局；候选/229、恰一次commit、2.2秒暂停投递后的peek、caret平移、Back/reopen、IME窗口blur与远端真实blur通过 |
| 最终89双视口 | `keyboard-rewrite-final-89`：同样1开0关、媒体身份保持；直接文本、2.2秒预览、caret平移、Back/reopen、window blur与真实远端blur通过；无CDP候选声明 |
| 最终157目标换代 | `keyboard-rewrite-targets-157`：既有移动专项通过真实候选、resize期间节点替换、旧commit拒绝、新target恰一次commit、Back/reopen、失焦后Latin输入 |

第一轮延迟测试未通过：预览仍在但失去keyboard-peek类，变成普通模糊拉伸。`keyboard-rewrite-preview-probe`确认它不是快照被销毁；据此将过渡原因从140ms事件提示改为持续事务状态。`keyboard-rewrite-157-final`随后通过延迟预览，却在Back测试超时：模拟器已禁用feedback，但此前排队的110ms回调没有复查armed，错误地又打开一次。修正模拟器取消/执行时检查后通过，没有放宽产品断言。原失败目录保留。

本轮Native源码未改，复用配套Native产物，不重复Native构建或性能矩阵。不打包、不上传；没有实体Android、UD710或实际输入法效果验收。
