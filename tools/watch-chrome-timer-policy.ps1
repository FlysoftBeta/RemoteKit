param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name)
$ErrorActionPreference = 'Stop'
$caseRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "develop/tmp/$Name"
$metrics = Join-Path $caseRoot 'metrics/client-metrics.jsonl'
$resultPath = Join-Path $caseRoot 'timer-policy.json'
$deadline = [DateTime]::UtcNow.AddSeconds(45)
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $metrics) {
      foreach ($line in Get-Content -LiteralPath $metrics) {
        try { $record = $line | ConvertFrom-Json } catch { continue }
        if ($record.metrics.kind -eq 'timer-policy-root' -and $record.metrics.runId -eq $Name) {
          & (Join-Path $PSScriptRoot 'probe-chrome-timer-policy.ps1') -BrowserProcessId $record.metrics.rootPid -HonorTimerResolution -OutputPath $resultPath
          exit 0
        }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'Timed out waiting for the host browser to report its own test root PID'
} catch {
  @{allSucceeded=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath
  exit 1
}
