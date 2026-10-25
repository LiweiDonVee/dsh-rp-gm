param([Parameter(Mandatory=$true)][string]$RunDirectory)
$ErrorActionPreference='Stop'
$gmRun=[System.IO.Path]::GetFullPath($RunDirectory)
$gmWorkspace=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$gmRuntimeRoot=[System.IO.Path]::GetFullPath((Join-Path $gmWorkspace '.runtime'))
if(!$gmRun.StartsWith($gmRuntimeRoot+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected native run directory'}
$gmInfo=Get-Content -LiteralPath (Join-Path $gmRun 'run-info.json') -Raw | ConvertFrom-Json
$gmHeaders=@{Cookie=(Get-Content -LiteralPath (Join-Path $gmRun 'cookie.txt') -Raw)}
$gmFlushed=Invoke-RestMethod -Uri "http://127.0.0.1:$($gmInfo.port)/api/gm-native-harness" -Method Post -Body '{"action":"flush"}' -ContentType 'application/json' -Headers $gmHeaders -SkipHttpErrorCheck -TimeoutSec 20
if(!$gmFlushed.ok){throw 'Owned host did not confirm persistence flush'}
$gmProcesses=Get-CimInstance Win32_Process
$gmRoot=$gmProcesses | Where-Object ProcessId -eq $gmInfo.pid
if($gmRoot -and ($gmRoot.CommandLine -notlike '*start-host.ps1*' -or $gmRoot.CommandLine -notlike ('*'+$gmRun.Replace('\','/')+'*') -and $gmRoot.CommandLine -notlike ('*'+$gmRun+'*'))){throw 'Recorded PID no longer belongs to this native run'}
$gmOwned=[System.Collections.Generic.HashSet[int]]::new()
if($gmRoot){$null=$gmOwned.Add([int]$gmRoot.ProcessId);do{$gmAdded=$false;foreach($gmProcess in $gmProcesses){if($gmOwned.Contains([int]$gmProcess.ParentProcessId) -and $gmOwned.Add([int]$gmProcess.ProcessId)){$gmAdded=$true}}}while($gmAdded)}
$gmListeners=@(Get-NetTCPConnection -State Listen -LocalPort $gmInfo.port -ErrorAction SilentlyContinue)
foreach($gmListener in $gmListeners){$gmNode=$gmProcesses | Where-Object ProcessId -eq $gmListener.OwningProcess;if(!$gmNode -or $gmNode.CommandLine -notlike '*fixture.patch.yml*' -or ($gmNode.CommandLine -notlike ('*'+$gmRun+'*') -and $gmNode.CommandLine -notlike ('*'+$gmRun.Replace('\','/')+'*'))){throw 'Port is not owned by this native fixture'};$null=$gmOwned.Add([int]$gmNode.ProcessId)}
foreach($gmProcessId in $gmOwned){if($gmProcessId -eq $PID){throw 'Refusing to stop this shell'};Stop-Process -Id $gmProcessId -Force -ErrorAction SilentlyContinue}
@{flushed=$true;stoppedIds=@($gmOwned);port=$gmInfo.port}|ConvertTo-Json -Compress
