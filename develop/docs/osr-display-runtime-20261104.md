# OS显示路径切换验证

2026-11-04，UHD630，实际SDK固定GPU LUID `00000000:0000ea2f`。使用最终Endpoint `5de85342922c926dc6d37c347f83a1e889fc019bc5089e8d93a9809454c045b5`，无playout参数，实际请求0/50ms。两组均使用隔离Control、Profile、默认H264 video；CDB仅附着本次Browser/GPU，健康记录与显示转换独立于性能benchmark。

| 转换 | 实际系统证据 | 串流与进程 |
|---|---|---|
| 断开会话→console | `sudo --inline tscon 2 /dest:console`退出0；本用户session2 Disc→console Active；同LUID DXGI attached output 0→1，出现DISPLAY1及一条active DisplayConfig path | 60/60健康采样，转换后42.331秒；Browser28712/GPU32984保持；decoded1468→1571→4010；单peer/track，无dump |
| console→断开会话 | `sudo --inline tsdiscon 2`退出0（约0.52秒）；本用户session2 Active→Disc；同LUID DXGI attached output 1→0 | 25/25健康采样，转换后12.869秒；Browser39656/GPU16240保持；decoded765→872→1570；单peer/track，无dump |

没有FATAL/CHECK、GPU进程退出或Browser替换。第二组转换后窗口小于原拟15秒，因此只记录实际12.869秒，不追加转换或扩成稳定性验收。最初读取断开会话的QueryDisplayConfig返回访问拒绝，不能将该错误当零显示路径；本结论使用DXGI输出、会话状态及后续有效DisplayConfig的组合证据。

这次真实覆盖OS显示输出的附着与移除，未执行物理线缆拔插，也未复现用户此前偶发崩溃。固定离屏页面与GPU不代表驱动/context loss不可能发生；新探针保留Browser/GPU PID、设备错误及资源退役证据，不能在未知GPU完成时解除租约保护。

原始证据：[附着](../tmp/osr-video-profile-20261104/display-attach/display-health-summary.json)、[移除](../tmp/osr-video-profile-20261104/display-disconnect/display-health-summary.json)，完整目录包含显示前后快照、CDB日志及健康记录。所有自有服务/端口/Browser/GPU/CDB已退出；测试创建的MCP Edge也已关闭。用户会话最终回到原本的Disc状态，未操作其他用户会话。
