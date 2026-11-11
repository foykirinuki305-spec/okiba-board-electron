param([ValidateSet('prepare','read')][string]$Action)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'hosted isolated TEMP only'}
$q=$env:OKIBA_COPY_FIXTURE|ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$q.root);$tmp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('')
if(-not $root.StartsWith($tmp+'',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($root) -notmatch '^okiba-packaged-copy-'){throw 'owned TEMP root required'}
if(-not (Test-Path -LiteralPath (Join-Path $root 'fixture.json') -PathType Leaf)){throw 'fixture marker missing'}
$paths=@($q.paths)
foreach($p in $paths){
 $p=[IO.Path]::GetFullPath([string]$p)
 if(-not $p.StartsWith($root+'',[StringComparison]::OrdinalIgnoreCase)){throw 'outside fixture'}
 $i=Get-Item -LiteralPath $p -Force
 while($i -and $i.FullName.StartsWith($tmp+'',[StringComparison]::OrdinalIgnoreCase)){if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'fixture reparse'};$i=$i.Parent;if(-not $i){$i=(Get-Item -LiteralPath $p -Force).Directory;$p=$i.FullName}}
}
$cs=Join-Path (Split-Path $PSScriptRoot -Parent) 'distwin-unpacked
esourcesscriptscopyout-native.cs'
Add-Type -Path $cs
if($Action -ceq 'prepare'){
 foreach($p in $paths){$attrs=if($p -ceq $q.hidden){34}else{32};[IO.File]::SetAttributes($p,[IO.FileAttributes]$attrs)}
}
$result=@();foreach($p in $paths){$result += [OkibaCopyOutFiles]::Read($p)}
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
ConvertTo-Json -InputObject $result -Depth 5 -Compress
