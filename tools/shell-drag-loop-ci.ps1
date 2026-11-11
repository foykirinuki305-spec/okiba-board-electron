$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'hosted only'}
$q=ConvertFrom-Json $env:OKIBA_SHELL_DROP_SPEC
if($q.kind -cnotin @('resident','hidden','cancel') -or @($q.paths).Count -ne 3 -or $q.tag -notmatch '^OkibaShellDrop-[a-f0-9]{24}$'){throw 'owned case required'}
$root=[IO.Path]::GetFullPath($q.root);$tmp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if(-not $root.StartsWith($tmp+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($root) -notlike 'okiba-shell-drop-*'){throw 'owned temp root required'}
$marker=Get-Content -LiteralPath (Join-Path $root 'fixture.json') -Raw|ConvertFrom-Json
if($marker.tag -cne $q.tag -or $marker.kind -cne $q.kind){throw 'fixture marker mismatch'}
$desktop=[Environment]::GetFolderPath('DesktopDirectory')
for($i=0;$i -lt 3;$i++){
 $parent=if($q.kind -ceq 'hidden'){$desktop}else{Join-Path $root 'files'}
 $expected=Join-Path $parent ($q.tag+'-'+($i+1)+'.txt')
 if($q.paths[$i] -cne $expected -or -not (Test-Path -LiteralPath $expected -PathType Leaf)){throw 'source fixture mismatch'}
 $item=Get-Item -LiteralPath $expected -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse fixture'}
}
Add-Type -Path (Join-Path $PSScriptRoot 'shell-drag-loop-ci.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
. (Join-Path $PSScriptRoot 'packaged-terminal-window-ci.ps1')
$terminal=$null;$result=@{}
try{
 $terminal=Suspend-RunnerTerminal
 $result.input=[OkibaShellDragCI]::Run([string[]]$q.paths,[int]$q.target.x,[int]$q.target.y,0,[int]$q.sy,[int]$q.area.left,[int]$q.area.top,[int]$q.area.right,[int]$q.area.bottom,($q.kind -ceq 'cancel'))
}finally{
 if($terminal){try{Resume-RunnerTerminal $terminal}finally{$result.terminal=$terminal.evidence;$terminal.owner.Dispose()}}
 $result|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $root 'input-result.json')
}
