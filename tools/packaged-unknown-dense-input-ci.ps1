# Hosted-only real pointer input; never product code.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'hosted only'}
$q=$env:OKIBA_DRAG_SPEC|ConvertFrom-Json
$base=[IO.Path]::GetFullPath([string]$q.base);$tmp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if(-not $base.StartsWith($tmp+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($base)) -notmatch '^okiba-packaged-preview-' -or [IO.Path]::GetFileName($base) -cne 'boards'){throw 'owned base only'}
$d=Get-Item -LiteralPath $base
while($d -and $d.FullName.StartsWith($tmp+'\',[StringComparison]::OrdinalIgnoreCase)){if(($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'fixture ancestor reparse'};$d=$d.Parent}
$m=Get-Content -LiteralPath (Join-Path $base 'Preview\.okiba-board.json') -Raw|ConvertFrom-Json
if($m.future.fixture -cne $q.tag -or $q.tag -notmatch '^OkibaPreview-[a-f0-9]{24}$'){throw 'owned board proof'}
if(@($q.paths).Count -notin @(3,24)){throw 'exact group required'}
foreach($f in $q.paths){if([IO.Path]::GetDirectoryName($f) -ine [Environment]::GetFolderPath('DesktopDirectory') -or -not [IO.Path]::GetFileName($f).StartsWith($q.tag+'-') -or @($m.links|Where-Object {$_.path -ceq $f}).Count -ne 1){throw 'owned selected links only'}}
$p=[Diagnostics.Process]::GetProcessById([int]$q.pid);$null=$p.Handle
$exe=Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\win-unpacked\OkibaBoard.exe'
$identity=@{expectedPID=[int]$q.pid;actualPID=$p.Id;expectedBirth=$q.started;actualBirth=$p.StartTime.ToUniversalTime().Ticks.ToString();expectedExe=$exe;actualExe=$p.MainModule.FileName}
if($identity.actualBirth -cne $identity.expectedBirth -or $identity.actualExe -ine $identity.expectedExe){throw ('packaged process identity: '+($identity|ConvertTo-Json -Compress))}
Add-Type -Path (Join-Path $PSScriptRoot 'packaged-unknown-drag-input-ci.cs')
foreach($old in $q.old){if([Math]::Abs([int]$q.target.x-[int]$old.x) -lt [int]$q.guardX -and [Math]::Abs([int]$q.target.y-[int]$old.y) -lt [int]$q.guardY){throw 'drop may hit existing icon'}}
[OkibaDragInputCI]::Drag($q.pid,$q.start.x,$q.start.y,$q.target.x,$q.target.y,$q.area.left,$q.area.top,$q.area.right,$q.area.bottom)
@{ok=$true;input='native SendInput';pid=$q.pid;target=$q.target}|ConvertTo-Json -Compress
