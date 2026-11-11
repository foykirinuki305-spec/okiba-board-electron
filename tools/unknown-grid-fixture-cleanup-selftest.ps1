# Pure cleanup transaction mocks. No filesystem/Process/Shell API.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'unknown-grid-fixture-cleanup-ci.ps1')
$script:SnapLease=$null;$script:hidden=$false;$script:sets=0;$script:oldChanged=$false;$script:flags=4;$script:expectedIdentity='owned';$script:visibilityReads=0
function Unknown-CIOnly {}
function Lease-Path($p){return $p}
function Unknown-Current($r){if($script:oldChanged){throw 'old-changed'};if($script:flags -ne $r.originalFlags){throw 'flags-changed'};foreach($n in $r.records){if($n.identity -cne $script:expectedIdentity -or $n.path -cne 'owned-fixture'){throw 'record-changed'}};return @{folderFlags=$script:flags}}
function Lease-Guard($r,$s){if($script:hidden){return @{}};return @{selected=1}}
function Lease-CheckRecord($r){if($r.identity -cne $script:expectedIdentity){throw 'identity-changed'};return @{hidden=$script:hidden}}
function Lease-SetHidden($r,$value,$expected){if($script:hidden -ne $expected){throw 'hidden-race'};$script:hidden=$value;$script:sets++}
function Lease-WaitVisibility($r,$visible){if($visible -or -not $script:hidden){throw 'not-absent'};for($i=0;$i -lt 2;$i++){$null=Unknown-Current $r;$script:visibilityReads++};return @{folderFlags=$script:flags}}
function Unknown-AssertFlags($r,$s){if($r.originalFlags -ne $s.folderFlags){throw 'flags-changed'}}
function Unknown-TerminalHidden($r){if(-not $script:hidden){throw 'hidden-missing'}}
function Reject($block){$failed=$false;try{&$block}catch{$failed=$true};if(-not $failed){throw 'rejection-required'}}
$q=@{snapshot=@{folderFlags=4};records=@(@{path='owned-fixture';identity='owned'})}
$r=Unknown-FixtureHideCleanup $q;if(-not $r.ok -or $script:sets -ne 1 -or $script:visibilityReads -ne 2){throw 'cleanup-did-not-verify'}
$r=Unknown-FixtureHideCleanup $q;if(-not $r.ok -or $script:sets -ne 1){throw 'cleanup-not-idempotent'}
$script:oldChanged=$true;Reject {Unknown-FixtureHideCleanup $q};$script:oldChanged=$false;$script:flags=0;Reject {Unknown-FixtureHideCleanup $q};$script:flags=4;$script:expectedIdentity='replaced';Reject {Unknown-FixtureHideCleanup $q};$script:expectedIdentity='owned';$script:SnapLease=@{};Reject {Unknown-FixtureHideCleanup $q}
Write-Output 'PASS pure owned cleanup hide/invisible verification, idempotence and old/flags/identity/active lease refusal'
