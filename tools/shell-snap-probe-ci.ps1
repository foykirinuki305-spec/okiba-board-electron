# Experimental evidence only. Never run on a user's desktop.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted Windows CI only; local execution forbidden.'}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
$cut=$source.IndexOf('# ---- Main loop ')
if($cut -lt 0){throw 'Helper definition boundary missing'}
. ([scriptblock]::Create($source.Substring(0,$cut)))
$ErrorActionPreference='Stop'
$report=@{scope='Single-display Shell snap evidence, NOT mixed-DPI verification';samples=@();events=@();proven=$false}
$probe=$null;$created=$false;$baseline=$null;$originalFlags=$null;$beforeSetup=$null
$dpi=[OkibaWin32]::EnterPhysicalScope()
function Old-Key($s){return (@($s.icons | Where-Object {$_.label -cne $script:name -and $_.label -cne $script:stem} | ForEach-Object {Strict-IconKey $_} | Sort-Object) | ConvertTo-Json -Compress)}
function Geometry($s){return (@($s.autoArrange,$s.snap,$s.sx,$s.sy,$s.origin,@($s.areas | ForEach-Object {@($_.left,$_.top,$_.right,$_.bottom,$_.scale)})) | ConvertTo-Json -Compress -Depth 8)}
function Evidence($phase,$snapshot,$detail='') {
 $script:report.events+=@{time=[DateTime]::UtcNow.ToString('o');phase=$phase;detail=$detail;snapshot=$snapshot}
}
function Stable([string]$phase,[bool]$guardOld=$false) {
 $deadline=[DateTime]::UtcNow.AddSeconds(10);$previous=$null
 do {
  $s=Get-StrictDesktopSnapshot
  if(-not $s.ok){
   Evidence $phase $s 'strict-snapshot-not-ready'
   try {
    $raw=Get-RawStrictDesktopSnapshot
    Evidence $phase $raw 'diagnostic-raw-snapshot'
   }catch{Evidence $phase $null ('raw-exception: '+$_.Exception.ToString());$raw=$null}
   if($guardOld -and $raw -and $raw.ok -and ((Old-Key $raw) -cne $script:oldKey -or (Geometry $raw) -cne $script:geometry)){throw ('Existing icons or geometry changed during '+$phase)}
   $previous=$null
  } else {
   if($guardOld -and ((Old-Key $s) -cne $script:oldKey -or (Geometry $s) -cne $script:geometry)){
    Evidence $phase $s 'existing-icon-or-geometry-mismatch';throw ('Existing icons or geometry changed during '+$phase)
   }
   if($null -ne $previous -and (Strict-IconsKey $previous) -ceq (Strict-IconsKey $s) -and (Geometry $previous) -ceq (Geometry $s)){return $s}
   Evidence $phase $s 'waiting-for-second-identical-snapshot';$previous=$s
  }
  Start-Sleep -Milliseconds 150
 }while([DateTime]::UtcNow -lt $deadline)
 throw ('Snapshot did not stabilize: '+$phase)
}
function Guard {return (Stable $script:phase $true)}
function Sample([int]$x,[int]$y,[string]$axis){
 $script:phase='before-'+$axis;$s=Guard
 $icons=@($s.icons | Where-Object {$_.label -ceq $script:name -or $_.label -ceq $script:stem})
 if($icons.Count -ne 1){throw 'Probe identity ambiguous'}
 $i=$icons[0]
 [OkibaFolderView]::PositionNewItem([int]$i.index,$script:probe,[int]$i.x,[int]$i.y,$x,$y)
 Start-Sleep -Milliseconds 180
 $script:phase='after-'+$axis;$after=Guard;$q=@($after.icons | Where-Object {$_.label -ceq $script:name -or $_.label -ceq $script:stem})
 if($q.Count -ne 1){throw 'Probe disappeared'}
 $r=@{axis=$axis;requestX=$x;requestY=$y;x=[int]$q[0].x;y=[int]$q[0].y}
 if($r.x -lt $script:patch.left -or $r.y -lt $script:patch.top -or $r.x -gt $script:patch.right -or $r.y -gt $script:patch.bottom){throw 'Probe snapped outside reserved empty patch'}
 $script:report.samples+= $r
 return $r
}
try {
 $phase='initial';$beforeSetup=Stable $phase
 $report.beforeSetup=$beforeSetup
 if(-not $beforeSetup.ok){throw 'Initial desktop snapshot unavailable'}
 $originalFlags=[OkibaFolderView]::ReadState()
 [OkibaFolderView]::SetFlagsForCI([uint32]5,[uint32]4)
 Start-Sleep -Milliseconds 300
 $phase='settings';$baseline=Stable $phase
 $report.baseline=$baseline
 if(-not $baseline.ok -or $baseline.autoArrange -or -not $baseline.snap){throw 'CI Shell did not enable manual arrangement and snap ON'}
 if((Strict-IconsKey $beforeSetup) -cne (Strict-IconsKey $baseline)){throw 'CI settings initialization moved existing icons; probe aborted'}
 if(@($baseline.areas).Count -ne 1){throw 'This experiment is single-display only'}
 $r=$baseline.areas[0];$sx=[int]$baseline.sx;$sy=[int]$baseline.sy
 $patch=$null
 # Require a 5x5 empty grid-sized rectangle, with one-cell guard around the sweep.
 for($x=[int]$r.left+$sx;$x+5*$sx -le $r.right -and $null -eq $patch;$x+=$sx){
  for($y=[int]$r.top+$sy;$y+5*$sy -le $r.bottom;$y+=$sy){
   $near=@($baseline.icons | Where-Object {$_.x -ge $x-$sx -and $_.x -le $x+6*$sx -and $_.y -ge $y-$sy -and $_.y -le $y+6*$sy})
   if($near.Count -eq 0){$patch=@{left=$x;top=$y;right=$x+5*$sx;bottom=$y+5*$sy};break}
  }
 }
 if($null -eq $patch){throw 'No sufficiently large isolated empty patch; no probe created'}
 $name='okiba-snap-probe-'+[guid]::NewGuid().ToString('N')+'.txt';$stem=[IO.Path]::GetFileNameWithoutExtension($name)
 $oldKey=Old-Key $baseline;$geometry=Geometry $baseline
 $desktop=[Environment]::GetFolderPath('DesktopDirectory');$probe=Join-Path $desktop $name
 $payload='Okiba hosted-CI snap probe '+$name
 $stream=[IO.File]::Open($probe,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes($payload);$stream.Write($bytes,0,$bytes.Length);$created=$true}finally{$stream.Dispose()}
 $deadline=[DateTime]::UtcNow.AddSeconds(10)
 $phase='arrival'
 do{Start-Sleep -Milliseconds 100;$s=Guard;$found=@($s.icons | Where-Object {$_.label -ceq $name -or $_.label -ceq $stem})}while($found.Count -ne 1 -and [DateTime]::UtcNow -lt $deadline)
 if($found.Count -ne 1){throw 'Probe did not appear'}
 $cx=$patch.left+[int][Math]::Floor(2.5*$sx);$cy=$patch.top+[int][Math]::Floor(2.5*$sy)
 $null=Sample $cx $cy 'center'
 foreach($axis in @('x','y')){
  $pitch=if($axis -eq 'x'){$sx}else{$sy}
  $step=[Math]::Max(2,[int][Math]::Floor($pitch/10))
  $rows=@()
  $radius=[int][Math]::Floor(1.5*$pitch)
  for($delta=-$radius;$delta -le $radius;$delta+=$step){
   $xx=$cx;$yy=$cy;if($axis -eq 'x'){$xx+=$delta}else{$yy+=$delta}
   $rows+=Sample $xx $yy $axis
  }
  $values=@($rows | ForEach-Object {$_[$axis]} | Sort-Object -Unique)
  $diffs=@();for($i=1;$i -lt $values.Count;$i++){$diffs+=($values[$i]-$values[$i-1])}
  $plateaus=@($rows | Group-Object -Property $axis | Where-Object {$_.Count -gt 1})
  $uniform=$values.Count -ge 3 -and @($diffs | Sort-Object -Unique).Count -eq 1 -and $diffs[0] -gt $step -and $plateaus.Count -ge 2
  # Reverse traversal must reproduce every measured sample exactly.
  for($i=$rows.Count-1;$i -ge 0;$i--){$old=$rows[$i];$again=Sample $old.requestX $old.requestY ($axis+'-reverse');if($again.x -ne $old.x -or $again.y -ne $old.y){$uniform=$false}}
  $report[$axis]=@{proven=$uniform;values=$values;deltas=$diffs;plateaus=$plateaus.Count}
 }
 $report.proven=$report.x.proven -and $report.y.proven
 if(-not $report.proven){throw 'Shell snap plateau NOT proven; see raw samples. Do not enable production calibration.'}
 Write-Host 'PASS: single-display Shell snap plateau and reverse reproducibility proven.'
} catch {$report.error=$_.Exception.Message;throw} finally {
 try {
  if($created){
   if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($probe)) -ine [IO.Path]::GetFullPath($desktop) -or [IO.Path]::GetFileName($probe) -cne $name){throw 'Cleanup path mismatch'}
   if([IO.File]::ReadAllText($probe) -cne $payload){throw 'Probe changed; refusing deletion'}
   Remove-Item -LiteralPath $probe
   Start-Sleep -Milliseconds 400
   $phase='cleanup-removal';$null=Guard
  }
 } finally {
  try {
   if($null -ne $originalFlags){
    [OkibaFolderView]::SetFlagsForCI([uint32]5,[uint32]($originalFlags[0] -band 5))
    Start-Sleep -Milliseconds 300
    $restored=[OkibaFolderView]::ReadState()
    if(($restored[0] -band 5) -ne ($originalFlags[0] -band 5) -or $restored[1] -ne $originalFlags[1]){throw 'CI original Shell flags restoration failed'}
    $phase='settings-restoration';$last=Stable $phase
    $report.afterRestoration=$last
    if((Strict-IconsKey $last) -cne (Strict-IconsKey $beforeSetup)){throw 'CI existing icon positions differ after cleanup and settings restoration (stable snapshots)'}
    $report.settingsRestored=$true
   }
  } catch {$report.cleanupError=$_.Exception.Message;throw} finally {
   $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\shell-snap-probe-ci.json') -Encoding UTF8
   if($dpi -ne [IntPtr]::Zero){[OkibaWin32]::LeavePhysicalScope($dpi)}
  }
 }
}
