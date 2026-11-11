# RESEARCH ONLY. Never dot-source on a user's desktop.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Snap lease prototype is hosted Windows CI only'}
$src=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
$src=$src.Substring(0,$src.IndexOf('# ---- Main loop '))
# Permit snap OFF only in this isolated research process, never production source.
$a=$src.IndexOf(' public static void PositionNewItems(');$b=$src.IndexOf(' // Never exposed through the normal helper protocol.',$a)
if($a -lt 0 -or $b -lt $a){throw 'Research injection anchors missing'}
$batch=$src.Substring($a,$b-$a).Replace('||(flags&4)==0','')
$src=$src.Substring(0,$a)+$batch+$src.Substring($b)
. ([scriptblock]::Create($src))
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class LeaseFileCI {
 [StructLayout(LayoutKind.Sequential)]struct Info{public uint attrs;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern void SHChangeNotify(uint e,uint f,string p,IntPtr second);
 public sealed class Record{public string path,identity,size,mtime;public uint attributes;}
 public static Record Read(string p){
  using(var h=CreateFile(p,0x80,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){
   if(h.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());Info i;if(!GetFileInformationByHandle(h,out i))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   if((i.attrs&0x410)!=0)throw new InvalidOperationException("directory-or-reparse-not-supported");
   return new Record{path=System.IO.Path.GetFullPath(p),identity=i.volume+":"+i.indexHigh+":"+i.indexLow,size=(((ulong)i.sizeHigh<<32)|i.sizeLow).ToString(),mtime=(((ulong)(uint)i.written.dwHighDateTime<<32)|(uint)i.written.dwLowDateTime).ToString(),attributes=i.attrs};
  }
 }
 public static void Updated(string p){if(!System.IO.File.Exists(p))throw new InvalidOperationException("missing-file");SHChangeNotify(0x2000u,0x1005u,p,IntPtr.Zero);}
}
'@
function Read-LeaseJson([string]$p){return (Get-Content -LiteralPath $p -Raw|ConvertFrom-Json)}
function Save-LeaseJson([string]$p,$value){
 $tmp=$p+'.'+[guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($tmp,($value|ConvertTo-Json -Depth 24 -Compress),[Text.UTF8Encoding]::new($false))
 if([IO.File]::Exists($p)){[IO.File]::Replace($tmp,$p,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($tmp,$p)}
}
function Assert-LeasePath($p,$tag){
 $full=[IO.Path]::GetFullPath($p);$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'))
 if([IO.Path]::GetDirectoryName($full) -ine $desktop -or -not [IO.Path]::GetFileName($full).StartsWith($tag) -or -not $tag.StartsWith('OkibaDense-')){throw 'Path is not an owned lease fixture'}
}
function New-LeaseRecord($path,$tag,$expectedHash){
 Assert-LeasePath $path $tag;$r=[LeaseFileCI]::Read($path)
 if(($r.attributes -band 2) -eq 0){throw 'Selected lease fixture must begin hidden'}
 $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();if($hash -cne $expectedHash){throw 'fixture hash mismatch'}
 return @{path=$r.path;identity=$r.identity;size=$r.size;mtime=$r.mtime;attributes=$r.attributes;hash=$hash}
}
function Assert-LeaseRecord($r){
 $now=[LeaseFileCI]::Read($r.path)
 if($now.identity -cne $r.identity -or $now.size -cne $r.size -or $now.mtime -cne $r.mtime -or ($now.attributes -band (-bnot 2)) -ne ($r.attributes -band (-bnot 2))){throw 'Selected file identity/content metadata/other attributes changed'}
 if((Get-FileHash -LiteralPath $r.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $r.hash){throw 'Selected file content changed'}
 return $now
}
function Get-LeaseSnapshot {
 $dpi=[OkibaWin32]::EnterPhysicalScope()
 try {return Get-StrictDesktopSnapshot}finally{if($dpi -ne [IntPtr]::Zero){[OkibaWin32]::LeavePhysicalScope($dpi)}}
}
function Lease-Geometry($s){return (@($s.explorerPid,$s.explorerStarted,$s.listviewHwnd,$s.origin.x,$s.origin.y,$s.viewDpi,$s.sx,$s.sy,@($s.areas|ForEach-Object{@($_.left,$_.top,$_.right,$_.bottom,$_.scale,$_.monitorOrigin.x,$_.monitorOrigin.y)}))|ConvertTo-Json -Depth 10 -Compress)}
function Assert-LeaseOld($baseline,$current,$selectedPaths){
 if(-not $current.ok){return $false}
 if((Lease-Geometry $baseline) -cne (Lease-Geometry $current)){throw ('Explorer or physical display changed; baseline='+(Lease-Geometry $baseline)+'; current='+(Lease-Geometry $current))}
 $old=New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
 foreach($i in $baseline.icons){if([string]::IsNullOrEmpty($i.identity) -or $old.ContainsKey($i.identity)){throw 'invalid baseline'};$old.Add($i.identity,$i)}
 $seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
 foreach($i in $current.icons){
  if(-not $seen.Add($i.identity)){throw 'duplicate live identity'}
  if($old.ContainsKey($i.identity)){$o=$old[$i.identity];if($o.x -ne $i.x -or $o.y -ne $i.y){throw 'Existing icon moved'}}
  elseif(-not $i.path -or @($selectedPaths|Where-Object{[string]::Equals([IO.Path]::GetFullPath($_),[IO.Path]::GetFullPath($i.path),[StringComparison]::OrdinalIgnoreCase)}).Count -ne 1){throw 'Unknown new icon'}
 }
 foreach($id in $old.Keys){if(-not $seen.Contains($id)){throw 'Existing identity disappeared'}}
 return $true
}
function Wait-LeaseHidden($spec){
 $deadline=[DateTime]::UtcNow.AddSeconds(15);$stable=0
 do {
  $s=Get-LeaseSnapshot
  if(Assert-LeaseOld $spec.baseline $s @($spec.selected.path)){
   $visible=@($s.icons|Where-Object{$p=$_.path;$p -and @($spec.selected|Where-Object{[string]::Equals($_.path,$p,[StringComparison]::OrdinalIgnoreCase)}).Count})
   if($visible.Count -eq 0){$stable++}else{$stable=0}
   if($stable -ge 2){return $s}
  }else{$stable=0}
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $deadline)
 throw 'Selected fixture visibility did not settle hidden'
}
