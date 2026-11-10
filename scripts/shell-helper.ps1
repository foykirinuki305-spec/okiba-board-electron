# Warm shell helper (v2.2): ONE long-lived PowerShell process that
# serves the shell-interop requests the app used to cold-spawn per
# operation (scripts/resolve-drop.ps1, scripts/position-desktop-icons.ps1).
# Protocol: JSON lines on stdin -> JSON lines on stdout, matched by
# "id". Commands: resolveDrop {x,y}, positionIcons {x,y,names[]},
# getDesktopPositions {names[]}. The helper stays sequential, so
# responses are written in request order. All literals are ASCII on
# purpose (console codepages); the client \u-escapes non-ASCII.
# Keep the cold-spawn scripts in sync behaviour-wise: they are the
# fallback when this helper is unavailable.
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

# ---- Resolve interop (same as resolve-drop.ps1) -------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OkibaWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int maxCount);
}
'@

# ---- Desktop listview interop (same as position-desktop-icons.ps1)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OkibaDesk {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr addr, int size, int type, int protect);
  [DllImport("kernel32.dll")] public static extern bool VirtualFreeEx(IntPtr h, IntPtr addr, int size, int type);
  [DllImport("kernel32.dll")] public static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int written);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static string ClassOf(IntPtr hwnd) {
    var sb = new StringBuilder(256);
    GetClassName(hwnd, sb, 256);
    return sb.ToString();
  }

  // Every desktop-icons listview: Progman's SHELLDLL_DefView plus
  // each WorkerW's (the wallpaper layer creates one; only one of
  // them actually hosts the icons).
  public static IntPtr[] FindDesktopListViews() {
    var found = new List<IntPtr>();
    IntPtr progman = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Progman", null);
    if (progman != IntPtr.Zero) {
      IntPtr def = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (def != IntPtr.Zero) {
        IntPtr lv = FindWindowEx(def, IntPtr.Zero, "SysListView32", null);
        if (lv != IntPtr.Zero) found.Add(lv);
      }
    }
    EnumWindows((top, lp) => {
      if (ClassOf(top) == "WorkerW") {
        IntPtr def = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (def != IntPtr.Zero) {
          IntPtr lv = FindWindowEx(def, IntPtr.Zero, "SysListView32", null);
          if (lv != IntPtr.Zero) found.Add(lv);
        }
      }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  public static int GetItemCount(IntPtr lv) {
    return SendMessage(lv, 0x1004, IntPtr.Zero, IntPtr.Zero).ToInt32(); // LVM_GETITEMCOUNT
  }

  // LVM_GETITEMSPACING: low word = cx, high word = cy.
  public static int GetSpacingX(IntPtr lv) {
    int v = SendMessage(lv, 0x1033, IntPtr.Zero, IntPtr.Zero).ToInt32();
    return v & 0xFFFF;
  }
  public static int GetSpacingY(IntPtr lv) {
    int v = SendMessage(lv, 0x1033, IntPtr.Zero, IntPtr.Zero).ToInt32();
    return (v >> 16) & 0xFFFF;
  }

  public const int LVM_FIRST = 0x1000;

  // Read item text cross-process (LVITEMW x64 layout: mask 0,
  // iItem 4, iSubItem 8, state 12, stateMask 16, pad 20,
  // pszText 24, cchTextMax 32).
  public static string GetItemText(IntPtr lv, int index) {
    int pid;
    GetWindowThreadProcessId(lv, out pid);
    IntPtr h = OpenProcess(0x001F0FFF, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      int textBytes = 520;
      IntPtr remote = VirtualAllocEx(h, IntPtr.Zero, 48 + textBytes, 0x3000, 0x04);
      if (remote == IntPtr.Zero) return "";
      try {
        IntPtr textPtr = (IntPtr)(remote.ToInt64() + 48);
        byte[] item = new byte[48];
        BitConverter.GetBytes((int)0x0001).CopyTo(item, 0);           // LVIF_TEXT
        BitConverter.GetBytes(index).CopyTo(item, 4);                 // iItem
        BitConverter.GetBytes(0).CopyTo(item, 8);                     // iSubItem
        BitConverter.GetBytes(textPtr.ToInt64()).CopyTo(item, 24);    // pszText
        BitConverter.GetBytes(textBytes / 2).CopyTo(item, 32);        // cchTextMax
        int w;
        WriteProcessMemory(h, remote, item, item.Length, out w);
        SendMessage(lv, 0x1073, (IntPtr)index, remote);               // LVM_GETITEMTEXTW
        byte[] buf = new byte[textBytes];
        int r;
        ReadProcessMemory(h, textPtr, buf, buf.Length, out r);
        return Encoding.Unicode.GetString(buf).TrimEnd('\0');
      } finally {
        VirtualFreeEx(h, remote, 0, 0x8000);
      }
    } finally {
      CloseHandle(h);
    }
  }

  // MAKELPARAM(x, y) as the LVM_GETITEMPOSITION out-point.
  public static int[] GetItemPosition(IntPtr lv, int index) {
    int pid;
    GetWindowThreadProcessId(lv, out pid);
    IntPtr h = OpenProcess(0x001F0FFF, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      IntPtr remote = VirtualAllocEx(h, IntPtr.Zero, 8, 0x3000, 0x04);
      if (remote == IntPtr.Zero) return null;
      try {
        SendMessage(lv, LVM_FIRST + 16, (IntPtr)index, remote);       // LVM_GETITEMPOSITION
        byte[] buf = new byte[8];
        int r;
        ReadProcessMemory(h, remote, buf, buf.Length, out r);
        return new int[] { BitConverter.ToInt32(buf, 0), BitConverter.ToInt32(buf, 4) };
      } finally {
        VirtualFreeEx(h, remote, 0, 0x8000);
      }
    } finally {
      CloseHandle(h);
    }
  }

  public static void SetItemPosition(IntPtr lv, int index, int x, int y) {
    int lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF);
    SendMessage(lv, LVM_FIRST + 15, (IntPtr)index, (IntPtr)lp);         // LVM_SETITEMPOSITION
  }
}
'@

# ---- Shared listview helpers (as in position-desktop-icons.ps1) ---
function Find-PopulatedListView {
  foreach ($cand in [OkibaDesk]::FindDesktopListViews()) {
    if ([OkibaDesk]::GetItemCount($cand) -gt 0) { return $cand }
  }
  return [IntPtr]::Zero
}

function Find-Matches([IntPtr]$lv, [string[]]$Names, [int]$count) {
  $texts = @()
  for ($i = 0; $i -lt $count; $i++) {
    $t = [OkibaDesk]::GetItemText($lv, $i)
    if ($null -eq $t) { $t = '' }
    $texts += $t
  }
  $used = @{}
  $slots = @{}
  $strategies = @('exact', 'noext', 'ci', 'startswith')
  foreach ($strategy in $strategies) {
    for ($s = 0; $s -lt $Names.Count; $s++) {
      if ($slots.ContainsKey($s)) { continue }
      $name = $Names[$s]
      $base = [IO.Path]::GetFileNameWithoutExtension($name)
      for ($i = 0; $i -lt $count; $i++) {
        if ($used.ContainsKey($i)) { continue }
        $t = $texts[$i]
        $hit = $false
        switch ($strategy) {
          'exact'      { $hit = ($t -eq $name) }
          'noext'      { $hit = ($base -ne '' -and $t -eq $base) }
          'ci'         { $hit = ($t -ieq $name -or ($base -ne '' -and $t -ieq $base)) }
          'startswith' { $hit = ($t -ne '' -and ($name.StartsWith($t) -or ($base -ne '' -and $base.StartsWith($t)))) }
        }
        if ($hit) { $slots[$s] = $i; $used[$i] = $true; break }
      }
    }
  }
  return @{ Slots = $slots; Texts = $texts }
}

# ---- resolveDrop (as in resolve-drop.ps1) -------------------------
function Resolve-DropTarget([int]$X, [int]$Y) {
  $pt = New-Object OkibaWin32+POINT
  $pt.X = $X
  $pt.Y = $Y
  $hwnd = [OkibaWin32]::WindowFromPoint($pt)
  if ($hwnd -ne [IntPtr]::Zero) {
    $root = [OkibaWin32]::GetAncestor($hwnd, 2) # GA_ROOT
    if ($root -ne [IntPtr]::Zero) { $hwnd = $root }
    $sb = New-Object System.Text.StringBuilder 256
    [void][OkibaWin32]::GetClassName($hwnd, $sb, 256)
    $cls = $sb.ToString()
    if ($cls -eq 'Progman' -or $cls -eq 'WorkerW') {
      $desktop = [Environment]::GetFolderPath('Desktop')
      return @{ type = 'desktop'; path = $desktop }
    }
    try {
      $shell = New-Object -ComObject Shell.Application
      foreach ($win in $shell.Windows()) {
        try {
          if ($win.HWND -eq $hwnd.ToInt64()) {
            $p = $win.Document.Folder.Self.Path
            if ($p) { return @{ type = 'explorer'; path = $p } }
          }
        } catch {}
      }
    } catch {}
  }
  return @{ type = 'unknown' }
}

# ---- positionIcons (as in position-desktop-icons.ps1, tightened) --
# Same layout rule, auto-arrange gate and set->readback->retry
# verification, but the icon-appear poll starts immediately and runs
# at ~50ms (the cold script polls at 200ms after a 150ms settle),
# because after a local move the icon normally shows up at once.
function Position-Icons([int]$X, [int]$Y, [string[]]$Names) {
  $result = @{ status = 'ok'; positioned = 0 }
  $lv = Find-PopulatedListView
  if ($lv -eq [IntPtr]::Zero) { $result.status = 'no-listview'; return $result }

  $style = [OkibaDesk]::GetWindowLong($lv, -16) # GWL_STYLE
  if (($style -band 0x0100) -ne 0) { $result.status = 'autoarrange'; return $result }

  $sx = [OkibaDesk]::GetSpacingX($lv)
  $sy = [OkibaDesk]::GetSpacingY($lv)
  if ($sx -le 0) { $sx = 78 }
  if ($sy -le 0) { $sy = 98 }

  # Wait for the moved icons to exist, first poll immediate, then
  # ~50ms, capped like the cold script (~8s).
  $count = 0
  $found = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ($true) {
    $count = [OkibaDesk]::GetItemCount($lv)
    $found = Find-Matches $lv $Names $count
    if ($found.Slots.Count -ge $Names.Count) { break }
    if ([DateTime]::UtcNow -gt $deadline) { break }
    Start-Sleep -Milliseconds 50
  }
  if ($found.Slots.Count -eq 0) {
    $result.status = 'no-item'
    $result.detail = "names=[$($Names -join ', ')] icons=$count texts=[$($found.Texts -join ', ')]"
    return $result
  }

  $rect = New-Object OkibaDesk+RECT
  [void][OkibaDesk]::GetClientRect($lv, [ref]$rect)
  if ($rect.Right -le 0) { $rect.Right = 1920 }
  if ($rect.Bottom -le 0) { $rect.Bottom = 1080 }
  $rowsPerCol = [Math]::Max(1, [Math]::Floor($rect.Bottom / $sy))

  $ox = $X - [Math]::Floor($sx / 2)
  $oy = $Y - [Math]::Floor($sy / 2)
  if ($ox -lt 0) { $ox = 0 }
  if ($oy -lt 0) { $oy = 0 }

  # Each set is verified by reading the position back; a miss is
  # retried twice with a short settle (cold script: 180ms).
  for ($k = 0; $k -lt $Names.Count; $k++) {
    if (-not $found.Slots.ContainsKey($k)) { continue }
    $slot = [int]$found.Slots[$k]
    $tx = $ox + [Math]::Floor($k / $rowsPerCol) * $sx
    $ty = $oy + ($k % $rowsPerCol) * $sy
    $okSet = $false
    for ($attempt = 0; $attempt -lt 3 -and -not $okSet; $attempt++) {
      [OkibaDesk]::SetItemPosition($lv, $slot, $tx, $ty)
      Start-Sleep -Milliseconds 60
      $pos = [OkibaDesk]::GetItemPosition($lv, $slot)
      if ($null -ne $pos -and [Math]::Abs($pos[0] - $tx) -lt $sx -and [Math]::Abs($pos[1] - $ty) -lt $sy) {
        $okSet = $true
      }
    }
    if ($okSet) { $result.positioned += 1 }
    else { $result["failed_$k"] = $Names[$k] }
  }
  if ($result.positioned -eq 0) { $result.status = 'set-unverified' }
  elseif ($result.positioned -lt $Names.Count) { $result.status = 'partial' }
  return $result
}

# ---- getDesktopPositions (new in v2.2; intake layout lookup) ------
function Get-DesktopPositions([string[]]$Names) {
  $out = @{ positions = @{}; sx = 78; sy = 98 }
  $lv = Find-PopulatedListView
  if ($lv -eq [IntPtr]::Zero) { return $out }
  $sx = [OkibaDesk]::GetSpacingX($lv)
  $sy = [OkibaDesk]::GetSpacingY($lv)
  if ($sx -gt 0) { $out.sx = $sx }
  if ($sy -gt 0) { $out.sy = $sy }
  $count = [OkibaDesk]::GetItemCount($lv)
  $found = Find-Matches $lv $Names $count
  foreach ($k in $found.Slots.Keys) {
    $pos = [OkibaDesk]::GetItemPosition($lv, [int]$found.Slots[$k])
    if ($null -ne $pos) {
      $out.positions[$Names[[int]$k]] = @{ x = [int]$pos[0]; y = [int]$pos[1] }
    }
  }
  return $out
}

# ---- Main loop ------------------------------------------------------
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = $null
    switch ($req.cmd) {
      'resolveDrop'         { $result = Resolve-DropTarget ([int]$req.x) ([int]$req.y) }
      'positionIcons'       { $result = Position-Icons ([int]$req.x) ([int]$req.y) ([string[]]@($req.names)) }
      'getDesktopPositions' { $result = Get-DesktopPositions ([string[]]@($req.names)) }
      default               { throw "unknown-cmd: $($req.cmd)" }
    }
    $resp = @{ id = $id; result = $result }
  } catch {
    $resp = @{ id = $id; error = "$($_.Exception.Message)" }
  }
  try {
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
  } catch { break }
}
