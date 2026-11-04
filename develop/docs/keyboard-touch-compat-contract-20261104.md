# 站点兼容设置、键盘与触控收尾

2026-11-04。本轮在137959版本基础上处理实体用户反馈；此文件记录root确定的边界，构建与运行结果另记，不能以方案代替验收。

## 产品行为

- 更多菜单中的平板选项移到“网页兼容性处理”子菜单，与“不自动弹出键盘”并列。两项按HTTP(S) origin存Control；旧记录默认自动弹出。只修改键盘设置不刷新网页、不下发UA。
- 手动模式仍保留远端编辑目标，通过当前Window的“显示键盘／隐藏键盘”悬浮按钮控制本地输入代理。隐藏不等于远端失焦；同一目标的重复状态与尺寸变化不能重新弹出。真正失焦、切换文档、锁定与断链撤销目标。普通手动隐藏完成当前组合文本，不能将未提交文本直接丢弃。
- Viewer外壳按visualViewport宽高布局，offset只更新位置；内容区真实大小决定远端DIP。可视区域平移不改变分辨率。键盘大小变化继续使用顶部保比例peek；普通内容布局变化继续使用最后帧模糊拉伸。

## 触控契约

- 本地队列接纳、DataChannel实际发送、Browser受理和canonical ACK完成分开处理。不能从本地入队开始按远端确认期限计时，也不能从任意失败推断原始输入未投递。
- Browser依据真实raw触点状态判断physical terminal；双指只抬起一指不是终止。按完整InputToken和sequence记录有界完成信息，记录须在可能同步回调的派发前建立；旧序列查询不能误读新序列状态。
- Endpoint在输入队列之外公平推进有限终止查询，不通过同步sleep阻塞后续输入。accepted-pending与最终processed/terminal-invalidated/terminal-unconfirmed使用原clientSequence及touchSequenceId关联；SDK发送背压保留关键回执并重试。
- 当前peer及授权代次可以用只读input.touchStatus查询自己已提交的精确序列。查询不重放input、不重新绑定当前坐标或focus。超时保持未知，不把未知包装成成功；正常恢复保持peer/DC。
- Client保留关键终止记录，普通输入不能将它挤出。新布局、文档、focus或连接身份只撤销自己的旧owner；迟到旧回执不能释放新手势。只有明确未受理的拒绝才允许按原身份补发必要取消。

## 验证范围

必要CPU回归涵盖站点补丁独立保存、键盘显隐与composition、仅offset变化、partial end、异步查询与发送背压、旧identity/sequence、队列丢弃和迟到回执。Chrome157与Chrome89使用隔离的实际H264会话验证菜单、模拟键盘视口、可信触摸、远端滚动、延迟回执及媒体身份。桌面模拟不能替代实体Android/iOS键盘验收，不追加历史性能矩阵。
