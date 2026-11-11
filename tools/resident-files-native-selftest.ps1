$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/resident-file-native.cs')
$helper=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
foreach($block in [regex]::Matches($helper,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")){if($block.Groups[1].Value.Contains('public static class OkibaFileAttributes')){Add-Type -TypeDefinition $block.Groups[1].Value}}
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath());$root=Join-Path $temp ('OkibaResidentNative-'+[Guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $root
$n=0;function Check($v,$m){if(-not $v){throw $m};$script:n++;Write-Host ('ok - '+$m)}
function Reject($f,$m){$thrown=$false;try{& $f|Out-Null}catch{$thrown=$true};Check $thrown $m}
function Stage($a,$b,$r,$ak,$bk){[OkibaResidentFiles]::Stage($a,$b,$r.identity,$r.size,$r.mtime,$r.attributes,$ak,$bk)}
function Back($b,$a,$r,$ak,$bk){[OkibaResidentFiles]::RestoreMoved($b,$a,$r.identity,$r.size,$r.mtime,$r.attributes,$ak,$bk)}
try{
 $src=Join-Path $root 'source';$dst=Join-Path $root 'destination';$null=New-Item -ItemType Directory -Path $src,$dst
 $ak=[OkibaResidentFiles]::Parent($src).ancestorKey;$bk=[OkibaResidentFiles]::Parent($dst).ancestorKey
 Check ($ak.Length -eq 64 -and $bk.Length -eq 64 -and $ak -cne $bk) 'ancestor chain deterministic and path bound'
 Check ($ak -ceq [OkibaResidentFiles]::Parent($src).ancestorKey) 'ancestor reread stable'
 foreach($original in @(32,34)){
  $a=Join-Path $src ('日本語 space-'+$original+'.txt');$b=Join-Path $dst ([IO.Path]::GetFileName($a));[IO.File]::WriteAllText($a,'owned fixture');[IO.File]::SetAttributes($a,[IO.FileAttributes]$original);$r=[OkibaResidentFiles]::Read($a)
  Check ($r.identity -ceq [OkibaFileAttributes]::Read($a).identity) 'native identity exact same format'
  Check ($r.regularFile -and -not $r.reparse -and $r.linkCount -eq 1) 'native eligibility fields verified'
  $after=Stage $a $b $r $ak $bk
  Check ((-not [IO.File]::Exists($a))-and [IO.File]::Exists($b)-and $after.attributes-eq 34) 'stage hidden and source absent'
  $closed=[OkibaResidentFiles]::Read($b);Check ($closed.identity-ceq $r.identity -and $closed.size-eq $r.size -and $closed.mtime-eq $r.mtime -and $closed.attributes-eq 34) 'rename-close no attribute rebaseline'
  Check ($null-eq [OkibaResidentFiles]::ReadIfMissing($a)) 'missing source classified absent'
  [IO.File]::SetAttributes($b,[IO.FileAttributes]32)
  $back=Back $b $a $r $ak $bk;Check ($back.attributes-eq $original -and -not [IO.File]::Exists($b)) 'visible destination rollback restores original attributes'
  Check ([IO.File]::ReadAllText($a)-eq 'owned fixture') 'content preserved'
  [IO.File]::SetAttributes($a,[IO.FileAttributes]34);$back=[OkibaResidentFiles]::RestoreUnmoved($a,$r.identity,$r.size,$r.mtime,$r.attributes,$ak);Check ($back.attributes-eq $original) 'hide-before-rename failure restored'
 }
 $a=Join-Path $src 'collision.txt';$b=Join-Path $dst 'collision.txt';[IO.File]::WriteAllText($a,'source');[IO.File]::SetAttributes($a,[IO.FileAttributes]32);$r=[OkibaResidentFiles]::Read($a)
 [IO.File]::WriteAllText($b,'foreign');Reject {Stage $a $b $r $ak $bk} 'destination occupant refuses stage';Check ([IO.File]::ReadAllText($a)-eq 'source'-and [IO.File]::ReadAllText($b)-eq 'foreign'-and [IO.File]::GetAttributes($a)-eq 32) 'collision no mutation';[IO.File]::Delete($b)
 Stage $a $b $r $ak $bk|Out-Null;[IO.File]::WriteAllText($a,'new occupant');Reject {Back $b $a $r $ak $bk} 'source reoccupied refuses rollback';Check ([IO.File]::ReadAllText($a)-eq 'new occupant'-and [IO.File]::ReadAllText($b)-eq 'source') 'rollback occupant untouched';[IO.File]::Delete($a);Back $b $a $r $ak $bk|Out-Null
 Reject {[OkibaResidentFiles]::Stage($a,$b,'wrong',$r.size,$r.mtime,32,$ak,$bk)} 'foreign identity refused'
 [IO.File]::SetAttributes($a,[IO.FileAttributes]33);Reject {[OkibaResidentFiles]::ReadIfMissing($a)} 'readonly not misclassified absent';[IO.File]::SetAttributes($a,[IO.FileAttributes]32)
 [IO.File]::AppendAllText($a,'changed');Reject {Stage $a $b $r $ak $bk} 'changed metadata refused';$r=[OkibaResidentFiles]::Read($a)
 $lock=[IO.File]::Open($a,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{Reject {[OkibaResidentFiles]::ReadIfMissing($a)} 'sharing failure not absent'}finally{$lock.Dispose()}
 $hard=Join-Path $src 'hardlink.txt';$null=New-Item -ItemType HardLink -Path $hard -Target $a;Reject {[OkibaResidentFiles]::Read($a)} 'multiple hardlinks refused';[IO.File]::Delete($hard)
 $oldDst=Join-Path $root 'old-destination';[IO.Directory]::Move($dst,$oldDst);$null=New-Item -ItemType Directory -Path $dst
 Reject {Stage $a $b $r $ak $bk} 'replaced ancestor same pathname refused'
 $bk=[OkibaResidentFiles]::Parent($dst).ancestorKey
 $link=Join-Path $root 'junction';$null=New-Item -ItemType Junction -Path $link -Target $src;Reject {[OkibaResidentFiles]::Read((Join-Path $link 'collision.txt'))} 'reparse ancestor refused';[IO.Directory]::Delete($link)
 Reject {[OkibaResidentFiles]::Read($src)} 'directory refused'
 Reject {[OkibaResidentFiles]::Read($a+':stream')} 'ADS refused'
 Reject {[OkibaResidentFiles]::Stage($a,$a,$r.identity,$r.size,$r.mtime,32,$ak,$ak)} 'same source destination refused'
 Write-Host "resident native: $n temp checks PASS; no Desktop/Shell notification calls"
}finally{
 $resolved=[IO.Path]::GetFullPath($root);if([IO.Path]::GetDirectoryName($resolved).TrimEnd('\')-cne $temp.TrimEnd('\')-or [IO.Path]::GetFileName($resolved)-notmatch '^OkibaResidentNative-[a-f0-9]{32}$'){throw 'unsafe fixture cleanup path'}
 if(Test-Path -LiteralPath $resolved){if(([IO.File]::GetAttributes($resolved)-band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'fixture root replaced'};Get-ChildItem -LiteralPath $resolved -File -Recurse -Force|ForEach-Object {[IO.File]::SetAttributes($_.FullName,[IO.FileAttributes]::Normal)};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
