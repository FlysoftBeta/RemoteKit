# Chromium API 源码调查

调查日期：2026-10-31。唯一 Chromium 来源为 `C:/src/chromium/src`。初次调查为 rb；因用户随后要求官方 Release 基线，最终复核为官方 tag `157.0.8103.15`、HEAD `1aa07b638799e59656559ae6c6649d4b197f555e`，当前分支 `remotekit`。切换由主任务完成；本调查未修改、checkout、构建或清理 Chromium。未读取、扫描或引用 `C:/Users/Flysoft/Desktop/remotekit`。以下以官方 tag 为准；部分行号用于定位附近声明。此文是事实与可选依赖调查，不作架构决定。

## 1. 独立 content embedder 的 Windows 启动面

最接近的现有示例为 `content/shell/app/shell_main.cc:30`。Windows 入口顺序是 PinUser32 / AllowDarkModeForApp、`base::CommandLine::Init(0, nullptr)`、初始化 sandbox info、构造进程共用 ContentMainDelegate、填写 ContentMainParams、调用 ContentMain。浏览器、renderer、GPU、utility 子进程都需要走这一入口，不能仅为主浏览器实现 WinMain。

实际签名：

```cpp
// content/public/app/content_main.h:38,108
explicit ContentMainParams(ContentMainDelegate* delegate);
int ContentMain(ContentMainParams params);
// Windows fields:
HINSTANCE instance;
raw_ptr<sandbox::SandboxInterfaceInfo> sandbox_info;

// content/public/app/sandbox_helper_win.h:29
void InitializeSandboxInfo(sandbox::SandboxInterfaceInfo* sandbox_info,
                          sandbox::MitigationFlags starting_mitigations = 0);

// content/public/app/content_main_delegate.h
virtual std::optional<int> BasicStartupComplete();
virtual void PreSandboxStartup();
virtual std::variant<int, MainFunctionParams> RunProcess(
    const std::string& process_type, MainFunctionParams main_function_params);
virtual ContentClient* CreateContentClient();
virtual ContentBrowserClient* CreateContentBrowserClient();
virtual ContentRendererClient* CreateContentRendererClient();
virtual ContentGpuClient* CreateContentGpuClient();
virtual ContentUtilityClient* CreateContentUtilityClient();

// content/public/browser/content_browser_client.h:363
virtual std::unique_ptr<BrowserMainParts> CreateBrowserMainParts(
    bool is_integration_test);
```

`InitializeSandboxInfo` 的头文件明确要求调用者位于 EXE 并静态链接 sandbox；从 DLL 导出调用不会正确工作。`ContentMainParams::minimal_browser_mode` 是跳过大量子系统的模式，不等于可正常导航的最小浏览器。

主循环参考 `content/shell/browser/shell_browser_main_parts.cc:185`：在 `PreMainMessageLoopRun()` 创建 BrowserContext、初始化窗口宿主、创建 WebContents；`WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>&)` 可取得退出闭包；`PostMainMessageLoopRun()` 销毁 context。`BrowserMainLoop::InitializeToolkit()`（`content/browser/browser_main_loop.cc:1568`）在 USE_AURA 下已经建立 `aura::Env`，embedder 不应再建立第二份。

独立实现可从公共 GN 面依赖 `//content/public/app`、`//content/public/browser`、`//content/public/renderer`、`//content/public/common`、按需 `//content/public/gpu` / `//content/public/utility`、`//base` 与 UI 资源/宿主 targets。`content/public/app/BUILD.gn` 与 `content/public/browser/BUILD.gn` 会按 component 模式转到 `//content`；不要直接链接受限 `:browser_sources`。

注意：`//content/shell:content_shell_app`、`:content_shell_lib` 均为 `testonly = true`（`content/shell/BUILD.gn:85,177`），且 Windows 包含 web-test、test Views delegate 等依赖。它们适合作为源码参考，不能直接当生产 SDK 链接目标。shell 还在 `PreSandboxStartup()` 初始化 `content_shell.pak`（`shell_main_delegate.cc:382`），独立 embedder 需要自己的资源及运行时文件部署，不是只有 exe 链接成功即可运行。应保持 ContentMainDelegate 默认 FeatureList/Mojo 初始化语义；shell 覆盖这两个时机是因为自身在 PostEarlyInitialization 补做，不能只复制其返回 false。

## 2. BrowserContext 最小抽象面与寿命

`content/public/browser/browser_context.h:389` 起，当前纯虚函数共 16 项：

```cpp
std::unique_ptr<ZoomLevelDelegate> CreateZoomLevelDelegate(
    const base::FilePath& partition_path);
base::FilePath GetPath() const;
bool IsOffTheRecord();
DownloadManagerDelegate* GetDownloadManagerDelegate();
BrowserPluginGuestManager* GetGuestManager();
storage::SpecialStoragePolicy* GetSpecialStoragePolicy();
PlatformNotificationService* GetPlatformNotificationService();
PushMessagingService* GetPushMessagingService();
StorageNotificationService* GetStorageNotificationService();
SSLHostStateDelegate* GetSSLHostStateDelegate();
PermissionControllerDelegate* GetPermissionControllerDelegate();
ReduceAcceptLanguageControllerDelegate* GetReduceAcceptLanguageControllerDelegate();
ClientHintsControllerDelegate* GetClientHintsControllerDelegate();
BackgroundFetchDelegate* GetBackgroundFetchDelegate();
BackgroundSyncController* GetBackgroundSyncController();
BrowsingDataRemoverDelegate* GetBrowsingDataRemoverDelegate();
```

上述均为 virtual，声明处带 `= 0`。`GetContentIndexProvider()` 与 `GetOriginTrialsControllerDelegate()` 等不是纯虚项。可空返回值必须遵循各项头文件注释；shell 的空返回不是所有产品功能均可忽略的保证。path、持久/隐私模式、权限与 CH cache 均需实际语义。

示例 `content/shell/browser/shell_browser_context.h:33`：`ShellBrowserContext(bool off_the_record, bool delay_services_creation = false)`。其 ctor/dtor 不只是填虚函数：建立 SimpleFactoryKey/关联，销毁时 `NotifyWillBeDestroyed()`、依赖管理器两阶段 shutdown、解除 key 映射、`ShutdownStoragePartitions()`（`.cc:55` 起）。不采用那些 keyed services 的 embedder 不必照搬 shell 的依赖管理器，但必须满足 BrowserContext 和 WebContents 的寿命协议：先销毁 WebContents，再启动 context destruction，在线程仍可运行时关闭 storage partitions（公共头 `.h:306,337,401`）。DownloadManagerDelegate 的头文件注释特别要求其寿命覆盖 DownloadManager，不能机械地当普通 subclass 成员提前释放。

## 3. WebContents 原生宿主与 Aura 的实际边界

公共创建面：`content/public/browser/web_contents.h:211,409`：

```cpp
explicit WebContents::CreateParams(
    BrowserContext* context,
    base::Location creator_location = base::Location::Current());
static std::unique_ptr<WebContents> WebContents::Create(const CreateParams& params);
// CreateParams::context (line 273) is gfx::NativeView, not HWND.
virtual gfx::NativeView GetNativeView() = 0;
virtual void SetDelegate(WebContentsDelegate* delegate) = 0;
virtual void WasShown() = 0;
```

导航参考 `content/shell/browser/shell.cc:224` 的 `CreateNewWindow` 与 `NavigationController::LoadURLWithParams`。WebContents 本身不创建完整桌面窗口、地址栏、权限弹窗或退出策略。

当前 Windows 默认为 Aura：`build/config/ui.gni:27` 的 `use_aura = is_win || ...`；`ui/gfx/native_ui_types.h:122` 下 `NativeView`、`NativeWindow` 都是 `aura::Window*`；Windows `gfx::AcceleratedWidget` 才是 HWND。不能对 `GetNativeView()` 做 HWND reinterpret_cast。

**临时 Aura bootstrap 可不使用 Views。** `content/shell/browser/shell_platform_data_aura.cc:79` 提供顺序参考：已有 Env → 配置 Screen → `aura::WindowTreeHost::Create(ui::PlatformWindowInitProperties)` → `InitHost()` → 显示 root → 安装 layout/focus/activation/capture/window-parenting/cursor clients。`shell_platform_delegate_aura.cc:60` 将 `web_contents->GetNativeView()` AddChild 到 root 并 Show；resize 走 RenderWidgetHostView::SetSize。该示例的 focus/parenting 是 `aura::test::*`，不能不加选择带入生产；Windows 的 Screen 也不能忽略：shell 默认 Views 分支用 `views::CreateDesktopScreen()`（`shell_platform_delegate_views.cc:343`）。这只是可跑通的 UI 初始化参考，不是完整输入/IME/拖拽/弹窗/可访问性实现。

原生链路已确认：`ui/aura/window_tree_host_platform.cc:59` 的 Create 返回 WindowTreeHostPlatform；其 `CreatePlatformWindow`（`:232`）Windows 分支使用 `ui::WinWindow(this, properties.bounds)`，随后 SetInputMethod。`ui/platform_window/win/win_window.cc:52` 使用 WS_OVERLAPPEDWINDOW 和 `gfx::WindowImpl::Init(NULL, bounds)`。**该分支忽略 PlatformWindowInitProperties::parent_widget，不能仅填 parent_widget 就得到嵌入已有 HWND 的 child host。** `WindowTreeHost::GetAcceleratedWidget()` 可取得宿主 HWND，但窗口拥有、父子关系、样式、DPI 与事件语义需要明确实现。

**最终彻底无 Aura view 不是公共 API 开关。** 源码证据：

- `content/browser/web_contents/web_contents_impl.cc:4552` 固定取 `GetWebContentsViewDelegate(this)`，再调用平台 `CreateWebContentsView(...)`。
- `content/browser/web_contents/web_contents_view.h:137` 内部工厂签名为 `std::unique_ptr<WebContentsView> CreateWebContentsView(WebContentsImpl*, std::unique_ptr<WebContentsViewDelegate>, raw_ptr<RenderViewHostDelegateView>*)`；Aura 实现在 `web_contents_view_aura.cc:97`。
- `ContentBrowserClient::GetWebContentsViewDelegate(WebContents*)`（公共头 `:404`）只提供 delegate，不能替换 WebContentsView 或 RenderWidgetHostView。
- `content/browser/BUILD.gn:3514` 按 use_aura 包含 Aura host/view/compositor；关闭 Aura 时只删除相关文件，没有 Windows 原生 WebContentsView 替代实现。
- `native_ui_types.h` 去掉 USE_AURA 后也没有 Windows NativeView 定义分支，会落到 `#error Unknown build environment`。

因此“无 Views 仍使用 Aura”与“完全无 Aura WebContentsView/RenderWidgetHostView”是不同工作量。后者若成立需 Chromium 内部平台实现/工厂、类型面与构建分支配套，再覆盖合成、输入、焦点、IME、popup、drag/drop、accessibility、DPI 与生命周期；不能以当前公共 embedder delegate 声称已支持。本调查不选择最终方案。

## 4. Mojo C API、初始化与 standalone 静态 SDK

现有 public target：`//mojo/public/c/system:system`（默认 `//mojo/public/c/system`，`mojo/public/c/system/BUILD.gn:5`），output_name `mojo_public_system`；它仅编译 thunks.cc，依赖 base，与 `:headers` 分开。实现目标为 `//mojo/core/embedder:embedder`，output_name `mojo_core_embedder`（`mojo/core/embedder/BUILD.gn:5`）；继续依赖 `//mojo/core:embedder_internal` / `:impl_for_embedder`、base、ipcz、platform、crypto 等，后两项有 visibility 限制。不能仅分发 mojo_public_system.lib 就得到完整 runtime。

`mojo/public/c/system/thunks.h` 明确规定 forward-compatible C ABI，pack 8，字段不可重排；当前主要表为 `MojoSystemThunks2`，另有 `MojoSystemThunks32`。导出签名（`:456`）：

```cpp
extern "C" {
const struct MojoSystemThunks2* MojoEmbedderGetSystemThunks2();
const MojoSystemThunks32* MojoEmbedderGetSystemThunks32();
void MojoEmbedderSetSystemThunks(const struct MojoSystemThunks2* system_thunks);
}
// Public C calls: message_pipe.h/data_pipe.h/buffer.h/trap.h/invitation.h etc.
```

**本版本 `MojoInitialize(const MojoInitializeOptions*)` 直接返回 MOJO_RESULT_UNIMPLEMENTED**（`thunks.cc:53`）。真实 embedder 初始化是 `mojo/core/embedder/embedder.h:29` 的 `void mojo::core::Init(const Configuration&)` / `void Init()`；`.cc:71` 创建 ipcz node 并 `MojoEmbedderSetSystemThunks(GetMojoIpczImpl())`。未安装 thunks 调普通 C API 会 fatal。跨进程要提供 IO task runner 和 `mojo::core::ScopedIPCSupport(scoped_refptr<base::SingleThreadTaskRunner>, ShutdownPolicy)`，并建立 platform channel / invitation；当前 header 明言 CLEAN/FAST policy 对已移除的 legacy Mojo 才有影响，不能复述旧版本的阻塞语义。

`//mojo/public/cpp/platform` 提供平台通道，`//mojo/public/cpp/system` 提供 C++ RAII/invitation wrapper；业务若仅暴露 C ABI 仍可在内部复用 C++ bootstrap。`ContentMain` 正常已初始化 Mojo 的进程不能再次调用 Init 建第二套核心。另一个 independently linked DLL/SDK 的 thunks 全局单例需明确归属，否则会有多份 handle universe。

静态导出约束：`component()` 的展开由 `build/config/BUILDCONFIG.gn:846` 决定，component build 是 DLL，非 component 可为 source_set 或 static_library；`is_component_build=false` 不会自动得到一个包含所有依赖的 SDK 单库。当前上述 GN 文件没有“standalone complete Mojo SDK”聚合 target。可选技术路径是基于公共 targets 增设 complete_static_lib 聚合及 C bootstrap shim，再检查实际归档闭包、Windows system libs、CRT/clang ABI/allocator与 generated headers；这属于后续实现，未在本次证明构建通过。`system_export.h` 依据 COMPONENT_BUILD / MOJO_SYSTEM_IMPLEMENTATION 决定 dllimport/export，消费方宏必须与构建产物匹配。

## 5. libwebrtc 当前静态归档目标

`third_party/webrtc/BUILD.gn:539`：完整 `rtc_static_library("webrtc")` **仅在 `!build_with_chromium` 定义**；`complete_static_lib=true`，抑制 thin_archive，visibility 限制到 WebRTC 根 `//:default` 与 `//:webrtc_lib_link_test`。在普通 Chromium GN 图中不能直接引用 `//third_party/webrtc:webrtc`。`api:create_peerconnection_factory` 也仅在 `!build_with_chromium` 下存在（`api/BUILD.gn:81`）。

当前 Chromium 可用的细分面包括 `//third_party/webrtc/api:create_modular_peer_connection_factory`（`:63`，visibility `*`）、`//third_party/webrtc/pc:peer_connection_factory`（`:1636`）、`:rtc_pc`（`:852`，source_set）、`:webrtc_sdp`（`:1558`），以及按需 api/audio_codecs、video_codecs、task_queue、transport targets。是否允许特定依赖须逐 target 校验 visibility 和 poison 约束。可优先从公开 modular factory 调用面进入，而非直接绕过 pc 内部 visibility。

`rtc_static_library` 模板固定 static_library（`webrtc.gni:719`）；常见 `rtc_library` 在 component/test/header-only 下展开 source_set，否则为 static_library（`:826`）。所以“现有细分 target 有 .lib”不等于它已完整收集全部传递依赖。`//third_party/webrtc:dcsctp` 是另一个 complete_static_lib（根 BUILD `:991`），仅覆盖 SCTP，不能充当 WebRTC SDK。

独立 WebRTC 构建和 Chromium 内聚合是两个待评估选项；不要在 Chromium 主构建随意切 build_with_chromium=false。源码在 true 时会选用 Chromium overrides（例如 api/location）、重写 Abseil deps 到 `//third_party/abseil-cpp:absl`（webrtc.gni），还改变 metrics/system-time/audio-device 默认值；跨构建直接混用库与头存在配置/ABI/符号重复问题。本调查未运行 GN，也未宣称某个新归档已可链接。

## 6. Chrome UA / Client Hints 可复用面

`//components/embedder_support:user_agent` 是现成 static_library（`components/embedder_support/BUILD.gn:56`）。公共头 `user_agent_utils.h:24`：

```cpp
std::string embedder_support::GetProductAndVersion();
std::optional<std::string> embedder_support::GetUserAgentFromCommandLine();
std::string embedder_support::GetUserAgent();
blink::UserAgentMetadata embedder_support::GetUserAgentMetadata(
    bool only_low_entropy_ch = false);
```

Chrome 自己的 `ChromeContentBrowserClient::GetUserAgent()` / `GetUserAgentMetadata()` 就直接委托这两个函数（`chrome/browser/chrome_content_browser_client.cc:7967`）。独立 ContentBrowserClient 可复用该组件并覆盖对应 virtual（公共头 `:2533,2536`）；网络侧还需 `ConfigureNetworkContextParams(BrowserContext*, bool in_memory, const base::FilePath&, network::mojom::NetworkContextParams*, cert_verifier::mojom::CertVerifierCreationParams*)`（`:2195`）设置 user_agent、accept_language 等。shell 示例在 `shell_content_browser_client.cc:866`。

官方 `user_agent_utils.cc:151` 的 brand list 按 `CHROMIUM_BRANDING` 决定是否加入品牌项；Chromium branding 下不能假定总有 Google Chrome brand。官方基线不存在 rb 的远程模式分支。复用同一函数有助于避免 UA 字符串与 major/full-version GREASE、平台 metadata 不一致，但不能只修改 UA header 就声称 CH 已完整接通。

Accept-CH cache / JavaScript 许可等由 `BrowserContext::GetClientHintsControllerDelegate()` 处理。较轻现有实现为 `//components/client_hints/browser:in_memory`，头 `in_memory_client_hints_controller_delegate.h:40`：

```cpp
InMemoryClientHintsControllerDelegate(
    network::NetworkQualityTracker* network_quality_tracker,
    base::RepeatingCallback<bool(const GURL&)> is_javascript_allowed_callback,
    blink::UserAgentMetadata user_agent_metadata);
```

它不依赖 ContentSettings 存 Accept-CH，寿命随 delegate。持久版本 `//components/client_hints/browser` 的 ClientHints 依赖 keyed service 与 content settings。BrowserClient metadata、NetworkContext UA、CH delegate 的 metadata 应来自同一配置。具体持久化策略留待架构决定。

## 7. window.chrome bindings 入口

content 提供“建立对象”的公共工具，而不是完整 Chrome 扩展体系：`content/public/renderer/chrome_object_extensions_utils.h:26`：

```cpp
v8::Local<v8::Object> content::GetOrCreateChromeObject(
    v8::Isolate* isolate, v8::Local<v8::Context> context);
```

官方 `chrome/renderer/loadtimes_bindings.h:51` 是 `static void LoadTimesBindings::Install(v8::Local<v8::Context> context)`；实现 `.cc:128` 用 gin/cppgc wrapper，经 GetOrCreateChromeObject 安装 chrome.loadTimes 与 chrome.csi。不是旧版 V8 extension 字符串注册入口。`ChromeRenderFrameObserver::DidCreateScriptContext(v8::Local<v8::Context>, int32_t world_id)`（`chrome_render_frame_observer.cc:413`）调用 BenchmarkingBindings::InstallConditionally 和 LoadTimesBindings::Install；DidClearWindowObject 主要负责其他特定页面 bindings。Chrome renderer 对 extension service worker 的安装另在 `chrome_content_renderer_client.cc:1591`。

## 8. 官方 Chromium 图内 SDK 聚合 target 候选

以下为可落到新 `//remotekit/sdk/BUILD.gn` 的 target 形状，仅作实施候选，未实际写入 Chromium 或运行 GN。SDK 包装实现也需另外编写，不能将 sources 注释误当成已有文件。

```gn
assert(!is_component_build, "Distribution SDK requires static dependencies")

static_library("mojo_sdk") {
  complete_static_lib = true
  output_name = "remotekit_mojo_sdk"
  # sources = [ "mojo_sdk_c_bootstrap.cc" ]  # 后续C ABI初始化/邀请包装
  deps = [
    "//mojo/core/embedder",
    "//mojo/public/c/system",
    "//mojo/public/cpp/platform",
    "//mojo/public/cpp/system",
  ]
}

static_library("webrtc_sdk") {
  complete_static_lib = true
  output_name = "remotekit_webrtc_sdk"
  # sources = [ "webrtc_sdk_c_api.cc" ]  # 后续跨CMake/编译器ABI包装
  deps = [
    "//third_party/webrtc/api:create_modular_peer_connection_factory",
    "//third_party/webrtc/api:enable_media",
    "//third_party/webrtc/api/environment:environment_factory",
    "//third_party/webrtc/api/audio_codecs:builtin_audio_decoder_factory",
    "//third_party/webrtc/api/audio_codecs:builtin_audio_encoder_factory",
    "//third_party/webrtc/api/video_codecs:builtin_video_decoder_factory",
    "//third_party/webrtc/api/video_codecs:builtin_video_encoder_factory",
  ]
}
```

这些 WebRTC 入口在各 BUILD.gn 看起来声明 `visibility=["*"]`，但 **rtc_library 模板在 build_with_chromium 下会将此重写为 webrtc_default_visibility**（`webrtc.gni:903`），所以外部 `//remotekit` 不能据此直接依赖。实际实现的最小 timeutils SDK 已需要窄化开放 visibility 的 patch（`patches/sdk-visibility.patch`）；上述宽SDK候选必须类似处理或通过合适的公开入口。后续按所需 codec/audio-device/environment/logging 收缩或补充，不能把全套默认codecs等同于产品要求。普通 GN static_library 包装不使用 rtc_library 模板，因此不会自动带 rtc_common_inherited_config；包装若含 WebRTC C++ 头，必须由 GN 实际校验缺失的 defines/include_dirs/configs，并以 `gn desc ... configs --blame` / 最终 compiler command 核实。

`gn help complete_static_lib` 已在本机确认：普通静态依赖与 source_set 会并入，另一个 complete_static_lib 永不并入。候选依赖没有直接使用根 `:dcsctp`，但应审计实际传递图是否还留有 complete archive / shared library；不要仅看根 target 输出名认定自足。可用 `gn desc <out> //remotekit/sdk:webrtc_sdk deps --all`、`gn desc <out> <label> complete_static_lib` 逐项核实。

另一个重要约束是两个 complete SDK 都可能收进 base/Abseil/crypto 的共同对象。它们分别可构建，不代表在同一个终端 EXE 同时链接一定没有对象重复或全局状态分裂。可以评估单个 combined SDK，或明确交付共享依赖库集合；最终需要一个真实 CMake consumer 链接并完成 Mojo invitation 和 WebRTC factory 的运行验证。

Windows 默认 `use_custom_libcxx=true`（`build/config/c++/c++.gni:17`），因此 CMake 若直接用 MSVC STL 消费 WebRTC C++ 接口，会跨标准库 ABI；仅使用同一CPU/DebugRelease并不充分。可选 C ABI shim 隔开所有 std/Abseil/WebRTC 类型和分配释放职责，或让终端完全匹配 Chromium clang/libc++、CRT、编译宏与 generated headers。系统库与 linker options 也不装进 .lib，SDK manifest/CMake imported target 应由实际 final link 命令导出，不能手列几项后声称完整。

独立 renderer 的可扩展点为 `ContentRendererClient::RenderFrameCreated` 建立自己的 RenderFrameObserver，再在 DidCreateScriptContext 按世界与页面语义安装 bindings。只调用 GetOrCreateChromeObject 只会得到空对象，chrome.runtime / chrome.app 等来自 extensions dispatcher/API provider，不能由 loadTimes 安装替代。LoadTimesBindings 当前编在庞大 `//chrome/renderer:renderer` static_library（BUILD `:62,85`）内，没有独立小 target；直接链接整个 Chrome renderer 会带入 Chrome/Extensions 依赖，若要复用需明确拆分依赖并保留 gin wrapper 信息与 cppgc 兼容，不能视为已有稳定 SDK。

## 验证范围

API 调查通过逐文件读取与 rg 交叉定位核实 API、条件编译和 GN 声明。文内第 8 节的宽静态聚合/非 Aura 实现仍为尚待评估的工作，不是已经验证可构建的方案。

主任务随后授权实现窄 C ABI DLL bootstrap：`//remotekit/browser/sdk:remotekit_sdk` 已在官方 tag 的 out/dev x64 component 模式实际编译链接成功。新增 patch 仅开放 timeutils 给该 SDK；其余代码在 overlay。DLL 依赖 base、Mojo core/embedder、Mojo C++ system、WebRTC timeutils（含 Chromium system_time override），没有引入媒体或编码器。独立 MSVC 19.51 + CMake/Ninja 消费导出头及 import lib，测试验证 Mojo 双向二进制/空 payload、参数错误、WebRTC clock 符号调用、terminal shutdown；CTest 1/1 passed。产物 `sdk/dist/dev`、日志 `develop/tmp/sdk-build-retry.log` / `sdk-smoke.log`。该验证不代表完整 libwebrtc SDK、跨进程 Mojo 或最终浏览器宿主已完成。
