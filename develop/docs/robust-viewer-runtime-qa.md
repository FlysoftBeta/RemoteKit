# 本批正式Viewer集成QA

## 最终发布定向验收（2026-11-03）

当前样本索引：`develop/tmp/final-viewer-release-qa`。对应 `navigation-video-final-build-manifest.json`，73项关键source/artifact SHA256逐项吻合；完整out/dev Browser/SDK、Endpoint package和Control生产dist，真实WinHTTP EndpointNode。89/DPR1与157/DPR2先后使用隔离host-managed Playwright contexts，同一自有Tenant；Browser PID42436贯穿本组，未跨Browser代拼样。没有重跑已通过音频、搜索、编辑、文件、触控或历史性能组。

已实际通过：

- 两版本首次start导航到未监听33479，真实视频错误文档可读“无法打开此网页”、失败URL和 `net::ERR_CONNECTION_REFUSED (-102)`；Control保持remote及实际URL、导航rejected。`89-error-first` / `157-error-first` PNG均由Sol实际查看。
- 新start→本地5秒slow→真实UI“停止加载”，原导航rejected、stop独立committed，回start且保留Native view明确visible=false、renderHost.enabled=false，后续正常导航恢复；89停止后另观察超过6秒，无SDK5输出重试。157旧remote→slow→stop保留原URL。`89-stop-first` / `89-stop-settled` / `157-stop-outcome` / `157-stop-remote`保留完整收据与Native状态。
- 两版本desktop split→1100×820→390×844→desktop split，全程默认video；窄屏100ms采样55次、约6秒，hidden plane current=false/stale=true/ready=false，metadataRetries始终0；active plane current/ready正常，backend始终video、MSTP0、稳态draw0。返回split两plane各自新epoch及自身observationSequence增长，peer/video/srcObject/track身份保持。两窗真实点击远端DOM坐标均为(120,30)，浮点误差小于0.001。见 `89/157-narrow-watchdog`、`89/157-hide-return`；初次89 resize helper在几何尚未稳定时捕获旧ready后600ms遇新屏障，保留工具断言；待实际布局稳定后同组检查通过，非降低产品断言。
- 真实页面按钮打开about:blank popup，Control adopted/remote、标题“Real blank popup”、同Tenant，同源document.write内容实际呈现；真实UI关闭后Control tab与Native view6均移除，无pending popup。`157-popup` / `157-popup-close`。最后补验已明确观测popup.opener===window为true，见下段。

首组曾发现首stop回start后Control tab.loading仍true，Native loading=false，工具栏可见“停止加载”X（没有kind过滤），start页面无spinner。root修复仅清回start的loading；`control-stop-loading-final-build-manifest.json`对应最后Control生产build，66项source/Control/Native hash核对一致（Native7项未改）。GPU重新GO后，独立子目录 `control-stop-final` / 新Browser16308仅补实际157/DPR2 start→slow→stop：Control kind=start/loading=false、Native visible=false/loading=false/render disabled，原nav rejected/stop committed，toolbar停止按钮0/刷新按钮1/可见progressbar0，实际看过 `157-stop-loading-final.png`，刷新图标及起始页清楚。没有跨代重算前组结果。

同一次最后补验真实popup报告 `openerMatches=true`，Control同Tenant、adopted/remote、URL about:blank、正确标题；关闭后Control及Native popup view2均移除，只剩opener view1。注意document.write后的popup.location.href继承调用者文档URL，工具最初将其直接断言about:blank而失败；最终分别记录真实opener与document URL、Control/Native controller URL，不混为导航失败。两次保存工具因顶层字段tenant被生产鉴权拒绝400，改为tenantEvidence后成功；原始sample已完整保留。最后 `157-popup-opener-final-proof` / `157-popup-close-final` 与stop证据均保存到metrics。定向QA最终5/5：所测三修复、真实popup/close及交付视觉全部通过；这不是全产品无缺口或实体设备验收声明。

最终清洁PNG已由Sol逐图查看，桌面两独立remote内容清楚、toolbar/content对齐；start简洁；设置搜索项可读；390远端内容及start均无Viewer横向溢出（scrollWidth390），无可见恢复遮罩、调试罩或未完成过渡。隐藏旧Window残留恢复节点为0×0、不在画面。交付优先选：

- `develop/tmp/final-viewer-release-qa/157-final-desktop-split.png`
- `develop/tmp/final-viewer-release-qa/157-final-desktop-start-remote.png`
- `develop/tmp/final-viewer-release-qa/157-final-settings.png`
- `develop/tmp/final-viewer-release-qa/157-final-start.png`
- `develop/tmp/final-viewer-release-qa/157-final-narrow.png`
- 89回切实景：`develop/tmp/final-viewer-release-qa/89-return-split.png`（已实际查看）；前attempt1的157过渡图不作为交付图。

本组日志无FATAL/CHECK、atlas fatal、SDK5或Browser自动重启。全部custom contexts/default host browser关闭，fixture正常shutdown/exec exit0；自有43544/48624/42436退出，33471/33472无监听，GPU释放供最后Control构建；未操作既有包或PID7816。上一attempt1模拟composition/visualViewport不是实体手机软键盘或原生Windows IME证据，本组没有新增实体设备验证。

最后补验同样无FATAL/CHECK、atlas fatal或Browser重启；全部custom contexts和default host browser再度关闭，fixture正常shutdown/exec exit0，自有48448/44848/16308退出，33471/33472无监听，GPU已释放供发布。没有重跑已通过组。

## 最终增量attempt1：三项失败已定位，独立组通过

使用 `native-retirement-build-manifest.json` 的完整out/dev Browser/SDK与Endpoint package，Control生产dist对应 `touch-retirement-control-build-manifest.json`；不是替换单exe或旧发布包。证据目录 `develop/tmp/final-viewer-runtime-qa`，真实WinHTTP EndpointNode。三个隔离账号分别用于首导航负例、89功能与157/DPR2编辑，失败Tenant关闭RTC后才切换，不跨Browser代拼样。

**通过的独立组：**

- 89实际首remote、两个独立Window的split及1100×820布局，默认video、MSTP0、稳态draw0。两Window真实点击报告分别为(120,90)/(119.99999,90)，ROI/Client bounds一致，peer/video/srcObject/track身份保持。原生controls关闭，PiP/remote playback禁用，playsInline启用。`89-desktop-split.png`实际看过，两平面清晰，工具栏与内容对齐。
- 89失焦root wheel实际scrollY420，nested wheel实际scrollTop192；真正root scrollbar拖动scrollY2028，nested scrollbar拖动scrollTop884。Playwright新拖拽拦截协议在89缺失，改由同一host-managed CDP `Input.dispatchMouseEvent`发送实际鼠标事件，未调用页面handler。早期reload保留scroll位置及HTTP事件回报延迟造成的两次工具断言失败保留，不作为产品失败；最终以唯一URL和实际DOM滚动报告为准。
- 89普通设置UI依次选Google/Bing/DuckDuckGo/百度，中文查询`中文 QA & +`的Control最终/pending URL分别精确匹配四模板及编码；百度设置在Viewer reload后恢复。Client localStorage/sessionStorage无设置键。外站页面可达性未作为搜索模板判据。
- 89真实Chromium音源440/880Hz经Opus到Viewer产品post-gate PCM，双开RMS约0.056/0.056，FFT约430.7/882.9Hz（44.1kHz/2048-bin量化）；左关/右关对应侧严格0，不播放双0；保存静音后reload仍双0，再开恢复当前音调。整个组保持默认video/MSTP0/稳态draw0，宿主destination前零gain不发声。`89-pcm-gates`及后续left-only采样保存在工具返回/metrics（left-only已实际读取正确，后续narrow失败前的保存未完成）。
- 157以390×844/DPR2首启单窗默认video真实通过，peer/video/srcObject/track保持。真实键盘插入hello、Backspace→hell、单行Enter不加换行；模拟composition提交后远端text为hell中文；textarea为`line1\nline`，真实blur后远端无editable，本地inputMode=none。模拟composition跨文档迟到不能写入新文档，新文档只收到new-document。
- 157模拟visualViewport 844→520→844，显示和收起分别只新增一次freeze copy；节点及时清理，600ms稳态draw0/MSTP0，RTC/video/srcObject/track不变。此处是桌面模拟几何及composition，非实体移动软键盘或原生Windows IME。实际back/forward UI（窄屏前进通过更多菜单）无workspace解包banner。

**不能通过的三项：**

1. 首start→未监听33479错误URL，Control正确remote+实际URL+rejected receipt，video ready；但Browser错误文档实际纯白，`157-error-first.png`及settled图保留。不能用状态正确代替可读错误页。
2. 新start→受控5秒/slow→真实“停止加载”：navigate收据rejected(stopped)，stop独立committed，但stop覆盖tab.navigation的previousKind/URL，最终仍remote/失败URL；Native view3实际空URL/document1仍visible=true，未回start/隐藏。随后该Tenant重复output open SDK5和恢复遮罩。`157-stop-outcome`保留，不算恢复通过。旧Tenant关闭后RTC inactive/views全hidden，SDK错误停止。
3. 89与157实际split→390均触发video-frame-metadata-timeout。157有4秒100ms ring：hidden view6仍旧epoch38/current=false/canvas0×0/ready=false，metadataRetries1→2→3；可见view7 epoch43/current=true/ready=true/retry0/opacity1持续正常640×1232解码，随后隐藏旧plane误触全局fallback。157最后canvas-2d/MSTP1/draw1；89canvas-2d/MSTP0/draw1。证据`157-narrow-ring`、`157-narrow-split`、`89-narrow-failure`。截图可见不代表默认video通过。

未出现FATAL/CHECK或Browser自动重启。三项均已报root并由独立修复owner处理。当前体验评分3/5：大部分功能正确，但错误页、首导航取消及正常窄屏切换仍有产品失败。此评价不覆盖尚未生成的修复产物。

GPU已释放：全部custom contexts、默认host browser、fixture/Endpoint/Browser关闭；33471/33472无监听，自有服务39368/Endpoint36520及Browser43540、35332退出，157独立Tenant随服务退出；未操作其他既有包进程或PID7816。下一轮仅定向复验三修复、完整hide→return与必要popup/close及清洁效果图，不重跑音频/搜索/编辑大组。现有157 start+remote/settings截图采样处于恢复过渡，不能作为最终交付效果图；390 start图可读无横溢出。

范围：4de343c之后工作树新增路径。尚未启动GPU或服务、尚未声明运行通过；等待root给出本批产物READY与独占GPU grant。历史产品/性能结果不算本批验收。

## 隔离与入口

- `tools/robust-viewer-qa-server.mts`：隔离SQLite/Endpoint Profile/事件/metrics，普通生产Viewer，明确指定本批Endpoint、Browser、dist。loopback默认33471/33472；关停只操作自己创建的服务。
- `tools/robust-viewer-qa-page.html`：确定布局、文本/textarea/IME/blur、真实about:blank popup、beforeunload、单/多文件真实字节与FNV、页面/嵌套滚动。真实网页通过HTTP回报DOM状态，不用输入sent/ok替代结果。
- `tools/robust-viewer-qa-browser.js`：仅由现有host-managed Playwright执行；准备脚本本身不启动浏览器。独立Chrome89/157 profiles，采样身份、DOM、RTC/track/video、WS/DC、画布copy与远端事件、截图；无Computer Use。仅自有会话可丢product回复/暂存快照/暂存ACK。
- `tools/robust-viewer-qa-regression.js`：在浏览器工具脚本之后装载，提供显式执行的`startSmoke()`、`reliability()`、`managementReconnect()`；分别验证首网页同peer、UI→DC丢回复/收据/重复创建/快照反序、真实WinHTTP管理断线同RTC。其余清单按实际UI与远端DOM事件逐项执行。
- Root READY后显式配置 `ROBUST_QA_ENDPOINT`、`ROBUST_QA_BROWSER`、`ROBUST_QA_CLIENT_DIR`、`ROBUST_QA_GPU_GRANTED=1`，再用仓库已有tsx执行服务。不得自动使用已发布包。所有产物与凭据仅置于develop/tmp，不提交。

## 运行验收与判据

|组|实际可执行操作|必须观察的结果|
|---|---|---|
|首启与起始页|全新账号→普通Viewer，start→首网页；再remote→start→remote|start明确kind；首网页不插伪Browser history；空remote时DC/peer保留；peer/video身份有记录|
|搜索设置|普通更多→设置逐选引擎；重载；输入中文搜索及中文URL|Control持久化，Client storage无设置；搜索模板/编码URL精确正确。对外搜索只验最终导航地址，不把外部页面可达性当产品判据|
|产品操作|UI新窗/新tab/切换/关闭/导航/布局，beforeunload分别取消与接受|操作即时pending后与Control快照精确收敛；真实popup不被start覆盖；所有action经DC，WS只状态/鉴权/信令/收据查询|
|可靠性|仅自有会话drop一次product.result，再查status，重发同operationId；持有两份快照按新→旧投递|不得重复创建/执行；旧快照不能回滚；generation/incarnation过期受限；未知不冒充失败或成功|
|媒体生命周期|focus/navigation/resize、空start→首网页、WS断线重连|peer/track/video identity保持；不在管理断线时无条件杀RTC；空视图可无video但peer不重建|
|文件|从远端input发起，本地自有Unicode二进制/空文件/多文件、取消、延迟读取、fake-camera取消与选择|实际远端文件名/长度/逐字节或hash一致；无HTTP/WS文件数据；取消无残留，不用API成功当实际文件成功|
|编辑输入|远端空白→input→textarea→blur，Enter/Backspace、composition跨文档|editable决定本地editor资格；实际DOM文本、换行/删除可观察；旧document composition不能落入新页|
|布局与键盘|157 DPR2，1440→1100→390，visualViewport模拟键盘；暂存ACK后旧surface输入|屏障中输入拒绝，放行后恢复；freeze只一次copy而非持续canvas；布局/点击位置一致，记录video/peer身份|
|小范围滚动|失焦wheel、nested wheel、根与nested scrollbar拖动|远端scrollY/scrollTop及DOM输入事件变化；只功能组，不重跑历史性能矩阵|
|Endpoint管理|用`ROBUST_QA_ENDPOINT_MODE=node`运行真实WinHTTP→EndpointNode；POST fixture `/management-disconnect`只断自己管理socket→重连，两自有tenant|RTC不自动销毁、状态最终收敛且不串tenant。测试token只在fixture/native环境内，不输出/保存。不可把stdio离线或CPU adapter测试冒充真实WinHTTP运行|
|视觉|两版本最终start/remote/split/设置/窄屏截图，Sol实际看图|记录截图路径、可读性、溢出、弹层与内容bounds。模拟visualViewport/fake-camera不等于实体设备软键盘/摄像头验收|

## 准备阶段限制

1. 新产物由其他owner构建，当前禁止运行；READY必须包含实际Endpoint/Browser/dist路径。已准备脚本不默认旧包。
2. 手势native专项由root安排另一QA，本组只保留原wheel/drag小范围功能回归，避免重复。
3. 接口仍在修改；真实运行前核对product.result、snapshot incarnation/seq、empty remote RTC、editable与resize freeze最终字段。必要适配仅限本组工具，不改产品。
4. EndpointNode真实WinHTTP模式与自有socket故障hook已装配，但当前未执行、未覆盖；READY时确认新native已经支持control-url/node-id。

## 2026-11-03 首次实际执行：FAIL，暂停等待修复

本轮已获READY及独占GPU，真实WinHTTP EndpointNode，隔离目录 `develop/tmp/robust-viewer-runtime-20261103-final`。157.0.8103.15 headless，1440×900/DPR2。首起UI新建Window→start→首网页，中文URL远端DOM确认、首网页无伪blank历史、同RTC、MSTP/稳态draw均0；丢product.result后的durable committed收据、同id重发不双建tab和旧snapshot不回滚通过。管理socket断链只验证了一个Tenant且active start无video平面时同RTC；不算两Tenant媒体恢复通过。

UI建第二独立Window并导航B后，两视频平面持续“正在恢复页面…”，超过45秒，随后打开设置期间最终恢复。该组判FAIL，不因最终恢复通过。失败时同RTC，远端A/B DOM已ready；Endpoint重复相同barrier21/epoch24/gen6，最后2.4秒接收事件ring中2000条几乎全为layout/prepare，未见对应presentation.ready；旧尺寸video仍1936×1104、B videoWidth0，实际atlas976×2192。编码submitted261/completed5/dropped258；tail IDR submitted202/completed1。完整最小时间线、layout/ACK/媒体指标见 `split-failure.json`，原始 `metrics/client-metrics.jsonl` 与PNG保留。Sol亲自看过split失败、设置截图：split白屏明确；设置可读，背景最终恢复。

四个搜索引擎选项UI分别选择后Control snapshot收敛、Client local/session storage均空；尚未验搜索URL模板及reload持久化。390×844截图scrollWidth390，无横向溢出，媒体相关仍不算通过。89已启动独立profile及注册准备，但host Playwright注入的checkVisibility API不兼容89，未执行实际flow，不能算89通过。root收到产品失败后要求停止，全部自有contexts、fixture/Endpoint/Browser已关闭，端口33471/33472无监听，GPU已释放；未动用户PID7816。

未覆盖：89正式Viewer；两Tenant管理恢复与媒体identity；真实DC文件/音频；nav/reload/back/forward/stop/beforeunload回调；wheel/scrollbar；编辑IME/keyboard freeze；ACK暂存旧输入门禁；搜索模板。无实体手机验收。整体本次体验评分2/5：首起与收据正常，但正常多Window操作出现超过45秒白屏。

### Chrome89工具兼容准备（尚未重启运行）

`qa.uiCount/uiPoint/uiClick/uiFill`现通过页面DOM只读CSS/精确文本筛选、scrollIntoView、两rAF后的bounds及elementFromPoint遮挡确认定位；实际操作由host-managed page.mouse坐标点击及keyboard.press/insertText完成。没有调用应用click handler或产品API，没有main-world checkVisibility polyfill。startSmoke/reliability的UI主链已改用这些helper；尚未重跑已通过收据组，也未启动Browser/GPU。两份JS经node --check静态语法检查通过。launch增加隔离注册口令入参，sample保留有标记的rolling事件及累计指标，避免metrics请求413。

## attempt2：split修复通过，导航发现两项缺陷后暂停

新产物READY后使用子目录 `attempt2`，保留首轮失败证据。157 DPR2原split链在点击第二Window导航后 **580ms** 两平面ready（硬上限10秒），atlas976×2192，ROI A(5,5 958×1083)/B(5,1099 958×1083)，两个video真实解码同尺寸并共享track；累计prepare13/readyACK10，无原flood，Sol亲自看过split截图。

新增通过：89普通start→首remote（helper实际坐标鼠标/键盘，同RTC）；157/89两个自有Tenant同时真实video（2/1平面）下WinHTTP管理socket断链恢复，两Tenant RTC/video/srcObject/track身份均不变，Browser各自PID7860/38176。157真实DC Unicode二进制逐字节 `[0,1,2,127,128,255,13,10]`、空文件、多文件 `[255,0,33]`、延迟读取及取消均由远端DOM报告确认，WS无浏览器/文件动作。fake-camera拍照产生3候选，选择一张后远端JPEG18363字节/FNV a1eeec24；这是模拟摄像头，非实体设备验证。文本插入、单行Enter/Backspace、textarea换行与删除和真实blur DOM报告正确。失焦跨Window wheel、nested wheel、root/nested scrollbar拖动分别观察真实scrollY/scrollTop变化。1100布局暂存ACK期间两plane均notready，远端input事件83→83；release后真实header pointerdown/up恢复，同RTC。

导航实际回调：正常navigate/back/forward/reload均最终committed；beforeunload取消停留C/rejected，接受后D/committed；受控慢HTTP被停止nav rejected(stopped)，stop操作committed，实际URL保持D；真实about:blank popup最终remote/adopted，未被start覆盖。POST reload仍不在支持范围，本组未测。

发现两项产品失败：首start导航未监听loopback33479后Browser已提交失败document及失败URL，Control仍kind=start，UI起始页遮蔽实际错误页（`chrome157-start-nav-failure`）；原remote导航失败URL/kind吻合并可继续导航。正常导航命令出现顶部 `Cannot read properties of undefined (reading 'workspace')`（`chrome157-ui-workspace-error`）。root已安排两项修复，故未在受Banner影响版本上继续验收。

末尾390×844截图内容可见且scrollWidth390，但默认video因`video-frame-metadata-timeout`回退canvas-2d：MSTP1/draw2/freezeCopies4；不能把窄屏默认video判通过。布局含先前失败start的远端view5与A，需新产物重测并判定是否另有问题。Sol实际看过 `chrome157-narrow-no-plane.png`。全部证据位于attempt2/metrics及PNG。

已按root要求在自然边界暂停，全部自有contexts及fixture/Endpoint/Browser/慢HTTP关闭，33471/33472/33478无监听，GPU明确释放，未动7816。不重跑已通过无关文件与管理断链组。剩余：修复后负例及无Banner复验；89多Window/resize/设置等完整UI；搜索四模板与持久化；真实音频PCM；IME跨文档；visualViewport键盘freeze单copy及结束；最终start/settings/narrow图；必要WS恢复、关闭beforeunload等。
