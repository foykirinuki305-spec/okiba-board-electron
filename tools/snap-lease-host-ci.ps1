param([Parameter(Mandatory=$true)][string]$SpecPath)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted CI only'}
$spec=Get-Content -LiteralPath $SpecPath -Raw|ConvertFrom-Json
$worker=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList ('-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'snap-lease-worker-ci.ps1')+'" -SpecPath "'+$SpecPath+'"') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $spec.caseDir 'worker.stdout.log') -RedirectStandardError (Join-Path $spec.caseDir 'worker.stderr.log') -PassThru
$me=Get-Process -Id $PID
[IO.File]::WriteAllText((Join-Path $spec.caseDir 'host.json'),(@{hostPid=$PID;hostStart=$me.StartTime.ToUniversalTime().Ticks.ToString();workerPid=$worker.Id;workerStart=$worker.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress))
while($true){[IO.File]::WriteAllText((Join-Path $spec.caseDir 'heartbeat'),[DateTime]::UtcNow.ToString('o'));Start-Sleep -Milliseconds 200}
