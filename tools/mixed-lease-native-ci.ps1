# Disposable hosted-CI copy only. Never dot-source in the production helper.
function Mixed-CIOnly {
 if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'mixed-hosted-ci-only'}
}
# Diagnostic observer only: no retry, timeout, guard, or Shell notification changes.
function Mixed-Trace([string]$phase,$detail=$null){
 Mixed-CIOnly
 $line=(@{utc=[DateTime]::UtcNow.ToString('o');pid=$PID;phase=$phase;detail=$detail}|ConvertTo-Json -Compress -Depth 8)
 if($env:OKIBA_MIXED_TRACE_PATH){
  $trace=[IO.Path]::GetFullPath($env:OKIBA_MIXED_TRACE_PATH)
  if(-not [IO.Path]::IsPathRooted($env:OKIBA_MIXED_TRACE_PATH) -or [IO.Path]::GetExtension($trace) -cne '.jsonl'){throw 'mixed-trace-path-invalid'}
  [IO.File]::AppendAllText($trace,$line+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
 }else{[Console]::Error.WriteLine($line)}
}
function Mixed-WaitVisibility($r,[bool]$visible){
 $until=[DateTime]::UtcNow.AddSeconds(15);$stable=0;$poll=0
 do{
  $s=Lease-Snapshot;$selected=Lease-Guard $r $s
  $indices=@();for($j=0;$j -lt @($r.records).Count;$j++){if($selected.ContainsKey((Lease-Path $r.records[$j].path))){$indices+=,$j}}
  if(($visible -and $selected.Count -eq @($r.records).Count) -or (-not $visible -and $selected.Count -eq 0)){$stable++}else{$stable=0}
  Mixed-Trace 'rollback-visibility-poll' @{poll=$poll;selectedCount=$selected.Count;selectedIndices=$indices;wantVisible=$visible;stable=$stable;flags=$s.folderFlags}
  if($stable -ge 2){return $s};Start-Sleep -Milliseconds 100;$poll++
 }while([DateTime]::UtcNow -lt $until)
 throw 'lease-visibility-timeout'
}
function Mixed-Is($r){return ($r.kind -ceq 'mixed-hidden-resident-prototype')}
function Mixed-ProjectionSame($a,$b){return ($a.identity -ceq $b.identity -and $a.size -ceq $b.size -and $a.mtime -ceq $b.mtime -and [uint32]$a.attributes -eq [uint32]$b.attributes)}
function Mixed-Validate($r,$current){
 Mixed-CIOnly
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
function Lease-ValidateRecovery($r,$current){if(Mixed-Is $r){Mixed-Validate $r $current;return};Lease-ValidateRecovery-CoreMixedBase $r $current}
function Lease-Prepare($req){
 if(-not (Mixed-Is $req.scope)){return Lease-Prepare-CoreMixedBase $req}
 Mixed-CIOnly;Resident-Native
 if($null -ne $script:SnapLease -or $req.token -isnot [string] -or $req.token -notmatch '^[A-Za-z0-9_-]{16,128}$'){throw 'mixed-invalid-token-or-active'}
 $owner=[OkibaLeaseOwner]::Read();if($owner.state -ne 'alive'){throw 'lease-owner-not-alive'}
 $q=$req.scope;$desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'))
 if((Lease-Path $q.desktop) -ine $desktop -or @($q.items).Count -lt 2 -or @($q.items).Count -gt 1000){throw 'mixed-invalid-scope'}
 $current=Lease-Snapshot
 if(-not $q.snapshot.ok -or (Strict-GeometryKey $q.snapshot) -cne (Strict-GeometryKey $current) -or (Strict-IconsKey $q.snapshot) -cne (Strict-IconsKey $current)){throw 'mixed-baseline-changed'}
 $links=@();$residents=@();$records=@()
 foreach($i in $q.items){$source=Lease-Path $i.path;$dest=Lease-Path $i.destination
  if(($source -ieq $dest -and $i.mode -cne 'hidden-link') -or ($source -ine $dest -and $i.mode -cne 'resident-file')){throw 'mixed-mode-path-mismatch'}
  if($source -ieq $dest){$record=Lease-ReadRecord $source;if($i.hidden -ne $true -or -not $record.hidden -or $record.identity -cne $i.fileIdentity){throw 'mixed-link-not-hidden-or-replaced'};$links+=,$record;$records+=,$record}
  else{
   $n=[OkibaResidentFiles]::Read($source);if($n.identity -cne $i.fileIdentity -or [uint32]$n.attributes -notin @(32,34) -or $null -ne [OkibaResidentFiles]::ReadIfMissing($dest)){throw 'mixed-resident-unsupported-or-occupied'}
   $sp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($source));$dp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($dest))
   if($sp.volume -cne $n.volume -or $dp.volume -cne $n.volume){throw 'mixed-cross-volume'}
   $residents+=,@{source=$source;destination=$dest;identity=$n.identity;volume=$n.volume;size=$n.size;mtime=$n.mtime;originalAttributes=[uint32]$n.attributes;sourceParentID=$sp.ancestorKey;destParentID=$dp.ancestorKey}
   $records+=,@{path=$dest;identity=$n.identity;size=$n.size;mtime=$n.mtime;attributes=[uint32]$n.attributes;hidden=$n.hidden}
  }
 }
 $r=@{version=3;kind='mixed-hidden-resident-prototype';token=$req.token;snapshot=$current;originalFlags=[uint32]$current.folderFlags;records=$records;linkRecords=$links;residentRecords=$residents;targets=@($q.targets);targetAreaIndex=$q.targetAreaIndex;owner=@{pid=$owner.pid;started=$owner.started}}
 Mixed-Validate $r $current;$null=Resident-All $r 'unmoved';if((Lease-Guard $r $current).Count -ne 0){throw 'mixed-selected-baseline-visible'}
 $script:SnapLease=$r;return @{ok=$true;recovery=$r}
}
function Lease-RevealPlace([string]$token){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){return Lease-RevealPlace-CoreMixedBase $token}
 Mixed-CIOnly;Mixed-Validate $r (Lease-Snapshot)
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
function Lease-RestoreVerify([string]$token){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){return Lease-RestoreVerify-CoreMixedBase $token}
 Mixed-CIOnly;$null=Resident-All $r 'moved';$result=Lease-RestoreVerify-CoreMixedBase $token;$null=Resident-All $r 'moved';return $result
}
function Mixed-TerminalRestored($r){
 foreach($link in $r.linkRecords){$n=Lease-CheckRecord $link;if(-not $n.hidden -or [uint32]$n.attributes -ne [uint32]$link.attributes){throw 'mixed-link-not-restored'}}
 foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($n.state -cne 'unmoved' -or [uint32]$n.record.attributes -ne [uint32]$i.originalAttributes){throw 'mixed-source-not-restored'}}
}
function Lease-Rollback([string]$token){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){return Lease-Rollback-CoreMixedBase $token}
 Mixed-CIOnly;Mixed-Trace 'rollback-start' @{links=@($r.linkRecords).Count;residents=@($r.residentRecords).Count}
 try{
  Mixed-Validate $r (Lease-Snapshot);Mixed-Trace 'rollback-preflight-done'
  $index=0
  foreach($link in $r.linkRecords){
   $script:LeasePhase='mixed-rollback-rehide';Mixed-Trace 'rehide-before' @{index=$index}
   $null=Lease-Guard $r (Lease-Snapshot);Lease-SetHidden $link $true
   Mixed-Trace 'rehide-after' @{index=$index};$index++
  }
  $index=0
  foreach($i in $r.residentRecords){
   $script:LeasePhase='mixed-rollback-resident';Mixed-Trace 'resident-restore-before' @{index=$index}
   $null=Lease-Guard $r (Lease-Snapshot);$n=Resident-Locate $i;Mixed-Trace 'resident-located' @{index=$index;state=$n.state}
   if($n.state -ceq 'moved'){$null=[OkibaResidentFiles]::RestoreMoved($i.destination,$i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)}
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
function Lease-Release([string]$token,[string]$expectedOutcome){
 $r=Lease-Require $token;if(-not (Mixed-Is $r)){return Lease-Release-CoreMixedBase $token $expectedOutcome}
 Mixed-CIOnly
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
