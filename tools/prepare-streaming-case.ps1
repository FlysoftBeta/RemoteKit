param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name,
  [int]$MarkerHz = -1,
  [ValidateSet('sync','worker')][string]$MarkerReadback = 'sync',
  [ValidateSet('after-work','before-work')][string]$CallbackRegistration = 'after-work',
  [string]$ServiceDirectory = 'build/endpoint-package/endpoint',
  [int]$Width = 1280,
  [int]$Height = 720,
  [int]$Tenants = 1,
  [switch]$DisableClientGpuVsync,
  [switch]$PreciseBrowserPoll,
  [switch]$VisibleVideoPreview,
  [ValidateSet(1,2,4)][int]$AsyncDepth = 1,
  [ValidateRange(1,7)][int]$TargetUsage = 4,
  [ValidateSet('cbr','vbr')][string]$RateControl = 'cbr',
  [ValidateRange(0.1,50)][decimal]$BitrateMbps = 18,
  [ValidateRange(0.1,60)][decimal]$MaxBitrateMbps = 40,
  [int]$BufferMs = 1000,
  [ValidateSet(0,24,48)][int]$DownlinkMbps = 0,
  [ValidateSet('animation','text','static','change-stop')][string]$FixtureMode = 'animation',
  [int]$InputIntervalMs = 0,
  [int]$IdleIdrMs = 150,
  [switch]$HonorClientTimerResolution,
  [int]$PlayoutDelayHintMs = -1,
  [string]$FixtureDirectory = 'control/dist/client',
  [switch]$CaptureQuality,
  [switch]$ResourceProfile,
  [switch]$ServerTrace,
  [switch]$DisableMediaTrace,
  [switch]$AtlasReadyGate,
  [switch]$SinglePlaneDirect,
  [ValidateSet(0,1,2,10)][int]$CaptureMaxPending=0,
  [switch]$OfficialTrace,
  [switch]$CopyOutputProfile,
  [switch]$OffscreenRoot,
  [string]$BrowserEnableFeatures='',
  [ValidateRange(0,60)][int]$CaptureRenderFps=0,
  [ValidateSet('auto','off')][string]$BrowserDirectComposition='auto',
  [ValidateSet('auto','1')][string]$BrowserHostScale='auto',
  [ValidateSet('offscreen','window')][string]$BrowserRenderHost='offscreen',
  [ValidateRange(0,60)][int]$BrowserRenderFps=0,
  [ValidateSet('off','on')][string]$AdaptiveFps='off',
  [ValidateSet('canvas','compositor')][string]$FixtureKind='canvas',
  [ValidateSet('snapshot','single-plane-direct')][string]$PresentationMode='snapshot',
  [ValidateSet('video','track-processor')][string]$FrameSource='video',
  [ValidateSet('latest1','fifo2')][string]$ProcessorScheduler='latest1',
  [switch]$ProcessorProfile,
  [switch]$DisableClientRafProbe,
  [ValidateSet('default','software','unlimited')][string]$ClientMode='default',
  [string]$ClientExecutablePath='C:/src/tmp/chrome89-google/app/chrome.exe',
  [ValidateSet(0,60,120)][int]$ClientRefreshHz=0,
  [ValidateSet('native','chrome89-h264-42','chrome89-h264-51','h264-level42-experimental')][string]$ReceiveProfile='chrome89-h264-42',
  [ValidateSet('','auto','on','off')][string]$QsvLowPower='',
  [string]$QsvLowPowerPattern='',
  [ValidateSet('external','async')][string]$QsvVpp='external',
  [ValidateSet('copy','shared')][string]$AtlasInput='copy',
  [ValidateSet(1,16)][int]$AtlasAlignment=1,
  [ValidateRange(-1,40950)][ValidateScript({$_ -eq -1 -or $_ % 10 -eq 0})][int]$RtcPlayoutMaxMs=-1
)
$ErrorActionPreference = 'Stop'
if($FrameSource -eq 'track-processor' -and $PresentationMode -ne 'snapshot'){throw 'track-processor requires snapshot presentation'}
if($BitrateMbps -gt $MaxBitrateMbps){throw 'BitrateMbps must not exceed MaxBitrateMbps'}
if($QsvLowPowerPattern -cnotmatch '^(?:(?:on|off)(?:,(?:on|off)){0,15})?$') {
  throw 'QsvLowPowerPattern requires 1..16 comma-separated on/off entries, or an empty string'
}
if($QsvLowPowerPattern -and $PSBoundParameters.ContainsKey('QsvLowPower')) {
  throw 'QsvLowPowerPattern cannot be combined with explicit QsvLowPower'
}
$QsvLowPower=$QsvLowPower.ToLowerInvariant()
$rkBitrateBps=[uint32][Math]::Round($BitrateMbps*1000000)
$rkMaxBitrateBps=[uint32][Math]::Round($MaxBitrateMbps*1000000)
if($ClientRefreshHz -ne 0 -and ($ClientMode -ne 'default' -or $DisableClientGpuVsync)) {
  throw 'ClientRefreshHz cannot be combined with software, unlimited, or DisableClientGpuVsync'
}
if(-not (Test-Path -LiteralPath $ClientExecutablePath -PathType Leaf)) {throw "Client executable does not exist: $ClientExecutablePath"}
$ClientExecutablePath=(Get-Item -LiteralPath $ClientExecutablePath).FullName
$BrowserDirectComposition=$BrowserDirectComposition.ToLowerInvariant()
$BrowserHostScale=$BrowserHostScale.ToLowerInvariant()
$BrowserRenderHost=$BrowserRenderHost.ToLowerInvariant()
$QsvVpp=$QsvVpp.ToLowerInvariant()
$AtlasInput=$AtlasInput.ToLowerInvariant()
if($AtlasInput -eq 'shared' -and ($QsvVpp -ne 'external' -or $AsyncDepth -ne 1)){throw 'AtlasInput shared requires QsvVpp external and AsyncDepth 1'}
if(-not $PSBoundParameters.ContainsKey('AtlasAlignment')){$AtlasAlignment=if($QsvVpp -eq 'async'){16}else{1}}
if($QsvVpp -eq 'async' -and $AtlasAlignment -ne 16){throw 'QsvVpp async requires AtlasAlignment 16'}
if($ServerTrace -and $DisableMediaTrace){throw 'ServerTrace also enables browser trace; use DisableMediaTrace without ServerTrace for the off baseline'}
if($CopyOutputProfile -and -not $OfficialTrace){throw 'CopyOutputProfile requires OfficialTrace to collect its opt-in events'}
$rkBrowserFeatures=@()
if($BrowserEnableFeatures){$rkBrowserFeatures+=$BrowserEnableFeatures}
if($CaptureMaxPending){$rkBrowserFeatures+="RemoteKitBoundedCapture:max_pending/$CaptureMaxPending"}
if($CopyOutputProfile){$rkBrowserFeatures+='RemoteKitCopyOutputProfile'}
if($OffscreenRoot){$rkBrowserFeatures+='RemoteKitOffscreenRoot'}
if($SinglePlaneDirect){$rkBrowserFeatures+='RemoteKitSinglePlaneDirect'}
if($CaptureRenderFps){$rkBrowserFeatures+="RemoteKitCaptureRenderRate:max_fps/$CaptureRenderFps"}
$rkBrowserFeaturesText=$rkBrowserFeatures -join ','
$rkRoot = Split-Path -Parent $PSScriptRoot
$caseRoot = Join-Path $rkRoot "develop/tmp/$Name"
if (Test-Path -LiteralPath $caseRoot) { throw "Use a new case name; existing measurements must be preserved: $caseRoot" }
$serviceRoot = (Resolve-Path -LiteralPath (Join-Path $rkRoot $ServiceDirectory)).Path
foreach ($directory in @('bin','metrics','browser-trace','source-trace','fixture')) {
  New-Item -ItemType Directory -Path (Join-Path $caseRoot $directory) -Force | Out-Null
}
foreach ($filename in @('test-pattern.html','marker-codec.js')) {
  $sourceFilename=if($filename -eq 'test-pattern.html' -and $FixtureKind -eq 'compositor'){'compositor-pattern.html'}else{$filename}
  Copy-Item -LiteralPath (Join-Path (Join-Path $rkRoot $FixtureDirectory) $sourceFilename) -Destination (Join-Path $caseRoot "fixture/$filename")
}
foreach ($filename in @('endpoint_service.exe','libvpl.dll')) {
  Copy-Item -LiteralPath (Join-Path $serviceRoot $filename) -Destination (Join-Path $caseRoot "bin/$filename")
}
$configuration = @{
  id=$Name; origin='http://127.0.0.1:3001'; fixtureOrigin='http://127.0.0.1:3013';
  tenants=$Tenants; width=$Width; height=$Height; dpr=1; mode=$FixtureMode;
  warmupMs=5000; sampleMs=20000; receiveProfile=$ReceiveProfile; callbackRegistration=$CallbackRegistration;
  requirePaint=$true; paintVersion='event-driven-v2'; visibleVideoPreview=[bool]$VisibleVideoPreview;
  inputIntervalMs=$InputIntervalMs;markerReadback=$MarkerReadback;
  honorClientTimerResolution=[bool]$HonorClientTimerResolution;
  timerPolicyTool=(Join-Path $rkRoot 'tools/probe-chrome-timer-policy.ps1'); timerPolicyOutput=(Join-Path $caseRoot 'timer-policy.json');
  captureQuality=[bool]$CaptureQuality; artifactToken=[guid]::NewGuid().ToString('N');
  resourceProfile=[bool]$ResourceProfile; observeClientRaf=(-not [bool]$DisableClientRafProbe);clientMode=$ClientMode;
  clientExecutablePath=$ClientExecutablePath;clientRefreshHz=$ClientRefreshHz;
  serverTrace=[bool]$ServerTrace;browserTrace=(-not [bool]$DisableMediaTrace);
  atlasReadyGate=[bool]$AtlasReadyGate;presentationMode=$PresentationMode;frameSource=$FrameSource;processorScheduler=$ProcessorScheduler;processorProfile=[bool]$ProcessorProfile;
  singlePlaneDirect=[bool]$SinglePlaneDirect;
  captureMaxPending=$CaptureMaxPending;captureRenderFps=$CaptureRenderFps;browserEnableFeatures=$rkBrowserFeaturesText;copyOutputProfile=[bool]$CopyOutputProfile;
  officialTrace=[bool]$OfficialTrace;fixtureKind=$FixtureKind;browserDirectComposition=$BrowserDirectComposition;browserHostScale=$BrowserHostScale;browserRenderHost=$BrowserRenderHost;browserRenderFps=$BrowserRenderFps;adaptiveFps=$AdaptiveFps;offscreenRoot=[bool]$OffscreenRoot;
  endpoint=@{build='Release';asyncDepth=$AsyncDepth;targetUsage=$TargetUsage;rateControl=$RateControl;qsvVpp=$QsvVpp;atlasInput=$AtlasInput;qsvLowPower=$QsvLowPower;qsvLowPowerPattern=$QsvLowPowerPattern;atlasAllocationAlignment=$AtlasAlignment;startBitrate=$rkBitrateBps;maxBitrate=$rkMaxBitrateBps;bufferMs=$BufferMs;idleIdrMs=$IdleIdrMs;rtcPlayoutDelayRequested=@{minMs=$(if($RtcPlayoutMaxMs -ge 0){0}else{-1});maxMs=$RtcPlayoutMaxMs}};
  network=@{enabled=$false;scope='same-machine unshaped cadence diagnostic'}
}
if ($DownlinkMbps) {
  $configuration.network = @{enabled=$true;oneWayDelayMs=5;downlinkMbps=$DownlinkMbps;uplinkMbps=1000;maxQueueBytes=300000;maxQueueDelayMs=100;scope='per-peer independent budget';aggregateDownlinkMbps=$Tenants*$DownlinkMbps}
}
if ($MarkerHz -ge 0) { $configuration.markerHz = $MarkerHz }
if ($PlayoutDelayHintMs -ge 0) { $configuration.playoutDelayHintMs = $PlayoutDelayHintMs }
if ($DisableClientGpuVsync) { $configuration.clientExtraFlags = @('--disable-gpu-vsync') }
if ($ClientMode -eq 'software') { $configuration.clientExtraFlags = @('--disable-gpu') }
if ($ClientMode -eq 'unlimited') { $configuration.clientExtraFlags = @('--disable-frame-rate-limit') }
if ($ClientRefreshHz -ne 0) { $configuration.clientExtraFlags = @("--fake-vsync-rate=$ClientRefreshHz") }
$configuration.endpoint.pollTimer = if ($PreciseBrowserPoll) { 'precise' } else { 'default' }
$configurationJson = ConvertTo-Json -InputObject $configuration -Depth 12 -Compress
$driver = [IO.File]::ReadAllText((Join-Path $rkRoot 'tools/streaming-benchmark.js'))
$driver = [regex]::Replace($driver, 'const config = /\* CONFIG \*/ .*?;', { 'const config = ' + $configurationJson + ';' })
[IO.File]::WriteAllText((Join-Path $caseRoot 'run.js'), $driver)
[IO.File]::WriteAllText((Join-Path $caseRoot 'config.json'), $configurationJson)
$fingerprints = @{}
$fingerprints[$ClientExecutablePath]=(Get-FileHash -LiteralPath $ClientExecutablePath -Algorithm SHA256).Hash
$clientChromeDll=Join-Path (Split-Path -Parent $ClientExecutablePath) 'chrome.dll'
if(Test-Path -LiteralPath $clientChromeDll -PathType Leaf){$fingerprints[$clientChromeDll]=(Get-FileHash -LiteralPath $clientChromeDll -Algorithm SHA256).Hash}
foreach ($relativePath in @('bin/endpoint_service.exe','bin/libvpl.dll')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $caseRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($relativePath in @('fixture/test-pattern.html','fixture/marker-codec.js')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $caseRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($relativePath in @('control/public/test-pattern.html','control/dist/server.mjs','tools/streaming-benchmark.js','tools/streaming-source-probe.mjs','tools/watch-streaming-resources.ps1','tools/windows-gpu-counters.cs','tools/streaming-endpoint-tee.mjs','tools/prepare-streaming-case.ps1')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $rkRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($relativePath in @('control/dist/client/marker-codec.js','control/dist/client/benchmark-marker-readback.js','control/dist/client/benchmark-marker-worker.js')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $rkRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($absolutePath in @('C:/src/chromium/src/out/dev/remotekit_browser.exe','C:/src/chromium/src/out/dev/remotekit_sdk.dll','C:/src/chromium/src/out/dev/components_viz_service.dll','C:/src/chromium/src/out/dev/content.dll')) {
  $fingerprints[$absolutePath] = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash
}
$fingerprints['patches/manifest.json']=(Get-FileHash -LiteralPath (Join-Path $rkRoot 'patches/manifest.json') -Algorithm SHA256).Hash
foreach ($asset in Get-ChildItem -LiteralPath (Join-Path $rkRoot 'control/dist/client/assets') -File) {
  $fingerprints['control/dist/client/assets/'+$asset.Name]=(Get-FileHash -LiteralPath $asset.FullName -Algorithm SHA256).Hash
}
$fingerprints | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseRoot 'fingerprints.json')
$env:REMOTEKIT_ENDPOINT = Join-Path $caseRoot 'bin/endpoint_service.exe'
$rkEndpointArguments = @(
  '--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe', "--data-path=$caseRoot/sessions", "--browser-direct-composition=$BrowserDirectComposition", "--browser-host-scale=$BrowserHostScale", "--browser-render-host=$BrowserRenderHost",
  "--browser-render-fps=$BrowserRenderFps",
  "--adaptive-fps=$AdaptiveFps",
  '--encoder=qsv','--fps=60',"--bitrate=$rkBitrateBps","--max-bitrate=$rkMaxBitrateBps",
  "--qsv-vpp=$QsvVpp", "--atlas-alignment=$AtlasAlignment",
  "--atlas-input=$AtlasInput",
  "--async-depth=$AsyncDepth", "--target-usage=$TargetUsage", "--buffer-ms=$BufferMs", "--rate-control=$RateControl", "--idle-idr-ms=$IdleIdrMs"
)
if($rkBrowserFeaturesText){
  $rkEndpointArguments+="--browser-enable-features=$rkBrowserFeaturesText"
}
if($OfficialTrace){$rkEndpointArguments+="--browser-trace-dir=$(Join-Path $caseRoot 'official-trace')"}
if($QsvLowPowerPattern){$rkEndpointArguments+="--qsv-low-power-pattern=$QsvLowPowerPattern"}
if ($QsvLowPower -or $RtcPlayoutMaxMs -ge 0) {
  $extraArgs=@()
  if($QsvLowPower){$configuration.endpoint.qsvLowPower=$QsvLowPower;$extraArgs+="--qsv-low-power=$QsvLowPower"}
  if($RtcPlayoutMaxMs -ge 0){$extraArgs+="--rtc-playout-max-ms=$RtcPlayoutMaxMs"}
  $rkEndpointArguments+=$extraArgs
  $configurationJson=ConvertTo-Json -InputObject $configuration -Depth 12 -Compress
  [IO.File]::WriteAllText((Join-Path $caseRoot 'config.json'),$configurationJson)
  $driver=[regex]::Replace($driver,'(?m)^  const config = .*?;$',{'  const config = '+$configurationJson+';'})
  [IO.File]::WriteAllText((Join-Path $caseRoot 'run.js'),$driver)
}
$env:REMOTEKIT_CONTROL_DB = Join-Path $caseRoot 'control.db'
$env:REMOTEKIT_METRICS_DIR = Join-Path $caseRoot 'metrics'
$env:REMOTEKIT_MEDIA_TRACE = if($DisableMediaTrace){$null}else{Join-Path $caseRoot 'browser-trace'}
$env:REMOTEKIT_SERVER_TRACE = if($ServerTrace){Join-Path $caseRoot 'server-trace'}else{$null}
$env:REMOTEKIT_ATLAS_READY_GATE = if($AtlasReadyGate){'1'}else{$null}
$env:REMOTEKIT_NETWORK_SIM = if ($DownlinkMbps) { ConvertTo-Json -Compress -InputObject @{oneWayDelayMs=5;downlinkMbps=$DownlinkMbps;uplinkMbps=1000;maxQueueBytes=300000;maxQueueDelayMs=100} } else { 'off' }
$env:REMOTEKIT_RTC_LOOPBACK_TEST = if ($DownlinkMbps) { '1' } else { '0' }
$env:REMOTEKIT_GPU_POLL = if ($PreciseBrowserPoll) { 'precise' } else { 'default' }
$env:REMOTEKIT_DIAGNOSTICS = '1'
$env:PORT = '3001'
$env:REMOTEKIT_ENDPOINT_ARGS=ConvertTo-Json -Compress -InputObject $rkEndpointArguments
[IO.File]::WriteAllText((Join-Path $caseRoot 'endpoint-args.json'),$env:REMOTEKIT_ENDPOINT_ARGS)
$nodeExe = (Get-Command node.exe).Source
if ($ResourceProfile) {
  $endpointArgs=$rkEndpointArguments
  $env:REMOTEKIT_ENDPOINT_ARGS=ConvertTo-Json -Compress -InputObject (@((Join-Path $rkRoot 'tools/streaming-endpoint-tee.mjs'),(Join-Path $caseRoot 'endpoint-responses.jsonl'),$env:REMOTEKIT_ENDPOINT)+@($endpointArgs))
  $env:REMOTEKIT_ENDPOINT=$nodeExe
}
$controlProcess = Start-Process -FilePath $nodeExe -ArgumentList 'dist/server.mjs' -WorkingDirectory (Join-Path $rkRoot 'control') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $caseRoot 'control.log') -RedirectStandardError (Join-Path $caseRoot 'control.err') -PassThru
$sourceArguments = '"' + (Join-Path $rkRoot 'tools/streaming-source-probe.mjs') + '" --output "' + (Join-Path $caseRoot 'source-trace') + '" --fixture-root "' + (Join-Path $caseRoot 'fixture') + '" --artifact-token ' + $configuration.artifactToken
$sourceProcess = Start-Process -FilePath $nodeExe -ArgumentList $sourceArguments -WorkingDirectory $rkRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $caseRoot 'source.log') -RedirectStandardError (Join-Path $caseRoot 'source.err') -PassThru
$casePids = @{control_pid=$controlProcess.Id;source_pid=$sourceProcess.Id}
if ($HonorClientTimerResolution) {
  $watchArguments = '-NoProfile -NonInteractive -File "' + (Join-Path $rkRoot 'tools/watch-chrome-timer-policy.ps1') + '" -Name ' + $Name
  $watcher = Start-Process -FilePath 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -ArgumentList $watchArguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $caseRoot 'timer-watch.log') -RedirectStandardError (Join-Path $caseRoot 'timer-watch.err') -PassThru
  $casePids.timer_policy_pid = $watcher.Id
}
$casePids | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseRoot 'pids.json')
if ($ResourceProfile) {
  $resourceArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $rkRoot 'tools/watch-streaming-resources.ps1')+'" -Name '+$Name+' -DurationSeconds 300'
  $resourceProcess=Start-Process -FilePath 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -ArgumentList $resourceArguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $caseRoot 'resource.log') -RedirectStandardError (Join-Path $caseRoot 'resource.err') -PassThru
  $casePids.resource_pid=$resourceProcess.Id
  $casePids|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $caseRoot 'pids.json')
}
Write-Output (Join-Path $caseRoot 'run.js')
