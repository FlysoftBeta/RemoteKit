param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$includeRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/Include'
$sdkRoot = Get-ChildItem -LiteralPath $includeRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um/dwmapi.h') } | Sort-Object { [Version]$_.Name } -Descending | Select-Object -First 1
$headerPath = Join-Path $sdkRoot.FullName 'um/dwmapi.h'
$header = [IO.File]::ReadAllText($headerPath)
$body = [regex]::Match($header, '(?s)typedef\s+struct _DWM_TIMING_INFO\s*\{(.*?)\}\s*DWM_TIMING_INFO;').Groups[1].Value
$types = @{UINT32='uint';UINT='uint';UNSIGNED_RATIO='Ratio';QPC_TIME='ulong';DWM_FRAME_COUNT='ulong';ULONGLONG='ulong'}
$fields = foreach ($match in [regex]::Matches($body, '(?m)^\s*(UINT32|UINT|UNSIGNED_RATIO|QPC_TIME|DWM_FRAME_COUNT|ULONGLONG)\s+(\w+)\s*;')) {
  'public ' + $types[$match.Groups[1].Value] + ' ' + $match.Groups[2].Value + ';'
}
$declaration = @'
using System;
using System.Runtime.InteropServices;
public static class RemoteKitDisplayProbe {
  [StructLayout(LayoutKind.Sequential, Pack=1)] public struct Ratio { public uint numerator, denominator; }
  [StructLayout(LayoutKind.Sequential, Pack=1)] public struct Timing {
FIELDS
  }
  [DllImport("dwmapi.dll")] public static extern int DwmGetCompositionTimingInfo(IntPtr hwnd, ref Timing timing);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] public static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int type, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);
}
'@
Add-Type ($declaration.Replace('FIELDS', ($fields -join "`n")))
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$protocol = $null
$state = $null
foreach ($information in @(16,8)) {
  $buffer = [IntPtr]::Zero; $bytes = 0
  if ([RemoteKitDisplayProbe]::WTSQuerySessionInformationW([IntPtr]::Zero, $sessionId, $information, [ref]$buffer, [ref]$bytes)) {
    try {
      if ($information -eq 16) { $protocol = [Runtime.InteropServices.Marshal]::ReadInt16($buffer) }
      else { $state = [Runtime.InteropServices.Marshal]::ReadInt32($buffer) }
    } finally { [RemoteKitDisplayProbe]::WTSFreeMemory($buffer) }
  }
}
$timing = New-Object RemoteKitDisplayProbe+Timing
$timing.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($timing)
$hresult = [RemoteKitDisplayProbe]::DwmGetCompositionTimingInfo([IntPtr]::Zero, [ref]$timing)
$result = @{
  wallTime=(Get-Date).ToUniversalTime().ToString('o'); sessionId=$sessionId;
  remoteSessionMetric=[RemoteKitDisplayProbe]::GetSystemMetrics(0x1000);
  clientProtocolCode=$protocol; connectStateCode=$state;
  protocolCodes=@{console=0;RDP=2}; stateCodes=@{active=0;connected=1;disconnected=4};
  screenWidth=[RemoteKitDisplayProbe]::GetSystemMetrics(0); screenHeight=[RemoteKitDisplayProbe]::GetSystemMetrics(1);
  sdkHeader=$headerPath; dwmHresult=$hresult; dwmStructBytes=$timing.cbSize;
  qpcFrequency=[Diagnostics.Stopwatch]::Frequency
}
if ($hresult -eq 0) {
  $result.dwmRefreshHz = $timing.rateRefresh.numerator / [double]$timing.rateRefresh.denominator
  $result.dwmComposeHz = $timing.rateCompose.numerator / [double]$timing.rateCompose.denominator
  $result.dwmQpcPeriodMs = $timing.qpcRefreshPeriod * 1000.0 / [Diagnostics.Stopwatch]::Frequency
  $result.dwmCounters = @{refresh=$timing.cRefresh;frame=$timing.cFrame;framesDisplayed=$timing.cFramesDisplayed;framesDropped=$timing.cFramesDropped;framesMissed=$timing.cFramesMissed}
}
$json = ConvertTo-Json -InputObject $result -Depth 5
if ($OutputPath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), $json) }
Write-Output $json
