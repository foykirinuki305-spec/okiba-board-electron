$ErrorActionPreference='Stop'
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$t,[ref]$e)
foreach($name in @('Strict-PointValid','Strict-Overlap')){$f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f.Extent.Text}
. (Join-Path $PSScriptRoot '../scripts/snap-lease.ps1')
function Lease-CheckRecord($r){return $r} # Pure mock. No filesystem or Shell calls.
$n=0
function Pass([bool]$yes,[string]$name){if(-not $yes){throw $name};$script:n++;Write-Host ('ok - '+$name)}
function Reject($f,[string]$expected){try{& $f|Out-Null}catch{Pass ($_.Exception.Message -ceq $expected) $expected;return};throw ('accepted '+$expected)}
function Clone-Data($a){return ($a|ConvertTo-Json -Depth 20|ConvertFrom-Json)}
$desktop=[Environment]::GetFolderPath('DesktopDirectory')
$s=@{ok=$true;identityVersion=1;explorerPid=1;explorerStarted='2';listviewHwnd=3;folderFlags=4;snap=$true;autoArrange=$false;shellAutoArrange=$false;origin=@{x=0;y=0};viewDpi=96;sx=100;sy=100;areas=@(@{left=0;top=0;right=1000;bottom=1000;scale=100;monitorOrigin=@{x=0;y=0};grid=@{gx=0;gy=0;sx=100;sy=100}});icons=@(@{identity='old';x=0;y=0;path='';label='old'})}
$r=@{version=1;token='abcdefghijklmnop';snapshot=$s;originalFlags=4;records=@(@{path=(Join-Path $desktop 'fixture.txt');identity='file';size='1';mtime='2';attributes=2;hidden=$true});targets=@(@{path=(Join-Path $desktop 'fixture.txt');x=200;y=0});targetAreaIndex=0}
Lease-ValidateRecovery $r $s;Pass $true 'valid lease recovery'
$c=Clone-Data $s;$c.folderFlags=0;$c.snap=$false
$null=Lease-Guard $r $c;Pass $true 'only owned snap bit may differ'
$c.folderFlags=8;Reject {Lease-Guard $r $c} 'lease-flags-changed'
$c=Clone-Data $s;$c.icons[0].x=100;Reject {Lease-Guard $r $c} 'lease-old-icon-moved'
$c=Clone-Data $s;$c.icons=@();Reject {Lease-Guard $r $c} 'lease-old-icon-disappeared'
$c=Clone-Data $s;$c.explorerStarted='4';Reject {Lease-Guard $r $c} 'lease-physical-changed'
$c=Clone-Data $s;$c.icons[0].x=1;Reject {Lease-AllGrid $s $c} 'lease-off-grid-icon'
$c=Clone-Data $s;$c.icons+=@{identity='extra';x=200;y=0;path=$r.targets[0].path}
$null=Lease-Guard $r $c $true;Lease-AllGrid $s $c;Pass $true 'selected exact target accepted'
$c.icons[1].x=201;Reject {Lease-Guard $r $c $true} 'lease-target-not-exact'
$c.icons[1].path=Join-Path $desktop 'unknown.txt';Reject {Lease-Guard $r $c} 'lease-unknown-new-icon'
$x=Clone-Data $r;$x.targetAreaIndex=-1;Reject {Lease-ValidateRecovery $x $s} 'lease-invalid-target-area'
$x=Clone-Data $r;$x.targets[0].x=0;Reject {Lease-ValidateRecovery $x $s} 'lease-target-occupied'
$x=Clone-Data $r;$x.targets[0].x=201;Reject {Lease-ValidateRecovery $x $s} 'lease-off-grid-target'
$x=Clone-Data $r;$x.snapshot.icons[0].path=$x.records[0].path;Reject {Lease-ValidateRecovery $x $s} 'lease-selected-baseline-visible'
$x=Clone-Data $r;$x.snapshot.areas[0].grid=$null;Reject {Lease-ValidateRecovery $x $s} 'lease-off-grid-icon'
$env:OKIBA_SNAP_LEASE=$null;$reply=Invoke-SnapLeaseRequest @{cmd='leasePrepare'};Pass (-not $reply.ok -and $reply.detail -eq 'lease-dedicated-helper-required') 'dedicated helper required'
Pass ($reply.perf.inclusive -and $reply.perf.metrics.total.count -eq 1) 'failure includes observer perf'
# Synthetic restore branch regression. Every OS operation is replaced with a mock.
function Lease-Snapshot {$script:readCount++;return $script:readQueue.Dequeue()}
function Lease-SetSnap($r,$s,[bool]$enabled){if(-not $enabled){throw 'unexpected disable'};$script:setCount++}
function Lease-CheckRecord($r){$script:fileChecks++;return @{hidden=$script:mockHidden}}
function Start-Sleep {param([int]$Milliseconds);$script:sleepMs+=$Milliseconds}
function Reset-RestoreMocks($snapshots){
 $script:readQueue=[Collections.Queue]::new();foreach($v in $snapshots){$script:readQueue.Enqueue($v)}
 $script:readCount=0;$script:setCount=0;$script:fileChecks=0;$script:sleepMs=0;$script:mockHidden=$false;$script:LeasePerf=@{}
}
$script:SnapLease=$r
$visible=Clone-Data $s;$visible.icons+=@{identity='selected';path=$r.targets[0].path;x=200;y=0}
Reset-RestoreMocks @($visible)
$reply=Lease-RestoreVerify $r.token
Pass ($reply.ok -and $reply.restoreMode -eq 'already-enabled-fresh-verification' -and $script:readCount -eq 1 -and $script:setCount -eq 0 -and $script:sleepMs -eq 0 -and $script:fileChecks -eq 1) 'already ON keeps fresh full checks without redundant transition wait'
Pass ($script:LeasePerf.restoreAlreadyEnabled.count -eq 1 -and -not $script:LeasePerf.ContainsKey('restoreSettle')) 'already ON skip is observable'
$off=Clone-Data $visible;$off.folderFlags=0;$off.snap=$false
Reset-RestoreMocks @($off,$visible)
$reply=Lease-RestoreVerify $r.token
Pass ($reply.ok -and $reply.restoreMode -eq 'changed-and-settled' -and $script:readCount -eq 2 -and $script:setCount -eq 1 -and $script:sleepMs -eq 250 -and $script:fileChecks -eq 1) 'OFF to ON retains setter wait and fresh final guard'
$changed=Clone-Data $visible;$changed.icons[0].x=100
Reset-RestoreMocks @($changed)
Reject {Lease-RestoreVerify $r.token} 'lease-old-icon-moved'
Reset-RestoreMocks @($visible);$script:mockHidden=$true
Reject {Lease-RestoreVerify $r.token} 'lease-target-hidden'
Reset-RestoreMocks @($off,$changed)
Reject {Lease-RestoreVerify $r.token} 'lease-old-icon-moved'
$script:SnapLease=$null;$script:LeasePerf=$null
Write-Host ('snap lease pure: '+$n+' passed; no desktop mutations')

