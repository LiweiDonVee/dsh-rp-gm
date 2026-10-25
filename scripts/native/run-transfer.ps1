param([Parameter(Mandatory=$true)][string]$SourceDirectory,[Parameter(Mandatory=$true)][string]$RunDirectory,[Parameter(Mandatory=$true)][string]$InputsFile)
$ErrorActionPreference='Stop'
$gmRun=[System.IO.Path]::GetFullPath($RunDirectory)
if(Test-Path -LiteralPath (Join-Path $gmRun 'home')){throw 'Cross-home transfer requires a new destination'}
New-Item -ItemType Directory -Path $gmRun -Force|Out-Null
& (Join-Path $PSScriptRoot 'install-inputs.ps1') -RunDirectory $gmRun -InputsFile $InputsFile
Copy-Item -LiteralPath (Join-Path $SourceDirectory 'fixture.patch.yml') -Destination (Join-Path $gmRun 'fixture.patch.yml')
& (Join-Path $PSScriptRoot 'boot-host.ps1') -RunDirectory $gmRun
& node (Join-Path $PSScriptRoot 'run-transfer.mjs') $SourceDirectory $gmRun
if($LASTEXITCODE -ne 0){throw 'Actual cross-home owner-provider integration failed'}
& (Join-Path $PSScriptRoot 'stop-host.ps1') -RunDirectory $gmRun|Set-Content -LiteralPath (Join-Path $gmRun 'transfer-restart-stop.json')
foreach($gmLogName in @('host.stdout.log','host.stderr.log')){Move-Item -LiteralPath (Join-Path $gmRun $gmLogName) -Destination (Join-Path $gmRun ('before-transfer-restart-'+$gmLogName))}
& (Join-Path $PSScriptRoot 'boot-host.ps1') -RunDirectory $gmRun
& node (Join-Path $PSScriptRoot 'verify-transfer-restart.mjs') $gmRun
if($LASTEXITCODE -ne 0){throw 'Destination cold restart validation failed'}
