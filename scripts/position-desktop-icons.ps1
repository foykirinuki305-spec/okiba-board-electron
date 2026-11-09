# OkibaBoard drag-out: place freshly dropped desktop icons at the
# drop point.
#
# Modes:
#   (default)      Position mode.
#                  Args: <x> <y> <fileName1> [fileName2 ...]
#                    x, y     = screen coordinates of the release
#                               (listview CLIENT coordinates when
#                               -ClientCoords is given)
#                    fileName = destination names of the files that
#                               were just MOVED into the Desktop
#                               folder (after any " (2)" renaming)
#   -GetPosition   Read-back mode (CI integration test / debugging).
#                  Args: 0 0 <fileName>
#                  Prints the item's current listview position.
#
# Position mode prints ONE JSON line:
#   {"status":"ok"|"partial"|"autoarrange"|"no-listview"|"no-item"|
#             "set-unverified"|"script-error",
#    "positioned":<n>,"detail":"..."}
# GetPosition mode prints ONE JSON line:
#   {"status":"ok","x":<n>,"y":<n>,"sx":<n>,"sy":<n>,"count":<n>}
#   or {"status":"no-listview"|"no-item","count":<n>}
#
# v1.3.1 notes — why positioning never worked in v1.3.0 (TWO bugs,
# either one sufficient):
# 1. THE STYLE GATE: the auto-arrange check tested style bit
#    0x1000, but LVS_AUTOARRANGE is 0x0100 — 0x1000 is
#    LVS_OWNERDATA, which is SET in the stock desktop listview
#    style (0x56003A40, observed on a real Explorer desktop).
#    So the script reported "autoarrange" on machines where
#    auto-arrange was OFF, and bailed before doing anything.
# 2. THE TEXT READ: GetItemText staged its LVITEM with the item
#    index at byte offset 8 and a zero at offset 12. Those are the
#    iSubItem and state fields; iItem lives at offset 4 (and was
#    left 0), iSubItem at offset 8. The text request therefore
#    only ever yields a real label for index 0 — name matching
#    would have failed on any normal desktop even past the gate,
#    and the caller treated the resulting "notfound" as silent.
# This version fixes both (correct bit, correct LVITEMW offsets),
# enumerates ALL candidate desktop listviews and uses the
# populated one, polls up to ~8s for the icons to appear, tries
# several name-match strategies, and VERIFIES each placement by
# reading the position back (retrying up to 3 times), because
# Explorer may snap (align-to-grid) or relayout after a set.
#
# Best-effort by design: the move itself already happened; this
# script never touches files, and always exits 0.
param(
  [int]$X = 0,
  [int]$Y = 0,
  [switch]$ClientCoords,
  [switch]$GetPosition,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Names
)

$ErrorActionPreference = 'Stop'

function Clean-Msg($m) {
  $s = [string]$m
  $s = $s -replace '\s+', ' '
  if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
  return $s
}
function Out-Result($status, $positioned, $detail) {
  $obj = @{ status = $status; positioned = $positioned; detail = (Clean-Msg $detail) }
  Write-Output ($obj | ConvertTo-Json -Compress)
}
function Out-Pos($obj) { Write-Output ($obj | ConvertTo-Json -Compress) }

try {
  $names = @($Names | Where-Object { $_ -and $_.Trim() -ne '' })
  if ($names.Count -eq 0) { Out-Result 'script-error' 0 'no file names given'; exit 0 }

  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
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
  public static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
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

  // The desktop icon listview lives under Progman normally, but
  // with wallpaper slideshows / multiple monitors it can be hosted
  // by a WorkerW window instead — and a stale empty one can linger
  // under Progman. Enumerate EVERY candidate; the caller picks the
  // populated one.
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

  const uint PROCESS_VM = 0x0400 | 0x0008 | 0x0010 | 0x0020; // QUERY_INFO|VM_OPERATION|VM_READ|VM_WRITE
  const uint MEM_COMMIT_RESERVE = 0x1000 | 0x2000;
  const uint MEM_RELEASE = 0x8000;
  const uint PAGE_RW = 0x04;

  public static int GetItemCount(IntPtr hwnd) {
    return (int)SendMessage(hwnd, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
  }

  // Read the text of one listview item in the explorer process.
  // Classic cross-process technique: stage an LVITEM (plus its text
  // buffer) in the owner process with VirtualAllocEx, let
  // LVM_GETITEMTEXTW fill it, read the text back.
  // LVITEMW (x64) byte offsets — VERIFIED against commctrl.h:
  //   mask@0, iItem@4, iSubItem@8, state@12, stateMask@16,
  //   pszText@24, cchTextMax@32, iImage@36, lParam@40 ...
  // (v1.3.0 wrote iItem at offset 8 and iSubItem at offset 12,
  // which broke matching for every item except index 0.)
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

  // Read an item's current position (client coordinates of the
  // item's top-left). Used to VERIFY a placement actually stuck.
  public static bool GetItemPosition(IntPtr hwnd, int item, out int x, out int y) {
    x = 0; y = 0;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    IntPtr proc = OpenProcess(PROCESS_VM, false, pid);
    if (proc == IntPtr.Zero) return false;
    IntPtr remote = IntPtr.Zero;
    try {
      remote = VirtualAllocEx(proc, IntPtr.Zero, 8, MEM_COMMIT_RESERVE, PAGE_RW);
      if (remote == IntPtr.Zero) return false;
      IntPtr res = SendMessage(hwnd, LVM_GETITEMPOSITION, new IntPtr(item), remote);
      if (res == IntPtr.Zero) return false;
      byte[] buf = new byte[8];
      UIntPtr read;
      if (!ReadProcessMemory(proc, remote, buf, (uint)buf.Length, out read)) return false;
      x = BitConverter.ToInt32(buf, 0);
      y = BitConverter.ToInt32(buf, 4);
      return true;
    } finally {
      if (remote != IntPtr.Zero) VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
      CloseHandle(proc);
    }
  }
}
'@

  # ---- candidate listviews: pick the populated one ----
  $candidates = @([OkibaDesk]::FindDesktopListViews())
  if ($candidates.Count -eq 0) {
    if ($GetPosition) { Out-Pos @{ status = 'no-listview'; count = 0 } }
    else { Out-Result 'no-listview' 0 'no desktop listview found' }
    exit 0
  }
  $lv = [IntPtr]::Zero
  $lvCount = -1
  foreach ($cand in $candidates) {
    try { $c = [OkibaDesk]::GetItemCount($cand) } catch { $c = -1 }
    if ($c -gt $lvCount) { $lvCount = $c; $lv = $cand }
  }
  if ($lv -eq [IntPtr]::Zero) {
    if ($GetPosition) { Out-Pos @{ status = 'no-listview'; count = 0 } }
    else { Out-Result 'no-listview' 0 'listview handle invalid' }
    exit 0
  }
  if ($lvCount -lt 0) { $lvCount = 0 }

  # ---- live metrics ----
  $LVM_GETITEMCOUNT = 0x1004
  $LVM_GETITEMSPACING = 0x1033
  $LVM_SETITEMPOSITION = 0x100F
  $spRet = [OkibaDesk]::SendMessage($lv, $LVM_GETITEMSPACING, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
  $sx = [int]($spRet -band 0xFFFF)
  $sy = [int](($spRet -shr 16) -band 0xFFFF)
  if ($sx -le 0) { $sx = 100 }
  if ($sy -le 0) { $sy = 100 }

  # ---- name matching, strategies in order ----
  # exact (case-sensitive) -> without extension -> case-insensitive
  # -> starts-with. Desktop labels often hide the extension.
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

  # Scan the listview once and assign items to name slots using the
  # strategies in strict order (a loose match never steals an item
  # an exact match needs). Returns @{ slot -> listview index }.
  function Find-Matches($lvHwnd, $nameList) {
    $found = @{}
    $usedItems = @{}
    $count = [OkibaDesk]::SendMessage($lvHwnd, $LVM_GETITEMCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($count -le 0) { return $found }
    $texts = @{}
    for ($i = 0; $i -lt $count; $i++) {
      $t = [OkibaDesk]::GetItemText($lvHwnd, $i)
      if ($null -ne $t) { $texts[$i] = $t }
    }
    foreach ($strategy in @('exact', 'noext', 'ci', 'startswith')) {
      for ($s = 0; $s -lt $nameList.Count; $s++) {
        if ($found.ContainsKey($s)) { continue }
        foreach ($i in $texts.Keys) {
          if ($usedItems.ContainsKey($i)) { continue }
          if (Test-NameMatch $texts[$i] $nameList[$s] $strategy) {
            $found[$s] = $i
            $usedItems[$i] = $true
            break
          }
        }
      }
      if ($found.Count -ge $nameList.Count) { break }
    }
    return $found
  }

  # ================= -GetPosition mode =================
  if ($GetPosition) {
    $itemOfSlot = @{}
    $deadline = (Get-Date).AddSeconds(2.5)
    do {
      $itemOfSlot = Find-Matches $lv $names
      if ($itemOfSlot.Count -gt 0) { break }
      Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    $countNow = [OkibaDesk]::GetItemCount($lv)
    if ($itemOfSlot.Count -eq 0) {
      Out-Pos @{ status = 'no-item'; count = $countNow }
      exit 0
    }
    $idx = [int]$itemOfSlot[0]
    $px = 0; $py = 0
    $okPos = [OkibaDesk]::GetItemPosition($lv, $idx, [ref]$px, [ref]$py)
    if (-not $okPos) {
      Out-Pos @{ status = 'no-item'; count = $countNow }
      exit 0
    }
    Out-Pos @{ status = 'ok'; x = $px; y = $py; sx = $sx; sy = $sy; count = $countNow }
    exit 0
  }

  # ================= position mode =================
  # ---- auto-arrange? positions will not stick; say so and stop ----
  $GWL_STYLE = -16
  $LVS_AUTOARRANGE = 0x0100 # commctrl.h — NOT 0x1000 (that is LVS_OWNERDATA)
  $style = [OkibaDesk]::GetWindowLong($lv, $GWL_STYLE)
  if (($style -band $LVS_AUTOARRANGE) -ne 0) { Out-Result 'autoarrange' 0 ''; exit 0 }

  $rect = New-Object OkibaDesk+RECT
  [void][OkibaDesk]::GetClientRect($lv, [ref]$rect)
  $cw = $rect.Right - $rect.Left
  $ch = $rect.Bottom - $rect.Top
  if ($cw -le 0 -or $ch -le 0) { Out-Result 'script-error' 0 'listview has no client area'; exit 0 }

  # ---- layout (same rule as lib/iconpos.js layoutIconPositions) ----
  if ($ClientCoords) {
    $anchorX = $X; $anchorY = $Y
  } else {
    $pt = New-Object OkibaDesk+POINT
    $pt.X = $X; $pt.Y = $Y
    [void][OkibaDesk]::ScreenToClient($lv, [ref]$pt)
    $anchorX = $pt.X; $anchorY = $pt.Y
  }
  $maxX = [Math]::Max(0, $cw - $sx)
  $maxY = [Math]::Max(0, $ch - $sy)
  $ax = [int][Math]::Max(0, [Math]::Min($maxX, [Math]::Round($anchorX - $sx / 2)))
  $ay = [int][Math]::Max(0, [Math]::Min($maxY, [Math]::Round($anchorY - $sy / 2)))
  $rowsPerCol = [int][Math]::Floor(($ch - $ay) / $sy)
  if ($rowsPerCol -lt 1) { $rowsPerCol = 1 }

  # ---- wait for the new icons to appear (Explorer can take a
  # while, especially after a cross-drive copy) ----
  $itemOfSlot = @{}
  $deadline = (Get-Date).AddSeconds(8)
  do {
    $itemOfSlot = Find-Matches $lv $names
    if ($itemOfSlot.Count -ge $names.Count) { break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)

  if ($itemOfSlot.Count -eq 0) { Out-Result 'no-item' 0 'no matching desktop icon appeared'; exit 0 }

  # ---- place each icon, then READ BACK and retry until it sticks
  # (align-to-grid snaps to the grid: within one spacing is a hit) --
  $verified = 0
  $attempted = 0
  foreach ($entry in $itemOfSlot.GetEnumerator()) {
    $slot = [int]$entry.Key
    $idx = [int]$entry.Value
    $col = [Math]::Floor($slot / $rowsPerCol)
    $row = $slot % $rowsPerCol
    $px = [int][Math]::Max(0, [Math]::Min($maxX, $ax + $col * $sx))
    $py = [int][Math]::Max(0, [Math]::Min($maxY, $ay + $row * $sy))
    $attempted++
    $stuck = $false
    for ($try = 0; $try -lt 3 -and -not $stuck; $try++) {
      $lp = [IntPtr](($py -shl 16) -bor ($px -band 0xFFFF))
      [void][OkibaDesk]::SendMessage($lv, $LVM_SETITEMPOSITION, [IntPtr]$idx, $lp)
      Start-Sleep -Milliseconds 180
      $rx = 0; $ry = 0
      if ([OkibaDesk]::GetItemPosition($lv, $idx, [ref]$rx, [ref]$ry)) {
        if ([Math]::Abs($rx - $px) -le $sx -and [Math]::Abs($ry - $py) -le $sy) {
          $stuck = $true
        }
      }
    }
    if ($stuck) { $verified++ }
  }

  if ($verified -eq 0) {
    Out-Result 'set-unverified' 0 'positions did not stick after retries'
  } elseif ($verified -lt $names.Count) {
    Out-Result 'partial' $verified ''
  } else {
    Out-Result 'ok' $verified ''
  }
} catch {
  Out-Result 'script-error' 0 (Clean-Msg $_.Exception.Message)
}
exit 0
