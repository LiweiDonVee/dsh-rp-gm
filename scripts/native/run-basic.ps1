param([Parameter(Mandatory=$true)][string]$RunDirectory,[Parameter(Mandatory=$true)][string]$InputsFile)
$ErrorActionPreference='Stop'
$gmRun=[System.IO.Path]::GetFullPath($RunDirectory)
if(Test-Path -LiteralPath (Join-Path $gmRun 'home')){throw 'Use a new isolated home for this complete native run'}
New-Item -ItemType Directory -Path $gmRun -Force|Out-Null
& (Join-Path $PSScriptRoot 'install-inputs.ps1') -RunDirectory $gmRun -InputsFile $InputsFile
$gmFixture=(Join-Path $PSScriptRoot 'harness.mjs').Replace('\','/')
@"
- id: session-title-llm
  disabled: true
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: agent-default-model
  config:
    provider: gm-native-local
    model: gm
- id: tools
  config:
    mode: native
- insert:
    - id: gm-native-harness
      name: '$gmFixture'
"@|Set-Content -LiteralPath (Join-Path $gmRun 'fixture.patch.yml')
$gmListener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$gmListener.Start();$gmPort=$gmListener.LocalEndpoint.Port;$gmListener.Stop()
function Start-GmTestHost {
  $gmProcess=Start-Process -FilePath (Get-Command pwsh.exe).Source -ArgumentList @('-NoProfile','-File',(Join-Path $PSScriptRoot 'start-host.ps1'),'-RunDirectory',$gmRun,'-Port',$gmPort) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $gmRun 'host.stdout.log') -RedirectStandardError (Join-Path $gmRun 'host.stderr.log') -PassThru
  @{pid=$gmProcess.Id;port=$gmPort;run=$gmRun}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $gmRun 'run-info.json')
  $gmUri=$null
  for($gmAttempt=0;$gmAttempt -lt 40;$gmAttempt++){if(Test-Path -LiteralPath (Join-Path $gmRun 'host.stdout.log')){$gmText=Get-Content -LiteralPath (Join-Path $gmRun 'host.stdout.log') -Raw;if($gmText){$gmUri=[regex]::Match($gmText,'http://127\.0\.0\.1:\d+/\?token=[^\s]+').Value}};if($gmUri){break};Start-Sleep -Milliseconds 250}
  if(!$gmUri){throw 'Isolated host did not print its owned login URL'}
  $script:gmJar=New-Object Microsoft.PowerShell.Commands.WebRequestSession;$null=Invoke-WebRequest -Uri $gmUri -WebSession $script:gmJar
  [System.IO.File]::WriteAllText((Join-Path $gmRun 'cookie.txt'),(($script:gmJar.Cookies.GetCookies([uri]"http://127.0.0.1:$gmPort/")|ForEach-Object{$_.Name+'='+$_.Value}) -join '; '))
}
function Call-GmTest([string]$gmName,[hashtable]$gmBody,[string]$gmRoute='harness'){
  $gmPath=if($gmRoute -eq 'product'){'/api/rp-gm/request'}else{'/api/gm-native-harness'}
  $gmReply=Invoke-RestMethod -Uri "http://127.0.0.1:$gmPort$gmPath" -Method Post -Body ($gmBody|ConvertTo-Json -Depth 100 -Compress) -ContentType 'application/json' -WebSession $script:gmJar -SkipHttpErrorCheck -TimeoutSec 30
  $gmReply|ConvertTo-Json -Depth 100 -Compress|Set-Content -LiteralPath (Join-Path $gmRun ($gmName+'.json'))
  if($gmReply.error -or $gmReply.ok -eq $false){throw "Native phase $gmName failed: $($gmReply.error|ConvertTo-Json -Compress)"};return $gmReply
}
Start-GmTestHost
$null=Call-GmTest 'ready' @{action='ready'}
$gmStarted=Call-GmTest 'clean-start' @{action='startSample';launchId='native-basic';openingId='rain'} 'product';$gmSessionId=$gmStarted.sessionId
$gmAgain=Call-GmTest 'same-launch' @{action='startSample';launchId='native-basic';openingId='rain'} 'product';if($gmAgain.sessionId -ne $gmSessionId){throw 'Same launch created another Session'}
$gmOpening=Call-GmTest 'clean-opening' @{action='idle';sessionId=$gmSessionId}
$null=Call-GmTest 'style-b' @{action='style';sessionId=$gmSessionId;variant='b'}
$null=Call-GmTest 'routes' @{action='routes';sessionId=$gmSessionId}
$null=Call-GmTest 'retry-injection' @{action='retryNextCommit';sessionId=$gmSessionId}
$gmTransfer=Call-GmTest 'transfer' @{action='prompt';sessionId=$gmSessionId;requestId='native-transfer';text='把信交给林遥。'}
$null=Call-GmTest 'counters-transfer' @{action='counters'}
$null=Call-GmTest 'style-c' @{action='style';sessionId=$gmSessionId;variant='c'}
$gmFork=Call-GmTest 'fork-before-transfer' @{action='forkGM';sessionId=$gmSessionId;atSeq=($gmOpening.value.events.Count-1)}
$null=Call-GmTest 'fork-state' @{action='snapshot';sessionId=$gmFork.value.sessionId}
$null=Call-GmTest 'fork-profile' @{action='profileState';sessionId=$gmFork.value.sessionId}
$gmAfter=Call-GmTest 'fork-after-transfer' @{action='forkGM';sessionId=$gmSessionId;atSeq=$gmTransfer.value.narratives.records[-1].ref.resultSeq}
$null=Call-GmTest 'fork-after-state' @{action='snapshot';sessionId=$gmAfter.value.sessionId}
$null=Call-GmTest 'fork-after-profile' @{action='profileState';sessionId=$gmAfter.value.sessionId}
$gmRollback=Call-GmTest 'rollback' @{action='rollbackGM';sessionId=$gmSessionId}
$null=Call-GmTest 'rollback-state' @{action='snapshot';sessionId=$gmRollback.value.sessionId}
$null=Call-GmTest 'writer-fail-enable' @{action='failWriter';enabled=$true}
$null=Call-GmTest 'failed-writer' @{action='prompt';sessionId=$gmSessionId;requestId='native-writer-failure';text='等候片刻。'}
$null=Call-GmTest 'counters-failed' @{action='counters'}
$gmSummaries=Call-GmTest 'failed-summaries' @{action='summaries';sessionId=$gmSessionId};$gmEligible=@($gmSummaries.value.presentations|Where-Object canRetry)
if(!$gmSummaries.value.capabilities.retryDispatch -or $gmEligible.Count -ne 1){throw 'Actual owner retry capability/family is unavailable'}
$null=Call-GmTest 'writer-fail-disable' @{action='failWriter';enabled=$false}
$null=Call-GmTest 'retried-writer' @{action='retryLast';sessionId=$gmSessionId;presentationId=$gmEligible[0].presentationId}
$null=Call-GmTest 'counters-retried' @{action='counters'}
$null=Call-GmTest 'actual-gm-export' @{action='exportGM';sessionIds=@($gmSessionId)}
$null=Call-GmTest 'before-restart' @{action='snapshot';sessionId=$gmSessionId}
& (Join-Path $PSScriptRoot 'stop-host.ps1') -RunDirectory $gmRun|Set-Content -LiteralPath (Join-Path $gmRun 'restart-stop.json')
foreach($gmLogName in @('host.stdout.log','host.stderr.log')){Move-Item -LiteralPath (Join-Path $gmRun $gmLogName) -Destination (Join-Path $gmRun ('before-restart-'+$gmLogName))}
Start-GmTestHost
$null=Call-GmTest 'restart-snapshot' @{action='snapshot';sessionId=$gmSessionId}
$null=Call-GmTest 'restart-resume' @{action='resume';sessionId=$gmSessionId}
$null=Call-GmTest 'restart-counters' @{action='counters'}
& node (Join-Path $PSScriptRoot 'verify-basic.mjs') $gmRun
if($LASTEXITCODE -ne 0){throw 'Native basic evidence validation failed'}
