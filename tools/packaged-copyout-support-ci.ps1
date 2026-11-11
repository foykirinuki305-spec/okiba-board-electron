param([ValidateSet('prepare','read')][string]$Action)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'hosted isolated TEMP only'}
$q=$env:OKIBA_COPY_FIXTURE|ConvertFrom-Json
$separator=[IO.Path]::DirectorySeparatorChar
$root=[IO.Path]::GetFullPath([string]$q.root);$tmp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd($separator)
if(-not $root.StartsWith($tmp+$separator,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($root) -notmatch '^okiba-packaged-copy-'){throw 'owned TEMP root required'}
if(-not (Test-Path -LiteralPath (Join-Path $root 'fixture.json') -PathType Leaf)){throw 'fixture marker missing'}
$paths=@($q.paths)
foreach($p in $paths){
 $p=[IO.Path]::GetFullPath([string]$p)
 if(-not $p.StartsWith($root+$separator,[StringComparison]::OrdinalIgnoreCase)){throw 'outside fixture'}
 $i=Get-Item -LiteralPath $p -Force
 if($i.PSIsContainer){throw 'fixture record must be a file'}
 while($i -and $i.FullName.StartsWith($tmp+$separator,[StringComparison]::OrdinalIgnoreCase)){
  if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'fixture reparse'}
  $i=if($i.PSIsContainer){$i.Parent}else{$i.Directory}
 }
}
$cs=Split-Path $PSScriptRoot -Parent
foreach($component in @('dist','win-unpacked','resources','scripts','copyout-native.cs')){$cs=Join-Path $cs $component}
Add-Type -Path $cs
if($Action -ceq 'prepare'){
 foreach($p in $paths){$attrs=if($p -ceq $q.hidden){34}else{32};[IO.File]::SetAttributes($p,[IO.FileAttributes]$attrs)}
}
$result=@();foreach($p in $paths){$result += [OkibaCopyOutFiles]::Read($p)}
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
# BEGIN tested-copy-fixture-wire
function Convert-CopyFixtureWire($value){
 $json=ConvertTo-Json -InputObject $value -Depth 8 -Compress
 return [regex]::Replace($json,'[^\u0000-\u007f]',{param($m) ('\u{0:x4}' -f [int][char]$m.Value)})
}
# END tested-copy-fixture-wire
[Console]::Out.WriteLine((Convert-CopyFixtureWire $result))
