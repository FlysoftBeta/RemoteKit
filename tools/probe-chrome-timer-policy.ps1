param(
  [Parameter(Mandatory=$true)][int]$BrowserProcessId,
  [switch]$HonorTimerResolution,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$expectedExecutable = (Resolve-Path -LiteralPath 'C:/src/tmp/chrome89-google/app/chrome.exe').Path
$processes = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'")
$rootProcess = $processes | Where-Object ProcessId -eq $BrowserProcessId | Select-Object -First 1
if (!$rootProcess -or $rootProcess.ExecutablePath -ne $expectedExecutable -or
    $rootProcess.CommandLine -notmatch '--user-data-dir=.*playwright_chromiumdev_profile' -or
    $rootProcess.CommandLine -match '--type=') {
  throw 'Target must be the root PID of this test Chrome89 Playwright profile'
}
$selected = @{$BrowserProcessId=$true}
do {
  $added = $false
  foreach ($process in $processes) {
    if ($process.ExecutablePath -eq $expectedExecutable -and $selected.ContainsKey([int]$process.ParentProcessId) -and !$selected.ContainsKey([int]$process.ProcessId)) {
      $selected[[int]$process.ProcessId] = $true; $added = $true
    }
  }
} while ($added)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RemoteKitTimerPolicy {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version, ControlMask, StateMask; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessInformation(IntPtr process, int type, ref State state, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetProcessInformation(IntPtr process, int type, ref State state, uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr process);
}
'@
$rows = @()
foreach ($process in $processes | Where-Object { $selected.ContainsKey([int]$_.ProcessId) }) {
  $row = @{pid=$process.ProcessId;parentPid=$process.ParentProcessId;setAttempted=[bool]$HonorTimerResolution;success=$false}
  $handle = [RemoteKitTimerPolicy]::OpenProcess(0x600, $false, $process.ProcessId)
  if ($handle -eq [IntPtr]::Zero) { $row.error=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); $rows += $row; continue }
  try {
    $before = New-Object RemoteKitTimerPolicy+State; $before.Version = 1
    if (![RemoteKitTimerPolicy]::GetProcessInformation($handle, 4, [ref]$before, 12)) {
      $row.error=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); $rows += $row; continue
    }
    $row.before = @{version=$before.Version;controlMask=$before.ControlMask;stateMask=$before.StateMask}
    if ($HonorTimerResolution) {
      $changed = New-Object RemoteKitTimerPolicy+State
      $changed.Version = 1; $changed.ControlMask = $before.ControlMask -bor 4
      $changed.StateMask = $before.StateMask -band ([uint32]4294967291)
      if (![RemoteKitTimerPolicy]::SetProcessInformation($handle, 4, [ref]$changed, 12)) {
        $row.error=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); $rows += $row; continue
      }
    }
    $after = New-Object RemoteKitTimerPolicy+State; $after.Version = 1
    $row.success = [RemoteKitTimerPolicy]::GetProcessInformation($handle, 4, [ref]$after, 12)
    $row.after = @{version=$after.Version;controlMask=$after.ControlMask;stateMask=$after.StateMask}
    if (!$row.success) { $row.error=[Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    if ($row.success -and $HonorTimerResolution -and (($after.ControlMask -band 4) -eq 0 -or ($after.StateMask -band 4) -ne 0)) {
      $row.success = $false; $row.error = 'policy-readback-mismatch'
    }
  } finally { [void][RemoteKitTimerPolicy]::CloseHandle($handle) }
  $rows += $row
}
$result = @{rootPid=$BrowserProcessId;honorTimerResolution=[bool]$HonorTimerResolution;allSucceeded=(@($rows | Where-Object { !$_.success }).Count -eq 0);processes=$rows;recovery='test browser and children exit at experiment end; no global policy changed'}
$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
if ($OutputPath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), $json) }
Write-Output $json
