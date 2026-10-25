param([Parameter(Mandatory=$true)][string]$RunDirectory)
$ErrorActionPreference='Stop'
$gmRun=[System.IO.Path]::GetFullPath($RunDirectory)
$gmRuntime=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.runtime'))
if(!$gmRun.StartsWith($gmRuntime+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected owned runtime path'}
$gmListener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$gmListener.Start();$gmPort=$gmListener.LocalEndpoint.Port;$gmListener.Stop()
$gmProcess=Start-Process -FilePath (Get-Command pwsh.exe).Source -ArgumentList @('-NoProfile','-File',(Join-Path $PSScriptRoot 'start-host.ps1'),'-RunDirectory',$gmRun,'-Port',$gmPort) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $gmRun 'host.stdout.log') -RedirectStandardError (Join-Path $gmRun 'host.stderr.log') -PassThru
@{pid=$gmProcess.Id;port=$gmPort;run=$gmRun}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $gmRun 'run-info.json')
$gmUri=$null
for($gmAttempt=0;$gmAttempt -lt 40;$gmAttempt++){if(Test-Path -LiteralPath (Join-Path $gmRun 'host.stdout.log')){$gmText=Get-Content -LiteralPath (Join-Path $gmRun 'host.stdout.log') -Raw;if($gmText){$gmUri=[regex]::Match($gmText,'http://127\.0\.0\.1:\d+/\?token=[^\s]+').Value}};if($gmUri){break};Start-Sleep -Milliseconds 250}
if(!$gmUri){throw 'Isolated host did not print its owned login URL'}
$gmJar=New-Object Microsoft.PowerShell.Commands.WebRequestSession;$null=Invoke-WebRequest -Uri $gmUri -WebSession $gmJar
[System.IO.File]::WriteAllText((Join-Path $gmRun 'cookie.txt'),(($gmJar.Cookies.GetCookies([uri]"http://127.0.0.1:$gmPort/")|ForEach-Object{$_.Name+'='+$_.Value}) -join '; '))
@{started=$true;pid=$gmProcess.Id;port=$gmPort}|ConvertTo-Json -Compress
