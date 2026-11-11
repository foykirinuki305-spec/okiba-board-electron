$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $repo 'scripts\folder-return-native.cs')
$root=Join-Path ([IO.Path]::GetTempPath()) ('okiba-folder-return-'+[guid]::NewGuid().ToString('N'))
$root=[IO.Path]::GetFullPath($root);$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(-not $root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'fixture-outside-temp'}
[IO.Directory]::CreateDirectory($root)|Out-Null
$src=Join-Path $root 'source';$dst=Join-Path $root 'destination'
[IO.Directory]::CreateDirectory($src)|Out-Null;[IO.Directory]::CreateDirectory($dst)|Out-Null
$count=0
function Assert($value,$label){if(-not $value){throw ('FAIL '+$label)};$script:count++}
function File($name,[bool]$hidden=$false){$p=Join-Path $src $name;[IO.File]::WriteAllText($p,'fixture-'+$name,[Text.UTF8Encoding]::new($false));[IO.File]::SetAttributes($p,$(if($hidden){34}else{32}));return $p}
$child=$null
try {
 $p=File '日本語 one.mp4' $true;$bytes=[IO.File]::ReadAllBytes($p)
 $x=[OkibaFolderReturnFiles]::Prepare($p,$dst)
 $before=[OkibaFolderReturnFiles]::Probe($x);Assert ($before.state -eq 'source' -and -not $before.moved) 'prepared source'
 $r=[OkibaFolderReturnFiles]::Execute($x);Assert ($r.moved -and $r.visible -and -not $r.partial) 'hidden actual move visible'
 Assert (-not [IO.File]::Exists($p) -and [IO.File]::Exists($x.dest)) 'only destination exists'
 $after=[OkibaFolderReturnFiles]::Read($x.dest);Assert ($after.identity -eq $x.identity -and $after.mtime -eq $x.mtime) 'same identity and mtime'
 Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($x.dest)) -eq [Convert]::ToBase64String($bytes)) 'content unchanged'
 $probe=[OkibaFolderReturnFiles]::Probe($x);Assert ($probe.state -eq 'destination' -and $probe.moved -and $probe.visible) 'probe moved'
 $again=[OkibaFolderReturnFiles]::Execute($x);Assert (-not $again.moved -and [IO.File]::Exists($x.dest)) 'no repeated move'
 $p2=File 'visible.mp4';$x2=[OkibaFolderReturnFiles]::Prepare($p2,$dst);$r2=[OkibaFolderReturnFiles]::Execute($x2);Assert ($r2.moved -and $r2.visible) 'visible actual move'
 $p3=File 'collision.mp4';$x3=[OkibaFolderReturnFiles]::Prepare($p3,$dst);[IO.File]::WriteAllText($x3.dest,'keep')
 $r3=[OkibaFolderReturnFiles]::Execute($x3);Assert ($r3.skipped -and -not $r3.moved) 'collision skips';Assert ([IO.File]::ReadAllText($x3.dest) -eq 'keep' -and [IO.File]::Exists($p3)) 'no overwrite'
 $p4=File 'changed.mp4';$x4=[OkibaFolderReturnFiles]::Prepare($p4,$dst);[IO.File]::AppendAllText($p4,'changed')
 $r4=[OkibaFolderReturnFiles]::Execute($x4);Assert (-not $r4.moved -and -not [IO.File]::Exists($x4.dest)) 'changed source rejected'
 $p5=File 'locked.mp4';$x5=[OkibaFolderReturnFiles]::Prepare($p5,$dst);$lock=[IO.File]::Open($p5,'Open','ReadWrite','None')
 try{$r5=[OkibaFolderReturnFiles]::Execute($x5);Assert (-not $r5.moved) 'locked source rejected'}finally{$lock.Dispose()}
 $r5=[OkibaFolderReturnFiles]::Execute($x5);Assert ($r5.moved -and $r5.visible) 'unlock explicit retry succeeds'
 $p6=File 'attributes.mp4';$x6=[OkibaFolderReturnFiles]::Prepare($p6,$dst);[IO.File]::SetAttributes($p6,33)
 $r6=[OkibaFolderReturnFiles]::Execute($x6);Assert (-not $r6.moved) 'readonly attributes rejected';[IO.File]::SetAttributes($p6,32)
 $p7=File 'wrong-parent.mp4';$x7=[OkibaFolderReturnFiles]::Prepare($p7,$dst);$x7.destAncestorKey='wrong';$r7=[OkibaFolderReturnFiles]::Execute($x7);Assert (-not $r7.moved) 'changed parent proof rejected'
 $p8=File 'wrong-volume.mp4';$x8=[OkibaFolderReturnFiles]::Prepare($p8,$dst);$x8.volume='BAD';$r8=[OkibaFolderReturnFiles]::Execute($x8);Assert (-not $r8.moved -and $r8.reason -match 'cross-volume') 'volume proof mismatch rejected'
 $p9=File 'rename.mp4';$x9=[OkibaFolderReturnFiles]::Prepare($p9,$dst);$x9.dest=Join-Path $dst 'different.mp4';$r9=[OkibaFolderReturnFiles]::Execute($x9);Assert (-not $r9.moved) 'name changes refused'
 $rejected=$false;try{$null=[OkibaFolderReturnFiles]::Prepare($src,$dst)}catch{$rejected=$true};Assert $rejected 'folder refused'
 $rejected=$false;try{$null=[OkibaFolderReturnFiles]::Prepare($p9,[Environment]::GetFolderPath('DesktopDirectory'))}catch{$rejected=$true};Assert $rejected 'desktop root refused without mutation'
 $hard=File 'hardlink.mp4';$hardAlias=Join-Path $src 'hardlink-alias.mp4';New-Item -ItemType HardLink -Path $hardAlias -Target $hard|Out-Null
 $rejected=$false;try{$null=[OkibaFolderReturnFiles]::Prepare($hard,$dst)}catch{$rejected=$true};Assert $rejected 'hardlink refused'
 $targetDir=Join-Path $root 'junction-target';[IO.Directory]::CreateDirectory($targetDir)|Out-Null
 $junction=Join-Path $root 'junction';New-Item -ItemType Junction -Path $junction -Target $targetDir|Out-Null
 try{$rejected=$false;try{$null=[OkibaFolderReturnFiles]::Prepare($p9,$junction)}catch{$rejected=$true};Assert $rejected 'junction parent refused'}finally{[IO.Directory]::Delete($junction)}
 $p11=File 'replaced.mp4';$x11=[OkibaFolderReturnFiles]::Prepare($p11,$dst);[IO.File]::Move($p11,($p11+'.old'));[IO.File]::WriteAllText($p11,'replacement');[IO.File]::SetAttributes($p11,32)
 $r11=[OkibaFolderReturnFiles]::Execute($x11);Assert (-not $r11.moved) 'source replacement refused'
 $p12=File 'precrash.mp4' $true;$x12=[OkibaFolderReturnFiles]::Prepare($p12,$dst)
 $r12=[OkibaFolderReturnFiles]::FinalizeDestination($x12);Assert (-not $r12.moved -and [IO.File]::Exists($p12)) 'finalize cannot move prepared source'
 $p13=File 'ambiguous.mp4';$x13=[OkibaFolderReturnFiles]::Prepare($p13,$dst);[IO.File]::WriteAllText($x13.dest,'other');[IO.File]::SetAttributes($x13.dest,32)
 $r13=[OkibaFolderReturnFiles]::Probe($x13);Assert ($r13.state -eq 'ambiguous' -and -not $r13.moved) 'probe refuses two objects'
 $p10=File 'interrupted.mp4' $true;$x10=[OkibaFolderReturnFiles]::Prepare($p10,$dst)
 # Test-only adapter pauses AFTER rename. Kill only its known child PID.
 $cs=Get-Content (Join-Path $repo 'scripts\folder-return-native.cs') -Raw -Encoding utf8
 $needle='Rename(h,x.dest);result.moved=true;'
 if(-not $cs.Contains($needle)){throw 'fault-injection-anchor-missing'}
 $cs=$cs.Replace($needle,'Rename(h,x.dest);System.Threading.Thread.Sleep(30000);result.moved=true;')
 $csPath=Join-Path $root 'interrupt-native.cs';[IO.File]::WriteAllText($csPath,$cs,[Text.UTF8Encoding]::new($false))
 $itemPath=Join-Path $root 'item.json';[IO.File]::WriteAllText($itemPath,($x10|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $runner=Join-Path $root 'interrupt.ps1'
 $runnerText=@'
param($Root)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $Root 'interrupt-native.cs')
$j=Get-Content (Join-Path $Root 'item.json') -Raw -Encoding utf8|ConvertFrom-Json
$x=New-Object OkibaFolderReturnFiles+Item
foreach($k in @('src','dest','identity','volume','size','mtime','sourceAncestorKey','destAncestorKey','attributes')){$x.$k=$j.$k}
[OkibaFolderReturnFiles]::Execute($x)|ConvertTo-Json -Compress
'@
 [IO.File]::WriteAllText($runner,$runnerText,[Text.UTF8Encoding]::new($false))
 $child=Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$runner+'"'),('"'+$root+'"')) -WindowStyle Hidden -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 while(-not [IO.File]::Exists($x10.dest) -and [DateTime]::UtcNow -lt $deadline -and -not $child.HasExited){Start-Sleep -Milliseconds 50}
 Assert ([IO.File]::Exists($x10.dest) -and -not [IO.File]::Exists($x10.src)) 'interrupted boundary reached'
 if(-not $child.HasExited){$child.Kill();$child.WaitForExit()};$child=$null
 $probe=[OkibaFolderReturnFiles]::Probe($x10);Assert ($probe.moved -and -not $probe.visible -and $probe.partial) 'interrupted hidden destination detected'
 $finish=[OkibaFolderReturnFiles]::FinalizeDestination($x10);Assert ($finish.moved -and $finish.visible -and -not $finish.partial) 'identity-bound visibility recovery'
 $probe=[OkibaFolderReturnFiles]::Probe($x10);Assert ($probe.visible -and $probe.moved) 'recovery final proof'
 $sourceText=Get-Content (Join-Path $repo 'scripts\folder-return-native.cs') -Raw -Encoding utf8
 Assert ($sourceText -notmatch 'File\.Copy|File\.Delete|CopyFile|DeleteFile') 'no copy/delete file APIs'
 Write-Output ('PASS folder-return-native '+$count+' checks')
} finally {
 if($child -and -not $child.HasExited){$child.Kill();$child.WaitForExit()}
 $resolved=[IO.Path]::GetFullPath($root)
 if($resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -match '^okiba-folder-return-[0-9a-f]{32}$') {Remove-Item -LiteralPath $resolved -Recurse -Force}
}
