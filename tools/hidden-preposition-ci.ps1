param([ValidateSet('modern','legacy')][string]$Mode='modern')
# Research only: never load or execute against a user's desktop.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted Windows CI only'}
$source=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$extra=Get-Content (Join-Path $PSScriptRoot 'hidden-preposition-ci.cs') -Raw
$source=$source.Replace('public static class OkibaFolderView {',('public static class OkibaFolderView {'+[Environment]::NewLine+$extra))
Invoke-Expression $source.Substring(0,$source.IndexOf('# ---- Main loop'))
$report=@{mode=$Mode;scope='CI-only hidden PIDL reservation experiment; not a production feature';proven=$false;events=@()}
$phase='setup';$owned=@();$original=$null;$flags=$null;$dpi=[OkibaWin32]::EnterPhysicalScope()
function Snapshot {
 for($k=0;$k -lt 40;$k++){$r=Get-StrictDesktopSnapshot;if($r.ok){return $r};if($k -eq 0){$script:report.events+=@{phase=$script:phase;kind='snapshot-not-ready';result=$r}};Start-Sleep -Milliseconds 100}
 $script:report.events+=@{phase=$script:phase;kind='snapshot-timeout';strict=$r;raw=(Get-RawStrictDesktopSnapshot)}
 throw 'Snapshot unavailable'
}
function Find-Probe($s,$path){$name=[IO.Path]::GetFileName($path);$stem=[IO.Path]::GetFileNameWithoutExtension($path);$hits=@($s.icons|Where-Object {$_.label -ceq $name -or $_.label -ceq $stem});if($hits.Count -eq 1){return $hits[0]};return $null}
function Wait-Visible($path,$visible){
 for($k=0;$k -lt 60;$k++){
  $s=Snapshot;$i=Find-Probe $s $path
  if($k -eq 0){$script:report.events+=@{phase=$script:phase;kind='wait-start';path=$path;expectedVisible=$visible;exists=(Test-Path -LiteralPath $path);attributes=$(if(Test-Path -LiteralPath $path){[string][IO.File]::GetAttributes($path)}else{'missing'});snapshot=$s}}
  if(($null -ne $i) -eq $visible){$script:report.events+=@{phase=$script:phase;kind='wait-done';iteration=$k;visible=($null -ne $i)};return $s}
  Start-Sleep -Milliseconds 100
 }
 $script:report.events+=@{phase=$script:phase;kind='wait-timeout';path=$path;expectedVisible=$visible;exists=(Test-Path -LiteralPath $path);attributes=$(if(Test-Path -LiteralPath $path){[string][IO.File]::GetAttributes($path)}else{'missing'});snapshot=$s;raw=(Get-RawStrictDesktopSnapshot)}
 throw ('Visibility transition timed out: '+$script:phase)
}
function Put($path,$point){$s=Wait-Visible $path $true;$i=Find-Probe $s $path;[OkibaFolderView]::PositionNewItem($i.index,$path,$i.x,$i.y,$point.x,$point.y);Start-Sleep -Milliseconds 500;$s=Snapshot;$i=Find-Probe $s $path;if(-not (Strict-Near $i $point)){throw 'Fixture placement failed'};return $s}
function Old-Signature($s,$exclude){return (@($s.icons|Where-Object { $hit=$false;foreach($p in $exclude){if($_.label -ceq [IO.Path]::GetFileName($p) -or $_.label -ceq [IO.Path]::GetFileNameWithoutExtension($p)){$hit=$true}};-not $hit }|ForEach-Object {Strict-IconKey $_}|Sort-Object)|ConvertTo-Json -Compress)}
try {
 $original=Snapshot;$flags=[OkibaFolderView]::ReadState();[OkibaFolderView]::SetFlagsForCI(5,4);Start-Sleep -Milliseconds 300
 $base=Snapshot;if((Strict-IconsKey $base) -cne (Strict-IconsKey $original)){throw 'Fixture settings moved existing icons'}
 $points=@();foreach($a in $base.areas){if($null -eq $a.grid){continue};$g=$a.grid
  for($x=$a.left+(($g.gx-$a.left)%$g.sx+$g.sx)%$g.sx;$x+$g.sx -le $a.right -and $points.Count -lt 2;$x+=$g.sx){
   for($y=$a.top+(($g.gy-$a.top)%$g.sy+$g.sy)%$g.sy;$y+$g.sy -le $a.bottom -and $points.Count -lt 2;$y+=$g.sy){$p=@{x=[int]$x;y=[int]$y};$blocked=$false;foreach($i in $base.icons){if(Strict-Overlap $p $i $base){$blocked=$true}};if(-not $blocked){$points+=$p}}
  }
 }
 if($points.Count -ne 2){throw 'No free fixture positions'}
 $desktop=[Environment]::GetFolderPath('DesktopDirectory');$tag=[Guid]::NewGuid().ToString('N')
 $probe=Join-Path $desktop ('OkibaHidden-'+$tag+'.lnk');$guard=Join-Path $desktop ('OkibaGuard-'+$tag+'.txt');$owned=@($probe,$guard)
 $w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut($probe);$link.TargetPath=Join-Path $env:WINDIR 'System32/notepad.exe';$link.Save();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($link);[void][Runtime.InteropServices.Marshal]::ReleaseComObject($w)
 $phase='probe-created-arrival';$report.probePath=$probe;$report.probeBytes=(Get-Item -LiteralPath $probe).Length
 $null=Put $probe $points[0]
 $phase='probe-hide';[IO.File]::SetAttributes($probe,([IO.File]::GetAttributes($probe) -bor [IO.FileAttributes]::Hidden));$null=Wait-Visible $probe $false
 $phase='guard-arrival';[IO.File]::WriteAllText($guard,'CI guard only');$before=Put $guard $points[0]
 if((Old-Signature $before $owned) -cne (Strict-IconsKey $original)){throw 'Fixture changed original icons; preposition not attempted'}
 $report.before= @{oldCell=$points[0];target=$points[1];allExisting=(Old-Signature $before @($probe))}
 $phase='hidden-api';try{$report.api=[OkibaFolderView]::PrepositionHiddenForCI($probe,$points[1].x,$points[1].y,$(if($Mode -eq 'legacy'){1}else{0}))}catch{$report.apiError=$_.Exception.ToString()}
 Start-Sleep -Milliseconds 500;$hidden=Snapshot
 $report.hiddenStillHidden=([IO.File]::GetAttributes($probe) -band [IO.FileAttributes]::Hidden) -ne 0
 $report.hiddenStillAbsent=$null -eq (Find-Probe $hidden $probe)
 $report.beforeUnhideExistingUnchanged=(Old-Signature $hidden @($probe)) -ceq (Old-Signature $before @($probe))
 $phase='probe-unhide';[IO.File]::SetAttributes($probe,([IO.File]::GetAttributes($probe) -band (-bnot [IO.FileAttributes]::Hidden)))
 $after=Wait-Visible $probe $true;Start-Sleep -Milliseconds 750;$after=Snapshot;$i=Find-Probe $after $probe
 $report.afterUnhide=@{probe=@{x=$i.x;y=$i.y};guard=(Find-Probe $after $guard);existingUnchanged=((Old-Signature $after @($probe)) -ceq (Old-Signature $before @($probe)))}
 $report.proven=$report.hiddenStillHidden -and $report.hiddenStillAbsent -and $report.beforeUnhideExistingUnchanged -and $report.afterUnhide.existingUnchanged -and (Strict-Near $i $points[1])
 Write-Host ('Hidden preposition evidence proven='+$report.proven)
}catch{$report.error=$_.Exception.ToString();$report.errorPhase=$phase;$report.errorStack=$_.ScriptStackTrace;throw}finally{
 $phase='cleanup';try{foreach($p in $owned){if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}};Start-Sleep -Milliseconds 500
  if($null -ne $flags){[OkibaFolderView]::SetFlagsForCI(5,[uint32]($flags[0] -band 5))}
  if($null -ne $original){$last=Snapshot;$report.cleanupExistingUnchanged=(Strict-IconsKey $last) -ceq (Strict-IconsKey $original);$report.cleanupBefore=$original;$report.cleanupAfter=$last}
 }finally{$report|ConvertTo-Json -Depth 12|Set-Content (Join-Path $PSScriptRoot ('../hidden-preposition-'+$Mode+'-ci.json')) -Encoding UTF8;[OkibaWin32]::LeavePhysicalScope($dpi)}
}
