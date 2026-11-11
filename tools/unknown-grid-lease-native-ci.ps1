# CI-only extension, loaded only by a disposable generated helper copy.
# No successful placement/commit API yet: this first slice proves probe/sample/abort.
function Unknown-CIOnly {
 if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OKIBA_UNKNOWN_GRID_CI -ne '1'){throw 'unknown-grid-hosted-ci-only'}
}
function Unknown-Current($r){
 $s=Lease-Snapshot;$null=Lease-Guard $r $s
 if($r.version -ne 2 -or $r.kind -cne 'samepath-hidden-unknown-grid-ci'){throw 'unknown-invalid-recovery'}
 if(@($r.records).Count -lt 1 -or @($r.records).Count -gt 1000 -or ([uint32]$r.originalFlags -band 5) -ne 4){throw 'unknown-records-or-flags-invalid'}
 $desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'))
 foreach($record in $r.records){$p=Lease-Path $record.path;if((Lease-Path ([IO.Path]::GetDirectoryName($p))) -ine $desktop -or -not [IO.Path]::GetFileName($p).StartsWith('OkibaUnknown-') -or ($record.attributes -band 2) -eq 0){throw 'unknown-recovery-not-owned'};$null=Lease-CheckRecord $record}
 Lease-AllGrid $r.snapshot $r.snapshot
 return $s
}
function Unknown-Live($r){$o=[OkibaLeaseOwner]::Read();if($o.state -ne 'alive' -or $o.pid -ne $r.owner.pid -or $o.started -cne $r.owner.started){throw 'unknown-owner-not-alive'}}
function Unknown-Patch($r,$p,[bool]$inner=$false){
 $patch=$r.plan.patch;$mx=0;$my=0;if($inner){$mx=$r.plan.maxSpacing.x;$my=$r.plan.maxSpacing.y}
 if(-not(Strict-PointValid $p) -or $p.x -lt $patch.left+$mx -or $p.x -gt $patch.right-$mx -or $p.y -lt $patch.top+$my -or $p.y -gt $patch.bottom-$my){throw 'unknown-outside-patch'}
}
function Unknown-Prepare($req){
 if($null -ne $script:SnapLease){throw 'lease-already-active'}
 if($req.token -isnot [string] -or $req.token -notmatch '^[a-f0-9]{32}$'){throw 'unknown-token-invalid'}
 $q=$req.scope;if($q.version -ne 2 -or $q.kind -cne 'samepath-hidden-unknown-grid-ci' -or @($q.items).Count -lt 1 -or @($q.items).Count -gt 1000 -or $null -ne $q.targets){throw 'unknown-scope-invalid'}
 $owner=[OkibaLeaseOwner]::Read();if($owner.state -ne 'alive'){throw 'unknown-owner-not-alive'}
 $s=Lease-Snapshot;if((Strict-GeometryKey $q.snapshot) -cne (Strict-GeometryKey $s) -or (Strict-IconsKey $q.snapshot) -cne (Strict-IconsKey $s)){throw 'unknown-baseline-changed'}
 if(($s.folderFlags -band 5) -ne 4 -or $s.autoArrange -or -not $s.snap){throw 'unknown-initial-flags'}
 $desktop=Lease-Path ([Environment]::GetFolderPath('DesktopDirectory'));$records=@();$paths=@{}
 foreach($i in $q.items){$p=Lease-Path $i.path;if($p -ine (Lease-Path $i.destination) -or (Lease-Path ([IO.Path]::GetDirectoryName($p))) -ine $desktop -or -not [IO.Path]::GetFileName($p).StartsWith('OkibaUnknown-') -or $paths.ContainsKey($p)){throw 'unknown-not-owned-ci-item'};$paths[$p]=$true;$record=Lease-ReadRecord $p;if(-not $record.hidden -or $record.identity -cne $i.fileIdentity){throw 'unknown-file-changed'};$records+=,$record}
 $index=[int]$q.targetAreaIndex;if($index -lt 0 -or $index -ge @($s.areas).Count -or $q.plan.areaIndex -ne $index -or $q.plan.probeId -ine $records[0].path){throw 'unknown-area-probe-invalid'}
 $area=$s.areas[$index];$patch=$q.plan.patch;$mx=$q.plan.maxSpacing.x;$my=$q.plan.maxSpacing.y
 if($mx -lt 8 -or $my -lt 8 -or $mx -gt 512 -or $my -gt 512 -or $patch.left -lt $area.left -or $patch.right -gt $area.right -or $patch.top -lt $area.top -or $patch.bottom -gt $area.bottom){throw 'unknown-patch-invalid'}
 foreach($i in $s.icons){if($i.x -ge $patch.left-$mx -and $i.x -le $patch.right+$mx -and $i.y -ge $patch.top-$my -and $i.y -le $patch.bottom+$my){throw 'unknown-patch-occupied'}}
 $r=@{version=2;kind=$q.kind;token=$req.token;snapshot=$s;originalFlags=[uint32]$s.folderFlags;records=$records;targets=@();targetAreaIndex=$index;plan=$q.plan;phase='unknown-prepared';owner=@{pid=$owner.pid;started=$owner.started}}
 $null=Unknown-Current $r;$selected=Lease-Guard $r $s;if($selected.Count -ne 0){throw 'unknown-initial-visible'};$script:SnapLease=$r
 return @{ok=$true;recovery=$r}
}
function Unknown-ProbeVisible($r){
 $deadline=[DateTime]::UtcNow.AddSeconds(6)
 do{$s=Unknown-Current $r;$selected=Lease-Guard $r $s;if($selected.Count -eq 1 -and $selected.ContainsKey((Lease-Path $r.records[0].path))){return @{snapshot=$s;probe=$selected[(Lease-Path $r.records[0].path)]}};if($selected.Count -gt 1){throw 'unknown-extra-selected-visible'};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $deadline)
 throw 'unknown-probe-arrival-timeout'
}
function Unknown-Abort($r){
 $s=Unknown-Current $r
 foreach($record in $r.records){$null=Unknown-Current $r;Lease-SetHidden $record $true}
 $s=Lease-WaitVisibility $r $false;Lease-AllGrid $r.snapshot $s
 if([uint32]$s.folderFlags -ne [uint32]$r.originalFlags){Lease-SetSnap $r $s $true}
 Start-Sleep -Milliseconds 250;$s=Unknown-Current $r;$selected=Lease-Guard $r $s
 if($selected.Count -ne 0 -or [uint32]$s.folderFlags -ne [uint32]$r.originalFlags){throw 'unknown-abort-unverified'}
 $r.phase='aborted';return @{ok=$true;snapRestored=$true;selectedHidden=$true;oldUnchanged=$true}
}
function Invoke-UnknownLeaseCI($req){
 Unknown-CIOnly
 if($req.cmd -ceq 'leaseUnknownPrepare'){return Unknown-Prepare $req}
 if($req.cmd -ceq 'leaseUnknownAdopt'){
  if($null -ne $script:SnapLease){throw 'lease-already-active'};$r=$req.recovery;$o=[OkibaLeaseOwner]::Read()
  if($o.state -eq 'unknown' -or $o.pid -ne $r.owner.pid -or $o.started -cne $r.owner.started){throw 'unknown-adopt-owner-mismatch'}
  $current=Unknown-Current $r;Lease-AdoptRestoration $r $current $req.restorationState;$r.phase='abort-only';$script:SnapLease=$r;return @{ok=$true;abortOnly=$true}
 }
 $r=Lease-Require $req.token
 if($req.cmd -ceq 'leaseUnknownAbort'){return Unknown-Abort $r}
 if($req.cmd -ceq 'leaseUnknownRelease'){
  if($r.phase -cne 'aborted'){throw 'unknown-release-before-abort'};$s=Unknown-Current $r
  if((Lease-Guard $r $s).Count -ne 0 -or $s.folderFlags -ne $r.originalFlags){throw 'unknown-release-unverified'}
  $script:SnapLease=$null;return @{ok=$true;released=$true}
 }
 Unknown-Live $r;if($r.phase -ceq 'abort-only'){throw 'unknown-adopted-abort-only'}
 switch($req.cmd){
  'leaseUnknownRevealProbe' {
   if($r.phase -cne 'unknown-prepared'){throw 'unknown-phase-invalid'};$s=Unknown-Current $r;Lease-SetSnap $r $s $false
   $r.phase='probe-revealing';Lease-SetHidden $r.records[0] $false $true;$found=Unknown-ProbeVisible $r;$i=$found.probe
   $x=[int][Math]::Floor(($r.plan.patch.left+$r.plan.patch.right)/2);$y=[int][Math]::Floor(($r.plan.patch.top+$r.plan.patch.bottom)/2);Unknown-Patch $r @{x=$x;y=$y} $true
   [OkibaFolderView]::PositionLeaseItems([string[]]@($i.identity),[string[]]@($r.records[0].path),[int[]]@($i.x),[int[]]@($i.y),[int[]]@($x),[int[]]@($y),[uint32]$found.snapshot.folderFlags,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted)
   Start-Sleep -Milliseconds 180;$found=Unknown-ProbeVisible $r;if($found.probe.x -ne $x -or $found.probe.y -ne $y){throw 'unknown-probe-position-inexact'};$r.phase='probe-visible-off'
   return @{ok=$true;recovery=$r;snapshot=$found.snapshot}
  }
  'leaseUnknownBeginCalibration' {
   if($r.phase -cne 'probe-visible-off'){throw 'unknown-phase-invalid'};$found=Unknown-ProbeVisible $r;Unknown-Patch $r $found.probe $false
   Lease-AllGrid $r.snapshot $r.snapshot;$s=$found.snapshot
   [OkibaFolderView]::SetLeaseSnap([uint32]$s.folderFlags,$true,[long]$r.snapshot.listviewHwnd,[int]$r.snapshot.explorerPid,[string]$r.snapshot.explorerStarted,[string[]]@($s.icons.identity),[int[]]@($s.icons.x),[int[]]@($s.icons.y))
   $clock=[Diagnostics.Stopwatch]::StartNew();$probe=@{path=$r.records[0].path;name=[IO.Path]::GetFileName($r.records[0].path)}
   $after=Wait-CalibrationSettled $r.snapshot $probe $r.plan.patch $clock;if(-not $after.ok){throw ('unknown-probe-snap-failed:'+ [string]$after.reason)}
   $r.phase='calibrating';return @{ok=$true;recovery=$r;snapshot=$after.current;probe=$after.new[0]}
  }
  'leaseUnknownCalibrationSample' {
   if($r.phase -cne 'calibrating'){throw 'unknown-phase-invalid'};Unknown-Patch $r $req.point $true;$found=Unknown-ProbeVisible $r;$i=$found.probe
   if($null -ne $req.previous -and ($i.x -ne $req.previous.x -or $i.y -ne $req.previous.y)){throw 'unknown-probe-changed'}
   if($found.snapshot.folderFlags -ne $r.originalFlags){throw 'unknown-calibration-flags'}
   [OkibaFolderView]::PositionNewItem([int]$i.index,$r.records[0].path,[int]$i.x,[int]$i.y,[int]$req.point.x,[int]$req.point.y,[string]$i.identity)
   $clock=[Diagnostics.Stopwatch]::StartNew();$probe=@{path=$r.records[0].path;name=[IO.Path]::GetFileName($r.records[0].path)}
   $after=Wait-CalibrationSettled $r.snapshot $probe $r.plan.patch $clock;if(-not $after.ok){throw 'unknown-sample-not-settled'}
   return @{ok=$true;snapshot=$after.current;probe=$after.new[0];elapsedMs=$clock.Elapsed.TotalMilliseconds}
  }
  default {throw 'unknown-ci-command-unsupported'}
 }
}
