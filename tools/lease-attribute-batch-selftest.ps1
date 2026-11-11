# Pure batch coordinator tests. All file/Shell dependencies are mocks.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../scripts/snap-lease.ps1')
$n=0
function Assert([bool]$v,[string]$name){if(-not $v){throw $name};$script:n++;Write-Host ('ok - '+$name)}
function Lease-CheckRecord($record){$script:preChecks++;if($script:fault -eq 'pre-metadata' -and $record.path -eq 'p2'){throw 'metadata-before-batch'};return @{hidden=$true}}
function Lease-Snapshot {$script:snaps++;return @{folderFlags=$(if($script:fault -eq 'post-flags' -and $script:snaps -eq 2){4}else{0})}}
function Lease-Guard($r,$s){$script:guards++;if($script:fault -eq 'post-old' -and $script:guards -eq 2){throw 'old-icon-changed'};return @{}}
function Lease-AssertFastOff($r,$off){$script:fast++;if($script:fast -eq 2 -and $script:fault -in @('flags','session')){throw ('changed-'+$script:fault)}}
function Lease-SetHidden($record,[bool]$hidden,$expected){
 if($hidden -ne $false -or $expected -ne $true){throw 'wrong expected mutation'}
 $script:attempts++;if($script:attempts -eq 2 -and $script:fault -eq 'metadata'){throw 'metadata-before-write'}
 $script:mutations++
}
function Run-Case([int]$count,[string]$fault){
 $script:fault=$fault;$script:preChecks=0;$script:snaps=0;$script:guards=0;$script:fast=0;$script:attempts=0;$script:mutations=0;$script:position=0;$script:LeaseBatchFailure=$null;$script:LeasePerf=@{}
 $r=@{records=@(0..($count-1)|ForEach-Object {@{path=('p'+$_)}})}
 try{Lease-RevealAttributeBatch $r 0;$script:position++;return $true}catch{return $false}
}
foreach($count in @(1,3,10)){
 $ok=Run-Case $count ''
 Assert ($ok -and $script:position -eq 1 -and $script:preChecks -eq $count -and $script:snaps -eq 2 -and $script:guards -eq 2 -and $script:fast -eq $count -and $script:mutations -eq $count) ('N='+$count+' full pre/post and every item witness')
 Assert ($script:LeasePerf.batchPreGuard.count -eq 1 -and $script:LeasePerf.batchPostGuard.count -eq 1 -and $script:LeasePerf.itemFastGuard.count -eq $count) ('N='+$count+' observer counts')
}
foreach($fault in @('flags','session','metadata')){
 $ok=Run-Case 3 $fault
 Assert (-not $ok -and $script:position -eq 0 -and $script:mutations -eq 1) ($fault+' after first mutation prevents position and further mutation')
 Assert ($script:LeaseBatchFailure.partialMutationPossible -and $script:LeaseBatchFailure.changedPaths.Count -eq 1 -and $script:LeaseBatchFailure.changedPaths[0] -eq 'p0') ($fault+' partial receipt retained')
}
$ok=Run-Case 3 'pre-metadata';Assert (-not $ok -and $script:position -eq 0 -and $script:mutations -eq 0 -and -not $script:LeaseBatchFailure.partialMutationPossible) 'all-record prevalidation precedes any mutation'
foreach($fault in @('post-old','post-flags')){$ok=Run-Case 3 $fault;Assert (-not $ok -and $script:position -eq 0 -and $script:LeaseBatchFailure.changedPaths.Count -eq 3) ($fault+' post guard prevents position')}
Write-Host ('lease attribute batch pure: '+$n+' passed; no native APIs invoked')
