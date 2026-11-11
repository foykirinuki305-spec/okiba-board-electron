# Only pure layout and negative gate validation. Does not read or set user settings.
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'show-hidden-fixture-ci.cs')
if([OkibaShowHiddenFixture]::StateBytes()-ne 32){throw 'SHELLSTATE wrong size'}
if([Runtime.InteropServices.Marshal]::OffsetOf([type]'OkibaShowHiddenFixture+ShellState','bits').ToInt32()-ne 0){throw 'bitfield offset wrong'}
if([Runtime.InteropServices.Marshal]::OffsetOf([type]'OkibaShowHiddenFixture+ShellState','lParamSort').ToInt32()-ne 12){throw 'LONG offset wrong'}
if([Runtime.InteropServices.Marshal]::OffsetOf([type]'OkibaShowHiddenFixture+ShellState','bits2').ToInt32()-ne 28){throw 'second bitfield offset wrong'}
# Remove CI flags so the setter exits before any native read or mutation.
$old=@{};foreach($key in @('GITHUB_ACTIONS','RUNNER_OS','RUNNER_ENVIRONMENT')){$old[$key]=[Environment]::GetEnvironmentVariable($key);[Environment]::SetEnvironmentVariable($key,$null)}
try{$blocked=$false;try{[OkibaShowHiddenFixture]::SetForCI($false,$true)|Out-Null}catch{if($_.Exception.ToString()-match 'hosted-CI-only-no-user-desktop'){$blocked=$true}else{throw}};if(-not $blocked){throw 'CI gate failed'}}finally{foreach($key in $old.Keys){[Environment]::SetEnvironmentVariable($key,$old[$key])}}
Write-Host 'show hidden fixture: 5 pure checks PASS; no setting reads/writes'
