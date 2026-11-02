# 音频/文件补充运行QA

2026-11-02，Sol6.1。隔离数据 `develop/tmp/audio-files-qa2`；使用host-managed Playwright，157.0.8103.15与89.0.4389.90。接收端AudioContext实际destination前gain0，测量post-gate PCM，不向宿主扬声器播声。未改产品源码。

## 已通过

- 最新单选修复进入生产dist：Control类型检查、Vite生产构建、server bundle及production smoke通过。
- 157真实chooser→自定义dialog→设备FileList→确认→原生FileSelectListener→网页读取：`中文-test.txt` name保持、size17、内容`exact bytes α\n42`精确；multiple `a.txt`/`empty.bin`分别3/0字节，内容`one`/空串。fixture-events.json保留页面结果。
- selected后约9秒，页面history.pushState并读取持有File，name/文本保持。此例是同Document延迟读取，不能扩展为跨Document对象保活。
- 实际取消关闭pending chooser。另pending期间跨Document tab.navigate后dialog消失，旧request files.begin被拒绝。
- 89真实单选`legacy89.txt`内容`Chrome89 exact`交付；重载Viewer使原lease ticket HTTP POST返回404，pending chooser在新Viewer重现并可取消。
- 157可听源播放期间Viewer reload，新peer实际post-gate PCM恢复双侧约0.056，FFT445.3/890.6Hz。89同样实际PCM双侧约0.056；Control保存双关3秒后双侧严格0，保存双开400ms后恢复当前音调。此前试直接修改audio graph会被产品state覆盖，该试验不计静音验收。
- 157桌面单文件dialog与390×844窄屏dialog/menu截图已检查，dialog宽/scrollWidth/clientWidth均390，无横向溢出，声音组紧凑独立。截图位于qa2根目录；菜单必须等Popover过渡后截图。

## 证据边界

沿用前轮声道全组合/AV单脉冲证据，不重复性能矩阵。此次未注入真正PCM/network gap，未验证真实autoplay拒绝、大字体、进行中的HTTP断传、commit与取消竞态、跨文档旧文件延迟消费及实体摄像头。camera性能由专项owner处理。89新版Playwright role查询调用缺失的checkVisibility，改用CSS定位/DOM点击，仅自动化兼容处理，未给产品注入polyfill。

初次157重连取样曾因测试点击落在resize期间的工具栏而创建about:blank第二窗口，PCM为0；确认测试操作问题后关闭该自有窗口，正确激活源再做audible-reconnect，最终指标有效。原始metrics保留失败取样，使用`157-audible-reconnect`与`89-saved-mute/reopen`判断，不把前述0当产品失败或通过。

全部自有157/89 context已关闭；fixture `/shutdown`正常完成，启动会话退出0。GPU独占窗口已向root释放。无commit/push。
