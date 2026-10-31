param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name,
  [int]$MarkerHz = -1,
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
  [switch]$DisableClientRafProbe,
  [ValidateSet('default','software','unlimited')][string]$ClientMode='default',
  [ValidateSet('','auto','on','off')][string]$QsvLowPower=''
)
$ErrorActionPreference = 'Stop'
$rkRoot = Split-Path -Parent $PSScriptRoot
$caseRoot = Join-Path $rkRoot "develop/tmp/$Name"
if (Test-Path -LiteralPath $caseRoot) { throw "Use a new case name; existing measurements must be preserved: $caseRoot" }
$serviceRoot = (Resolve-Path -LiteralPath (Join-Path $rkRoot $ServiceDirectory)).Path
foreach ($directory in @('bin','metrics','browser-trace','source-trace','fixture')) {
  New-Item -ItemType Directory -Path (Join-Path $caseRoot $directory) -Force | Out-Null
}
foreach ($filename in @('test-pattern.html','marker-codec.js')) {
  Copy-Item -LiteralPath (Join-Path (Join-Path $rkRoot $FixtureDirectory) $filename) -Destination (Join-Path $caseRoot "fixture/$filename")
}
foreach ($filename in @('endpoint_service.exe','libvpl.dll')) {
  Copy-Item -LiteralPath (Join-Path $serviceRoot $filename) -Destination (Join-Path $caseRoot "bin/$filename")
}
$configuration = @{
  id=$Name; origin='http://127.0.0.1:3001'; fixtureOrigin='http://127.0.0.1:3013';
  tenants=$Tenants; width=$Width; height=$Height; dpr=1; mode=$FixtureMode;
  warmupMs=5000; sampleMs=20000; receiveProfile='chrome89-h264-42'; callbackRegistration=$CallbackRegistration;
  requirePaint=$true; paintVersion='event-driven-v2'; visibleVideoPreview=[bool]$VisibleVideoPreview;
  inputIntervalMs=$InputIntervalMs;
  honorClientTimerResolution=[bool]$HonorClientTimerResolution;
  timerPolicyTool=(Join-Path $rkRoot 'tools/probe-chrome-timer-policy.ps1'); timerPolicyOutput=(Join-Path $caseRoot 'timer-policy.json');
  captureQuality=[bool]$CaptureQuality; artifactToken=[guid]::NewGuid().ToString('N');
  resourceProfile=[bool]$ResourceProfile; observeClientRaf=(-not [bool]$DisableClientRafProbe);clientMode=$ClientMode;
  endpoint=@{build='Release';asyncDepth=$AsyncDepth;targetUsage=$TargetUsage;rateControl=$RateControl;startBitrate=18000000;maxBitrate=40000000;bufferMs=$BufferMs;idleIdrMs=$IdleIdrMs};
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
$configuration.endpoint.pollTimer = if ($PreciseBrowserPoll) { 'precise' } else { 'default' }
$configurationJson = ConvertTo-Json -InputObject $configuration -Depth 12 -Compress
$driver = [IO.File]::ReadAllText((Join-Path $rkRoot 'tools/streaming-benchmark.js'))
$driver = [regex]::Replace($driver, 'const config = /\* CONFIG \*/ .*?;', { 'const config = ' + $configurationJson + ';' })
[IO.File]::WriteAllText((Join-Path $caseRoot 'run.js'), $driver)
[IO.File]::WriteAllText((Join-Path $caseRoot 'config.json'), $configurationJson)
$fingerprints = @{}
foreach ($relativePath in @('bin/endpoint_service.exe','bin/libvpl.dll')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $caseRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($relativePath in @('fixture/test-pattern.html','fixture/marker-codec.js')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $caseRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($relativePath in @('control/public/test-pattern.html','control/dist/server.mjs','tools/streaming-benchmark.js','tools/streaming-source-probe.mjs','tools/watch-streaming-resources.ps1','tools/windows-gpu-counters.cs','tools/streaming-endpoint-tee.mjs','tools/prepare-streaming-case.ps1')) {
  $fingerprints[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $rkRoot $relativePath) -Algorithm SHA256).Hash
}
foreach ($absolutePath in @('C:/src/chromium/src/out/dev/remotekit_browser.exe','C:/src/chromium/src/out/dev/remotekit_sdk.dll')) {
  $fingerprints[$absolutePath] = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash
}
$fingerprints | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseRoot 'fingerprints.json')
$env:REMOTEKIT_ENDPOINT = Join-Path $caseRoot 'bin/endpoint_service.exe'
$env:REMOTEKIT_ENDPOINT_ARGS = ConvertTo-Json -Compress -InputObject @(
  '--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe', "--data-path=$caseRoot/sessions",
  '--encoder=qsv','--fps=60','--bitrate=18000000','--max-bitrate=40000000',
  "--async-depth=$AsyncDepth", "--target-usage=$TargetUsage", "--buffer-ms=$BufferMs", "--rate-control=$RateControl", "--idle-idr-ms=$IdleIdrMs"
)
if ($QsvLowPower) {
  $configuration.endpoint.qsvLowPower=$QsvLowPower
  $env:REMOTEKIT_ENDPOINT_ARGS=ConvertTo-Json -Compress -InputObject (@(ConvertFrom-Json $env:REMOTEKIT_ENDPOINT_ARGS)+@("--qsv-low-power=$QsvLowPower"))
  $configurationJson=ConvertTo-Json -InputObject $configuration -Depth 12 -Compress
  [IO.File]::WriteAllText((Join-Path $caseRoot 'config.json'),$configurationJson)
  $driver=[regex]::Replace($driver,'const config = /\* CONFIG \*/ .*?;',{'const config = '+$configurationJson+';'})
  [IO.File]::WriteAllText((Join-Path $caseRoot 'run.js'),$driver)
}
$env:REMOTEKIT_CONTROL_DB = Join-Path $caseRoot 'control.db'
$env:REMOTEKIT_METRICS_DIR = Join-Path $caseRoot 'metrics'
$env:REMOTEKIT_MEDIA_TRACE = Join-Path $caseRoot 'browser-trace'
$env:REMOTEKIT_NETWORK_SIM = if ($DownlinkMbps) { ConvertTo-Json -Compress -InputObject @{oneWayDelayMs=5;downlinkMbps=$DownlinkMbps;uplinkMbps=1000;maxQueueBytes=300000;maxQueueDelayMs=100} } else { 'off' }
$env:REMOTEKIT_RTC_LOOPBACK_TEST = if ($DownlinkMbps) { '1' } else { '0' }
$env:REMOTEKIT_GPU_POLL = if ($PreciseBrowserPoll) { 'precise' } else { 'default' }
$env:PORT = '3001'
$nodeExe = (Get-Command node.exe).Source
if ($ResourceProfile) {
  $endpointArgs=ConvertFrom-Json $env:REMOTEKIT_ENDPOINT_ARGS
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
  $resourceArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $rkRoot 'tools/watch-streaming-resources.ps1')+'" -Name '+$Name
  $resourceProcess=Start-Process -FilePath 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -ArgumentList $resourceArguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $caseRoot 'resource.log') -RedirectStandardError (Join-Path $caseRoot 'resource.err') -PassThru
  $casePids.resource_pid=$resourceProcess.Id
  $casePids|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $caseRoot 'pids.json')
}
Write-Output (Join-Path $caseRoot 'run.js')
