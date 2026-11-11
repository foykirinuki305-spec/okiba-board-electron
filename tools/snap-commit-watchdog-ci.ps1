param([Parameter(Mandatory=$true)][string]$SpecPath)
. (Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1')
$spec=Read-LeaseJson $SpecPath;$journal=Join-Path $spec.caseDir 'journal.json';$result=Join-Path $spec.caseDir 'result.json'
$report=@{ok=$false;scope='CI-only durable commit gate; no production connection';events=@()}
$mutex=$null;$locked=$false;$hostProcess=$null;$workerProcess=$null;$records=@();$original=$null;$permit=$null
function Record-Lease($phase,$detail=$null){$script:report.phase=$phase;$script:report.events+=@{phase=$phase;utc=[DateTime]::UtcNow.ToString('o');detail=$detail};Save-LeaseJson $script:journal @{phase=$phase;original=$script:original;records=$script:records;permit=$script:permit;receipts=$script:spec.receipts;report=$script:report}}
try {
 $mutex=New-Object Threading.Mutex($false,('Local\OkibaSnapLeaseCI-'+[Diagnostics.Process]::GetCurrentProcess().SessionId))
 $locked=$mutex.WaitOne(0);if(-not $locked){throw 'lease already owned'}
 $identity=Read-LeaseJson (Join-Path $spec.caseDir 'host.json')
 $hostProcess=[Diagnostics.Process]::GetProcessById([int]$identity.hostPid);$workerProcess=[Diagnostics.Process]::GetProcessById([int]$identity.workerPid)
 $null=$hostProcess.Handle;$null=$workerProcess.Handle # Pin process handles; do not rely on reusable PIDs.
 if($hostProcess.StartTime.ToUniversalTime().Ticks.ToString() -cne $identity.hostStart -or $workerProcess.StartTime.ToUniversalTime().Ticks.ToString() -cne $identity.workerStart){throw 'process identity changed'}
 $null=Wait-LeaseHidden $spec
 foreach($i in $spec.selected){$records+=New-LeaseRecord $i.path $spec.tag $i.hash}
 $original=[OkibaFolderView]::ReadState();if(($original[0] -band 5) -ne 4 -or $original[1] -ne 0){throw 'initial flags not manual grid ON'}
 Record-Lease 'before-disable'
 [OkibaFolderView]::SetFlagsForCI([uint32]4,[uint32]0)
 $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 0 -or $flags[1] -ne 0){throw 'snap OFF not verified'}
 Record-Lease 'armed'
 # Wait for exact placement, still before commit permission.
 $deadline=[DateTime]::UtcNow.AddSeconds(35);$phasePath=Join-Path $spec.caseDir 'phase.json'
 do{
  $hostProcess.Refresh();$workerProcess.Refresh()
  if($hostProcess.HasExited -or $workerProcess.HasExited){throw 'owner stopped before commit preparation'}
  if([IO.File]::Exists($phasePath)){break}
  $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 0){throw 'external setting change'}
  $null=Assert-LeaseOld $spec.baseline (Get-LeaseSnapshot) @($spec.selected.path)
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $deadline)
 if(-not [IO.File]::Exists($phasePath)){throw 'placement phase timeout'}
 $phase=Read-LeaseJson $phasePath;if($phase.phase -ne 'pre-restore'){throw 'unexpected placement phase'}
 # Worker cannot perform late visual writes after the gate opens.
 $workerProcess.Kill();if(-not $workerProcess.WaitForExit(5000)){throw 'worker stop not confirmed'}
 function Assert-CommitVisible {
  $s=Get-LeaseSnapshot
  if(-not (Assert-LeaseOld $spec.baseline $s @($spec.selected.path))){throw 'visible snapshot unavailable'}
  foreach($target in $spec.targets){$i=@($s.icons|Where-Object{[string]::Equals($_.path,$target.path,[StringComparison]::OrdinalIgnoreCase)});if($i.Count -ne 1 -or $i[0].x -ne $target.x -or $i[0].y -ne $target.y){throw 'commit target not exact'}}
  foreach($r in $records){$now=Assert-LeaseRecord $r;if(($now.attributes -band 2) -ne 0){throw 'committed target hidden'}}
 }
 Assert-CommitVisible
 $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 0){throw 'flags changed before restore'}
 Record-Lease 'before-setting-restore'
 [OkibaFolderView]::SetFlagsForCI([uint32]4,[uint32]($original[0] -band 4))
 Start-Sleep -Milliseconds 250
 $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 4 -or $flags[1] -ne 0){throw 'snap ON not restored'}
 Assert-CommitVisible
 # Verify every preauthorized metadata path and before digest immediately before permission.
 foreach($r in $spec.receipts){
  if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($r.path)) -cne (Join-Path $spec.caseDir 'metadata')){throw 'receipt path outside owned temp scope'}
  if((Get-FileHash -LiteralPath $r.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.beforeHash){throw 'before receipt changed'}
 }
 $hostProcess.Refresh();if($hostProcess.HasExited){throw 'host exited before permission'}
 if($spec.commitCase -eq 'abort-before-permit'){
  # Durable terminal state; no permit was ever issued. A late polling host must not write.
  Record-Lease 'aborted-before-permit'
  foreach($r in $records){$null=Assert-LeaseRecord $r;[IO.File]::SetAttributes($r.path,[IO.FileAttributes]$r.attributes);[LeaseFileCI]::Updated($r.path)}
  $null=Wait-LeaseHidden $spec
  Start-Sleep -Milliseconds 500
  foreach($r in $spec.receipts){if((Get-FileHash -LiteralPath $r.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.beforeHash){throw 'late commit after abort'}}
  $report.outcome='rollback-selected';$report.permitIssued=$false;$report.ok=$true
 }else{
 $permit=[guid]::NewGuid().ToString('N');$report.permitIssued=$true;Record-Lease 'commit-permitted'
 # Permission is durable. A live owner timeout is not authority to hide anything.
 $deadline=[DateTime]::UtcNow.AddSeconds(35);$ackPath=Join-Path $spec.caseDir 'ack.json';$ack=$null
 do{
  $hostProcess.Refresh()
  if([IO.File]::Exists($ackPath)){$ack=Read-LeaseJson $ackPath;if($ack.permit -cne $permit){throw 'wrong acknowledgement permit'};break}
  if($hostProcess.HasExited){break}
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $deadline)
 $hostProcess.Refresh()
 if(-not $ack -and -not $hostProcess.HasExited){$report.outcome='wait-owner';Record-Lease 'wait-owner';throw 'owner alive after permitted deadline; no rollback'}
 $states=@();foreach($r in $spec.receipts){$h=(Get-FileHash -LiteralPath $r.path -Algorithm SHA256).Hash.ToLowerInvariant();$states+=if($h -ceq $r.beforeHash){'before'}elseif($h -ceq $r.afterHash){'after'}else{'unknown'}}
 $report.receiptStates=$states;$report.ownerExited=$hostProcess.HasExited;$report.acknowledged=($null -ne $ack)
 if(@($states|Where-Object{$_ -ne 'after'}).Count -eq 0){
  Assert-CommitVisible;$report.outcome='keep-visible';$report.ok=$true;Record-Lease 'committed'
 }elseif(-not $ack -and $hostProcess.HasExited -and @($states|Where-Object{$_ -ne 'before'}).Count -eq 0){
  Record-Lease 'before-hide-rollback'
  foreach($r in $records){$null=Assert-LeaseRecord $r;[IO.File]::SetAttributes($r.path,[IO.FileAttributes]$r.attributes);[LeaseFileCI]::Updated($r.path)}
  $null=Wait-LeaseHidden $spec;$report.outcome='rollback-selected';$report.ok=$true;Record-Lease 'aborted'
 }else{
  Assert-CommitVisible;$report.outcome='blocked';$report.ok=$true;Record-Lease 'blocked-receipts'
 }
 }
 $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 4 -or $flags[1] -ne 0){throw 'final flags changed'}
 $report.originalFlags=$original;$report.restoredFlags=$flags
} catch {$report.ok=$false;$report.error=$_.Exception.ToString();try{Record-Lease 'blocked-recovery' $report.error}catch{}}
finally {
 Save-LeaseJson $result $report
 if($locked){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()};if($hostProcess){$hostProcess.Dispose()};if($workerProcess){$workerProcess.Dispose()}
}
if(-not $report.ok){exit 1}
