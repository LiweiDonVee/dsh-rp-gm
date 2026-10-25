param([Parameter(Mandatory=$true)][string]$RunDirectory,[Parameter(Mandatory=$true)][string]$InputsFile)
$ErrorActionPreference='Stop'
$gmRun=[System.IO.Path]::GetFullPath($RunDirectory)
$gmWorkspace=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$gmRuntimeRoot=[System.IO.Path]::GetFullPath((Join-Path $gmWorkspace '.runtime'))
if(!$gmRun.StartsWith($gmRuntimeRoot+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected native run directory'}
$gmInputs=Get-Content -LiteralPath $InputsFile -Raw|ConvertFrom-Json
$gmCli='C:/Users/Owner/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$env:DSH_HOME=Join-Path $gmRun 'home'
$gmHostVersion=(& $gmCli --version).Trim()
if($gmHostVersion -ne $gmInputs.hostVersion){throw 'Actual DSH version does not match frozen native inputs'}
$gmInputDirectory=Join-Path $gmRun 'inputs'
New-Item -ItemType Directory -Path $gmInputDirectory -Force|Out-Null
$gmInstalled=@()
foreach($gmPackage in $gmInputs.packages){
  if($gmPackage.name -notmatch '^[a-z0-9][a-z0-9-]*$' -or $gmPackage.version -notmatch '^[a-zA-Z0-9.+-]+$' -or $gmPackage.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid frozen package input metadata'}
  $gmHash=(Get-FileHash -LiteralPath $gmPackage.path -Algorithm SHA256).Hash.ToLowerInvariant()
  if($gmHash -ne $gmPackage.sha256){throw "Package hash mismatch: $($gmPackage.name)"}
  # A new content hash gets a new file URL; pnpm may cache an unchanged file URL/version.
  $gmArchive=Join-Path $gmInputDirectory "$($gmPackage.name)-$($gmPackage.version)-$gmHash.tgz"
  if(Test-Path -LiteralPath $gmArchive){if((Get-FileHash -LiteralPath $gmArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $gmHash){throw 'Immutable input archive changed'}}else{Copy-Item -LiteralPath $gmPackage.path -Destination $gmArchive}
  & $gmCli plugin --profile web add $gmArchive
  if($LASTEXITCODE -ne 0){throw "Native package installation failed: $($gmPackage.name)"}
  $gmManifest=Get-Content -LiteralPath (Join-Path $env:DSH_HOME "profiles/web/node_modules/$($gmPackage.name)/package.json") -Raw|ConvertFrom-Json
  if($gmManifest.version -ne $gmPackage.version){throw 'Installed manifest version differs from frozen input'}
  $gmInstalled+=@{name=$gmPackage.name;version=$gmManifest.version;sha256=$gmHash;archive=$gmArchive}
}
@{hostVersion=$gmHostVersion;packages=$gmInstalled}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $gmRun 'installed-inputs.json')
