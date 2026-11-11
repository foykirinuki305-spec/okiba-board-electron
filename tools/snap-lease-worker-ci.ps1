param([Parameter(Mandatory=$true)][string]$SpecPath)
. (Join-Path $PSScriptRoot 'snap-lease-common-ci.ps1')
$spec=Read-LeaseJson $SpecPath;$journal=Join-Path $spec.caseDir 'journal.json'
Save-LeaseJson (Join-Path $spec.caseDir 'worker-ready.json') @{pid=$PID;started=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()}
$deadline=[DateTime]::UtcNow.AddSeconds(40)
do{if(Test-Path -LiteralPath $journal){$j=Read-LeaseJson $journal;if($j.phase -eq 'armed'){break}};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $deadline)
if($j.phase -ne 'armed'){throw 'watchdog did not arm'}
$show=if($spec.killPhase -eq 'off'){0}elseif($spec.killPhase -eq 'one-visible'){1}else{@($j.records).Count}
for($i=0;$i -lt $show;$i++){
 $r=$j.records[$i];$null=Assert-LeaseRecord $r
 [IO.File]::SetAttributes($r.path,[IO.FileAttributes]($r.attributes -band (-bnot 2)));[LeaseFileCI]::Updated($r.path)
}
if($show -gt 0){
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 do{
  $s=Get-LeaseSnapshot
  if(Assert-LeaseOld $spec.baseline $s @($spec.selected.path)){
   $visible=@($s.icons|Where-Object{$p=$_.path;$p -and @($spec.selected|Where-Object{[string]::Equals($_.path,$p,[StringComparison]::OrdinalIgnoreCase)}).Count})
   if($visible.Count -eq $show){break}
  }
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $deadline)
 if($visible.Count -ne $show){throw 'worker reveal timeout'}
}
if($spec.killPhase -eq 'pre-restore'){
 $ids=@();$paths=@();$ox=@();$oy=@();$nx=@();$ny=@()
 foreach($target in $spec.targets){$i=@($s.icons|Where-Object{[string]::Equals($_.path,$target.path,[StringComparison]::OrdinalIgnoreCase)});if($i.Count -ne 1){throw 'worker target identity missing'};$ids+=$i[0].identity;$paths+=$target.path;$ox+=$i[0].x;$oy+=$i[0].y;$nx+=$target.x;$ny+=$target.y}
 $dpi=[OkibaWin32]::EnterPhysicalScope()
 try{[OkibaFolderView]::PositionNewItems([string[]]$ids,[string[]]$paths,[int[]]$ox,[int[]]$oy,[int[]]$nx,[int[]]$ny)}finally{if($dpi -ne [IntPtr]::Zero){[OkibaWin32]::LeavePhysicalScope($dpi)}}
 Start-Sleep -Milliseconds 250;$s=Get-LeaseSnapshot
 if(-not (Assert-LeaseOld $spec.baseline $s @($spec.selected.path))){throw 'worker placement snapshot unavailable'}
 foreach($target in $spec.targets){$i=@($s.icons|Where-Object{[string]::Equals($_.path,$target.path,[StringComparison]::OrdinalIgnoreCase)});if($i.Count -ne 1 -or $i[0].x -ne $target.x -or $i[0].y -ne $target.y){throw 'worker placement inexact'}}
}
Save-LeaseJson (Join-Path $spec.caseDir 'phase.json') @{phase=$spec.killPhase;visible=$show;pid=$PID;time=[DateTime]::UtcNow.ToString('o')}
# Black-box worker deliberately waits here; CI supervisor forcibly terminates it or its host.
while($true){Start-Sleep -Milliseconds 200}
