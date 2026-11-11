# Pure PS mocks only. Loading functions does not invoke any native command.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'unknown-grid-lease-native-ci.ps1')
function ExpectThrow([scriptblock]$body){$threw=$false;try{& $body}catch{$threw=$true};if(-not $threw){throw 'expected rejection'}}
$r=@{originalFlags=4;flagState='on';records=@(@{identity='same';attributes=2;hidden=$true})}
Unknown-AssertFlags $r @{folderFlags=4}
ExpectThrow {Unknown-AssertFlags $r @{folderFlags=0}} # external OFF during calibration
$r.flagState='off';Unknown-AssertFlags $r @{folderFlags=0}
ExpectThrow {Unknown-AssertFlags $r @{folderFlags=4}} # external ON before calibration
foreach($state in @('on-intent','off-intent','restore-on-intent','bad')){$r.flagState=$state;ExpectThrow {Unknown-AssertFlags $r @{folderFlags=4}}}
$script:mockHidden=$true;$script:mockAttributes=2
function Lease-CheckRecord($record){return @{hidden=$script:mockHidden;attributes=$script:mockAttributes}}
Unknown-TerminalHidden $r
$script:mockHidden=$false;$script:mockAttributes=0
ExpectThrow {Unknown-TerminalHidden $r} # Explorer has not yet shown the unhidden file
$script:mockHidden=$true;$script:mockAttributes=34
ExpectThrow {Unknown-TerminalHidden $r} # unrelated attribute changed
Write-Output 'PASS pure exact phase flags and terminal Hidden/attributes guards; no Desktop API invoked'
