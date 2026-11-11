# Prototype never toggles settings. Initial native state must already be safe.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted Windows CI only'}
& node (Join-Path $PSScriptRoot 'calibration-adaptive-ci.js') ([Environment]::GetFolderPath('Desktop'))
$code=$LASTEXITCODE
$evidence=Join-Path $PSScriptRoot '..\calibration-adaptive-ci.json'
if(-not(Test-Path -LiteralPath $evidence)){throw 'No cleanup evidence; blind restore forbidden'}
$report=Get-Content -LiteralPath $evidence -Raw|ConvertFrom-Json
if(-not $report.cleanupVerified){throw 'Cleanup not verified; blind restore forbidden'}
exit $code
