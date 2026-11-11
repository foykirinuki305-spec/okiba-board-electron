# Warm shell helper (v2.2): ONE long-lived PowerShell process that
# serves the shell-interop requests the app used to cold-spawn per
# operation (scripts/resolve-drop.ps1, scripts/position-desktop-icons.ps1).
# Protocol: JSON lines on stdin -> JSON lines on stdout, matched by
# "id". Commands: resolveDrop {x,y}, positionIcons {x,y,names[]},
# getDesktopPositions {names[]}, cursorState {} (v2.2.2: OS cursor
# position + left-button state for drag pre-resolution). The helper
# stays sequential, so responses are written in request order. All
# literals are ASCII on purpose (console codepages); the client
# \u-escapes non-ASCII.
# Keep the cold-spawn scripts in sync behaviour-wise: they are the
# fallback when this helper is unavailable.
#
# v2.2.1 (Job 1 regression fix): the desktop listview code below is
# now a FAITHFUL PORT of scripts/position-desktop-icons.ps1
# (v1.3.1, user-confirmed on a real PC). The v2.2 helper had drifted
# from it in ways that made drops land in the wrong place:
#   - GetItemText staged a 48-byte LVITEM with the text buffer
#     INSIDE the struct allocation (cold: an 88-byte LVITEM plus a
#     SEPARATE text buffer) and opened Explorer with
#     PROCESS_ALL_ACCESS (0x001F0FFF), which can be denied where
#     the cold script's minimal VM rights succeed -> empty labels
#     -> no name match -> 'no-item' -> icon left wherever
#     Explorer's default placement put it.
#   - positionIcons never converted the drop point with
#     ScreenToClient: the screen coordinates main passes were
#     treated as listview client coordinates verbatim.
#   - the populated-listview pick returned the FIRST candidate
#     with items (cold: the one with the LARGEST item count), so a
#     stale WorkerW listview could win over the real desktop.
#   - name matching used case-insensitive equality for the 'exact'
#     pass and a REVERSED starts-with test (cold: case-sensitive
#     exact/noext, starts-with = label.StartsWith(name)).
#   - layout: rowsPerCol used the full client height (cold: the
#     height REMAINING below the anchor) and per-icon targets were
#     never clamped into the client area; set verification used a
#     strict < spacing test after a 60ms settle (cold: <= spacing
#     after 180ms).
# All of those now match the cold script exactly. The only
# deliberate difference left is the icon-appear poll: it still
# starts immediately and runs at ~50ms (the speed fix that was the
# point of the warm helper), instead of the cold script's 200ms.
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

  // v2.2.2: global cursor witness for drag pre-resolution. The
  // renderer cannot reliably see the pointer once it leaves the
  // window (pointer capture clamps it), so during a drag main
  // polls this instead: the true OS cursor position (screen
  // coordinates) plus whether the left button is currently down
  // (GetAsyncKeyState's high bit = key is down right now).
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT pt);

  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);

  public static int[] CursorState() {
    POINT pt;
    if (!GetCursorPos(out pt)) return null;
    bool lbtn = (GetAsyncKeyState(0x01) & 0x8000) != 0; // VK_LBUTTON
    return new int[] { pt.X, pt.Y, lbtn ? 1 : 0 };
  }
}
'@

# ---- Desktop listview interop -------------------------------------
# FAITHFUL PORT of position-desktop-icons.ps1's OkibaDesk (v1.3.1):
# same signatures, same LVITEMW offsets, same minimal process
# rights, plus GetSpacingX/Y, SetItemPosition and ToClient helpers
# the helper's other commands need.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OkibaDesk {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool ScreenToClient(IntPtr hwnd, ref POINT pt);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

  [DllImport("kernel32.dll")]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  public static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, uint size, uint type, uint protect);
  [DllImport("kernel32.dll")]
  public static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, uint size, uint type);
  [DllImport("kernel32.dll")]
  public static extern bool WriteProcessMemory(IntPtr proc, IntPtr addr, byte[] buf, uint size, out UIntPtr written);
  [DllImport("kernel32.dll")]
  public static extern bool ReadProcessMemory(IntPtr proc, IntPtr addr, byte[] buf, uint size, out UIntPtr read);

  static IntPtr FromDefView(IntPtr parent) {
    if (parent == IntPtr.Zero) return IntPtr.Zero;
    IntPtr dv = FindWindowEx(parent, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (dv == IntPtr.Zero) return IntPtr.Zero;
    return FindWindowEx(dv, IntPtr.Zero, "SysListView32", null);
  }

  // Every desktop-icons listview candidate (Progman + each
  // WorkerW); the caller picks the populated one (largest count).
  public static IntPtr[] FindDesktopListViews() {
    var list = new List<IntPtr>();
    IntPtr lv = FromDefView(FindWindow("Progman", null));
    if (lv != IntPtr.Zero) list.Add(lv);
    EnumWindows((hwnd, lp) => {
      var sb = new StringBuilder(64);
      GetClassName(hwnd, sb, 64);
      if (sb.ToString() == "WorkerW") {
        IntPtr v = FromDefView(hwnd);
        if (v != IntPtr.Zero && !list.Contains(v)) list.Add(v);
      }
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public const int LVM_FIRST = 0x1000;
  public const int LVM_GETITEMCOUNT = LVM_FIRST + 4;    // 0x1004
  public const int LVM_GETITEMPOSITION = LVM_FIRST + 16; // 0x1010
  public const int LVM_GETITEMTEXTW = LVM_FIRST + 115;   // 0x1073
  public const int LVM_SETITEMPOSITION = LVM_FIRST + 15; // 0x100F
  public const int LVM_GETITEMSPACING = LVM_FIRST + 51;  // 0x1033

  const uint PROCESS_VM = 0x0400 | 0x0008 | 0x0010 | 0x0020; // QUERY_INFO|VM_OPERATION|VM_READ|VM_WRITE
  const uint MEM_COMMIT_RESERVE = 0x1000 | 0x2000;
  const uint MEM_RELEASE = 0x8000;
  const uint PAGE_RW = 0x04;

  public static int GetItemCount(IntPtr hwnd) {
    return (int)SendMessage(hwnd, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
  }

  // LVM_GETITEMSPACING: low word = cx, high word = cy.
  public static int GetSpacingX(IntPtr lv) {
    int v = SendMessage(lv, LVM_GETITEMSPACING, IntPtr.Zero, IntPtr.Zero).ToInt32();
    return v & 0xFFFF;
  }
  public static int GetSpacingY(IntPtr lv) {
    int v = SendMessage(lv, LVM_GETITEMSPACING, IntPtr.Zero, IntPtr.Zero).ToInt32();
    return (v >> 16) & 0xFFFF;
  }

  // Screen -> listview client coordinates (the cold script calls
  // ScreenToClient the same way; v2.2 skipped this entirely).
  public static int[] ToClient(IntPtr hwnd, int x, int y) {
    POINT pt; pt.X = x; pt.Y = y;
    ScreenToClient(hwnd, ref pt);
    return new int[] { pt.X, pt.Y };
  }

  // Read item text cross-process. LVITEMW (x64) byte offsets —
  // VERIFIED against commctrl.h: mask@0, iItem@4, iSubItem@8,
  // state@12, stateMask@16, pszText@24, cchTextMax@32. The struct
  // is 88 bytes and the text buffer is a SEPARATE allocation
  // (v2.2 used a 48-byte struct with the buffer inside it).
  public static string GetItemText(IntPtr hwnd, int item) {
    const int MAXCHARS = 260;
    const int ITEMSIZE = 88;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    IntPtr proc = OpenProcess(PROCESS_VM, false, pid);
    if (proc == IntPtr.Zero) return null;
    IntPtr remoteItem = IntPtr.Zero, remoteText = IntPtr.Zero;
    try {
      remoteItem = VirtualAllocEx(proc, IntPtr.Zero, ITEMSIZE, MEM_COMMIT_RESERVE, PAGE_RW);
      remoteText = VirtualAllocEx(proc, IntPtr.Zero, MAXCHARS * 2, MEM_COMMIT_RESERVE, PAGE_RW);
      if (remoteItem == IntPtr.Zero || remoteText == IntPtr.Zero) return null;
      byte[] data = new byte[ITEMSIZE];
      BitConverter.GetBytes((uint)0x0001).CopyTo(data, 0);           // mask = LVIF_TEXT
      BitConverter.GetBytes(item).CopyTo(data, 4);                    // iItem
      BitConverter.GetBytes((int)0).CopyTo(data, 8);                  // iSubItem = 0 (the label)
      BitConverter.GetBytes(remoteText.ToInt64()).CopyTo(data, 24);   // pszText
      BitConverter.GetBytes(MAXCHARS).CopyTo(data, 32);               // cchTextMax
      UIntPtr written;
      if (!WriteProcessMemory(proc, remoteItem, data, ITEMSIZE, out written)) return null;
      SendMessage(hwnd, LVM_GETITEMTEXTW, new IntPtr(item), remoteItem);
      byte[] textBuf = new byte[MAXCHARS * 2];
      UIntPtr read;
      if (!ReadProcessMemory(proc, remoteText, textBuf, (uint)textBuf.Length, out read)) return null;
      string text = Encoding.Unicode.GetString(textBuf, 0, (int)read.ToUInt32());
      int nul = text.IndexOf('\0');
      return nul >= 0 ? text.Substring(0, nul) : text;
    } finally {
      if (remoteItem != IntPtr.Zero) VirtualFreeEx(proc, remoteItem, 0, MEM_RELEASE);
      if (remoteText != IntPtr.Zero) VirtualFreeEx(proc, remoteText, 0, MEM_RELEASE);
      CloseHandle(proc);
    }
  }

  // Read an item's current position (client coords of its
  // top-left); null when the read fails. Same cross-process
  // technique and minimal rights as the cold script.
  public static int[] GetItemPosition(IntPtr hwnd, int item) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    IntPtr proc = OpenProcess(PROCESS_VM, false, pid);
    if (proc == IntPtr.Zero) return null;
    IntPtr remote = IntPtr.Zero;
    try {
      remote = VirtualAllocEx(proc, IntPtr.Zero, 8, MEM_COMMIT_RESERVE, PAGE_RW);
      if (remote == IntPtr.Zero) return null;
      IntPtr res = SendMessage(hwnd, LVM_GETITEMPOSITION, new IntPtr(item), remote);
      if (res == IntPtr.Zero) return null;
      byte[] buf = new byte[8];
      UIntPtr read;
      if (!ReadProcessMemory(proc, remote, buf, (uint)buf.Length, out read)) return null;
      return new int[] { BitConverter.ToInt32(buf, 0), BitConverter.ToInt32(buf, 4) };
    } finally {
      if (remote != IntPtr.Zero) VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
      CloseHandle(proc);
    }
  }

  public static void SetItemPosition(IntPtr lv, int index, int x, int y) {
    int lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF);
    SendMessage(lv, LVM_SETITEMPOSITION, (IntPtr)index, (IntPtr)lp);
  }
}
'@

# ---- Shared listview helpers (ported from the cold script) --------
# Pick the candidate with the LARGEST item count (cold script
# behaviour; v2.2 took the first non-empty one).
function Find-BestListView {
  $best = [IntPtr]::Zero
  $bestCount = -1
  foreach ($cand in [OkibaDesk]::FindDesktopListViews()) {
    try { $c = [OkibaDesk]::GetItemCount($cand) } catch { $c = -1 }
    if ($c -gt $bestCount) { $bestCount = $c; $best = $cand }
  }
  return $best
}

# Name matching, strategies in strict order — identical to the
# cold script's Test-NameMatch (case-SENSITIVE exact/noext first;
# starts-with tests the LABEL against the name, not the reverse).
function Test-NameMatch($text, $name, $strategy) {
  if ($null -eq $text -or $text -eq '') { return $false }
  $noExt = [System.IO.Path]::GetFileNameWithoutExtension($name)
  switch ($strategy) {
    'exact'      { return $text -ceq $name }
    'noext'      { return ($noExt -and ($text -ceq $noExt)) }
    'ci'         { return ($text -ieq $name) -or ($noExt -and ($text -ieq $noExt)) }
    'startswith' { return $text.StartsWith($name) -or ($noExt -and $text.StartsWith($noExt)) }
  }
  return $false
}

function Find-Matches([IntPtr]$lv, [string[]]$Names, [int]$count) {
  $texts = @{}
  for ($i = 0; $i -lt $count; $i++) {
    $t = [OkibaDesk]::GetItemText($lv, $i)
    if ($null -ne $t) { $texts[$i] = $t }
  }
  $slots = @{}
  $used = @{}
  foreach ($strategy in @('exact', 'noext', 'ci', 'startswith')) {
    for ($s = 0; $s -lt $Names.Count; $s++) {
      if ($slots.ContainsKey($s)) { continue }
      foreach ($i in $texts.Keys) {
        if ($used.ContainsKey($i)) { continue }
        if (Test-NameMatch $texts[$i] $Names[$s] $strategy) {
          $slots[$s] = $i
          $used[$i] = $true
          break
        }
      }
    }
    if ($slots.Count -ge $Names.Count) { break }
  }
  return @{ Slots = $slots; Texts = @($texts.Values) }
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

# ---- positionIcons -------------------------------------------------
# Faithful port of position-desktop-icons.ps1's position mode:
# ScreenToClient conversion, clamped layout anchored at the drop
# point, rowsPerCol from the height REMAINING below the anchor,
# auto-arrange gate on LVS_AUTOARRANGE (0x0100), and set ->
# read-back -> retry verification with the cold script's 180ms
# settle and <= spacing tolerance. X/Y arrive as SCREEN
# coordinates (exactly what main passes the cold script).
# Only the icon-appear poll differs: immediate first poll, then
# ~50ms (the warm-helper speed point), capped at ~8s like cold.
function Position-Icons([int]$X, [int]$Y, [string[]]$Names) {
  $result = @{ status = 'ok'; positioned = 0; detail = '' }
  $lv = Find-BestListView
  if ($lv -eq [IntPtr]::Zero) { $result.status = 'no-listview'; $result.detail = 'no desktop listview found'; return $result }

  $style = [OkibaDesk]::GetWindowLong($lv, -16) # GWL_STYLE
  if (($style -band 0x0100) -ne 0) { $result.status = 'autoarrange'; return $result }

  $sx = [OkibaDesk]::GetSpacingX($lv)
  $sy = [OkibaDesk]::GetSpacingY($lv)
  if ($sx -le 0) { $sx = 100 }
  if ($sy -le 0) { $sy = 100 }

  $rect = New-Object OkibaDesk+RECT
  [void][OkibaDesk]::GetClientRect($lv, [ref]$rect)
  $cw = $rect.Right - $rect.Left
  $ch = $rect.Bottom - $rect.Top
  if ($cw -le 0 -or $ch -le 0) {
    $result.status = 'script-error'; $result.detail = 'listview has no client area'; return $result
  }

  # Layout (same rule as the cold script / lib/iconpos.js).
  $client = [OkibaDesk]::ToClient($lv, $X, $Y)
  $anchorX = $client[0]; $anchorY = $client[1]
  $maxX = [Math]::Max(0, $cw - $sx)
  $maxY = [Math]::Max(0, $ch - $sy)
  $ax = [int][Math]::Max(0, [Math]::Min($maxX, [Math]::Round($anchorX - $sx / 2)))
  $ay = [int][Math]::Max(0, [Math]::Min($maxY, [Math]::Round($anchorY - $sy / 2)))
  $rowsPerCol = [int][Math]::Floor(($ch - $ay) / $sy)
  if ($rowsPerCol -lt 1) { $rowsPerCol = 1 }

  # Wait for the moved icons to appear (first poll immediate,
  # then ~50ms, ~8s cap — cold polls at 200ms to the same cap).
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

  # Place each icon, then READ BACK and retry until it sticks
  # (align-to-grid snaps to the grid: within one spacing is a hit).
  $verified = 0
  foreach ($entry in $found.Slots.GetEnumerator()) {
    $slot = [int]$entry.Key
    $idx = [int]$entry.Value
    $col = [Math]::Floor($slot / $rowsPerCol)
    $row = $slot % $rowsPerCol
    $tx = [int][Math]::Max(0, [Math]::Min($maxX, $ax + $col * $sx))
    $ty = [int][Math]::Max(0, [Math]::Min($maxY, $ay + $row * $sy))
    $stuck = $false
    for ($try = 0; $try -lt 3 -and -not $stuck; $try++) {
      [OkibaDesk]::SetItemPosition($lv, $idx, $tx, $ty)
      Start-Sleep -Milliseconds 180
      $pos = [OkibaDesk]::GetItemPosition($lv, $idx)
      if ($null -ne $pos -and [Math]::Abs($pos[0] - $tx) -le $sx -and [Math]::Abs($pos[1] - $ty) -le $sy) {
        $stuck = $true
      }
    }
    if ($stuck) { $verified++ }
  }
  $result.positioned = $verified
  if ($verified -eq 0) {
    $result.status = 'set-unverified'
    $result.detail = 'positions did not stick after retries'
  } elseif ($verified -lt $Names.Count) {
    $result.status = 'partial'
  }
  return $result
}

# ---- getDesktopPositions (intake layout lookup) -------------------
function Get-DesktopPositions([string[]]$Names) {
  $out = @{ positions = @{}; sx = 100; sy = 100 }
  $lv = Find-BestListView
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

# ---- cursorState (v2.2.2: drag pre-resolution witness) -------------
function Get-CursorState {
  $s = [OkibaWin32]::CursorState()
  if ($null -eq $s) { return @{ x = 0; y = 0; lbtn = $false } }
  return @{ x = [int]$s[0]; y = [int]$s[1]; lbtn = ($s[2] -ne 0) }
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
      'cursorState'         { $result = Get-CursorState }
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
