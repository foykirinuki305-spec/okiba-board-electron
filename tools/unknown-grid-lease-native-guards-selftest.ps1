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

foreach($phase in @('abort-only','calibrating','abort-hidden','aborted','targets-resolved')){ExpectThrow {Unknown-AssertVisiblePhase @{phase=$phase}}}
foreach($phase in @('resolved-restored','resolve-only')){Unknown-AssertVisiblePhase @{phase=$phase}}
if(-not (Unknown-VisibleAttributesMatch 2 128) -or -not (Unknown-VisibleAttributesMatch 34 32)){throw 'normal-attribute-normalization-failed'}
if((Unknown-VisibleAttributesMatch 2 32) -or (Unknown-VisibleAttributesMatch 34 128) -or (Unknown-VisibleAttributesMatch 2 2)){throw 'foreign-attribute-accepted'}
function Strict-GeometryKey($s){return $s.key}
function Strict-IconsKey($s){return $s.iconsKey}
$original=@{key='geometry';iconsKey='old-icons'}
$bound=@{token='owned';records=@(@{path='probe'});snapshot=$original;success=@{baseline=$original;binding=@{token='owned';probeId='probe';geometryKey='geometry';iconsKey='old-icons'}}}
Unknown-AssertProofBinding $bound
foreach($key in @('token','probeId','geometryKey','iconsKey')){$before=$bound.success.binding[$key];$bound.success.binding[$key]='foreign';ExpectThrow {Unknown-AssertProofBinding $bound};$bound.success.binding[$key]=$before}
$bound.snapshot=@{key='changed';iconsKey='old-icons'};ExpectThrow {Unknown-AssertProofBinding $bound}
Write-Output 'PASS native pure abort-only visible refusal, NORMAL normalization and immutable proof binding'
