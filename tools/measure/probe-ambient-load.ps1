param(
  [ValidateRange(1,10)][int]$Windows=3,
  [ValidateRange(1000,10000)][int]$IntervalMs=2000,
  [ValidateRange(1,50)][int]$Top=10,
  [switch]$IncludeGpu,
  [string]$Output
)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-gpu-counters.cs')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RemoteKitSystemCpu {
  [DllImport("kernel32.dll")] private static extern bool GetSystemTimes(out long idle,out long kernel,out long user);
  public static long[] Read(){long i,k,u;if(!GetSystemTimes(out i,out k,out u))throw new InvalidOperationException("GetSystemTimes failed");return new long[]{i,k,u};}
}
'@
function Read-Processes {
  $names=@{};foreach($p in [Diagnostics.Process]::GetProcesses()){try{$names[$p.Id]=$p.ProcessName}finally{$p.Dispose()}}
  $times=@{};foreach($p in [RemoteKitGpuCounters]::ReadCpu([int[]]@($names.Keys))){$times[$p.Pid]=@{name=$names[$p.Pid];seconds=$p.Seconds}}
  $script:ambientProcessNames=$names
  return $times
}
$gpu=if($IncludeGpu){[RemoteKitGpuCounters]::new()}else{$null}
$clock=[Diagnostics.Stopwatch]::StartNew();$samples=[Collections.Generic.List[object]]::new()
try {
 for($window=0;$window -lt $Windows;$window++) {
  $collection=[Diagnostics.Stopwatch]::StartNew();$before=Read-Processes;$sysBefore=[RemoteKitSystemCpu]::Read();$at=$clock.Elapsed.TotalSeconds;$start=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$beginCollectionMs=$collection.Elapsed.TotalMilliseconds
  Start-Sleep -Milliseconds $IntervalMs
  $collection.Restart();$sysAfter=[RemoteKitSystemCpu]::Read();$endAt=$clock.Elapsed.TotalSeconds;$end=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$after=Read-Processes;$elapsed=$endAt-$at
  $rows=@(foreach($id in $after.Keys){if($before.ContainsKey($id) -and $before[$id].name -eq $after[$id].name){$delta=$after[$id].seconds-$before[$id].seconds;if($delta -ge 0){[pscustomobject]@{pid=$id;name=$after[$id].name;cpuCores=$delta/$elapsed}}}})
  $total=($sysAfter[1]-$sysBefore[1])+($sysAfter[2]-$sysBefore[2]);$idle=$sysAfter[0]-$sysBefore[0];$busy=$total-$idle
  $gpuRows=@();$gpuError=$null
  if($gpu){try{$group=@{};foreach($g in $gpu.Read()){if($g.Name -match '^pid_(\d+)_(luid_.+_phys_\d+_eng_\d+_engtype_.+)$'){$id=[int]$Matches[1];$engine=$Matches[2];$key="$id/$engine";if(!$group.ContainsKey($key)){$group[$key]=[pscustomobject]@{pid=$id;name=$(if($script:ambientProcessNames.ContainsKey($id)){$script:ambientProcessNames[$id]}else{'unavailable'});engine=$engine;gpuPercent=0.0}};$group[$key].gpuPercent+=$g.Percent}};$gpuRows=@($group.Values|Where-Object {$_.gpuPercent -gt 0}|Sort-Object gpuPercent -Descending|Select-Object -First $Top)}catch{$gpuError=$_.Exception.Message}}
  $sum=($rows|Measure-Object cpuCores -Sum).Sum
  $samples.Add(@{window=$window;wallStartMs=$start;wallEndMs=$end;elapsedMs=$elapsed*1000;logicalCpus=[Environment]::ProcessorCount;systemBusyPercent=$(if($total -gt 0){100.0*$busy/$total}else{$null});systemBusyCores=$busy/10000000.0/$elapsed;readableProcessCpuCores=$sum;unattributedCpuCores=$busy/10000000.0/$elapsed-$sum;processes=@($rows|Sort-Object cpuCores -Descending|Select-Object -First $Top);gpu=$gpuRows;gpuError=$gpuError;collectionMs=$beginCollectionMs+$collection.Elapsed.TotalMilliseconds})
 }
}finally{if($gpu){$gpu.Dispose()}}
$result=@{kind='ambient-load';scope='all readable process CPU; no command lines or environments';gpuScope=$(if($IncludeGpu){'top process/physical-engine PDH instances'}else{'not sampled'});samples=@($samples)}
$json=ConvertTo-Json $result -Depth 6
if($Output){[IO.File]::WriteAllText([IO.Path]::GetFullPath($Output),$json)}
Write-Output $json
