# Dedicated watchdog lease commands. No main.js call site is enabled.
$script:SnapLease=$null
$script:LeasePhase='idle'
$script:LeasePerf=$null
function Add-LeasePerf([string]$name,$clock){
 if($null -eq $script:LeasePerf){return}
 if(-not $script:LeasePerf.ContainsKey($name)){$script:LeasePerf[$name]=@{count=0;ms=0.0}}
 $script:LeasePerf[$name].count++;$script:LeasePerf[$name].ms+=$clock.Elapsed.TotalMilliseconds
}
function Measure-LeaseStep([string]$name,[scriptblock]$work){
 $clock=[Diagnostics.Stopwatch]::StartNew()
 try{return (& $work)}finally{Add-LeasePerf $name $clock}
}

function Lease-PhysicalKey($s) {
 return (@($s.explorerPid,$s.explorerStarted,$s.listviewHwnd,[int]$s.origin.x,[int]$s.origin.y,$s.viewDpi,$s.sx,$s.sy,@($s.areas|ForEach-Object{@($_.left,$_.top,$_.right,$_.bottom,$_.scale,[int]$_.monitorOrigin.x,[int]$_.monitorOrigin.y)}))|ConvertTo-Json -Depth 10 -Compress)
}
function Lease-Path([string]$p){return [IO.Path]::GetFullPath($p).TrimEnd('\')}
function Lease-Snapshot {
 $metricClock=[Diagnostics.Stopwatch]::StartNew()
 try{
 $deadline=[DateTime]::UtcNow.AddSeconds(8)
 do{$s=Get-StrictDesktopSnapshot;if($s.ok){return $s};if($s.reason -ne 'desktop-changing'){throw ('lease-snapshot-'+$s.reason)};Start-Sleep -Milliseconds 50}while([DateTime]::UtcNow -lt $deadline)
 throw 'lease-snapshot-timeout'
 }finally{Add-LeasePerf 'snapshot' $metricClock}
}
function Lease-AllGrid($baseline,$current) {
 foreach($i in $current.icons){
  $areas=@($baseline.areas|Where-Object {$i.x -ge $_.left -and $i.x -lt $_.right -and $i.y -ge $_.top -and $i.y -lt $_.bottom})
  if($areas.Count -ne 1){throw 'lease-icon-outside-monitor'};$g=$areas[0].grid
  if($null -eq $g -or $g.sx -le 0 -or $g.sy -le 0 -or (($i.x-$g.gx)%$g.sx) -ne 0 -or (($i.y-$g.gy)%$g.sy) -ne 0){throw 'lease-off-grid-icon'}
 }
}
function Lease-Guard($r,$current,[bool]$exact=$false) {
 if(-not $current.ok -or (Lease-PhysicalKey $r.snapshot) -cne (Lease-PhysicalKey $current)){throw 'lease-physical-changed'}
 if($current.autoArrange -or $current.shellAutoArrange){throw 'lease-autoarrange-changed'}
 $on=[uint32]$r.originalFlags;$off=$on -band ([uint32]::MaxValue -bxor 4)
 if($r.restored -eq $true -and ([uint32]$current.folderFlags -ne $on -or -not $current.snap)){throw 'lease-post-restore-flags-changed'}
 if([uint32]$current.folderFlags -ne $on -and [uint32]$current.folderFlags -ne $off){throw 'lease-flags-changed'}
 $old=@{};foreach($i in $r.snapshot.icons){if([string]::IsNullOrEmpty($i.identity) -or $old.ContainsKey($i.identity)){throw 'lease-invalid-baseline'};$old[$i.identity]=$i}
 $seen=@{};$selected=@{}
 foreach($i in $current.icons){
  if([string]::IsNullOrEmpty($i.identity) -or $seen.ContainsKey($i.identity)){throw 'lease-duplicate-identity'};$seen[$i.identity]=$true
  if($old.ContainsKey($i.identity)){$o=$old[$i.identity];if($o.x -ne $i.x -or $o.y -ne $i.y){throw 'lease-old-icon-moved'}}
  else{
   if([string]::IsNullOrEmpty($i.path)){throw 'lease-unknown-new-icon'}
   $path=Lease-Path $i.path;$matches=@($r.records|Where-Object {(Lease-Path $_.path) -ieq $path})
   if($matches.Count -ne 1 -or $selected.ContainsKey($path)){throw 'lease-unknown-new-icon'};$selected[$path]=$i
  }
 }
 foreach($id in $old.Keys){if(-not $seen.ContainsKey($id)){throw 'lease-old-icon-disappeared'}}
 if($exact){foreach($t in $r.targets){$path=Lease-Path $t.path;if(-not $selected.ContainsKey($path) -or $selected[$path].x -ne $t.x -or $selected[$path].y -ne $t.y){throw 'lease-target-not-exact'}}}
 return $selected
}
function Lease-ReadRecord([string]$path) {
 $path=Lease-Path $path;$n=[OkibaFileAttributes]::Read($path)
 if($n.directory){throw 'lease-directory-not-supported'}
 return @{path=$path;identity=$n.identity;size=$n.size;mtime=$n.mtime;attributes=$n.attributes;hidden=$n.hidden}
}
function Lease-OtherAttributes([uint32]$attributes){return ($attributes -band ([uint32]::MaxValue -bxor 130))}
function Lease-CheckRecord($record) {
 $metricClock=[Diagnostics.Stopwatch]::StartNew()
 try{
 $n=Lease-ReadRecord $record.path
 if($n.identity -cne $record.identity -or $n.size -cne $record.size -or $n.mtime -cne $record.mtime -or (Lease-OtherAttributes $n.attributes) -ne (Lease-OtherAttributes $record.attributes)){throw 'lease-selected-file-changed'}
 return $n
 }finally{Add-LeasePerf 'metadatafilechecks' $metricClock}
}
function Lease-SetHidden($record,[bool]$hidden,$expectedHidden=$null){
 $n=Lease-CheckRecord $record
 if($null -ne $expectedHidden -and $n.hidden -ne [bool]$expectedHidden){throw 'lease-selected-hidden-state-changed'}
 Measure-LeaseStep 'attributes' {$null=[OkibaFileAttributes]::SetRecordedAndNotify($record.path,$record.identity,$n.hidden,$hidden,$record.size,$record.mtime,[uint32]$record.attributes)}
}
function Lease-SetSnap($r,$current,[bool]$enabled){
 $script:LeasePhase=if($enabled){'native-snap-enable'}else{'native-snap-disable'}
 $null=Lease-Guard $r $current
 if($enabled){Lease-AllGrid $r.snapshot $current}
 Measure-LeaseStep $(if($enabled){'restoreNative'}else{'disable'}) {[OkibaFolderView]::SetLeaseSnap([uint32]$current.folderFlags,$enabled,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted,[string[]]@($current.icons.identity),[int[]]@($current.icons.x),[int[]]@($current.icons.y))}
}
function Lease-Require([string]$token){
 if($null -eq $script:SnapLease -or $script:SnapLease.token -cne $token){throw 'lease-token-invalid'}
 return $script:SnapLease
}
function Lease-ValidateRecovery($r,$current){
 if($r.kind -ceq 'resident-archive-samevolume'){Resident-Validate $r $current;return}
 if($r.snapshot.identityVersion -ne 1){throw 'lease-invalid-identity-version'}
 if($r.version -ne 1 -or [string]::IsNullOrEmpty($r.token) -or -not $r.snapshot.ok -or @($r.records).Count -lt 1 -or @($r.records).Count -gt 1000 -or @($r.targets).Count -ne @($r.records).Count){throw 'lease-invalid-recovery'}
 if(([uint32]$r.originalFlags -band 5) -ne 4 -or [uint32]$r.snapshot.folderFlags -ne [uint32]$r.originalFlags -or $r.snapshot.autoArrange -or -not $r.snapshot.snap){throw 'lease-invalid-original-flags'}
 $desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'));$paths=@{}
 foreach($record in $r.records){
  $p=Lease-Path $record.path
  if((Lease-Path ([IO.Path]::GetDirectoryName($p))) -ine $desktop -or $paths.ContainsKey($p) -or ($record.attributes -band 2) -eq 0){throw 'lease-invalid-selected-path'};$paths[$p]=$true
  foreach($old in $r.snapshot.icons){if($old.path -and (Lease-Path $old.path) -ieq $p){throw 'lease-selected-baseline-visible'}}
  $null=Lease-CheckRecord $record
 }
 Lease-AllGrid $r.snapshot $r.snapshot
 if($null -eq $r.targetAreaIndex -or [double]$r.targetAreaIndex -ne [int]$r.targetAreaIndex -or $r.targetAreaIndex -lt 0 -or $r.targetAreaIndex -ge @($r.snapshot.areas).Count){throw 'lease-invalid-target-area'}
 $area=$r.snapshot.areas[[int]$r.targetAreaIndex];$g=$area.grid
 if($null -eq $g -or $g.sx -le 0 -or $g.sy -le 0){throw 'lease-unknown-target-grid'}
 $seen=@{};$prior=@()
 foreach($t in $r.targets){
  $path=Lease-Path $t.path
  if(-not $paths.ContainsKey($path) -or $seen.ContainsKey($path) -or -not (Strict-PointValid $t)){throw 'lease-invalid-target'};$seen[$path]=$true
  if($t.x -lt $area.left -or $t.y -lt $area.top -or $t.x+$g.sx -gt $area.right -or $t.y+$g.sy -gt $area.bottom -or (($t.x-$g.gx)%$g.sx) -ne 0 -or (($t.y-$g.gy)%$g.sy) -ne 0){throw 'lease-off-grid-target'}
  foreach($i in @($r.snapshot.icons)+@($prior)){if(Strict-Overlap $t $i $g){throw 'lease-target-occupied'}};$prior+=,$t
 }
 $null=Lease-Guard $r $current
}
function Lease-Prepare($req){
 if($null -ne $script:SnapLease){throw 'lease-already-active'}
 if($req.token -isnot [string] -or $req.token -notmatch '^[A-Za-z0-9_-]{16,128}$'){throw 'lease-invalid-token'}
 $owner=[OkibaLeaseOwner]::Read();if($owner.state -ne 'alive'){throw 'lease-owner-not-alive'}
 $scope=$req.scope
 if($scope.kind -ceq 'resident-archive-samevolume'){return Resident-Prepare $req $owner}
 if($scope.kind -ne 'samepath-hidden' -or @($scope.items).Count -lt 1 -or @($scope.items).Count -gt 1000){throw 'lease-invalid-scope'}
 $current=Lease-Snapshot
 if(-not $scope.snapshot.ok -or (Strict-GeometryKey $scope.snapshot) -cne (Strict-GeometryKey $current) -or (Strict-IconsKey $scope.snapshot) -cne (Strict-IconsKey $current)){throw 'lease-baseline-changed'}
 $desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'))
 if((Lease-Path $scope.desktop) -ine $desktop){throw 'lease-wrong-desktop'}
 $records=@()
 foreach($item in $scope.items){
  if((Lease-Path $item.path) -ine (Lease-Path $item.destination) -or $item.hidden -ne $true){throw 'lease-not-samepath-hidden'}
  $record=Lease-ReadRecord $item.path
  if(-not $record.hidden -or $record.identity -cne $item.fileIdentity){throw 'lease-selected-not-hidden-or-replaced'};$records+=,$record
 }
 $r=@{version=1;token=$req.token;snapshot=$current;records=$records;originalFlags=[uint32]$current.folderFlags;targets=@($scope.targets);targetAreaIndex=$scope.targetAreaIndex;owner=@{pid=$owner.pid;started=$owner.started}}
 Lease-ValidateRecovery $r $current
 $selected=Lease-Guard $r $current;if($selected.Count -ne 0){throw 'lease-selected-already-visible'}
 $script:SnapLease=$r
 return @{ok=$true;recovery=$r}
}
function Lease-WaitVisibility($r,[bool]$visible){
 $until=[DateTime]::UtcNow.AddSeconds(15);$stable=0
 do{
  $s=Lease-Snapshot;$selected=Lease-Guard $r $s
  if(($visible -and $selected.Count -eq @($r.records).Count) -or (-not $visible -and $selected.Count -eq 0)){$stable++}else{$stable=0}
  if($stable -ge 2){return $s};Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $until)
 throw 'lease-visibility-timeout'
}
function Lease-AssertFastOff($r,[uint32]$off){
 [OkibaFolderView]::AssertLeaseSessionFlags($off,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)
}
function Lease-RevealAttributeBatch($r,[uint32]$off){
 $attempted=New-Object 'System.Collections.Generic.List[string]';$changed=New-Object 'System.Collections.Generic.List[string]'
 try{
  foreach($record in $r.records){if(-not (Lease-CheckRecord $record).hidden){throw 'lease-selected-not-hidden'}}
  $before=Measure-LeaseStep 'batchPreGuard' {Lease-Snapshot};$null=Lease-Guard $r $before
  if([uint32]$before.folderFlags -ne $off){throw 'lease-flags-changed'}
  foreach($record in $r.records){
   Measure-LeaseStep 'itemFastGuard' {Lease-AssertFastOff $r $off}
   $attempted.Add([string]$record.path)
   Lease-SetHidden $record $false $true
   $changed.Add([string]$record.path)
  }
  $after=Measure-LeaseStep 'batchPostGuard' {Lease-Snapshot};$null=Lease-Guard $r $after
  if([uint32]$after.folderFlags -ne $off){throw 'lease-flags-changed'}
 }catch{
  # A setter can fail after mutation; attemptedPaths is deliberately conservative.
  $script:LeaseBatchFailure=@{attemptedPaths=@($attempted.ToArray());changedPaths=@($changed.ToArray());partialMutationPossible=($attempted.Count -gt 0)}
  throw
 }
}
function Lease-RevealPlace([string]$token){
 $resident=Lease-Require $token;if($resident.kind -ceq 'resident-archive-samevolume'){return Resident-RevealPlace $resident}
 $script:LeasePhase='reveal-preflight'
 $r=Lease-Require $token;if(([OkibaLeaseOwner]::Read()).state -ne 'alive'){throw 'lease-owner-not-alive'};$s=Lease-Snapshot;Lease-ValidateRecovery $r $s
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){throw 'lease-not-initial-flags'}
 foreach($record in $r.records){if(-not (Lease-CheckRecord $record).hidden){throw 'lease-selected-not-hidden'}}
 if((Lease-Guard $r $s).Count -ne 0){throw 'lease-selected-visible-before-reveal'}
 Lease-SetSnap $r $s $false
 $off=[uint32]$r.originalFlags -band ([uint32]::MaxValue -bxor 4)
 $script:LeasePhase='reveal-attributes'
 Lease-RevealAttributeBatch $r $off
 $script:LeasePhase='reveal-arrival'
 $s=Measure-LeaseStep 'arrival' {Lease-WaitVisibility $r $true};$selected=Lease-Guard $r $s
 if([uint32]$s.folderFlags -ne $off){throw 'lease-flags-changed'}
 $ids=@();$paths=@();$xs=@();$ys=@();$tx=@();$ty=@()
 foreach($t in $r.targets){$i=$selected[(Lease-Path $t.path)];$ids+=$i.identity;$paths+=$t.path;$xs+=$i.x;$ys+=$i.y;$tx+=$t.x;$ty+=$t.y}
 $script:LeasePhase='native-place'
 Measure-LeaseStep 'nativePosition' {[OkibaFolderView]::PositionLeaseItems([string[]]$ids,[string[]]$paths,[int[]]$xs,[int[]]$ys,[int[]]$tx,[int[]]$ty,$off,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)}
 $script:LeasePhase='after-place'
 Measure-LeaseStep 'settle' {Start-Sleep -Milliseconds 180}
 $s=Measure-LeaseStep 'afterguard' {Lease-Snapshot};Measure-LeaseStep 'exactGuard' {$null=Lease-Guard $r $s $true}
 if([uint32]$s.folderFlags -ne $off){throw 'lease-flags-changed'}
 return @{ok=$true;oldUnchanged=$true;targetsExact=$true;snapRestored=$false}
}
function Lease-MarkRestored($r){
 if($r -is [Collections.IDictionary]){$r['restored']=$true}else{$r|Add-Member -NotePropertyName restored -NotePropertyValue $true -Force}
}
function Lease-AdoptRestoration($r,$current,[string]$state){
 if($state -notin @('not-attempted','attempted','verified')){throw 'lease-restoration-state-unknown'}
 if($state -eq 'not-attempted'){
  if($r.restored -eq $true){throw 'lease-restoration-state-conflict'}
  return
 }
 # A timed-out restore may have completed before its response was lost. OFF is
 # ambiguous after that boundary: do not overwrite a possible user's new choice.
 if([uint32]$current.folderFlags -ne [uint32]$r.originalFlags -or -not $current.snap){throw 'lease-restoration-outcome-unknown'}
 Lease-MarkRestored $r
}
function Lease-RestoreVerify([string]$token){
 $resident=Lease-Require $token;if($resident.kind -ceq 'resident-archive-samevolume'){$null=Resident-All $resident 'moved'}
 $script:LeasePhase='restore-preflight'
 $r=Lease-Require $token;$s=Measure-LeaseStep 'restoreCheck' {Lease-Snapshot};$null=Lease-Guard $r $s $true;Lease-AllGrid $r.snapshot $s
 foreach($record in $r.records){if((Lease-CheckRecord $record).hidden){throw 'lease-target-hidden'}}
 # A fresh full verification is still mandatory on every call. If no setting
 # changes now, there is no self-induced transition needing another settle/read.
 if([uint32]$s.folderFlags -eq [uint32]$r.originalFlags){
  if(-not $s.snap){throw 'lease-restore-unverified'}
  Add-LeasePerf 'restoreAlreadyEnabled' ([Diagnostics.Stopwatch]::StartNew())
  Lease-MarkRestored $r
  return @{ok=$true;snapRestored=$true;oldUnchanged=$true;targetsExact=$true;restoreMode='already-enabled-fresh-verification'}
 }
 Lease-SetSnap $r $s $true
 Measure-LeaseStep 'restoreSettle' {Start-Sleep -Milliseconds 250}
 $s=Measure-LeaseStep 'afterguard' {Lease-Snapshot};Measure-LeaseStep 'exactGuard' {$null=Lease-Guard $r $s $true}
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or -not $s.snap){throw 'lease-restore-unverified'}
 Lease-MarkRestored $r
 return @{ok=$true;snapRestored=$true;oldUnchanged=$true;targetsExact=$true;restoreMode='changed-and-settled'}
}
function Lease-Rollback([string]$token){
 $resident=Lease-Require $token;if($resident.kind -ceq 'resident-archive-samevolume'){return Resident-Rollback $resident}
 $script:LeasePhase='rollback-preflight'
 $r=Lease-Require $token;$s=Lease-Snapshot;$null=Lease-Guard $r $s
 foreach($record in $r.records){$null=Lease-CheckRecord $record}
 foreach($record in $r.records){$s=Measure-LeaseStep 'perRecordSnapshot' {Lease-Snapshot};$null=Lease-Guard $r $s;Lease-SetHidden $record $true}
 $s=Measure-LeaseStep 'rollbackVisibility' {Lease-WaitVisibility $r $false};Lease-AllGrid $r.snapshot $s
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){Lease-SetSnap $r $s $true}
 Measure-LeaseStep 'restoreSettle' {Start-Sleep -Milliseconds 250}
 $s=Lease-Snapshot;$selected=Lease-Guard $r $s
 if($selected.Count -ne 0 -or [uint32]$s.folderFlags -ne [uint32]$r.originalFlags){throw 'lease-rollback-unverified'}
 Lease-MarkRestored $r
 return @{ok=$true;snapRestored=$true;oldUnchanged=$true;selectedHidden=$true}
}
function Lease-Release([string]$token,[string]$expectedOutcome){
 $resident=Lease-Require $token;if($resident.kind -ceq 'resident-archive-samevolume'){if($expectedOutcome -ceq 'source-restored'){return Resident-ReleaseSources $resident};if($expectedOutcome -cne 'visible'){throw 'resident-release-outcome-invalid'};$null=Resident-All $resident 'moved'}
 if($expectedOutcome -cne 'visible' -and $expectedOutcome -cne 'hidden'){throw 'lease-release-outcome-required'}
 $r=Lease-Require $token
 $visible=$expectedOutcome -ceq 'visible'
 # Verify again at the final release boundary, not just at an earlier commit gate.
 $s=Lease-Snapshot;$selected=Lease-Guard $r $s $visible
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or -not $s.snap){throw 'lease-still-disabled'}
 foreach($record in $r.records){$n=Lease-CheckRecord $record;if($n.hidden -eq $visible){throw 'lease-release-visibility-changed'}}
 $s=Lease-Snapshot;$selected=Lease-Guard $r $s $visible
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or -not $s.snap){throw 'lease-still-disabled'}
 if(($visible -and $selected.Count -ne @($r.records).Count) -or (-not $visible -and $selected.Count -ne 0)){throw 'lease-release-visibility-changed'}
 Lease-AllGrid $r.snapshot $s
 if($r.kind -ceq 'resident-archive-samevolume'){$null=Resident-All $r 'moved'}
 $script:SnapLease=$null
 return @{ok=$true;released=$true;expectedOutcome=$expectedOutcome;snapRestored=$true;oldUnchanged=$true;targetsExact=$visible;selectedHidden=(-not $visible)}
}
function Invoke-SnapLeaseRequestCore($req){
 try{
  $script:LeasePhase=[string]$req.cmd;$script:LeaseBatchFailure=$null
  if($env:OKIBA_SNAP_LEASE -ne '1'){throw 'lease-dedicated-helper-required'}
  switch($req.cmd){
   'leaseHelperIdentity' {return @{ok=$true;pid=$PID;started=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString());sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;desktop=[Environment]::GetFolderPath('DesktopDirectory');localAppData=[Environment]::GetFolderPath('LocalApplicationData')}}
   'leaseOwnerPin' {if($null -ne $script:SnapLease){throw 'lease-already-active'};return [OkibaLeaseOwner]::Pin([int]$req.pid,[string]$req.started)}
   'leaseOwnerState' {return [OkibaLeaseOwner]::Read()}
   'leaseReadFiles' {if(@($req.paths).Count -lt 1 -or @($req.paths).Count -gt 1000){throw 'lease-invalid-path-count'};$records=@($req.paths|ForEach-Object {Lease-ReadRecord $_});return @{ok=$true;records=$records}}
   'leasePrepare' {return Measure-LeaseStep 'prepare' {Lease-Prepare $req}}
   'leaseRevealPlace' {return Lease-RevealPlace $req.token}
   'leaseRestoreVerify' {return Lease-RestoreVerify $req.token}
   'leaseRollback' {return Lease-Rollback $req.token}
   'leaseAdopt' {if($null -ne $script:SnapLease){throw 'lease-already-active'};$r=$req.recovery;$owner=[OkibaLeaseOwner]::Read();if($owner.state -eq 'unknown' -or $owner.pid -ne $r.owner.pid -or $owner.started -cne $r.owner.started){throw 'lease-owner-mismatch'};$s=Lease-Snapshot;Lease-AdoptRestoration $r $s $req.restorationState;Lease-ValidateRecovery $r $s;$script:SnapLease=$r;return @{ok=$true}}
   'leaseRelease' {return Lease-Release $req.token $req.expectedOutcome}
   default {throw 'lease-unknown-command'}
  }
 }catch{
  $inner=$_.Exception;while($null -ne $inner.InnerException){$inner=$inner.InnerException}
  $detail=[regex]::Replace([string]$inner.Message,'[^\x20-\x7E]','?')
  return @{ok=$false;reason='lease-operation-failed';detail=$detail;phase=$script:LeasePhase;errorType=$inner.GetType().FullName;hresult=('0x{0:X8}' -f $inner.HResult);line=$_.InvocationInfo.ScriptLineNumber;batch=$script:LeaseBatchFailure}
 }
}

function Invoke-SnapLeaseRequest($req){
 $previous=$script:LeasePerf;$script:LeasePerf=@{};$clock=[Diagnostics.Stopwatch]::StartNew()
 try{
  $result=Invoke-SnapLeaseRequestCore $req
  Add-LeasePerf 'total' $clock
  foreach($m in $script:LeasePerf.Values){$m.ms=[Math]::Round($m.ms,2)}
  $perf=@{inclusive=$true;metrics=$script:LeasePerf}
  if($result -is [Collections.IDictionary]){$result.perf=$perf}else{$result|Add-Member -NotePropertyName perf -NotePropertyValue $perf -Force}
  return $result
 }finally{$script:LeasePerf=$previous}
}

# Optional in samepath-only test copies; required when requesting the new kind.
$residentModule=Join-Path $PSScriptRoot 'resident-lease.ps1'
if(Test-Path -LiteralPath $residentModule){. $residentModule}
