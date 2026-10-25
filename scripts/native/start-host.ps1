param([Parameter(Mandatory=$true)][string]$RunDirectory,[int]$Port=18763)
$ErrorActionPreference='Stop'
$gmRun = [System.IO.Path]::GetFullPath($RunDirectory)
$gmWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$gmRuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $gmWorkspace '.runtime'))
if (!$gmRun.StartsWith($gmRuntimeRoot + [System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Native run must be inside this GM workspace .runtime directory' }
$env:DSH_HOME=Join-Path $gmRun 'home'
$env:DEEPSEEK_API_KEY='isolated-local-provider-never-use'
$env:DSH_TOOLS_MODE='native'
& 'C:/Users/Owner/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd' web --patch (Join-Path $gmRun 'fixture.patch.yml') --host 127.0.0.1 --port $Port --no-open
