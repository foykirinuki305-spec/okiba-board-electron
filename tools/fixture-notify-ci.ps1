param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Fixture CREATE notification is hosted CI only'}
$full=[IO.Path]::GetFullPath($Path);$desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'))
if([IO.Path]::GetDirectoryName($full) -ine $desktop -or -not [IO.Path]::GetFileName($full).StartsWith('OkibaSafe-') -or -not [IO.File]::Exists($full)){throw 'Only an existing owned Desktop fixture can be announced'}
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class OkibaFixtureCreateCI {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern void SHChangeNotify(uint e,uint f,string p,IntPtr other);
 public static void Created(string p){if(!System.IO.File.Exists(p))throw new InvalidOperationException("fixture no longer exists");SHChangeNotify(2u,0x1005u,p,IntPtr.Zero);}
}
'@
[OkibaFixtureCreateCI]::Created($full)
