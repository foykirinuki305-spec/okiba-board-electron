param([Parameter(Mandatory=$true)][string]$SpecPath)
. (Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1')
$spec=Read-LeaseJson $SpecPath;$journal=Join-Path $spec.caseDir 'journal.json';$result=Join-Path $spec.caseDir 'result.json'
$report=@{ok=$false;scope='CI-only same-path hidden rollback; watchdog simultaneous death and OS shutdown NOT covered';events=@()}
$mutex=$null;$locked=$false;$hostProcess=$null;$workerProcess=$null;$records=@();$original=$null
function Record-Lease($phase,$detail=$null){$script:report.phase=$phase;$script:report.events+=@{phase=$phase;utc=[DateTime]::UtcNow.ToString('o');detail=$detail};Save-LeaseJson $script:journal @{phase=$phase;original=$script:original;records=$script:records;report=$script:report}}
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
 $deadline=[DateTime]::UtcNow.AddSeconds(35);$cause=$null
 do{
  $hostProcess.Refresh();$workerProcess.Refresh()
  if($hostProcess.HasExited){$cause='host-exit';break}
  if($workerProcess.HasExited){$cause='worker-exit';break}
  if((Test-Path (Join-Path $spec.caseDir 'heartbeat')) -and ([DateTime]::UtcNow-(Get-Item (Join-Path $spec.caseDir 'heartbeat')).LastWriteTimeUtc).TotalSeconds -gt 3){$cause='heartbeat-expired';break}
  $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 0 -or $flags[1] -ne 0){throw 'external setting change; no blind restoration permitted'}
  $s=Get-LeaseSnapshot;$null=Assert-LeaseOld $spec.baseline $s @($spec.selected.path)
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $deadline)
 if(-not $cause){$cause='lease-deadline'}
 Record-Lease 'stopping-worker' $cause
 $workerProcess.Refresh();if(-not $workerProcess.HasExited){$workerProcess.Kill();if(-not $workerProcess.WaitForExit(5000)){throw 'worker termination unconfirmed'}}
 Record-Lease 'before-hide-rollback'
 foreach($r in $records){$null=Assert-LeaseRecord $r;[IO.File]::SetAttributes($r.path,[IO.FileAttributes]$r.attributes);[LeaseFileCI]::Updated($r.path)}
 $null=Wait-LeaseHidden $spec
 foreach($r in $records){$now=Assert-LeaseRecord $r;if($now.attributes -ne $r.attributes){throw 'original attributes not restored'}}
 Record-Lease 'before-setting-restore'
 $flags=[OkibaFolderView]::ReadState();if(($flags[0] -band 5) -ne 0 -or $flags[1] -ne 0){throw 'external flags changed before restore'}
 [OkibaFolderView]::SetFlagsForCI([uint32]4,[uint32]($original[0] -band 4))
 Start-Sleep -Milliseconds 250;$flags=[OkibaFolderView]::ReadState()
 if(($flags[0] -band 5) -ne ($original[0] -band 5) -or $flags[1] -ne $original[1]){throw 'flags restoration not verified'}
 $null=Wait-LeaseHidden $spec
 $report.ok=$true;$report.cause=$cause;$report.originalFlags=$original;$report.restoredFlags=$flags
 Record-Lease 'restored'
} catch {$report.error=$_.Exception.ToString();try{Record-Lease 'blocked-recovery' $report.error}catch{}}
finally {
 Save-LeaseJson $result $report
 if($locked){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()};if($hostProcess){$hostProcess.Dispose()};if($workerProcess){$workerProcess.Dispose()}
}
if(-not $report.ok){exit 1}
