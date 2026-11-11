param([Parameter(Mandatory=$true)][ValidateSet('baseline-first','candidate-first')][string]$Order)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){
 throw 'Hosted disposable Windows CI only; user Desktop is forbidden.'
}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence=Join-Path $root 'desktop-lease-key-evidence'
if(Test-Path -LiteralPath $evidence){throw 'Evidence already exists; refusing overwrite'}
$null=New-Item -ItemType Directory -Path $evidence
$definitions=@{
 baseline=@{name='baseline';ref='2a55eeebc649a41804cb9e618fc8629e8730af7a';source=(Join-Path $root '..\key-baseline')}
 candidate=@{name='candidate';ref='705fc7c88d8b5534fa224671c5c8d759792308d3';source=(Join-Path $root '..\key-candidate')}
}
$sequence=if($Order -eq 'baseline-first'){@('baseline','candidate')}else{@('candidate','baseline')}
$report=@{order=$Order;passed=$false;runs=@();scope='Same-runner sequential pinned canonical-key optimization comparison (terminal release fix c3dbd00 is absent from both measured revisions): 42 fixture links plus 3 guards, N3/N6 each one warmup and five measured rounds. Each revision keeps one warm helper. Reverse order uses another runner, so order effects and runner variance remain. Not 202-icon Desktop or mixed-DPI evidence.'}
try{
 foreach($name in $sequence){
  $d=$definitions[$name];$source=(Resolve-Path -LiteralPath $d.source).Path
  $actual=(& git -C $source rev-parse HEAD).Trim();if($LASTEXITCODE -ne 0 -or $actual -cne $d.ref){throw 'Pinned source SHA mismatch'}
  $dirty=& git -C $source status --porcelain;if($LASTEXITCODE -ne 0 -or $dirty){throw 'Pinned source is not clean'}
  $runDir=Join-Path $evidence $name;$null=New-Item -ItemType Directory -Path $runDir
  $json=Join-Path $root 'desktop-lease-warm-ci.json';$journals=Join-Path $root 'desktop-lease-warm-journals'
  if((Test-Path -LiteralPath $json) -or (Test-Path -LiteralPath $journals)){throw 'Previous evidence not archived; refusing to overwrite'}
  $exitCode=-1
  try{
   & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'desktop-lease-warm-ci.ps1') -SourceRoot $source -SourceRef $d.ref 2>&1 | Tee-Object -FilePath (Join-Path $runDir 'warm.log')
   $exitCode=$LASTEXITCODE
  }finally{
   if(Test-Path -LiteralPath $json){Move-Item -LiteralPath $json -Destination (Join-Path $runDir 'warm.json')}
   if(Test-Path -LiteralPath $journals){Move-Item -LiteralPath $journals -Destination (Join-Path $runDir 'journals')}
  }
  $saved=Join-Path $runDir 'warm.json';if(-not (Test-Path -LiteralPath $saved)){throw 'Missing cleanup evidence; second revision must not start'}
  $r=Get-Content -LiteralPath $saved -Raw|ConvertFrom-Json
  $entry=@{name=$name;ref=$d.ref;exitCode=$exitCode;passed=$r.passed;cleanupVerified=$r.cleanupVerified;summary=$r.summary}
  $report.runs+=,$entry
  if($exitCode -ne 0 -or $r.passed -ne $true -or $r.cleanupVerified -ne $true -or $r.cleanupBlocked){throw 'Run/cleanup/process safety gate failed; second revision must not start'}
  if($r.sourceRef -cne $d.ref -or @($r.samples).Count -ne 12){throw 'Unexpected source or sample count'}
  foreach($count in @(3,6)){
   if(@($r.samples|Where-Object {$_.count -eq $count -and -not $_.warmup}).Count -ne 5){throw 'Missing measured repetitions'}
  }
  Write-Host ('Verified complete cleanup and original flag restoration before proceeding: '+$name)
 }
 $report.passed=$true
} catch {
 $report.error=$_.Exception.Message
 throw
} finally {
 $report|ConvertTo-Json -Depth 40|Set-Content -LiteralPath (Join-Path $evidence 'sequence.json') -Encoding utf8
}
