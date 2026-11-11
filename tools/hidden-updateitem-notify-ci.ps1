param([Parameter(Mandatory=$true)][string]$Path,[ValidateSet('none','update')][string]$Mode,[ValidateSet('hidden','visible')][string]$Expected)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Hosted Windows CI only'}
$full=[IO.Path]::GetFullPath($Path);$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'))
if([IO.Path]::GetDirectoryName($full) -ine $desktop -or [IO.Path]::GetFileName($full) -notlike 'OkibaDense-*' -or -not [IO.File]::Exists($full)){throw 'Not an existing owned CI file'}
$hidden=([IO.File]::GetAttributes($full) -band [IO.FileAttributes]::Hidden) -ne 0
if($hidden -ne ($Expected -eq 'hidden')){throw 'Actual attribute does not match notification claim'}
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices; public static class OkibaActualNotify { [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint change,uint flags,string item,IntPtr other); }'
if($Mode -eq 'update'){[OkibaActualNotify]::SHChangeNotify(0x2000,0x1005,$full,[IntPtr]::Zero)}
[pscustomobject]@{mode=$Mode;hidden=$hidden;notification=$(if($Mode -eq 'update'){'SHCNE_UPDATEITEM'}else{'none-control'})}|ConvertTo-Json -Compress
