$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted CI only; user Desktop forbidden'}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OkibaRenameNotifyCI{[DllImport("shell32.dll",CharSet=CharSet.Unicode)]public static extern void SHChangeNotify(uint e,uint flags,string oldPath,string newPath);}'
$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'))
$root=[IO.Path]::GetFullPath($env:OKIBA_RENAME_SOURCE_ROOT)
if(-not $root.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)-or[IO.Path]::GetFileName($root)-notlike 'okiba-rename-ci-*'){throw 'Invalid owned source root'}
[Console]::Out.WriteLine('{"ready":true}')
while($null-ne($line=[Console]::ReadLine())){try{$r=ConvertFrom-Json $line
 if($r.cmd-eq'ping'){$result=@{ok=$true}}
 else{
  if($r.cmd-ne'actualRename'-or$r.mode-notin@('none','notify','delete-create')){throw 'invalid command'}
  $old=[IO.Path]::GetFullPath([string]$r.source);$new=[IO.Path]::GetFullPath([string]$r.destination)
  if([IO.Path]::GetDirectoryName($old)-ine$root-or[IO.Path]::GetDirectoryName($new)-ine$desktop-or[IO.Path]::GetFileName($new)-notlike'OkibaRename-*'-or[IO.Path]::GetFileName($old)-cne[IO.Path]::GetFileName($new)){throw 'not owned CI rename pair'}
  if([IO.File]::Exists($old)-or[IO.Directory]::Exists($old)-or-not[IO.File]::Exists($new)){throw 'rename has not actually completed'}
  $w=[Diagnostics.Stopwatch]::StartNew();if($r.mode-eq'notify'){[OkibaRenameNotifyCI]::SHChangeNotify(1,0x1005,$old,$new)}elseif($r.mode-eq'delete-create'){[OkibaRenameNotifyCI]::SHChangeNotify(4,0x1005,$old,$null);[OkibaRenameNotifyCI]::SHChangeNotify(2,0x1005,$new,$null)};$w.Stop()
  $result=@{ok=$true;mode=$r.mode;notificationMs=$w.Elapsed.TotalMilliseconds;notification=$(if($r.mode-eq'notify'){'SHCNE_RENAMEITEM PATHW FLUSH'}elseif($r.mode-eq'delete-create'){'SHCNE_DELETE old + SHCNE_CREATE new PATHW FLUSH'}else{'none'})}
 }
 [Console]::Out.WriteLine((@{id=$r.id;result=$result}|ConvertTo-Json -Compress -Depth 5))
}catch{[Console]::Out.WriteLine((@{id=$r.id;error=$_.Exception.Message}|ConvertTo-Json -Compress))}}
