# OkibaBoard drag-out: place freshly dropped desktop icons at the
# drop point.
# Args: <x> <y> <fileName1> [fileName2 ...]
#   x, y     = screen coordinates where the user released the drag
#   fileName = display names of the files that were just MOVED into
#              the Desktop folder (destination names, after any
#              " (2)" disambiguation)
# Prints ONE JSON line:
#   {"status":"ok"|"partial"|"autoarrange"|"notfound"|"failed",
#    "positioned":<n>}
# Best-effort by design: anything unexpected -> "failed", exit 0.
# The move itself already happened; this script never touches files.
param(
  [int]$X,
  [int]$Y,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Names
)

$ErrorActionPreference = 'Stop'
function Out-Result($status, $positioned) {
  $obj = @{ status = $status; positioned = $positioned }
  Write-Output ($obj | ConvertTo-Json -Compress)
}

try {
  $names = @($Names | Where-Object { $_ -and $_.Trim() -ne '' })
  if ($names.Count -eq 0) { Out-Result 'failed' 0; exit 0 }

  Add-Type -TypeDefinition @'
using System;
using System.Text;
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
  // by a WorkerW window instead — search both, like the shell does.
  public static IntPtr FindDesktopListView() {
    IntPtr lv = FromDefView(FindWindow("Progman", null));
    if (lv != IntPtr.Zero) return lv;
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, lp) => {
      var sb = new StringBuilder(64);
      GetClassName(hwnd, sb, 64);
      if (sb.ToString() == "WorkerW") {
        IntPtr v = FromDefView(hwnd);
        if (v != IntPtr.Zero) { found = v; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  const int LVM_FIRST = 0x1000;
  const int LVM_GETITEMTEXTW = LVM_FIRST + 115;
  const uint PROCESS_VM = 0x0400 | 0x0008 | 0x0010 | 0x0020; // QUERY_INFO|VM_OPERATION|VM_READ|VM_WRITE
  const uint MEM_COMMIT_RESERVE = 0x1000 | 0x2000;
  const uint MEM_RELEASE = 0x8000;
  const uint PAGE_RW = 0x04;

  // Read the text of one listview item in the explorer process.
  // Classic cross-process technique: stage an LVITEM (plus its text
  // buffer) in the owner process with VirtualAllocEx, let
  // LVM_GETITEMTEXTW fill it, read the text back.
  // LVITEMW (x64) byte offsets: mask@0, iItem@8, iSubItem@12,
  // state@16, stateMask@20, pszText@24, cchTextMax@32, iImage@36.
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
      BitConverter.GetBytes(item).CopyTo(data, 8);                    // iItem
      BitConverter.GetBytes((int)0).CopyTo(data, 12);                 // iSubItem
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
}
'@

  # ---- find the desktop listview ----
  $lv = [OkibaDesk]::FindDesktopListView()
  if ($lv -eq [IntPtr]::Zero) { Out-Result 'failed' 0; exit 0 }

  # ---- auto-arrange? positions will not stick; say so and stop ----
  $GWL_STYLE = -16
  $LVS_AUTOARRANGE = 0x1000
  $style = [OkibaDesk]::GetWindowLong($lv, $GWL_STYLE)
  if (($style -band $LVS_AUTOARRANGE) -ne 0) { Out-Result 'autoarrange' 0; exit 0 }

  # ---- live metrics ----
  $LVM_GETITEMCOUNT = 0x1004
  $LVM_GETITEMSPACING = 0x1033
  $LVM_SETITEMPOSITION = 0x100F
  $spRet = [OkibaDesk]::SendMessage($lv, $LVM_GETITEMSPACING, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
  $sx = [int]($spRet -band 0xFFFF)
  $sy = [int](($spRet -shr 16) -band 0xFFFF)
  if ($sx -le 0) { $sx = 100 }
  if ($sy -le 0) { $sy = 100 }

  $rect = New-Object OkibaDesk+RECT
  [void][OkibaDesk]::GetClientRect($lv, [ref]$rect)
  $cw = $rect.Right - $rect.Left
  $ch = $rect.Bottom - $rect.Top
  if ($cw -le 0 -or $ch -le 0) { Out-Result 'failed' 0; exit 0 }

  # ---- layout (same rule as lib/iconpos.js layoutIconPositions) ----
  $pt = New-Object OkibaDesk+POINT
  $pt.X = $X; $pt.Y = $Y
  [void][OkibaDesk]::ScreenToClient($lv, [ref]$pt)
  $maxX = [Math]::Max(0, $cw - $sx)
  $maxY = [Math]::Max(0, $ch - $sy)
  $ax = [int][Math]::Max(0, [Math]::Min($maxX, [Math]::Round($pt.X - $sx / 2)))
  $ay = [int][Math]::Max(0, [Math]::Min($maxY, [Math]::Round($pt.Y - $sy / 2)))
  $rowsPerCol = [int][Math]::Floor(($ch - $ay) / $sy)
  if ($rowsPerCol -lt 1) { $rowsPerCol = 1 }

  # ---- wait for the new icons to appear, matching by item text ----
  # Desktop items may show the name without its extension, so each
  # name matches its full form first, then the extension-less form.
  $slotOfItem = @{}   # listview index -> slot (index into $names)
  $itemOfSlot = @{}   # slot -> listview index
  $deadline = (Get-Date).AddSeconds(3)
  do {
    $count = [OkibaDesk]::SendMessage($lv, $LVM_GETITEMCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    for ($i = 0; $i -lt $count; $i++) {
      if ($slotOfItem.ContainsKey($i)) { continue }
      $text = [OkibaDesk]::GetItemText($lv, $i)
      if ($null -eq $text) { continue }
      for ($s = 0; $s -lt $names.Count; $s++) {
        if ($itemOfSlot.ContainsKey($s)) { continue }
        $noExt = [System.IO.Path]::GetFileNameWithoutExtension($names[$s])
        if ($text -eq $names[$s] -or ($noExt -and $text -eq $noExt)) {
          $slotOfItem[$i] = $s
          $itemOfSlot[$s] = $i
          break
        }
      }
    }
    if ($itemOfSlot.Count -ge $names.Count) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)

  # ---- place the icons that were found ----
  # LVM_SETITEMPOSITION takes the coordinates directly in lParam
  # (x in the low word, y in the high word) — no struct needed.
  $positioned = 0
  foreach ($entry in $itemOfSlot.GetEnumerator()) {
    $slot = [int]$entry.Key
    $idx = [int]$entry.Value
    $col = [Math]::Floor($slot / $rowsPerCol)
    $row = $slot % $rowsPerCol
    $px = [int][Math]::Max(0, [Math]::Min($maxX, $ax + $col * $sx))
    $py = [int][Math]::Max(0, [Math]::Min($maxY, $ay + $row * $sy))
    $lp = [IntPtr](($py -shl 16) -bor ($px -band 0xFFFF))
    [void][OkibaDesk]::SendMessage($lv, $LVM_SETITEMPOSITION, [IntPtr]$idx, $lp)
    $positioned++
  }

  if ($positioned -eq 0) { Out-Result 'notfound' 0 }
  elseif ($positioned -lt $names.Count) { Out-Result 'partial' $positioned }
  else { Out-Result 'ok' $positioned }
} catch {
  Out-Result 'failed' 0
}
exit 0
