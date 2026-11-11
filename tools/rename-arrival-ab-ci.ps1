param([ValidateSet('none','notify','delete-create')][string]$Mode='none')
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS-ne'true'-or$env:RUNNER_OS-ne'Windows'-or$env:RUNNER_ENVIRONMENT-ne'github-hosted'){throw 'Hosted Windows CI only; user Desktop forbidden'}
. (Join-Path $PSScriptRoot 'desktop-fixture-guard.ps1')
$original=[OkibaFolderView]::ReadState();if($null-eq$original-or$original.Length-lt2){throw 'Cannot read Shell state'}
$exitCode=1;$baseline=$null
try{
 [OkibaFolderView]::SetFlagsForCI([uint32]5,[uint32]4);Start-Sleep -Milliseconds 300
 $actual=[OkibaFolderView]::ReadState();if(($actual[0]-band5)-ne4-or$actual[1]-ne0){throw 'Manual snap-to-grid not confirmed'}
 $baseline=Start-FixtureGuard
 & node (Join-Path $PSScriptRoot 'rename-arrival-ab-ci.js') ([Environment]::GetFolderPath('DesktopDirectory')) $Mode
 $exitCode=$LASTEXITCODE
}finally{
 try{if($null-ne$baseline){$report=Join-Path $PSScriptRoot ('..\rename-arrival-'+$Mode+'-ci.json');if(Test-Path -LiteralPath $report){$r=Get-Content -LiteralPath $report -Raw|ConvertFrom-Json;if($r.cleanupError){throw $r.cleanupError};Complete-FixtureGuard $baseline @($r.owned)}else{throw 'Missing cleanup ownership report'}}}
 finally{[OkibaFolderView]::SetFlagsForCI([uint32]5,[uint32]($original[0]-band5));$restored=[OkibaFolderView]::ReadState();if(($restored[0]-band5)-ne($original[0]-band5)-or$restored[1]-ne$original[1]){throw 'Original Shell state restoration failed'}}
}
exit $exitCode
