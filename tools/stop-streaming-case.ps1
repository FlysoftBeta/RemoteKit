param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name)
$ErrorActionPreference = 'Stop'
$caseRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "develop/tmp/$Name"
$saved = Get-Content -LiteralPath (Join-Path $caseRoot 'pids.json') -Raw | ConvertFrom-Json
$prepared = (Get-Item -LiteralPath (Join-Path $caseRoot 'config.json')).CreationTimeUtc
foreach ($kind in @('control','source','timer_policy','resource')) {
  $processId = $saved."${kind}_pid"
  if (!$processId) { continue }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
  if (!$process) { continue }
  $created = $process.CreationDate.ToUniversalTime()
  if ($created -lt $prepared.AddSeconds(-1) -or $created -gt $prepared.AddSeconds(30)) { continue }
  $commandLine = $process.CommandLine.Replace('\','/').ToLowerInvariant()
  if ($kind -eq 'control' -and ($process.Name -ne 'node.exe' -or !$commandLine.Contains('dist/server.mjs'))) { continue }
  if ($kind -eq 'source' -and ($process.Name -ne 'node.exe' -or !$commandLine.Contains('streaming-source-probe.mjs') -or !$commandLine.Contains($Name.ToLowerInvariant()))) { continue }
  if ($kind -eq 'timer_policy' -and !$commandLine.Contains('watch-chrome-timer-policy.ps1')) { continue }
  if ($kind -eq 'resource') {
    if (!$commandLine.Contains('watch-streaming-resources.ps1')) { continue }
    [IO.File]::WriteAllText((Join-Path $caseRoot 'resource.stop'),'stop')
    $handle=Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($handle -and $handle.WaitForExit(3000)) { continue }
  }
  Stop-Process -Id $processId -ErrorAction SilentlyContinue
}
