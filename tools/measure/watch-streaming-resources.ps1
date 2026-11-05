param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name,
  [ValidateRange(5,300)][int]$DurationSeconds=120,
  [ValidateRange(500,5000)][int]$IntervalMs=1000,
  [ValidateSet('pdh','cim')][string]$GpuProvider='pdh',
  [Parameter(Mandatory=$true)][string]$Viewer,
  [Parameter(Mandatory=$true)][int]$ReceiverPid
)
$ErrorActionPreference='Stop'
$caseRoot=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "develop/tmp/$Name"
$output=Join-Path $caseRoot 'resource-samples.jsonl'
$stopFile=Join-Path $caseRoot 'resource.stop'
$logicalCpus=[Environment]::ProcessorCount
$known=@{}; $previousCpu=@{}; $previousGpu=@{}; $receiverRootId=$ReceiverPid
$inventoryAt=-10000; $clock=[Diagnostics.Stopwatch]::StartNew()
$receiverPath=[IO.Path]::GetFullPath($Viewer.Replace('/','\'))
$receiverName=[IO.Path]::GetFileName($receiverPath)
$receiverFilter=$receiverPath.Replace('\','\\').Replace("'","\'")
$receiverNameFilter=$receiverName.Replace('\','\\').Replace("'","\'")
$filter="Name='remotekit_browser.exe' OR Name='endpoint_service.exe' OR (Name='$receiverNameFilter' AND ExecutablePath='$receiverFilter')"
$writer=[IO.StreamWriter]::new($output,$false,[Text.UTF8Encoding]::new($false));$writer.AutoFlush=$true
$self=Get-Process -Id $PID; $previousSelfCpu=$self.TotalProcessorTime.TotalSeconds; $previousSelfAt=0
$pdh=$null
Add-Type -Path (Join-Path $PSScriptRoot 'windows-gpu-counters.cs')
if($GpuProvider -eq 'pdh'){$pdh=[RemoteKitGpuCounters]::new()}
try {
 while($clock.Elapsed.TotalSeconds -lt $DurationSeconds -and !(Test-Path -LiteralPath $stopFile)) {
  $cycle=[Diagnostics.Stopwatch]::StartNew();$wall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($clock.ElapsedMilliseconds-$inventoryAt -ge 2000) {
   $inventoryAt=$clock.ElapsedMilliseconds
   $inventory=@(Get-CimInstance Win32_Process -Filter $filter)
   $roles=@{}
   foreach($process in $inventory) {
    if($process.Name -eq 'endpoint_service.exe' -and $process.CommandLine -and $process.CommandLine.Contains($caseRoot)){$roles[[int]$process.ProcessId]='endpoint'}
    if($receiverRootId -and $process.ProcessId -eq $receiverRootId){$roles[[int]$process.ProcessId]='receiver-browser'}
   }
   for($pass=0;$pass -lt 8;$pass++) {
    foreach($process in $inventory) {
     $id=[int]$process.ProcessId;$parent=[int]$process.ParentProcessId
     if($roles.ContainsKey($id) -or !$roles.ContainsKey($parent)){continue}
     $prefix=if($roles[$parent].StartsWith('receiver')){'receiver'}else{'source'}
     $type=if($process.CommandLine -match '--type=([^\s]+)'){$Matches[1]}else{'browser'}
     $roles[$id]="$prefix-$type"
    }
   }
   foreach($process in $inventory) {
    $id=[int]$process.ProcessId;if(!$roles.ContainsKey($id)){continue}
    $flags=@([regex]::Matches([string]$process.CommandLine,'--(?:use-angle|use-gl)=[^\s]+|--disable-gpu(?:\s|$)|--(?:enable|disable)-features=[^\s"]+')|ForEach-Object{$_.Value.Trim()})
    $known[$id]=@{pid=$id;parentPid=[int]$process.ParentProcessId;role=$roles[$id];name=$process.Name;flags=$flags;createdUtc=$process.CreationDate.ToUniversalTime().ToString('o')}
   }
   $saved=Get-Content -LiteralPath (Join-Path $caseRoot 'pids.json') -Raw|ConvertFrom-Json
   foreach($pair in @(@('control_pid','control-node'),@('source_pid','source-probe'))) {
    $id=[int]$saved.($pair[0]);if($id){$known[$id]=@{pid=$id;role=$pair[1];name='node.exe'}}
   }
   $known[$PID]=@{pid=$PID;role='resource-probe';name='powershell.exe'}
   @{kind='owned-process-inventory';receiverRootPid=$receiverRootId;logicalCpus=$logicalCpus;processes=@($known.Values)}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $caseRoot 'resource-processes.json') -Encoding UTF8
  }
  $cpu=[Collections.Generic.List[object]]::new()
  $cpuStarted=$cycle.Elapsed.TotalMilliseconds
  foreach($process in [RemoteKitGpuCounters]::ReadCpu([int[]]@($known.Keys))) {
   $id=$process.Pid
   try {
    $seconds=$process.Seconds;$now=$clock.Elapsed.TotalSeconds;$cores=$null
    if($previousCpu.ContainsKey($id)){$elapsed=$now-$previousCpu[$id].at;if($elapsed -gt 0 -and $seconds -ge $previousCpu[$id].cpu){$cores=($seconds-$previousCpu[$id].cpu)/$elapsed}}
    $previousCpu[$id]=@{at=$now;cpu=$seconds}
    $cpu.Add(@{pid=$id;role=$known[$id].role;cpuCores=$cores;hostCpuPercent=$(if($null -ne $cores){100*$cores/$logicalCpus}else{$null});cpuSeconds=$seconds;workingSetBytes=$null})
   }catch{}
  }
  $ownedGpu=[Collections.Generic.List[object]]::new();$unownedGpu=[Collections.Generic.List[object]]::new();$engines=@{};$gpuError=$null
  $cpuMs=$cycle.Elapsed.TotalMilliseconds-$cpuStarted;$gpuStarted=$cycle.Elapsed.TotalMilliseconds
  try {
   $gpuSamples=if($pdh){$pdh.Read()}else{Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine}
   foreach($gpu in $gpuSamples) {
    $instance=[string]$gpu.Name
    if($instance -notmatch '^pid_(\d+)_(luid_.+_phys_\d+_eng_\d+_engtype_(.+))$'){continue}
    $id=[int]$Matches[1];$engine=$Matches[2];$type=$Matches[3];$util=$null
    if($pdh){$util=[double]$gpu.Percent}
    elseif($previousGpu.ContainsKey($instance)) {
     $elapsed=[int64]$gpu.Timestamp_Sys100NS-$previousGpu[$instance].timestamp
     $delta=[int64]$gpu.UtilizationPercentage-$previousGpu[$instance].numerator
     if($elapsed -gt 0 -and $delta -ge 0){$util=100.0*$delta/$elapsed}
    }
    if(!$pdh){$previousGpu[$instance]=@{timestamp=[int64]$gpu.Timestamp_Sys100NS;numerator=[int64]$gpu.UtilizationPercentage}}
    if(!$engines.ContainsKey($engine)){$engines[$engine]=@{engine=$engine;type=$type;totalUtilPercent=0.0;ownedUtilPercent=0.0;validInstances=0}}
    if($null -ne $util){$engines[$engine].totalUtilPercent+=$util;$engines[$engine].validInstances++}
    if($known.ContainsKey($id)) {
     if($null -ne $util){$engines[$engine].ownedUtilPercent+=$util}
     $ownedGpu.Add(@{pid=$id;role=$known[$id].role;engine=$engine;type=$type;utilPercent=$util;runningTimeRaw=$(if(!$pdh){[int64]$gpu.RunningTime}else{$null});utilizationRaw=$(if(!$pdh){[int64]$gpu.UtilizationPercentage}else{$null});timestampSys100Ns=$(if(!$pdh){[int64]$gpu.Timestamp_Sys100NS}else{$null})})
    } else {
     # Keep every counter, including exited/unknown PIDs. A name is a separate
     # best-effort observation, not an inferred benchmark role.
     $unownedGpu.Add(@{pid=$id;engine=$engine;type=$type;utilPercent=$util;processName=$null})
    }
   }
   $unownedNames=@{}
   $unownedIds=@($unownedGpu|ForEach-Object{$_.pid}|Sort-Object -Unique)
   if($unownedIds.Count) {
    foreach($process in @(Get-Process -Id $unownedIds -ErrorAction SilentlyContinue)) {
     try{$unownedNames[[int]$process.Id]=$process.ProcessName}catch{}
    }
   }
   $nameObservationWall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
   foreach($counter in $unownedGpu) {
    $counter.processNameObservedWallTimeMs=$nameObservationWall
    if($unownedNames.ContainsKey([int]$counter.pid)){$counter.processName=$unownedNames[[int]$counter.pid]}
   }
  }catch{$gpuError=$_.Exception.Message}
  $self.Refresh();$selfCpu=$self.TotalProcessorTime.TotalSeconds;$selfAt=$clock.Elapsed.TotalSeconds
  $selfCores=if($selfAt -gt $previousSelfAt){($selfCpu-$previousSelfCpu)/($selfAt-$previousSelfAt)}else{$null}
  $previousSelfCpu=$selfCpu;$previousSelfAt=$selfAt
  $writer.WriteLine((@{kind='resource-sample';gpuProvider=$GpuProvider;wallTimeMs=$wall;elapsedMs=$clock.ElapsedMilliseconds;collectionMs=$cycle.Elapsed.TotalMilliseconds;cpuCollectionMs=$cpuMs;gpuCollectionMs=($cycle.Elapsed.TotalMilliseconds-$gpuStarted);logicalCpus=$logicalCpus;collectorCpuCores=$selfCores;cpu=@($cpu);gpu=@($ownedGpu);unownedGpu=@($unownedGpu);engines=@($engines.Values);gpuError=$gpuError}|ConvertTo-Json -Depth 6 -Compress))
  $delay=$IntervalMs-$cycle.ElapsedMilliseconds;if($delay -gt 0){Start-Sleep -Milliseconds $delay}
 }
}finally{$writer.Dispose();if($pdh){$pdh.Dispose()}}
