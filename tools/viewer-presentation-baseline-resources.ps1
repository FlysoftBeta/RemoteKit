param([int]$Seconds=12,[string]$OutputName='resource-samples.jsonl',[string]$RunDirectory='develop/tmp/viewer-presentation-baseline')
$ErrorActionPreference='Stop'
$run=Join-Path (Split-Path -Parent $PSScriptRoot) $RunDirectory
$service=Get-Content -LiteralPath (Join-Path $run 'service.json') -Raw|ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-gpu-counters.cs')
$inventory=@(Get-CimInstance Win32_Process)
$owned=@{};$owned[[int]$service.pid]='control'
foreach($p in $inventory){if($p.Name -eq 'chrome.exe' -and ($p.CommandLine -like "*$run*client-*" -or $p.CommandLine -like "*$($run.Replace('\','/'))*client-*")){$owned[[int]$p.ProcessId]='receiver'}}
for($i=0;$i -lt 10;$i++){foreach($p in $inventory){if(!$owned.ContainsKey([int]$p.ProcessId)-and $owned.ContainsKey([int]$p.ParentProcessId)){$owned[[int]$p.ProcessId]=if($owned[[int]$p.ParentProcessId] -eq 'receiver'){'receiver'}else{'source'}}}}
$inventory|Where-Object{$owned.ContainsKey([int]$_.ProcessId)}|Select-Object ProcessId,ParentProcessId,Name,@{n='role';e={$owned[[int]$_.ProcessId]}}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $run ($OutputName+'.processes.json'))
$pdh=[RemoteKitGpuCounters]::new();$previous=@{};$clock=[Diagnostics.Stopwatch]::StartNew()
$writer=[IO.StreamWriter]::new((Join-Path $run $OutputName),$false,[Text.UTF8Encoding]::new($false))
try{while($clock.Elapsed.TotalSeconds -lt $Seconds){$now=$clock.Elapsed.TotalSeconds;$cpu=@();foreach($p in [RemoteKitGpuCounters]::ReadCpu([int[]]@($owned.Keys))){$cores=$null;if($previous.ContainsKey($p.Pid)){$cores=($p.Seconds-$previous[$p.Pid].seconds)/($now-$previous[$p.Pid].at)};$previous[$p.Pid]=@{seconds=$p.Seconds;at=$now};$cpu+=@{pid=$p.Pid;role=$owned[$p.Pid];cores=$cores}}
$gpu=@();foreach($g in $pdh.Read()){if($g.Name -match '^pid_(\d+)_.+engtype_(.+)$' -and $owned.ContainsKey([int]$Matches[1])){$gpu+=@{pid=[int]$Matches[1];role=$owned[[int]$Matches[1]];engine=$Matches[2];percent=$g.Percent}}}
$writer.WriteLine((@{at=$now;wall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cpu=$cpu;gpu=$gpu}|ConvertTo-Json -Depth 5 -Compress));$writer.Flush();Start-Sleep -Milliseconds 1000}}finally{$writer.Dispose();$pdh.Dispose()}
