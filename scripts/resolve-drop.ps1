# OkibaBoard drag-out: resolve the folder under a screen point.
# Args: <x> <y>  (screen coordinates, integers)
# Prints ONE JSON line: {"type":"desktop"|"explorer"|"unknown","path":"..."}
# Anything unexpected -> {"type":"unknown"} and exit 0. Never throws.
param([int]$X, [int]$Y)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OkibaWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder buf, int max);
}
'@

  $pt = New-Object OkibaWin32+POINT
  $pt.X = $X; $pt.Y = $Y
  $hwnd = [OkibaWin32]::WindowFromPoint($pt)
  if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"type":"unknown"}'; exit 0 }
  $root = [OkibaWin32]::GetAncestor($hwnd, 2) # GA_ROOT
  if ($root -eq [IntPtr]::Zero) { $root = $hwnd }

  $sb = New-Object System.Text.StringBuilder 256
  [void][OkibaWin32]::GetClassName($root, $sb, 256)
  $className = $sb.ToString()

  if ($className -eq 'Progman' -or $className -eq 'WorkerW') {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $obj = @{ type = 'desktop'; path = $desktop }
    Write-Output ($obj | ConvertTo-Json -Compress)
    exit 0
  }

  # Explorer windows: match the top-level HWND in ShellWindows.
  $shell = New-Object -ComObject Shell.Application
  $target = $root.ToInt64()
  foreach ($win in $shell.Windows()) {
    try {
      if ($win.HWND -eq $target) {
        $folder = $win.Document.Folder
        if ($null -ne $folder) {
          $p = $folder.Self.Path
          if ($p -and ($p.Trim() -ne '')) {
            $obj = @{ type = 'explorer'; path = $p }
            Write-Output ($obj | ConvertTo-Json -Compress)
            exit 0
          }
        }
        break
      }
    } catch { continue }
  }
  Write-Output '{"type":"unknown"}'
} catch {
  Write-Output '{"type":"unknown"}'
}
exit 0
