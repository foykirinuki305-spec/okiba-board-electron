$ErrorActionPreference='Stop'
$src=Get-Content (Join-Path $PSScriptRoot '../scripts/shell-helper.ps1') -Raw
$blocks=[regex]::Matches($src,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
$cs=@($blocks|Where-Object {$_.Groups[1].Value.Contains('public static class OkibaFileAttributes')})[0].Groups[1].Value
$needle=' [DllImport("shell32.dll",EntryPoint="SHChangeNotify",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern void NotifyAttributes(uint eventId,uint flags,string path,IntPtr second);'
if(-not $cs.Contains($needle)){throw 'notification test injection anchor missing'}
$fake=' public static int notificationCount;public static bool expectedAtEvent;static void NotifyAttributes(uint eventId,uint flags,string path,IntPtr second){if(eventId!=0x800u||flags!=0x1005u||second!=IntPtr.Zero)throw new Exception("wrong-event");if(((File.GetAttributes(path)&FileAttributes.Hidden)!=0)!=expectedAtEvent)throw new Exception("event-before-mutation");notificationCount++;}'
if(-not $cs.Contains('NotifyAttributes(0x800u,0x1005u,path,IntPtr.Zero)')){throw 'notification event/flags changed'}
if($cs -match '\.Refresh\(' -or $cs -match 'NotifyAttributes\(0x2u,'){throw 'forbidden refresh/delete notification'}
$cs=$cs.Replace($needle,$fake).Replace('OkibaFileAttributes','OkibaFileNotifyTest');Add-Type -TypeDefinition $cs
. (Join-Path $PSScriptRoot '../scripts/snap-lease.ps1')
function Lease-ReadRecord([string]$path){$v=[OkibaFileNotifyTest]::Read($path);return @{path=$path;identity=$v.identity;size=$v.size;mtime=$v.mtime;attributes=$v.attributes;hidden=$v.hidden}}

$root=Join-Path ([IO.Path]::GetTempPath()) ('OkibaNotifyStub-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $root|Out-Null
$n=0
function Assert([bool]$v,[string]$message){if(-not $v){throw $message};$script:n++;Write-Host ('ok - '+$message)}
try{
 foreach($count in @(1,3,10)){
  [OkibaFileNotifyTest]::notificationCount=0
  for($i=0;$i -lt $count;$i++){
   $p=Join-Path $root ('case-'+$count+'-'+$i+'.txt');[IO.File]::WriteAllText($p,'data');$r=[OkibaFileNotifyTest]::Read($p)
   [OkibaFileNotifyTest]::expectedAtEvent=$true;$null=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$false,$true,$r.size,$r.mtime,$r.attributes)
   $null=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$true,$true,$r.size,$r.mtime,$r.attributes)
   [OkibaFileNotifyTest]::expectedAtEvent=$false;$null=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$true,$false,$r.size,$r.mtime,$r.attributes)
   $after=[OkibaFileNotifyTest]::Read($p);Assert (-not $after.hidden -and $after.identity -eq $r.identity -and $after.size -eq $r.size -and $after.mtime -eq $r.mtime) ('roundtrip metadata '+$count+'/'+$i)
  }
  Assert ([OkibaFileNotifyTest]::notificationCount -eq 2*$count) ('N='+$count+' only real mutations notify')
 }
 $p=Join-Path $root 'failure.txt';[IO.File]::WriteAllText($p,'data');$r=[OkibaFileNotifyTest]::Read($p);[OkibaFileNotifyTest]::notificationCount=0
 foreach($case in @('identity','size','mtime','attrs')){
  $id=$r.identity;$size=$r.size;$mtime=$r.mtime;$attrs=$r.attributes
  switch($case){identity{$id='wrong'}size{$size='999'}mtime{$mtime='0'}attrs{$attrs=$attrs -bxor 1}}
  $failed=$false;try{$null=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$id,$false,$true,$size,$mtime,$attrs)}catch{$failed=$true}
  Assert ($failed -and [OkibaFileNotifyTest]::notificationCount -eq 0 -and -not ([OkibaFileNotifyTest]::Read($p)).hidden) ('failed '+$case+' has no mutation or notification')
 }
 $paths=@();$records=@();for($i=0;$i -lt 3;$i++){$p=Join-Path $root ('partial-'+$i+'.txt');[IO.File]::WriteAllText($p,'data');$paths+=$p;$records+=[OkibaFileNotifyTest]::Read($p)}
 [OkibaFileNotifyTest]::expectedAtEvent=$true;$failed=$false
 try{for($i=0;$i -lt 3;$i++){$r=$records[$i];$size=if($i -eq 1){'wrong'}else{$r.size};$null=[OkibaFileNotifyTest]::SetRecordedAndNotify($paths[$i],$r.identity,$false,$true,$size,$r.mtime,$r.attributes)}}catch{$failed=$true}
 Assert ($failed -and [OkibaFileNotifyTest]::notificationCount -eq 1 -and ([OkibaFileNotifyTest]::Read($paths[0])).hidden -and -not ([OkibaFileNotifyTest]::Read($paths[1])).hidden -and -not ([OkibaFileNotifyTest]::Read($paths[2])).hidden) 'partial mutation remains identifiable after later failure'
 $r=$records[0];[OkibaFileNotifyTest]::expectedAtEvent=$false;$null=[OkibaFileNotifyTest]::SetRecordedAndNotify($paths[0],$r.identity,$true,$false,$r.size,$r.mtime,$r.attributes)
 Assert (-not ([OkibaFileNotifyTest]::Read($paths[0])).hidden -and [OkibaFileNotifyTest]::notificationCount -eq 2) 'partial first item can be reverted with same identity guard'
 # Explicit Hidden-only has no Archive bit; Windows uses NORMAL when cleared.
 $p=Join-Path $root 'hidden-only.txt';[IO.File]::WriteAllText($p,'kept');[IO.File]::SetAttributes($p,[IO.FileAttributes]::Hidden)
 $r=[OkibaFileNotifyTest]::Read($p);Assert ($r.attributes -eq 2) 'fixture begins Hidden-only without Archive'
 [OkibaFileNotifyTest]::notificationCount=0;[OkibaFileNotifyTest]::expectedAtEvent=$false
 $v=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$true,$false,$r.size,$r.mtime,$r.attributes)
 Assert ($v.attributes -eq 128 -and [OkibaFileNotifyTest]::notificationCount -eq 1) 'Hidden-only clears to NORMAL'
 $saved=@{path=$p;identity=$r.identity;size=$r.size;mtime=$r.mtime;attributes=$r.attributes;hidden=$true}
 $checked=Lease-CheckRecord $saved;Assert ($checked.attributes -eq 128) 'PowerShell lease record accepts legitimate NORMAL transition'

 $same=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$false,$false,$r.size,$r.mtime,$r.attributes)
 Assert ($same.attributes -eq 128 -and [OkibaFileNotifyTest]::notificationCount -eq 1) 'NORMAL idempotent no new notification'
 [OkibaFileNotifyTest]::expectedAtEvent=$true;$h=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$false,$true,$r.size,$r.mtime,$r.attributes)
 Assert ($h.attributes -eq 2 -and [OkibaFileNotifyTest]::notificationCount -eq 2 -and $h.mtime -ceq $r.mtime) 'rollback NORMAL to Hidden-only preserves metadata'
 [IO.File]::SetAttributes($p,([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReadOnly));$failed=$false
 try{$null=[OkibaFileNotifyTest]::SetRecordedAndNotify($p,$r.identity,$true,$false,$r.size,$r.mtime,$r.attributes)}catch{$failed=$true}
 Assert ($failed -and [OkibaFileNotifyTest]::notificationCount -eq 2 -and ([OkibaFileNotifyTest]::Read($p)).attributes -eq 3) 'readonly added still rejects before mutation or notification'
 $failed=$false;try{$null=Lease-CheckRecord $saved}catch{$failed=$_.Exception.Message -eq 'lease-selected-file-changed'}
 Assert $failed 'PowerShell lease record rejects added ReadOnly bit'

 Write-Host ('truthful attributes stub: '+$n+' checks passed; no Shell notifications issued')
}finally{
 $resolved=[IO.Path]::GetFullPath($root)
 $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
 if([IO.Path]::GetDirectoryName($resolved) -ine $tempRoot -or [IO.Path]::GetFileName($resolved) -cnotmatch '^OkibaNotifyStub-[a-f0-9]{32}$' -or (([IO.File]::GetAttributes($resolved) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'unsafe temp cleanup target'}
 Get-ChildItem -LiteralPath $resolved -File -Force|ForEach-Object {[IO.File]::SetAttributes($_.FullName,[IO.FileAttributes]::Normal)};Remove-Item -LiteralPath $resolved -Recurse -Force}
