# Standalone cleanup for synthetic, already-terminal hosted fixture files only.
# No flag changes, no moves, no deletes. The caller must close the owning watchdog first.
function Unknown-FixtureHideCleanup($req){
 Unknown-CIOnly;if($null -ne $script:SnapLease){throw 'cleanup-active-helper-lease'}
 if($null -eq $req.snapshot -or @($req.records).Count -lt 1 -or @($req.records).Count -gt 32){throw 'cleanup-invalid-scope'}
 $r=@{version=2;kind='samepath-hidden-unknown-grid-ci';snapshot=$req.snapshot;originalFlags=[uint32]$req.snapshot.folderFlags;records=@($req.records);targets=@();flagState='on'}
 $seen=@{};foreach($record in $r.records){$p=Lease-Path $record.path;if($seen.ContainsKey($p)){throw 'cleanup-duplicate-record'};$seen[$p]=$true;foreach($old in $r.snapshot.icons){if($old.path -and (Lease-Path $old.path) -ieq $p){throw 'cleanup-record-was-baseline-icon'}}}
 $s=Unknown-Current $r;$null=Lease-Guard $r $s
 # The fully bound record checks preserve file identity, size, time and all other bits.
 # Idempotent Hidden is allowed only for these same owned fixture records on a retry.
 foreach($record in $r.records){$null=Unknown-Current $r;$n=Lease-CheckRecord $record;if(-not $n.hidden){Lease-SetHidden $record $true $false}}
 $s=Lease-WaitVisibility $r $false;Unknown-AssertFlags $r $s;Unknown-TerminalHidden $r
 if((Lease-Guard $r $s).Count -ne 0){throw 'cleanup-selected-still-visible'}
 return @{ok=$true;selectedHidden=$true;oldUnchanged=$true;flagsUnchanged=$true;snapshot=$s}
}
