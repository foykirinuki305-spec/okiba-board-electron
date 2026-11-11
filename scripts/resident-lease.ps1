# Resident future-destination lease. Not selected by main.js; native CI/test scopes only.
function Resident-Native {
 if(-not ('OkibaResidentFiles' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'resident-file-native.cs')}
}
function Resident-Same($actual,$r){
 return ($null -ne $actual -and $actual.identity -ceq $r.identity -and $actual.volume -ceq $r.volume -and $actual.size -ceq $r.size -and $actual.mtime -ceq $r.mtime -and [uint32]$actual.attributes -in @(32,34))
}
function Resident-Locate($r){
 Resident-Native
 $sp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($r.source));$dp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($r.destination))
 if($sp.ancestorKey -cne $r.sourceParentID -or $dp.ancestorKey -cne $r.destParentID -or $sp.volume -cne $r.volume -or $dp.volume -cne $r.volume){throw 'resident-parent-changed'}
 $s=[OkibaResidentFiles]::ReadIfMissing($r.source);$d=[OkibaResidentFiles]::ReadIfMissing($r.destination)
 if($null -ne $s -and $null -ne $d){throw 'resident-both-paths-occupied'}
 if($null -eq $s -and $null -eq $d){throw 'resident-both-paths-missing'}
 if($null -ne $s){if(-not (Resident-Same $s $r)){throw 'resident-source-changed'};return @{state='unmoved';record=$s}}
 if(-not (Resident-Same $d $r)){throw 'resident-destination-changed'};return @{state='moved';record=$d}
}
function Resident-All($r,[string]$want='any'){
 $located=@();foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($want -ne 'any' -and $n.state -cne $want){throw 'resident-location-not-expected'};$located+=,$n};return ,$located
}
function Resident-Validate($r,$current){
 if($r.version -ne 2 -or $r.kind -cne 'resident-archive-samevolume' -or $r.snapshot.identityVersion -ne 1 -or -not $r.snapshot.ok -or @($r.residentRecords).Count -lt 1 -or @($r.residentRecords).Count -gt 1000 -or @($r.records).Count -ne @($r.residentRecords).Count -or @($r.targets).Count -ne @($r.records).Count){throw 'resident-recovery-invalid'}
 if(([uint32]$r.originalFlags -band 5) -ne 4 -or [uint32]$r.snapshot.folderFlags -ne [uint32]$r.originalFlags -or $r.snapshot.autoArrange -or -not $r.snapshot.snap){throw 'resident-original-flags-invalid'}
 $desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'));$paths=@{};$ids=@{};$destinations=@{}
 foreach($i in $r.residentRecords){
  $source=Lease-Path $i.source;$dest=Lease-Path $i.destination
  if($source.StartsWith($desktop+'\',[StringComparison]::OrdinalIgnoreCase) -or $source -ieq $desktop -or (Lease-Path ([IO.Path]::GetDirectoryName($dest))) -ine $desktop -or $paths.ContainsKey($source) -or $paths.ContainsKey($dest) -or [uint32]$i.originalAttributes -notin @(32,34) -or [string]::IsNullOrEmpty($i.identity) -or $ids.ContainsKey($i.identity)){throw 'resident-path-or-identity-invalid'}
  $paths[$source]=$true;$paths[$dest]=$true;$ids[$i.identity]=$true;$destinations[$dest]=$i
  $projection=@($r.records|Where-Object{(Lease-Path $_.path) -ieq $dest})
  if($projection.Count -ne 1 -or $projection[0].identity -cne $i.identity -or $projection[0].size -cne $i.size -or $projection[0].mtime -cne $i.mtime -or [uint32]$projection[0].attributes -ne [uint32]$i.originalAttributes){throw 'resident-projection-invalid'}
  $publicDesktop=Lease-Path ([Environment]::GetFolderPath('CommonDesktopDirectory'))
  if($source -ieq $publicDesktop -or $source.StartsWith($publicDesktop+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'resident-source-public-desktop'}
  foreach($old in $r.snapshot.icons){if($old.path){$oldPath=Lease-Path $old.path;if($oldPath -ieq $dest){throw 'resident-destination-baseline-visible'};if($source -ieq $oldPath -or $source.StartsWith($oldPath+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'resident-source-baseline-visible'}}}
 }
 $null=Resident-All $r
 Lease-AllGrid $r.snapshot $r.snapshot
 if($null -eq $r.targetAreaIndex -or [double]$r.targetAreaIndex -ne [int]$r.targetAreaIndex -or $r.targetAreaIndex -lt 0 -or $r.targetAreaIndex -ge @($r.snapshot.areas).Count){throw 'resident-target-area-invalid'}
 $area=$r.snapshot.areas[[int]$r.targetAreaIndex];$g=$area.grid;if($null -eq $g -or $g.sx -le 0 -or $g.sy -le 0){throw 'resident-target-grid-unknown'}
 $seen=@{};$prior=@()
 foreach($t in $r.targets){$p=Lease-Path $t.path;if(-not $destinations.ContainsKey($p) -or $seen.ContainsKey($p) -or -not (Strict-PointValid $t)){throw 'resident-target-invalid'};$seen[$p]=$true
  if($t.x -lt $area.left -or $t.y -lt $area.top -or $t.x+$g.sx -gt $area.right -or $t.y+$g.sy -gt $area.bottom -or (($t.x-$g.gx)%$g.sx) -ne 0 -or (($t.y-$g.gy)%$g.sy) -ne 0){throw 'resident-target-offgrid'}
  foreach($old in @($r.snapshot.icons)+@($prior)){if(Strict-Overlap $t $old $g){throw 'resident-target-occupied'}};$prior+=,$t
 }
 $null=Lease-Guard $r $current
}
function Resident-Prepare($req,$owner){
 Resident-Native
 $scope=$req.scope;$desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'))
 if((Lease-Path $scope.desktop) -ine $desktop -or @($scope.items).Count -lt 1 -or @($scope.items).Count -gt 1000){throw 'resident-scope-invalid'}
 $current=Lease-Snapshot;if(-not $scope.snapshot.ok -or (Strict-GeometryKey $scope.snapshot) -cne (Strict-GeometryKey $current) -or (Strict-IconsKey $scope.snapshot) -cne (Strict-IconsKey $current)){throw 'resident-baseline-changed'}
 $resident=@();$projection=@()
 foreach($i in $scope.items){
  $source=Lease-Path $i.path;$dest=Lease-Path $i.destination
  $n=[OkibaResidentFiles]::Read($source);if($n.identity -cne $i.fileIdentity -or [uint32]$n.attributes -notin @(32,34)){throw 'resident-source-unsupported-or-changed'}
  if($null -ne [OkibaResidentFiles]::ReadIfMissing($dest)){throw 'resident-destination-exists'}
  $sp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($source));$dp=[OkibaResidentFiles]::Parent([IO.Path]::GetDirectoryName($dest));if($sp.volume -cne $n.volume -or $dp.volume -cne $n.volume){throw 'resident-cross-volume-unsupported'}
  $resident+=,@{source=$source;destination=$dest;identity=$n.identity;volume=$n.volume;size=$n.size;mtime=$n.mtime;originalAttributes=[uint32]$n.attributes;sourceParentID=$sp.ancestorKey;destParentID=$dp.ancestorKey}
  $projection+=,@{path=$dest;identity=$n.identity;size=$n.size;mtime=$n.mtime;attributes=[uint32]$n.attributes;hidden=$n.hidden}
 }
 $r=@{version=2;kind='resident-archive-samevolume';token=$req.token;snapshot=$current;residentRecords=$resident;records=$projection;originalFlags=[uint32]$current.folderFlags;targets=@($scope.targets);targetAreaIndex=$scope.targetAreaIndex;owner=@{pid=$owner.pid;started=$owner.started}}
 Resident-Validate $r $current;$null=Resident-All $r 'unmoved';if((Lease-Guard $r $current).Count -ne 0){throw 'resident-selected-visible-before-stage'}
 $script:SnapLease=$r;return @{ok=$true;recovery=$r}
}
function Resident-RevealPlace($r){
 Resident-Validate $r (Lease-Snapshot);if(([OkibaLeaseOwner]::Read()).state -ne 'alive'){throw 'lease-owner-not-alive'}
 $located=Resident-All $r 'unmoved';for($i=0;$i -lt $located.Count;$i++){if([uint32]$located[$i].record.attributes -ne [uint32]$r.residentRecords[$i].originalAttributes){throw 'resident-original-hidden-changed'}}
 $s=Lease-Snapshot;if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){throw 'resident-not-initial-flags'};Lease-SetSnap $r $s $false;$off=[uint32]$r.originalFlags -band ([uint32]::MaxValue -bxor 4)
 foreach($i in $r.residentRecords){
  $script:LeasePhase='resident-stage';Lease-AssertFastOff $r $off;if(([OkibaLeaseOwner]::Read()).state -ne 'alive'){throw 'lease-owner-not-alive'}
  $null=[OkibaResidentFiles]::Stage($i.source,$i.destination,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)
 }
 $null=Resident-All $r 'moved';$null=Lease-Guard $r (Lease-Snapshot);Lease-RevealAttributeBatch $r $off
 $script:LeasePhase='resident-arrival';$s=Measure-LeaseStep 'arrival' {Lease-WaitVisibility $r $true};$selected=Lease-Guard $r $s
 $ids=@();$paths=@();$xs=@();$ys=@();$tx=@();$ty=@()
 foreach($t in $r.targets){$i=$selected[(Lease-Path $t.path)];$ids+=$i.identity;$paths+=$t.path;$xs+=$i.x;$ys+=$i.y;$tx+=$t.x;$ty+=$t.y}
 Measure-LeaseStep 'nativePosition' {[OkibaFolderView]::PositionLeaseItems([string[]]$ids,[string[]]$paths,[int[]]$xs,[int[]]$ys,[int[]]$tx,[int[]]$ty,$off,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)}
 Measure-LeaseStep 'settle' {Start-Sleep -Milliseconds 180};$s=Measure-LeaseStep 'afterguard' {Lease-Snapshot};Measure-LeaseStep 'exactGuard' {$null=Lease-Guard $r $s $true};$null=Resident-All $r 'moved';if([uint32]$s.folderFlags -ne $off){throw 'resident-flags-changed'}
 return @{ok=$true;oldUnchanged=$true;targetsExact=$true;snapRestored=$false}
}
function Resident-Rollback($r){
 Resident-Validate $r (Lease-Snapshot)
 foreach($i in $r.residentRecords){
  $null=Lease-Guard $r (Lease-Snapshot);$n=Resident-Locate $i
  if($n.state -ceq 'moved'){$null=[OkibaResidentFiles]::RestoreMoved($i.destination,$i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)}
  else{$null=[OkibaResidentFiles]::RestoreUnmoved($i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID)}
 }
 $null=Resident-All $r 'unmoved';$s=Lease-WaitVisibility $r $false;Lease-AllGrid $r.snapshot $s
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){Lease-SetSnap $r $s $true}
 Start-Sleep -Milliseconds 250;$s=Lease-Snapshot;$null=Lease-Guard $r $s;if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){throw 'resident-rollback-flags-unverified'}
 foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($n.state -cne 'unmoved' -or [uint32]$n.record.attributes -ne [uint32]$i.originalAttributes){throw 'resident-source-not-restored'}}
 Lease-MarkRestored $r;return @{ok=$true;snapRestored=$true;oldUnchanged=$true;sourceRestored=$true}
}
function Resident-ReleaseSources($r){
 foreach($pass in @(1,2)){
  $s=Lease-Snapshot;$selected=Lease-Guard $r $s;if($selected.Count -ne 0 -or [uint32]$s.folderFlags -ne [uint32]$r.originalFlags -or -not $s.snap){throw 'resident-release-desktop-unverified'}
  foreach($i in $r.residentRecords){$n=Resident-Locate $i;if($n.state -cne 'unmoved' -or [uint32]$n.record.attributes -ne [uint32]$i.originalAttributes){throw 'resident-source-not-restored'}}
  Lease-AllGrid $r.snapshot $s
 }
 $script:SnapLease=$null;return @{ok=$true;released=$true;expectedOutcome='source-restored';snapRestored=$true;oldUnchanged=$true;sourceRestored=$true}
}
