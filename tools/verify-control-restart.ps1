param(
  [Parameter(Mandatory=$true)][string]$EndpointPath,
  [Parameter(Mandatory=$true)][string]$MetricsFile,
  [int]$TimeoutSeconds=180,
  [string]$OutputPath
)
$ErrorActionPreference='Stop'
$taskArguments=@("$PSScriptRoot/verify-control-restart.mjs",'--endpoint',$EndpointPath,'--metrics',$MetricsFile,'--timeout',"$TimeoutSeconds")
if($OutputPath){$taskArguments+=@('--output',$OutputPath)}
& node @taskArguments
exit $LASTEXITCODE
