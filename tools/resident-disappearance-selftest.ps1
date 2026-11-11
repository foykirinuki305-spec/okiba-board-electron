$ErrorActionPreference='Stop'
# Functions only; all IO/native dependencies replaced below. No Desktop API is invoked.
. (Join-Path $PSScriptRoot '..\scripts\resident-lease.ps1')
$script:checks=0
function Check($ok,$why){if(-not $ok){throw $why};$script:checks++}
function Failure($code='0x80004005',$reason='shell-snapshot-error',$type='System.Runtime.InteropServices.COMException',$detail='Exception calling "ReadShellBatch"'){
 $e=[InvalidOperationException]::new('original-shell-error');$e.Data['snapshotFailure']=@{reason=$reason;hresult=$code;errorType=$type;detail=$detail};return $e
}
function Record($e){return [System.Management.Automation.ErrorRecord]::new($e,'mock',[System.Management.Automation.ErrorCategory]::ReadError,$null)}
Check (Resident-IsDisappearanceReadFailure (Record (Failure))) 'exact failure accepted'
foreach($e in @((Failure '0x80070490'),(Failure '0x80004005' 'desktop-changing'),(Failure '0x80004005' 'shell-snapshot-error' 'Other'),(Failure '0x80004005' 'shell-snapshot-error' 'System.Runtime.InteropServices.COMException' 'DifferentMethod'),([Exception]::new('E_FAIL ReadShellBatch')))) {Check (-not (Resident-IsDisappearanceReadFailure (Record $e))) 'non-specific failure rejected'}
function Resident-Locate($i){$script:sourceReads++;if($script:badSource){throw 'resident-source-changed'};return @{state='unmoved';record=@{attributes=32}}}
function Resident-AssertExactSessionFlags($r,$f){$script:flagReads++;if($script:badFlags){throw 'external-flags-changed'}}
function Lease-Snapshot {$script:snapshotReads++;$v=$script:queue.Dequeue();if($v -is [Exception]){throw $v};return $v}
function Lease-Guard($r,$s){if($s.badOld){throw 'lease-old-icon-moved'};if($s.visible){return @{owned=1}};return @{}}
function Start-Sleep {param($Milliseconds)}
function Setup($values){$script:queue=[Collections.Queue]::new();foreach($v in $values){$script:queue.Enqueue($v)};$script:sourceReads=0;$script:flagReads=0;$script:snapshotReads=0;$script:badSource=$false;$script:badFlags=$false;return @{residentRecords=@(@{originalAttributes=32});snapshot=@{}}}
$empty=@{folderFlags=0;visible=$false};$visible=@{folderFlags=0;visible=$true}
$r=Setup @($empty,(Failure),$empty,$empty);$null=Resident-WaitRestoredInvisible $r 0
Check ($script:snapshotReads -eq 4) 'error resets two-read stability'
Check ($r.disappearanceReadFailures.Count -eq 1) 'original failure retained'
Check ($script:sourceReads -ge 8 -and $script:flagReads -ge 5) 'identity and flags rechecked'
$r=Setup @($visible,$empty,$empty);$null=Resident-WaitRestoredInvisible $r 0;Check ($script:snapshotReads -eq 3) 'visible prevents early acceptance'
$r=Setup @((Failure),(Failure),(Failure),(Failure));$failed=$false;try{$null=Resident-WaitRestoredInvisible $r 0}catch{$failed=$true};Check ($failed -and $script:snapshotReads -eq 4) 'fourth read error blocks'
$r=Setup @((Failure '0x80070490'));$failed=$false;try{$null=Resident-WaitRestoredInvisible $r 0}catch{$failed=$true};Check ($failed -and $script:snapshotReads -eq 1) 'other HRESULT never retried'
foreach($mode in @('source','flag','old','snapshotflag')){
 $v=@{folderFlags=0;visible=$false};if($mode -eq 'old'){$v.badOld=$true};if($mode -eq 'snapshotflag'){$v.folderFlags=4}
 $r=Setup @($v,$empty);if($mode -eq 'source'){$script:badSource=$true};if($mode -eq 'flag'){$script:badFlags=$true}
 $failed=$false;try{$null=Resident-WaitRestoredInvisible $r 0}catch{$failed=$true};Check $failed ('guard rejection '+$mode)
}
Write-Output "resident disappearance pure: $script:checks PASS (all IO mocked)"
