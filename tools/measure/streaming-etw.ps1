# Record WPR after the current Viewer profile signals readiness.
param(
  [Parameter(Mandatory=$true)][string]$CaseRoot,
  [ValidateRange(1,30)][int]$DurationSeconds=11,
  [ValidateRange(1,180)][int]$ReadyTimeoutSeconds=90
)
$ErrorActionPreference='Stop'
$rkCase=(Resolve-Path -LiteralPath $CaseRoot).Path
if(Test-Path -LiteralPath (Join-Path $rkCase 'gpu.etl')){throw 'CaseRoot already contains gpu.etl; use a fresh case for this profile run'}
$rkWpr='C:/Program Files (x86)/Windows Kits/10/Windows Performance Toolkit/wpr.exe'
$rkProfile='C:/Program Files (x86)/Windows Kits/10/Windows Performance Toolkit/gpuview/log.wprp!GPUView'
$rkOwned=$false
$rkRecords=[Collections.Generic.List[object]]::new()
function Add-Anchor([string]$Name) {
  $rkBefore=[Diagnostics.Stopwatch]::GetTimestamp()
  $rkWall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rkAfter=[Diagnostics.Stopwatch]::GetTimestamp()
  $rkRecords.Add(@{name=$Name;qpcBefore=$rkBefore;qpcAfter=$rkAfter;qpcFrequency=[Diagnostics.Stopwatch]::Frequency;wallMs=$rkWall})
}
try {
  $rkDeadline=[DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  $rkReady=Join-Path $rkCase 'etw-ready.json'
  while(-not (Test-Path -LiteralPath $rkReady)) {
    if([DateTime]::UtcNow -gt $rkDeadline){throw 'Timed out waiting for Viewer readiness'}
    Start-Sleep -Milliseconds 100
  }
  $rkStatus=& $rkWpr -status 2>&1 | Out-String
  $rkStatus | Set-Content -LiteralPath (Join-Path $rkCase 'etw-status-before.txt')
  if($LASTEXITCODE -ne 0 -or $rkStatus -notmatch 'WPR is not recording'){throw 'WPR has an existing or unknown recording; leaving it untouched'}
  Add-Anchor 'start-before'
  & sudo $rkWpr -start $rkProfile -filemode
  if($LASTEXITCODE -ne 0){throw "WPR start failed: $LASTEXITCODE"}
  $rkOwned=$true
  Add-Anchor 'start-after'
  $rkTimer=[Diagnostics.Stopwatch]::StartNew()
  Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CreationDate|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $rkCase 'etw-processes.json')
  $rkRemaining=[int]($DurationSeconds*1000-$rkTimer.Elapsed.TotalMilliseconds)
  if($rkRemaining -gt 0){Start-Sleep -Milliseconds $rkRemaining}
} finally {
  if($rkOwned) {
    Add-Anchor 'stop-before'
    & sudo $rkWpr -stop (Join-Path $rkCase 'gpu.etl') -skipPdbGen
    $rkStopCode=$LASTEXITCODE
    Add-Anchor 'stop-after'
  }
  $rkRecords|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $rkCase 'etw-anchors.json')
  if($rkOwned -and $rkStopCode -ne 0){throw "Owned WPR stop failed: $rkStopCode"}
}
