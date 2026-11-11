param([Parameter(Mandatory=$true)][string]$SpecPath)
. (Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1')
$spec=Read-LeaseJson $SpecPath
$worker=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList ('-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'snap-lease-worker-ci.ps1')+'" -SpecPath "'+$SpecPath+'"') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $spec.caseDir 'worker.stdout.log') -RedirectStandardError (Join-Path $spec.caseDir 'worker.stderr.log') -PassThru
$me=Get-Process -Id $PID
Save-LeaseJson (Join-Path $spec.caseDir 'host.json') @{hostPid=$PID;hostStart=$me.StartTime.ToUniversalTime().Ticks.ToString();workerPid=$worker.Id;workerStart=$worker.StartTime.ToUniversalTime().Ticks.ToString()}
$acted=$false
while($true){
 [IO.File]::WriteAllText((Join-Path $spec.caseDir 'heartbeat'),[DateTime]::UtcNow.ToString('o'))
 $journal=Join-Path $spec.caseDir 'journal.json'
 if(-not $acted -and [IO.File]::Exists($journal)){
  $j=Read-LeaseJson $journal
  if($j.phase -eq 'commit-permitted'){
   if(-not $j.permit -or $j.receipts.Count -ne $spec.receipts.Count){throw 'invalid permit'}
   # Scope is fixed before the lease. Never accept a path from the permit itself.
   for($i=0;$i -lt $spec.receipts.Count;$i++){
    $r=$spec.receipts[$i];$a=$j.receipts[$i]
    if($a.path -cne $r.path -or $a.beforeHash -cne $r.beforeHash -or $a.afterHash -cne $r.afterHash){throw 'permit scope mismatch'}
    if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($r.path)) -cne (Join-Path $spec.caseDir 'metadata')){throw 'outside fixture metadata'}
    if((Get-FileHash -LiteralPath $r.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.beforeHash){throw 'metadata changed before commit'}
   }
   if($spec.commitCase -eq 'death-before'){exit 0}
   for($i=0;$i -lt $spec.receipts.Count;$i++){
    $r=$spec.receipts[$i];$text=$r.afterText
    if($spec.commitCase -eq 'third-party' -and $i -eq 0){$text='third-party-edited-by-test'}
    $tmp=$r.path+'.commit.tmp';[IO.File]::WriteAllText($tmp,$text,[Text.UTF8Encoding]::new($false))
    Invoke-LeaseFileExchange {[IO.File]::Replace($tmp,$r.path,[System.Management.Automation.Language.NullString]::Value)}
   }
   $acted=$true
   if($spec.commitCase -in @('ack-lost','third-party')){exit 0}
   Save-LeaseJson (Join-Path $spec.caseDir 'ack.json') @{permit=$j.permit;phase='committed'}
  }
 }
 Start-Sleep -Milliseconds 100
}
