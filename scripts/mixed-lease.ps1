# Explicit opt-in mixed lease. Not selected by main or preview.
function Mixed-Enabled {if($env:OKIBA_MIXED_LEASE -cne '1'){throw 'mixed-lease-disabled'}}
function Mixed-Trace([string]$phase,$detail=$null){} # No persistent research trace in production.
function Mixed-IsRemovalReadFailure($errorRecord){
 $f=$errorRecord.Exception.Data['snapshotFailure']
 return ($null -ne $f -and $f.reason -ceq 'shell-snapshot-error' -and $f.errorType -ceq 'System.Runtime.InteropServices.COMException' -and $f.hresult -ceq '0x80070490' -and [string]$f.detail -cmatch 'ReadShellBatch')
}
function Mixed-AssertHiddenBeforeRename($r,[uint32]$flags){
 [OkibaFolderView]::AssertLeaseExactSessionFlags($flags,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)
 foreach($link in $r.linkRecords){$n=Lease-CheckRecord $link;if(-not $n.hidden -or [uint32]$n.attributes -ne ([uint32]$link.attributes -bor 2)){throw 'mixed-retry-link-not-hidden'}}
 foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($n.state -cne 'moved' -or -not (Resident-Same $n.record $i) -or -not $n.record.hidden -or [uint32]$n.record.attributes -ne ([uint32]$i.originalAttributes -bor 2)){throw 'mixed-retry-resident-not-hidden'}}
 [OkibaFolderView]::AssertLeaseExactSessionFlags($flags,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)
}
function Mixed-WaitVisibility($r,[bool]$visible,[bool]$allowPreRenameReadRetry=$false){
 $until=[DateTime]::UtcNow.AddSeconds(15);$stable=0;$poll=0;$previousSelected=$null;$lastGuarded=$null;$readFailures=0;$immutableFlags=$null
 do{
  try{$s=Lease-Snapshot}catch{
   if(-not $allowPreRenameReadRetry -or $visible -or $script:LeasePhase -cne 'mixed-rollback-pre-rename-visibility' -or $null -eq $lastGuarded -or -not (Mixed-IsRemovalReadFailure $_)){throw}
   $stable=0;$previousSelected=$null;$readFailures++
   if($readFailures -gt 3 -or [DateTime]::UtcNow -ge $until){throw}
   Mixed-AssertHiddenBeforeRename $r ([uint32]$immutableFlags)
   Mixed-Trace 'pre-rename-read-reobserve' @{attempt=$readFailures;flags=$lastGuarded.folderFlags}
   $lastGuarded=$null;Start-Sleep -Milliseconds 100;continue
  }
  $selected=Lease-Guard $r $s
  if($allowPreRenameReadRetry -and -not $visible -and $script:LeasePhase -ceq 'mixed-rollback-pre-rename-visibility'){
   if($null -eq $immutableFlags){$immutableFlags=[uint32]$s.folderFlags}elseif([uint32]$s.folderFlags -ne [uint32]$immutableFlags){throw 'mixed-pre-rename-flags-changed'}
  }
  $lastGuarded=$s
  $indices=@();for($j=0;$j -lt @($r.records).Count;$j++){if($selected.ContainsKey((Lease-Path $r.records[$j].path))){$indices+=,$j}}
  if(($visible -and $selected.Count -eq @($r.records).Count) -or (-not $visible -and $selected.Count -eq 0)){$stable++}else{$stable=0}
  $owned=@($selected.Values|ForEach-Object{@{identity=$_.identity;path=$_.path;x=$_.x;y=$_.y}})
  $ownedKey=$owned|ConvertTo-Json -Depth 4 -Compress
  if($poll -eq 0 -or $ownedKey -cne $previousSelected){Mixed-Trace 'rollback-visibility-selected-change' @{poll=$poll;selected=$owned};$previousSelected=$ownedKey}
  Mixed-Trace 'rollback-visibility-poll' @{poll=$poll;selectedCount=$selected.Count;selectedIndices=$indices;wantVisible=$visible;stable=$stable;flags=$s.folderFlags}
  if($stable -ge 2){return $s};Start-Sleep -Milliseconds 100;$poll++
 }while([DateTime]::UtcNow -lt $until)
 throw 'lease-visibility-timeout'
}
function Mixed-RenameNotification([string]$oldPath,[string]$newPath){
 Mixed-Enabled
 if(-not ('OkibaMixedRenameNotify' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'mixed-rename-notify.cs')}
 [OkibaMixedRenameNotify]::Renamed($oldPath,$newPath)
}
function Mixed-NotifyRestored($record,[string]$beforeState){
 if($beforeState -cne 'moved'){throw 'mixed-notify-no-completed-move'}
 # Locate validates both parent chains, destination absence, source native ID,
 # size/mtime and allowed substantive attributes. Require original attrs too.
 $after=Resident-Locate $record
 if($after.state -cne 'unmoved' -or -not (Resident-Same $after.record $record) -or [uint32]$after.record.attributes -ne [uint32]$record.originalAttributes){throw 'mixed-rename-postcondition-failed'}
 Mixed-RenameNotification $record.destination $record.source
 return $after
}
function Mixed-Is($r){return ($r.kind -ceq 'mixed-hidden-resident')}
function Mixed-ProjectionSame($a,$b){return ($a.identity -ceq $b.identity -and $a.size -ceq $b.size -and $a.mtime -ceq $b.mtime -and [uint32]$a.attributes -eq [uint32]$b.attributes)}
function Mixed-Validate($r,$current){
 Mixed-Enabled;Resident-Native
 if($r.version -ne 3 -or -not (Mixed-Is $r) -or $r.token -notmatch '^[A-Za-z0-9_-]{16,128}$' -or -not $r.snapshot.ok -or $r.snapshot.identityVersion -ne 1){throw 'mixed-invalid-recovery'}
 $count=@($r.records).Count
 if(@($r.linkRecords).Count -lt 1 -or @($r.residentRecords).Count -lt 1 -or $count -gt 1000 -or $count -ne (@($r.linkRecords).Count+@($r.residentRecords).Count) -or @($r.targets).Count -ne $count){throw 'mixed-invalid-count'}
 if(([uint32]$r.originalFlags -band 5) -ne 4 -or [uint32]$r.snapshot.folderFlags -ne [uint32]$r.originalFlags -or $r.snapshot.autoArrange -or -not $r.snapshot.snap){throw 'mixed-original-flags-invalid'}
 $desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'));$public=Lease-Path ([Environment]::GetFolderPath('CommonDesktopDirectory'))
 $allPaths=@{};$destinations=@{};$ids=@{}
 foreach($link in $r.linkRecords){
  $p=Lease-Path $link.path
  if((Lease-Path ([IO.Path]::GetDirectoryName($p))) -ine $desktop -or ($link.attributes -band 2) -eq 0 -or $allPaths.ContainsKey($p) -or [string]::IsNullOrEmpty($link.identity) -or $ids.ContainsKey($link.identity)){throw 'mixed-link-invalid'}
  $allPaths[$p]=$true;$destinations[$p]=$link;$ids[$link.identity]=$true
  $null=Lease-CheckRecord $link
  $nativeLink=[OkibaResidentFiles]::Read($p)
  if($nativeLink.identity -cne $link.identity -or $nativeLink.size -cne $link.size -or $nativeLink.mtime -cne $link.mtime -or ([uint32]$nativeLink.attributes -bor 2) -ne ([uint32]$link.attributes -bor 2) -or -not $nativeLink.regularFile -or $nativeLink.reparse -or $nativeLink.linkCount -ne 1){throw 'mixed-link-native-changed'}
 }
 foreach($resident in $r.residentRecords){
  $source=Lease-Path $resident.source;$dest=Lease-Path $resident.destination
  if($source -ieq $desktop -or $source.StartsWith($desktop+'\',[StringComparison]::OrdinalIgnoreCase) -or $source -ieq $public -or $source.StartsWith($public+'\',[StringComparison]::OrdinalIgnoreCase) -or (Lease-Path ([IO.Path]::GetDirectoryName($dest))) -ine $desktop -or $allPaths.ContainsKey($source) -or $allPaths.ContainsKey($dest) -or $source -ieq $dest -or [uint32]$resident.originalAttributes -notin @(32,34) -or [string]::IsNullOrEmpty($resident.identity) -or $ids.ContainsKey($resident.identity)){throw 'mixed-resident-invalid'}
  $allPaths[$source]=$true;$allPaths[$dest]=$true;$ids[$resident.identity]=$true
  $destinations[$dest]=@{identity=$resident.identity;size=$resident.size;mtime=$resident.mtime;attributes=[uint32]$resident.originalAttributes}
  foreach($old in $r.snapshot.icons){if($old.path){$p=Lease-Path $old.path;if($source -ieq $p -or $source.StartsWith($p+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'mixed-source-baseline-visible'}}}
 }
 $seen=@{}
 foreach($record in $r.records){$p=Lease-Path $record.path;if(-not $destinations.ContainsKey($p) -or $seen.ContainsKey($p) -or -not (Mixed-ProjectionSame $record $destinations[$p])){throw 'mixed-projection-invalid'};$seen[$p]=$true}
 foreach($old in $r.snapshot.icons){if($old.path -and $destinations.ContainsKey((Lease-Path $old.path))){throw 'mixed-destination-baseline-visible'}}
 $null=Resident-All $r
 Lease-AllGrid $r.snapshot $r.snapshot
 if($null -eq $r.targetAreaIndex -or [double]$r.targetAreaIndex -ne [int]$r.targetAreaIndex -or $r.targetAreaIndex -lt 0 -or $r.targetAreaIndex -ge @($r.snapshot.areas).Count){throw 'mixed-target-area-invalid'}
 $area=$r.snapshot.areas[[int]$r.targetAreaIndex];$g=$area.grid
 if($null -eq $g -or $g.sx -le 0 -or $g.sy -le 0){throw 'mixed-grid-unknown'}
 $seen=@{};$prior=@()
 foreach($t in $r.targets){$p=Lease-Path $t.path;if(-not $destinations.ContainsKey($p) -or $seen.ContainsKey($p) -or -not (Strict-PointValid $t)){throw 'mixed-target-invalid'};$seen[$p]=$true
  if($t.x -lt $area.left -or $t.y -lt $area.top -or $t.x+$g.sx -gt $area.right -or $t.y+$g.sy -gt $area.bottom -or (($t.x-$g.gx)%$g.sx) -ne 0 -or (($t.y-$g.gy)%$g.sy) -ne 0){throw 'mixed-target-offgrid'}
  foreach($old in @($r.snapshot.icons)+@($prior)){if(Strict-Overlap $t $old $g){throw 'mixed-target-occupied'}};$prior+=,$t
 }
 $null=Lease-Guard $r $current
}
function Mixed-Prepare($req){
 Mixed-Enabled;if(-not (Mixed-Is $req.scope)){throw 'mixed-kind-required'};Resident-Native
 if($null -ne $script:SnapLease -or $req.token -isnot [string] -or $req.token -notmatch '^[A-Za-z0-9_-]{16,128}$'){throw 'mixed-invalid-token-or-active'}
 $owner=[OkibaLeaseOwner]::Read();if($owner.state -ne 'alive'){throw 'lease-owner-not-alive'}
 $q=$req.scope;$desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'))
 if((Lease-Path $q.desktop) -ine $desktop -or @($q.items).Count -lt 2 -or @($q.items).Count -gt 1000){throw 'mixed-invalid-scope'}
 $current=Lease-Snapshot
 if(-not $q.snapshot.ok -or (Strict-GeometryKey $q.snapshot) -cne (Strict-GeometryKey $current) -or (Strict-IconsKey $q.snapshot) -cne (Strict-IconsKey $current)){throw 'mixed-baseline-changed'}
 $links=@();$residents=@();$records=@()
 foreach($i in $q.items){$source=Lease-Path $i.path;$dest=Lease-Path $i.destination
  if(($source -ieq $dest -and $i.mode -cne 'hidden-link') -or ($source -ine $dest -and $i.mode -cne 'resident-file')){throw 'mixed-mode-path-mismatch'}
  if($source -ieq $dest){$record=[OkibaResidentFiles]::Read($source);if(-not $record.regularFile -or $record.reparse -or $record.linkCount -ne 1 -or [uint32]$record.attributes -ne 34){throw 'mixed-link-native-unsupported'};if($i.hidden -ne $true -or -not $record.hidden -or $record.identity -cne $i.fileIdentity){throw 'mixed-link-not-hidden-or-replaced'};$links+=,$record;$records+=,$record}
  else{
   $n=[OkibaResidentFiles]::Read($source);if($n.identity -cne $i.fileIdentity -or [uint32]$n.attributes -notin @(32,34) -or $null -ne [OkibaResidentFiles]::ReadIfMissing($dest)){throw 'mixed-resident-unsupported-or-occupied'}
   $sp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($source));$dp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($dest))
   if($sp.volume -cne $n.volume -or $dp.volume -cne $n.volume){throw 'mixed-cross-volume'}
   $residents+=,@{source=$source;destination=$dest;identity=$n.identity;volume=$n.volume;size=$n.size;mtime=$n.mtime;originalAttributes=[uint32]$n.attributes;sourceParentID=$sp.ancestorKey;destParentID=$dp.ancestorKey}
   $records+=,@{path=$dest;identity=$n.identity;size=$n.size;mtime=$n.mtime;attributes=[uint32]$n.attributes;hidden=$n.hidden}
  }
 }
 $r=@{version=3;kind='mixed-hidden-resident';token=$req.token;snapshot=$current;originalFlags=[uint32]$current.folderFlags;records=$records;linkRecords=$links;residentRecords=$residents;targets=@($q.targets);targetAreaIndex=$q.targetAreaIndex;owner=@{pid=$owner.pid;started=$owner.started}}
 Mixed-Validate $r $current;$null=Resident-All $r 'unmoved';if((Lease-Guard $r $current).Count -ne 0){throw 'mixed-selected-baseline-visible'}
 $script:SnapLease=$r;return @{ok=$true;recovery=$r}
}
function Mixed-RevealPlace([string]$token){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){throw 'mixed-kind-required'}
 Mixed-Enabled;Mixed-Validate $r (Lease-Snapshot)
 if(([OkibaLeaseOwner]::Read()).state -ne 'alive'){throw 'lease-owner-not-alive'}
 $located=Resident-All $r 'unmoved'
 for($j=0;$j -lt $located.Count;$j++){if([uint32]$located[$j].record.attributes -ne [uint32]$r.residentRecords[$j].originalAttributes){throw 'mixed-original-resident-attributes-changed'}}
 foreach($link in $r.linkRecords){if(-not (Lease-CheckRecord $link).hidden){throw 'mixed-link-hidden-changed'}}
 $s=Lease-Snapshot;if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or (Lease-Guard $r $s).Count -ne 0){throw 'mixed-reveal-initial-state'}
 Lease-SetSnap $r $s $false;$off=[uint32]$r.originalFlags -band ([uint32]::MaxValue -bxor 4)
 $stageIndex=0
 foreach($i in $r.residentRecords){$script:LeasePhase='mixed-stage';Lease-AssertFastOff $r $off;if(([OkibaLeaseOwner]::Read()).state -ne 'alive'){throw 'lease-owner-not-alive'};$null=[OkibaResidentFiles]::Stage($i.source,$i.destination,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)
  if($stageIndex -eq 0){
   # CI-MIXED-AFTER-FIRST-STAGE
  };$stageIndex++
 }
 $null=Resident-All $r 'moved';$null=Lease-Guard $r (Lease-Snapshot)
 foreach($record in $r.records){if(-not (Lease-CheckRecord $record).hidden){throw 'mixed-selected-not-hidden'}}
 $s=Lease-Snapshot;$null=Lease-Guard $r $s;if([uint32]$s.folderFlags -ne $off){throw 'mixed-flags-changed'}
 $revealIndex=0
 foreach($record in $r.records){Lease-AssertFastOff $r $off;Lease-SetHidden $record $false $true
  if($revealIndex -eq 0){
   # CI-MIXED-AFTER-FIRST-REVEAL
  };$revealIndex++
 }
 $s=Lease-Snapshot;$null=Lease-Guard $r $s;if([uint32]$s.folderFlags -ne $off){throw 'mixed-flags-changed'}
 $script:LeasePhase='mixed-arrival';$s=Measure-LeaseStep 'arrival' {Lease-WaitVisibility $r $true};$selected=Lease-Guard $r $s
 if([uint32]$s.folderFlags -ne $off){throw 'mixed-flags-changed'}
 $ids=@();$paths=@();$xs=@();$ys=@();$tx=@();$ty=@()
 foreach($t in $r.targets){$i=$selected[(Lease-Path $t.path)];$ids+=$i.identity;$paths+=$t.path;$xs+=$i.x;$ys+=$i.y;$tx+=$t.x;$ty+=$t.y}
 Measure-LeaseStep 'nativePosition' {[OkibaFolderView]::PositionLeaseItems([string[]]$ids,[string[]]$paths,[int[]]$xs,[int[]]$ys,[int[]]$tx,[int[]]$ty,$off,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)}
 Start-Sleep -Milliseconds 180;$s=Lease-Snapshot;$null=Lease-Guard $r $s $true;$null=Resident-All $r 'moved'
 if([uint32]$s.folderFlags -ne $off){throw 'mixed-flags-changed'}
 return @{ok=$true;oldUnchanged=$true;targetsExact=$true;snapRestored=$false}
}
function Mixed-RestoreVerify([string]$token){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){throw 'mixed-kind-required'}
 Mixed-Enabled;$null=Resident-All $r 'moved';$result=Lease-RestoreVerifyCore $token;$null=Resident-All $r 'moved';return $result
}
function Mixed-TerminalRestored($r){
 foreach($link in $r.linkRecords){$n=Lease-CheckRecord $link;if(-not $n.hidden -or [uint32]$n.attributes -ne [uint32]$link.attributes){throw 'mixed-link-not-restored'}}
 foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($n.state -cne 'unmoved' -or [uint32]$n.record.attributes -ne [uint32]$i.originalAttributes){throw 'mixed-source-not-restored'}}
}
function Mixed-HideBeforeRestore($r){
 # No source rename is allowed until the entire original group is invisible.
 $null=Lease-Guard $r (Lease-Snapshot)
 $index=0
 foreach($link in $r.linkRecords){
  $script:LeasePhase='mixed-rollback-rehide';Mixed-Trace 'rehide-before' @{index=$index}
  $null=Lease-Guard $r (Lease-Snapshot);Lease-SetHidden $link $true
  Mixed-Trace 'rehide-after' @{index=$index};$index++
 }
 $index=0
 foreach($i in $r.residentRecords){
  $script:LeasePhase='mixed-rollback-prehide-resident';$null=Lease-Guard $r (Lease-Snapshot)
  $n=Resident-Locate $i;Mixed-Trace 'resident-prehide-located' @{index=$index;state=$n.state}
  if($n.state -ceq 'moved'){
   $projection=@($r.records|Where-Object{(Lease-Path $_.path) -ieq (Lease-Path $i.destination)})
   if($projection.Count -ne 1 -or $projection[0].identity -cne $i.identity){throw 'mixed-prehide-projection-invalid'}
   Lease-SetHidden $projection[0] $true
   $after=Resident-Locate $i
   if($after.state -cne 'moved' -or -not $after.record.hidden -or [uint32]$after.record.attributes -ne ([uint32]$i.originalAttributes -bor 2)){throw 'mixed-prehide-unverified'}
   Mixed-Trace 'resident-prehide-verified' @{index=$index;attributes=$after.record.attributes}
  }elseif($n.state -cne 'unmoved'){throw 'mixed-prehide-location-unknown'}
  $index++
 }
 $script:LeasePhase='mixed-rollback-pre-rename-visibility';Mixed-Trace 'pre-rename-visibility-before'
 $s=Mixed-WaitVisibility $r $false $true;$selected=Lease-Guard $r $s
 if($selected.Count -ne 0){throw 'mixed-pre-rename-visible'}
 foreach($link in $r.linkRecords){if(-not (Lease-CheckRecord $link).hidden){throw 'mixed-pre-rename-link-visible'}}
 foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($n.state -ceq 'moved' -and -not $n.record.hidden){throw 'mixed-pre-rename-resident-visible'}}
 Mixed-Trace 'pre-rename-all-group-zero' @{selectedCount=$selected.Count;flags=$s.folderFlags}
 return $s
}
function Mixed-Rollback([string]$token){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){throw 'mixed-kind-required'}
 Mixed-Enabled;Mixed-Trace 'rollback-start' @{links=@($r.linkRecords).Count;residents=@($r.residentRecords).Count}
 try{
  Mixed-Validate $r (Lease-Snapshot);Mixed-Trace 'rollback-preflight-done'
  $s=Mixed-HideBeforeRestore $r
  $index=0
  foreach($i in $r.residentRecords){
   $script:LeasePhase='mixed-rollback-resident';Mixed-Trace 'resident-restore-before' @{index=$index}
   $null=Lease-Guard $r (Lease-Snapshot);$n=Resident-Locate $i;Mixed-Trace 'resident-located' @{index=$index;state=$n.state}
   if($n.state -ceq 'moved'){
    $null=[OkibaResidentFiles]::RestoreMoved($i.destination,$i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)
    $after=Mixed-NotifyRestored $i $n.state
    Mixed-Trace 'resident-restore-postcondition-notified' @{index=$index;state=$after.state;identityMatches=($after.record.identity -ceq $i.identity);attributes=$after.record.attributes}
   }
   else{$null=[OkibaResidentFiles]::RestoreUnmoved($i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID)}
   Mixed-Trace 'resident-restore-after' @{index=$index};$index++
  }
  $script:LeasePhase='mixed-rollback-visibility';Mixed-Trace 'visibility-before'
  $s=Mixed-WaitVisibility $r $false;Mixed-Trace 'visibility-after' @{flags=$s.folderFlags};Lease-AllGrid $r.snapshot $s;Mixed-TerminalRestored $r
  $script:LeasePhase='mixed-rollback-restore-snap';Mixed-Trace 'restore-snap-before' @{flags=$s.folderFlags;originalFlags=$r.originalFlags}
  if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){Lease-SetSnap $r $s $true}
  Mixed-Trace 'restore-snap-after'
  Start-Sleep -Milliseconds 250;$s=Lease-Snapshot;$selected=Lease-Guard $r $s
  if($selected.Count -ne 0 -or [uint32]$s.folderFlags -ne [uint32]$r.originalFlags){throw 'mixed-rollback-unverified'}
  Mixed-TerminalRestored $r;Lease-MarkRestored $r;Mixed-Trace 'rollback-verified' @{flags=$s.folderFlags}
  return @{ok=$true;snapRestored=$true;oldUnchanged=$true;selectedHidden=$true;sourceRestored=$true;recovered=$true}
 }catch{Mixed-Trace 'rollback-failed' @{phase=$script:LeasePhase;error=$_.Exception.Message};throw}
}
function Mixed-Release([string]$token,[string]$expectedOutcome){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){throw 'mixed-kind-required'}
 Mixed-Enabled
 if($expectedOutcome -ceq 'visible'){
  foreach($pass in @(1,2)){
   $s=Lease-Snapshot;$selected=Lease-Guard $r $s $true
   if($selected.Count -ne @($r.records).Count -or [uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or -not $s.snap){throw 'mixed-release-visible-unverified'}
   foreach($record in $r.records){if((Lease-CheckRecord $record).hidden){throw 'mixed-release-target-hidden'}}
   $null=Resident-All $r 'moved';Lease-AllGrid $r.snapshot $s
  }
  $script:SnapLease=$null;return @{ok=$true;released=$true;expectedOutcome='visible';snapRestored=$true;oldUnchanged=$true;targetsExact=$true}
 }
 if($expectedOutcome -cne 'mixed-restored'){throw 'mixed-release-outcome-required'}
 foreach($pass in @(1,2)){
  $s=Lease-Snapshot;$selected=Lease-Guard $r $s
  if($selected.Count -ne 0 -or [uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or -not $s.snap){throw 'mixed-release-desktop-unverified'}
  Mixed-TerminalRestored $r;Lease-AllGrid $r.snapshot $s
 }
 $script:SnapLease=$null;return @{ok=$true;released=$true;expectedOutcome=$expectedOutcome;snapRestored=$true;oldUnchanged=$true;selectedHidden=$true;sourceRestored=$true;recovered=$true}
}
