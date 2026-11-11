$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\resident-lease.ps1')
function Lease-Path([string]$p){return [IO.Path]::GetFullPath($p).TrimEnd('\')}
$root=Join-Path ([IO.Path]::GetTempPath()) ('okiba-resident-locator-'+[Guid]::NewGuid().ToString('N'));$checks=0
function Check($ok,$message){if(-not $ok){throw $message};$script:checks++}
function Reject([scriptblock]$f){$failed=$false;try{& $f}catch{$failed=$true};Check $failed 'unsafe locator accepted'}
try{
 Resident-Native;$src=Join-Path $root 'source';$dst=Join-Path $root 'destination';[IO.Directory]::CreateDirectory($src)|Out-Null;[IO.Directory]::CreateDirectory($dst)|Out-Null
 foreach($attrs in @(32,34)){
  $s=Join-Path $src ('file'+$attrs+'.txt');$d=Join-Path $dst ('file'+$attrs+'.txt');[IO.File]::WriteAllText($s,'owned fixture');[IO.File]::SetAttributes($s,[IO.FileAttributes]$attrs)
  $n=[OkibaResidentFiles]::Read($s);$r=@{source=$s;destination=$d;identity=$n.identity;volume=$n.volume;size=$n.size;mtime=$n.mtime;originalAttributes=$attrs;sourceParentID=([OkibaResidentFiles]::Parent($src)).ancestorKey;destParentID=([OkibaResidentFiles]::Parent($dst)).ancestorKey}
  Check ((Resident-Locate $r).state -ceq 'unmoved') 'unmoved not detected'
  [IO.File]::SetAttributes($s,[IO.FileAttributes]34);Check ((Resident-Locate $r).state -ceq 'unmoved') 'partial hide not recognized'
  $null=[OkibaResidentFiles]::RestoreUnmoved($s,$r.identity,$r.size,$r.mtime,$attrs,$r.sourceParentID);Check ([uint32][IO.File]::GetAttributes($s)-eq $attrs) 'unmoved hidden not restored'
  $null=[OkibaResidentFiles]::Stage($s,$d,$r.identity,$r.size,$r.mtime,$attrs,$r.sourceParentID,$r.destParentID);Check ((Resident-Locate $r).state -ceq 'moved') 'moved not detected'
  [IO.File]::WriteAllText($s,'foreign fixture');Reject {Resident-Locate $r};Check ([IO.File]::ReadAllText($s)-ceq 'foreign fixture') 'foreign source damaged';[IO.File]::Delete($s)
  $null=[OkibaResidentFiles]::RestoreMoved($d,$s,$r.identity,$r.size,$r.mtime,$attrs,$r.sourceParentID,$r.destParentID);Check ((Resident-Locate $r).state -ceq 'unmoved') 'reverse move not recognized'
  [IO.File]::SetAttributes($s,[IO.FileAttributes]::ReadOnly);Reject {Resident-Locate $r};[IO.File]::SetAttributes($s,[IO.FileAttributes]$attrs)
  [IO.File]::Move($s,($s+'.away'));Reject {Resident-Locate $r};[IO.File]::WriteAllText($s,'replacement');Reject {Resident-Locate $r}
 }
 Write-Output "PASS resident PS/native locator $checks checks; owned TEMP only"
}finally{
 $resolved=[IO.Path]::GetFullPath($root);$prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\';if(-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)-or -not [IO.Path]::GetFileName($resolved).StartsWith('okiba-resident-locator-')){throw 'cleanup boundary'};if([IO.Directory]::Exists($resolved)){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
