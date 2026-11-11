# Hosted-CI only. Called inside safe-desktop-test.ps1's settings save/restore scope.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Desktop batch placement is hosted CI only'}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
$source=$source.Substring(0,$source.IndexOf('# ---- Main loop '))
if('OkibaFolderView' -as [type]){$source=[regex]::Replace($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@",'')}
. ([scriptblock]::Create($source))
$ErrorActionPreference='Stop'
# Truthful, fixture-only deletion notification; never announce an existing path deleted.
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public static class OkibaBatchCleanupCI {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern void SHChangeNotify(uint ev,uint flags,string path,IntPtr second);
 public static void Deleted(string path){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");
  if(System.IO.File.Exists(path)||System.IO.Directory.Exists(path))throw new InvalidOperationException("path still exists");
  SHChangeNotify(4u,0x1005u,path,IntPtr.Zero);
 }
}
"@
$previous=[OkibaWin32]::EnterPhysicalScope();$owned=@();$baseline=$null
function StableBatch {
 for($i=0;$i -lt 40;$i++){$s=Get-StrictDesktopSnapshot;if($s.ok){return $s};Start-Sleep -Milliseconds 100}
 throw 'No stable CI snapshot'
}
function Check($condition,$message){if(-not $condition){throw $message};Write-Host ('PASS batch: '+$message)}
try {
 $baseline=StableBatch
 Check (-not $baseline.autoArrange -and $baseline.snap) 'manual arrangement with grid enabled'
 $tag='okiba-batch-ci-'+[guid]::NewGuid().ToString('N');$desktop=[Environment]::GetFolderPath('DesktopDirectory')
 $targets=@()
 for($i=0;$i -lt 3;$i++){
  $name=$tag+'-'+$i+'.txt';$file=Join-Path $desktop $name
  $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$owned+= $file;$bytes=[Text.Encoding]::UTF8.GetBytes($tag);$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
  $targets+=@{name=$name;path=$file}
 }
 $state=$null
 for($i=0;$i -lt 60;$i++){$current=StableBatch;$state=Get-StrictTransactionState $baseline $current $targets;if(-not $state.ok){throw ('arrival changed existing state: '+($state|ConvertTo-Json -Compress -Depth 8))};if($state.new.Count -eq 3){break};Start-Sleep -Milliseconds 100}
 Check ($state.new.Count -eq 3) 'three owned files arrived without changing existing icons'
 $cells=$null;$grid=$null
 foreach($area in $baseline.areas){
  $g=Strict-AreaGrid $area $baseline;if($null -eq $g){continue}
  $x0=$g.gx+[Math]::Ceiling(($area.left-$g.gx)/$g.sx)*$g.sx;$y0=$g.gy+[Math]::Ceiling(($area.top-$g.gy)/$g.sy)*$g.sy
  for($x=$x0;$x+$g.sx -le $area.right -and $null -eq $cells;$x+=$g.sx){
   for($y=$y0;$y+4*$g.sy -le $area.bottom;$y+=$g.sy){
    $candidate=@(0..3|ForEach-Object{@{x=[int]$x;y=[int]($y+$_*$g.sy)}});$free=$true
    foreach($p in $candidate){foreach($old in $current.icons){if(Strict-Overlap $p $old $g){$free=$false;break}}}
    if($free){$cells=$candidate;$grid=$g;break}
   }
  }
  if($null -ne $cells){break}
 }
 Check ($null -ne $cells) 'four empty vertically aligned cells reserved'
 for($i=0;$i -lt 3;$i++){$targets[$i].x=$cells[$i].x;$targets[$i].y=$cells[$i].y}
 $ids=[string[]]@(0..2|ForEach-Object{$state.new[$_].identity});$paths=[string[]]@(0..2|ForEach-Object{$targets[$_].path})
 $ox=[int[]]@(0..2|ForEach-Object{$state.new[$_].x});$oy=[int[]]@(0..2|ForEach-Object{$state.new[$_].y})
 $nx=[int[]]@(0..2|ForEach-Object{$targets[$_].x});$ny=[int[]]@(0..2|ForEach-Object{$targets[$_].y})
 $badPaths=[string[]]$paths.Clone();$badPaths[1]+='.wrong';$rejected=$false
 try{[OkibaFolderView]::PositionNewItems($ids,$badPaths,$ox,$oy,$nx,$ny)}catch{$rejected=$true}
 Check $rejected 'bad second path rejects entire batch before placement'
 $afterReject=StableBatch;Check ((Strict-IconsKey $current) -ceq (Strict-IconsKey $afterReject)) 'all icon identities and coordinates unchanged after invalid batch'
 $result=Position-DesktopPlan $baseline $targets $cells[3]
 Check $result.ok ('three-file placement succeeded: '+($result|ConvertTo-Json -Compress))
 Check (@($result.batchSizes).Count -eq 1 -and $result.batchSizes[0] -eq 3) 'three independent destinations used one COM batch'
 $swap=@();for($i=0;$i -lt 3;$i++){$slot=if($i -eq 0){1}elseif($i -eq 1){0}else{2};$swap+=@{path=$paths[$i];name=$targets[$i].name;x=$cells[$slot].x;y=$cells[$slot].y}}
 $result=Position-DesktopPlan $baseline $swap $cells[3]
 Check $result.ok ('cyclic swap succeeded using reserved buffer: '+($result|ConvertTo-Json -Compress))
 Check (@($result.batchSizes).Count -eq 3 -and @($result.batchSizes|Where-Object{$_ -ne 1}).Count -eq 0) 'two-item cycle uses three safe singleton waves'
 $last=StableBatch;$guard=Get-StrictTransactionState $baseline $last $swap;Check $guard.ok 'every original icon remains unchanged'
 foreach($n in 0..2){Check (Strict-Near $guard.new[$n] $swap[$n]) ('exact final coordinate for item '+$n)}
} finally {
 try {
  foreach($file in $owned){if([IO.Path]::GetDirectoryName($file) -ine $desktop -or -not [IO.Path]::GetFileName($file).StartsWith($tag+'-')){throw 'cleanup boundary mismatch'};if([IO.File]::ReadAllText($file) -cne $tag){throw 'owned fixture changed; refusing deletion'};Remove-Item -LiteralPath $file;[OkibaBatchCleanupCI]::Deleted($file)}
  if($baseline){
   $deadline=[DateTime]::UtcNow.AddSeconds(15);$consecutive=0;$last=$null;$cleanupState=$null
   do {
    $last=Get-StrictDesktopSnapshot
    if(-not $last.ok){$raw=Get-RawStrictDesktopSnapshot;if($raw.ok){$last=$raw}else{Write-Host ('batch cleanup snapshot pending: '+($last|ConvertTo-Json -Compress -Depth 8));$consecutive=0;Start-Sleep -Milliseconds 100;continue}}
    $cleanupState=Get-StrictTransactionState $baseline $last $targets
    if(-not $cleanupState.ok){
     Write-Host ('BATCH CLEANUP EXISTING STATE FAILURE '+(@{before=$baseline;after=$last;guard=$cleanupState;owned=$owned}|ConvertTo-Json -Compress -Depth 12))
     throw 'cleanup observed existing icon identity/position change or unknown extra item'
    }
    if($cleanupState.new.Count -eq 0 -and (Strict-IconsKey $baseline) -ceq (Strict-IconsKey $last)){$consecutive++}else{$consecutive=0}
    if($consecutive -ge 2){break}
    Start-Sleep -Milliseconds 100
   }while([DateTime]::UtcNow -lt $deadline)
   if($consecutive -lt 2){Write-Host ('BATCH CLEANUP OWNED ICON TIMEOUT '+(@{before=$baseline;after=$last;guard=$cleanupState;owned=$owned}|ConvertTo-Json -Compress -Depth 12));throw 'owned fixture icons did not disappear before cleanup deadline'}
   Check $true 'cleanup restored original icon set and coordinates (two confirmed snapshots)'
  }
 }finally{if($previous -ne [IntPtr]::Zero){[OkibaWin32]::LeavePhysicalScope($previous)}}
}
