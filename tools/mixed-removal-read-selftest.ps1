# Pure fake snapshot/native-record tests. No Desktop access or OS calls.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../scripts/mixed-lease.ps1')
Add-Type 'public static class OkibaFolderView {public static int calls=0;public static bool fail=false;public static void AssertLeaseExactSessionFlags(uint f,long h,int p,string b){calls++;if(fail||f!=0)throw new System.Exception("session-changed");}}'
function Start-Sleep {param($Milliseconds)}
function Lease-Path($p){return $p}
function Lease-CheckRecord($r){if($script:badFile){throw 'file-changed'};return @{hidden=$true;attributes=34}}
function Resident-Locate($r){return @{state=$(if($script:unmoved){'unmoved'}else{'moved'});record=@{hidden=$true;attributes=34}}}
function Resident-Same($a,$b){return (-not $script:badIdentity)}
function Lease-Guard($r,$s){if($s.badOld){throw 'old-changed'};if($s.selected){return @{p=@{identity='new';path='p';x=0;y=0}}};return @{}}
function Lease-Snapshot {
 if($script:index -ge $script:sequence.Count){throw 'sequence-exhausted'};$v=$script:sequence[$script:index++];
 if($v -is [string]){$e=[InvalidOperationException]::new('lease-snapshot-shell-snapshot-error');$e.Data['snapshotFailure']=@{reason='shell-snapshot-error';errorType='System.Runtime.InteropServices.COMException';hresult=$v;detail='Exception calling ReadShellBatch'};throw $e}
 return $v
}
$r=@{snapshot=@{listviewHwnd=1;explorerPid=1;explorerStarted='1';icons=@()};records=@(@{path='p'});linkRecords=@(@{attributes=34});residentRecords=@(@{originalAttributes=32})}
$zero=@{folderFlags=0;selected=$false};$one=@{folderFlags=0;selected=$true};$bad=@{folderFlags=0;badOld=$true}
function Reset($seq){$script:sequence=$seq;$script:index=0;$script:badFile=$false;$script:badIdentity=$false;$script:unmoved=$false;[OkibaFolderView]::fail=$false;[OkibaFolderView]::calls=0;$script:LeasePhase='mixed-rollback-pre-rename-visibility'}
function Reject([scriptblock]$work){$caught=$false;try{& $work}catch{$caught=$true};if(-not $caught){throw 'unexpected acceptance'}}
Reset @($zero,'0x80070490',$zero,$zero);$null=Mixed-WaitVisibility $r $false $true;if($script:index -ne 4 -or [OkibaFolderView]::calls -ne 2){throw 'reset/new 2 full snapshots required'}
Reset @($one,'0x80070490',$one,'0x80070490',$one,'0x80070490',$zero,$zero);$null=Mixed-WaitVisibility $r $false $true;if([OkibaFolderView]::calls -ne 6){throw 'three bounded rechecks'}
Reset @($one,'0x80070490',$one,'0x80070490',$one,'0x80070490',$one,'0x80070490',$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true}
Reset @('0x80070490',$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true};if([OkibaFolderView]::calls){throw 'initial failure cannot retry'}
Reset @($one,'0x80004005',$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',$zero,$zero);Reject {Mixed-WaitVisibility $r $false}
Reset @($one,'0x80070490',$zero,$zero);$script:LeasePhase='mixed-rollback-visibility';Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',$zero,$zero);Reject {Mixed-WaitVisibility $r $true $true}
Reset @($one,'0x80070490',$zero,$zero);$script:badFile=$true;Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',$zero,$zero);$script:badIdentity=$true;Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',$zero,$zero);$script:unmoved=$true;Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',$zero,$zero);[OkibaFolderView]::fail=$true;Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',$bad,$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490','0x80070490',$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,'0x80070490',@{folderFlags=4;selected=$false},$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true}
Reset @($one,@{folderFlags=4;selected=$false},$zero,$zero);Reject {Mixed-WaitVisibility $r $false $true}
# Without explicit retry eligibility the existing general visibility contract remains unchanged.
Reset @($zero,@{folderFlags=4;selected=$false});$null=Mixed-WaitVisibility $r $false
foreach($field in @('reason','errorType','hresult','detail')){$e=[InvalidOperationException]::new('x');$e.Data['snapshotFailure']=@{reason='shell-snapshot-error';errorType='System.Runtime.InteropServices.COMException';hresult='0x80070490';detail='ReadShellBatch'};$e.Data['snapshotFailure'][$field]='unexpected';$er=[Management.Automation.ErrorRecord]::new($e,'x',[Management.Automation.ErrorCategory]::NotSpecified,$null);if(Mixed-IsRemovalReadFailure $er){throw ('unexpected classifier acceptance '+$field)}}
'PASS mixed removal read: 21 positive/negative pure sequences; zero native/rename/setter calls'
