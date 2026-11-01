# 2026-11-01 配套构建与Chromium接收端增量刷新

本轮在主 Agent 分配的唯一CPU构建窗口内执行，GPU实验暂停；没有运行浏览器、clean输出或新建out目录。正式入口直接使用仓库工具与Chromium GN/autoninja，临时日志不是构建输入。

## 服务端配套

先运行 `tools/chromium.py stage`，再一次 `tools/chromium.py build --target remotekit_browser --target remotekit_browser_demo --target remotekit_sdk`。复用out/dev，实际执行4步，15.37秒：gpu_atlas两份对象和browser/demo两份exe链接。SDK目标已是最新。`tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev`成功，导出的SDK DLL与out/dev SHA256一致；没有ABI变化或endpoint编译。

| 产物 | SHA256 |
| --- | --- |
| out/dev/remotekit_browser.exe | `7ad9d280b570eaf9b2c439c64550cb230ae3083940de0878917600512a2bc168` |
| out/dev/remotekit_browser_demo.exe | `1d3f21514dac976053c10138066ec26706449f053c91bf97d30db1f910f6db52` |
| out/dev/remotekit_sdk.dll 与 sdk/dist/dev/bin/remotekit_sdk.dll | `91433dd933a89557108b590093bac751e6d583bc66775d569fbfe4d074b19922` |

## 接收端配置与计划

out/rel/args.gn备份到 `develop/tmp/receiver-incremental-build/args.before-20261101-155326.gn`。保留is_debug/component/official/dcheck/symbol/compiler/H264参数，移除旧项目注释及enable_widevine、enable_library_cdms、bundle_widevine_cdm、enable_cdm_host_verification四条显式覆盖，采用官方默认。没有修改tracked Chromium文件。

在源码根执行 `gn gen out/rel`，36,516个GN targets、5,088文件、13.844秒。第一次从仓库根调用未传--root，GN报找不到源码根；未产生配置输出，立即修正cwd后成功。

`autoninja -C out/rel -n chrome`只预览，11.19秒、235步（202 CXX、7链接、26 Python action），skip97,498。随后 `autoninja -C out/rel chrome -j 16`使用全部16逻辑CPU。生成header变动导致Siso动态重新评估依赖，初始pending短暂超过20k，再随restat/skip下降；不是全树重编。

旧PRTS来源已由Siso explain闭合：branding生成header比恢复后的官方BRANDING输入旧；chrome字符串输入、旧tracked源码恢复及CDM buildflags也有dirty项。构建已自然重生成PRODUCT_NAME与PRODUCT_FULLNAME为Chromium，没有手改gen文件。

`LAST_CHANGE`仍全0是非official构建的官方默认行为：`build/util/lastchange.gni`定义 `use_dummy_lastchange=!is_official_build`，版本action读取LASTCHANGE.dummy。不能把它误判为残留PRTS或为填HEAD改变整个编译模式；实际源码HEAD由独立git/build记录报告。

## 接收端构建结果

成功，exit0。Siso报告12m28.58秒、1,215步；外层计时749.694秒，2026-11-01 15:54:21–16:06:50（UTC+8）。实际702个CXX、21次链接、126次静态库、355个action完成，skip96,518；保留全部既有out/rel增量对象。最终chrome.dll链接17.31秒、initialexe链接0.46秒，然后reorder_imports完成。没有全量或clean。

新chrome.exe、chrome.dll、chrome_elf.dll的FileVersion/ProductVersion均为157.0.8103.15，ProductName均Chromium。生成版本header产品名也均Chromium。LAST_CHANGE按上述官方非official默认仍dummy；源码HEAD保持 `1aa07b638799e59656559ae6c6649d4b197f555e`，已有RemoteKit patchset保持原状，本轮没有新增tracked Chromium修改。

| rel产物 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| chrome.exe | 3,100,672 | `f833f59831e7d428e1527bf1e12c0d4a2b338a0cbd4239a050f280c1c62ea62a` |
| chrome.dll | 340,848,640 | `d26882e6555c6a970a79de3f91b7dcd003f5681976ee0a168e8a061396026f1f` |
| chrome_elf.dll | 1,591,296 | `c7d725e630b4f85fd20752412c97001949b58359a3ff06599a6e54534aa28d8d` |

完整日志与机器可读产物：`develop/tmp/receiver-incremental-build/chrome-plan.log`、`chrome-build.log`、`build-timing.json`、`artifacts.json`。未启动浏览器或运行GPU；CPU/GPU资源已交还主 Agent，下一步由runtime在新binary上验证publication与synthetic60真实串流/marker。

## 0005精准模拟刷新后续增量

主 Agent审阅接受0005（SHA256 `9215c41dddf06248a5b743a57c7c7777e0b2f18b9a09c4981d7a05a85002239a`）后，独占CPU窗口再次执行 `autoninja -C out/rel chrome -j 16`，没有gen、改args或clean。56步/43.77秒成功，skip97,677，外层44.932秒，16:34:47–16:35:31（UTC+8）。chrome.dll链接14.62秒。

最新chrome.dll大小340,850,688字节，SHA256 `a0f2e596eb42fed41ccc69faa53a97db195e5ed971d04862cee8f3002cbe6637`；chrome.exe壳未变，hash仍为 `f833f59831e7d428e1527bf1e12c0d4a2b338a0cbd4239a050f280c1c62ea62a`。两者产品名Chromium、版本157.0.8103.15。out/dev及SDK未动，patchset status五项applied；没有GPU/浏览器运行，资源已交还主 Agent。

记录：`develop/tmp/receiver-incremental-build/synthetic-deadline-build.log`、`synthetic-deadline-timing.json`、`synthetic-deadline-artifacts.json`。

## 配对高精度timer请求修正版

0005当前hash为 `f90452cb86b58970f4162a1eb8c350f99f0d33f28c45b1992c3a099f8e345ebd`，恢复整个fake等待期间与旧Sleep路径相同的成对高精度timer请求，避免把进程timer语义变化混入cadence优化。独占CPU窗口 `autoninja -C out/rel chrome -j 16` 成功：48步/33.56秒，skip97,685；外层34.711秒，16:51:03–16:51:38（UTC+8）。没有gen、clean、改args或out/dev/SDK变化。

当前chrome.dll SHA256 `5809b86306592699ceb34aa75546411c77782550cd8800b75eca153ab1dc3332`，chrome.exe仍 `f833f59831e7d428e1527bf1e12c0d4a2b338a0cbd4239a050f280c1c62ea62a`。patchset五项applied；没有GPU/浏览器运行，不预称性能改善。资源已交还主 Agent，后续单变量运行验证。

记录：`develop/tmp/receiver-incremental-build/synthetic-paired-timer-build.log`、`synthetic-paired-timer-timing.json`、`synthetic-paired-timer-artifacts.json`。

## 0006 rVFC候选增量

主 Agent审阅接受默认关闭的0006后，独占CPU窗口 `autoninja -C out/rel chrome -j 16` 成功：48步/45.46秒，skip97,685；外层46.571秒，16:57:21–16:58:07（UTC+8）。无需编译修正；0006 hash仍 `3b3630da6e53ed8d5d852e3a0ea7b9235c08f00baba009d0cd262184fe6261d7`，0005保持f90452，patchset六项applied。

当前chrome.dll SHA256 `20c0f298d2012b6841ba8acb7af7f62dc6df23a40f899073c9d74dd0fc034fcc`，chrome.exe仍 `f833f59831e7d428e1527bf1e12c0d4a2b338a0cbd4239a050f280c1c62ea62a`。没有gen、clean、改args或out/dev变化；未运行浏览器/GPU，资源交还后由runtime使用同binary进行feature off/on配对。

记录：`develop/tmp/receiver-incremental-build/rvfc-cadence-build.log`、`rvfc-cadence-timing.json`、`rvfc-cadence-artifacts.json`。
