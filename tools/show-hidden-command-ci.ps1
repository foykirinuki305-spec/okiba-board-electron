# Hosted fixture only; no production helper dependency.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted CI only'}
Add-Type -Path (Join-Path $PSScriptRoot 'show-hidden-fixture-ci.cs')
if($env:OKIBA_SHOW_ACTION -eq 'read'){@{value=[OkibaShowHiddenFixture]::Read()}|ConvertTo-Json -Compress}
elseif($env:OKIBA_SHOW_ACTION -eq 'set') {[OkibaShowHiddenFixture]::SetForCI(($env:OKIBA_SHOW_EXPECTED -eq 'true'),($env:OKIBA_SHOW_VALUE -eq 'true'))|ConvertTo-Json -Compress}
else{throw 'Unknown action'}
