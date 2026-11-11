$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'GitHub-hosted Windows only'}
$repo=Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $repo 'scripts\folder-return-native.cs')
$cTemp=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Temp'))
$dTemp=[IO.Path]::GetFullPath($env:RUNNER_TEMP)
if(-not $cTemp.StartsWith('C:\',[StringComparison]::OrdinalIgnoreCase) -or -not $dTemp.StartsWith('D:\',[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $cTemp -PathType Container) -or -not (Test-Path -LiteralPath $dTemp -PathType Container)){
 Write-Output 'SKIP real cross-volume: isolated C and D temporary roots unavailable';exit 0
}
$tag='okiba-folder-return-cross-'+[guid]::NewGuid().ToString('N')
$c=Join-Path $cTemp $tag;$d=Join-Path $dTemp $tag
function Assert($v,$label){if(-not $v){throw ('FAIL '+$label)};Write-Output ('PASS '+$label)}
try{
 [IO.Directory]::CreateDirectory($c)|Out-Null;[IO.Directory]::CreateDirectory($d)|Out-Null
 foreach($pair in @(@($c,$d),@($d,$c))){
  $source=Join-Path $pair[0] 'generated.mp4';$target=Join-Path $pair[1] 'generated.mp4'
  [IO.File]::WriteAllText($source,'isolated cross-volume fixture',[Text.UTF8Encoding]::new($false));[IO.File]::SetAttributes($source,34)
  $before=[OkibaFolderReturnFiles]::Read($source)
  $parent=[OkibaFolderReturnFiles]::Parent($pair[1]);Assert ($before.volume -ne $parent.volume) 'actual distinct volume identities'
  $rejected=$false;try{$null=[OkibaFolderReturnFiles]::Prepare($source,$pair[1])}catch{$rejected=$_.Exception.Message -match 'cross-volume-refused'}
  Assert $rejected 'Prepare rejects actual cross-volume move'
  # Also challenge Execute independently with an otherwise identity-bound item.
  $item=New-Object OkibaFolderReturnFiles+Item
  $item.src=$source;$item.dest=$target;$item.identity=$before.identity;$item.volume=$before.volume;$item.size=$before.size;$item.mtime=$before.mtime;$item.attributes=$before.attributes
  $item.sourceAncestorKey=([OkibaFolderReturnFiles]::Parent($pair[0])).ancestorKey;$item.destAncestorKey=$parent.ancestorKey
  $result=[OkibaFolderReturnFiles]::Execute($item)
  Assert (-not $result.moved -and $result.reason -match 'cross-volume-refused') 'Execute rejects actual cross-volume move'
  $after=[OkibaFolderReturnFiles]::Read($source)
  Assert ($after.identity -eq $before.identity -and $after.mtime -eq $before.mtime -and $after.attributes -eq $before.attributes -and [IO.File]::ReadAllText($source) -eq 'isolated cross-volume fixture') 'original identity bytes mtime and Hidden preserved'
  Assert (-not [IO.File]::Exists($target)) 'no destination copy created'
  # Remove only this generated fixture before testing the reverse direction.
  Remove-Item -LiteralPath $source -Force
 }
}finally{
 foreach($pair in @(@($c,$cTemp),@($d,$dTemp))){
  $resolved=[IO.Path]::GetFullPath($pair[0]);$allowed=[IO.Path]::GetFullPath($pair[1]).TrimEnd('\')+'\'
  if(-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -ne $tag){throw 'cleanup outside fixture'}
  if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
 }
}