$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS-ne'true'-or$env:RUNNER_OS-ne'Windows'-or$env:RUNNER_ENVIRONMENT-ne'github-hosted'){throw 'Hosted Windows CI only; user Desktop forbidden'}
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\shell-helper.ps1') -Raw
$extra=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'view-refresh-injection-ci.cs') -Raw
$needle=' public static long[] ReadState()';if(-not$source.Contains($needle)){throw 'C# injection anchor missing'};$source=$source.Replace($needle,$extra+"`n"+$needle)
$session='  public IFolderView2 Folder {get{return (IFolderView2)view;}}';if(-not$source.Contains($session)){throw 'Session anchor missing'};$source=$source.Replace($session,$session+"`n  public int RefreshForCI(bool refresh){var v=(IShellViewRefreshCI)view;return refresh?v.Refresh():0;}")
foreach($block in [regex]::Matches($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")){Add-Type -TypeDefinition $block.Groups[1].Value}
$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'));$root=[IO.Path]::GetFullPath($env:OKIBA_RENAME_SOURCE_ROOT)
if(-not$root.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)-or[IO.Path]::GetFileName($root)-notlike'okiba-rename-ci-*'){throw 'Invalid fixture root'}
[Console]::Out.WriteLine('{"ready":true}')
while($null-ne($line=[Console]::ReadLine())){try{$r=ConvertFrom-Json $line
 if($r.cmd-eq'ping'){$result=@{ok=$true}}else{
  if($r.cmd-ne'afterMoves'-or$r.mode-notin@('none','refresh')-or@($r.items).Count-lt1){throw 'invalid request'}
  foreach($i in $r.items){$old=[IO.Path]::GetFullPath([string]$i.source);$new=[IO.Path]::GetFullPath([string]$i.destination);if([IO.Path]::GetDirectoryName($old)-ine$root-or[IO.Path]::GetDirectoryName($new)-ine$desktop-or[IO.Path]::GetFileName($new)-notlike'OkibaRename-*'-or[IO.Path]::GetFileName($old)-cne[IO.Path]::GetFileName($new)-or[IO.File]::Exists($old)-or[IO.Directory]::Exists($old)-or-not[IO.File]::Exists($new)){throw 'not a completed owned move'}}
  $before=[OkibaFolderView]::ReadState();$w=[Diagnostics.Stopwatch]::StartNew();$hr=[OkibaFolderView]::RefreshViewForCI(($r.mode-eq'refresh'));$w.Stop();[Runtime.InteropServices.Marshal]::ThrowExceptionForHR($hr);$after=[OkibaFolderView]::ReadState();if(($before|ConvertTo-Json -Compress)-cne($after|ConvertTo-Json -Compress)){throw 'REFRESH CHANGED SHELL FLAGS'}
  $result=@{ok=$true;mode=$r.mode;refreshMs=$w.Elapsed.TotalMilliseconds;hresult=$hr;flagsBefore=$before;flagsAfter=$after}
 };[Console]::Out.WriteLine((@{id=$r.id;result=$result}|ConvertTo-Json -Depth 6 -Compress))
}catch{[Console]::Out.WriteLine((@{id=$r.id;error=$_.Exception.Message}|ConvertTo-Json -Compress))}}
