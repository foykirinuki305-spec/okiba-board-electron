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
# Matching/layout remain identical to the cold script. The warm path
# reuses process buffers, polls at 50ms, and batch-verifies at 40ms
# with the proven sequential 180ms retry for grid-layout conflicts.
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

  // Tell Explorer that the Desktop directory changed. This does not invent
  // per-file shell events and does not force a synchronous Explorer refresh.
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern void SHChangeNotify(uint eventId, uint flags, string path, IntPtr item2);
  public static void NotifyDesktopDirectory() {
    string path = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    if (!String.IsNullOrEmpty(path)) SHChangeNotify(0x00001000, 0x0005 | 0x2000, path, IntPtr.Zero);
  }

  public static void NotifyDesktopItems(string[] names) {
    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    foreach (string name in names) {
      try {
        if (String.IsNullOrEmpty(name) || System.IO.Path.GetFileName(name) != name) continue;
        string item = System.IO.Path.Combine(desktop, name);
        uint evt;
        if (System.IO.Directory.Exists(item)) evt = 0x00000008; // MKDIR
        else if (System.IO.File.Exists(item)) evt = 0x00000002; // CREATE
        else continue;
        // PATHW | FLUSH: notify only an actual existing dropped item. This
        // avoids Explorer's delayed directory-wide refresh/coalescing.
        SHChangeNotify(evt, 0x0005u | 0x1000u, item, IntPtr.Zero);
      } catch {
        // Notifications are advisory. Normal appearance polling still runs.
      }
    }
  }

  [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool MoveFileEx(string source, string destination, uint flags);
  public static int MoveNoReplace(string source, string destination) {
    // Flags zero: never replace an existing path and never emulate a
    // cross-volume move with copy/delete. MoveFileW permits that emulation.
    return MoveFileEx(source, destination, 0) ? 0 : Marshal.GetLastWin32Error();
  }

  public static bool IsSnapToGrid(IntPtr hwnd) {
    // LVM_GETEXTENDEDLISTVIEWSTYLE, LVS_EX_SNAPTOGRID (not GWL_EXSTYLE).
    return (((long)SendMessage(hwnd, LVM_FIRST + 55, IntPtr.Zero, IntPtr.Zero)) & 0x00080000L) != 0;
  }
  public static int[] ReadGridOrigin(Reader reader, int count, int sx, int sy, int[] excluded) {
    var skip = new HashSet<int>(excluded);
    var xs = new Dictionary<int, int>();
    var ys = new Dictionary<int, int>();
    int bestX = 0, bestY = 0, votesX = 0, votesY = 0, sampled = 0;
    // Infer from already settled icons, not the newly arriving target group.
    for (int i = 0; i < count && sampled < 32; i++) {
      if (skip.Contains(i)) continue;
      int[] pos = reader.GetPosition(i);
      if (pos == null || pos[0] < 0 || pos[1] < 0) continue;
      sampled++;
      int x = pos[0] % sx, y = pos[1] % sy, n;
      xs.TryGetValue(x, out n); xs[x] = ++n;
      if (n > votesX) { votesX = n; bestX = x; }
      ys.TryGetValue(y, out n); ys[y] = ++n;
      if (n > votesY) { votesY = n; bestY = y; }
    }
    if (sampled == 0 && excluded.Length > 0)
      return ReadGridOrigin(reader, count, sx, sy, new int[0]);
    return new int[] { bestX, bestY };
  }

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
  // One session per request: reuse the Explorer handle and separate remote
  // buffers across the entire label scan, appear polls and verification.
  // Dispose even on failure; never retain an Explorer handle between requests.
  public sealed class Reader : IDisposable {
    const int MAXCHARS = 260;
    const int ITEMSIZE = 88;
    readonly IntPtr hwnd;
    IntPtr proc, remoteItem, remoteText, remotePoint;
    readonly byte[] data = new byte[ITEMSIZE];
    readonly byte[] textBuf = new byte[MAXCHARS * 2];
    readonly byte[] pointBuf = new byte[8];
    public Reader(IntPtr hwnd) {
      this.hwnd = hwnd;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      proc = OpenProcess(PROCESS_VM, false, pid);
      if (proc == IntPtr.Zero) return;
      try {
        remoteItem = VirtualAllocEx(proc, IntPtr.Zero, ITEMSIZE, MEM_COMMIT_RESERVE, PAGE_RW);
        remoteText = VirtualAllocEx(proc, IntPtr.Zero, MAXCHARS * 2, MEM_COMMIT_RESERVE, PAGE_RW);
        remotePoint = VirtualAllocEx(proc, IntPtr.Zero, 8, MEM_COMMIT_RESERVE, PAGE_RW);
        if (remoteItem == IntPtr.Zero || remoteText == IntPtr.Zero || remotePoint == IntPtr.Zero) {
          Dispose(); return;
        }
        BitConverter.GetBytes((uint)0x0001).CopyTo(data, 0);
        BitConverter.GetBytes(remoteText.ToInt64()).CopyTo(data, 24);
        BitConverter.GetBytes(MAXCHARS).CopyTo(data, 32);
      } catch { Dispose(); throw; }
    }
    public string GetText(int item) {
      if (proc == IntPtr.Zero) return null;
      BitConverter.GetBytes(item).CopyTo(data, 4);
      UIntPtr written, read;
      if (!WriteProcessMemory(proc, remoteItem, data, ITEMSIZE, out written)) return null;
      // Reset the first character so a failed label request cannot reuse a
      // previous item's text. The return value is the actual character count.
      if (!WriteProcessMemory(proc, remoteText, new byte[2], 2, out written)) return null;
      int chars = (int)SendMessage(hwnd, LVM_GETITEMTEXTW, new IntPtr(item), remoteItem);
      if (chars <= 0) return "";
      int bytes = Math.Min(chars, MAXCHARS - 1) * 2;
      if (!ReadProcessMemory(proc, remoteText, textBuf, (uint)bytes, out read)) return null;
      string text = Encoding.Unicode.GetString(textBuf, 0, Math.Min(bytes, (int)read.ToUInt32()));
      int nul = text.IndexOf('\0');
      return nul >= 0 ? text.Substring(0, nul) : text;
    }
    public int[] GetPosition(int item) {
      if (proc == IntPtr.Zero) return null;
      if (SendMessage(hwnd, LVM_GETITEMPOSITION, new IntPtr(item), remotePoint) == IntPtr.Zero) return null;
      UIntPtr read;
      if (!ReadProcessMemory(proc, remotePoint, pointBuf, 8, out read) || read.ToUInt32() != 8) return null;
      return new int[] { BitConverter.ToInt32(pointBuf, 0), BitConverter.ToInt32(pointBuf, 4) };
    }
    public void Dispose() {
      if (proc == IntPtr.Zero) return;
      if (remoteItem != IntPtr.Zero) VirtualFreeEx(proc, remoteItem, 0, MEM_RELEASE);
      if (remoteText != IntPtr.Zero) VirtualFreeEx(proc, remoteText, 0, MEM_RELEASE);
      if (remotePoint != IntPtr.Zero) VirtualFreeEx(proc, remotePoint, 0, MEM_RELEASE);
      CloseHandle(proc);
      proc = remoteItem = remoteText = remotePoint = IntPtr.Zero;
    }
  }
  public static string GetItemText(IntPtr hwnd, int item) {
    using (var reader = new Reader(hwnd)) { return reader.GetText(item); }
  }
  public static int[] GetItemPosition(IntPtr hwnd, int item) {
    using (var reader = new Reader(hwnd)) { return reader.GetPosition(item); }
  }

  public static void SetItemPosition(IntPtr lv, int index, int x, int y) {
    int lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF);
    SendMessage(lv, LVM_SETITEMPOSITION, (IntPtr)index, (IntPtr)lp);
  }
}
'@

# Official Shell FolderView API. Vtable order verified against Microsoft
# win32metadata ShObjIdl_core.h IFolderView/IFolderView2/IShellBrowser.
Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
public static class OkibaFolderView {
 [ComImport,Guid("6d5140c1-7436-11ce-8034-00aa006009fa"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IServiceProvider { [PreserveSig] int QueryService(ref Guid service,ref Guid iid,out IntPtr result); }
 [ComImport,Guid("000214e2-0000-0000-c000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellBrowser {
  [PreserveSig] int GetWindow(out IntPtr hwnd);
  [PreserveSig] int ContextSensitiveHelp(int enter);
  [PreserveSig] int InsertMenusSB(IntPtr menu,IntPtr widths);
  [PreserveSig] int SetMenuSB(IntPtr menu,IntPtr resource,IntPtr active);
  [PreserveSig] int RemoveMenusSB(IntPtr menu);
  [PreserveSig] int SetStatusTextSB(IntPtr text);
  [PreserveSig] int EnableModelessSB(int enable);
  [PreserveSig] int TranslateAcceleratorSB(IntPtr message,ushort id);
  [PreserveSig] int BrowseObject(IntPtr pidl,uint flags);
  [PreserveSig] int GetViewStateStream(uint mode,out IntPtr stream);
  [PreserveSig] int GetControlWindow(uint id,out IntPtr hwnd);
  [PreserveSig] int SendControlMsg(uint id,uint message,IntPtr wp,IntPtr lp,out IntPtr result);
  [PreserveSig] int QueryActiveShellView(out IntPtr view);
 }
 [ComImport,Guid("1af3a467-214f-4298-908e-06b03e0b39f9"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IFolderView2 {
  [PreserveSig] int GetCurrentViewMode(out uint mode);
  [PreserveSig] int SetCurrentViewMode(uint mode);
  [PreserveSig] int GetFolder(ref Guid iid,out IntPtr folder);
  [PreserveSig] int Item(int index,out IntPtr pidl);
  [PreserveSig] int ItemCount(uint flags,out int count);
  [PreserveSig] int Items(uint flags,ref Guid iid,out IntPtr items);
  [PreserveSig] int GetSelectionMarkedItem(out int index);
  [PreserveSig] int GetFocusedItem(out int index);
  [PreserveSig] int GetItemPosition(IntPtr pidl,IntPtr point);
  [PreserveSig] int GetSpacing(IntPtr point);
  [PreserveSig] int GetDefaultSpacing(IntPtr point);
  [PreserveSig] int GetAutoArrange();
  [PreserveSig] int SelectItem(int index,uint flags);
  [PreserveSig] int SelectAndPositionItems(uint count,IntPtr pidls,IntPtr points,uint flags);
  [PreserveSig] int SetGroupBy(IntPtr key,int ascending);
  [PreserveSig] int GetGroupBy(IntPtr key,IntPtr ascending);
  [PreserveSig] int SetViewProperty(IntPtr pidl,IntPtr key,IntPtr value);
  [PreserveSig] int GetViewProperty(IntPtr pidl,IntPtr key,IntPtr value);
  [PreserveSig] int SetTileViewProperties(IntPtr pidl,IntPtr properties);
  [PreserveSig] int SetExtendedTileViewProperties(IntPtr pidl,IntPtr properties);
  [PreserveSig] int SetText(int type,IntPtr text);
  [PreserveSig] int SetCurrentFolderFlags(uint mask,uint flags);
  [PreserveSig] int GetCurrentFolderFlags(out uint flags);
 }
 sealed class Session:IDisposable {
  object windows,dispatch,browser,view;
  public IFolderView2 Folder {get{return (IFolderView2)view;}}
  public Session(){try{
   windows=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9ba05972-f6a8-11cf-a442-00a0c90a8f39")));
   object[] args=new object[]{0,0,8,0,1};
   var mod=new ParameterModifier(5);mod[0]=true;mod[1]=true;mod[3]=true;
   dispatch=windows.GetType().InvokeMember("FindWindowSW",BindingFlags.InvokeMethod,null,windows,args,new ParameterModifier[]{mod},null,null);
   if(dispatch==null)throw new InvalidOperationException("desktop-shell-unavailable");
   Guid service=new Guid("4c96be40-915c-11cf-99d3-00aa004ae837"),iid=typeof(IShellBrowser).GUID;
   IntPtr ptr;
   Marshal.ThrowExceptionForHR(((IServiceProvider)dispatch).QueryService(ref service,ref iid,out ptr));
   try{browser=Marshal.GetObjectForIUnknown(ptr);}finally{Marshal.Release(ptr);}
   Marshal.ThrowExceptionForHR(((IShellBrowser)browser).QueryActiveShellView(out ptr));
   try{view=Marshal.GetObjectForIUnknown(ptr);}finally{Marshal.Release(ptr);}
   IFolderView2 verified=Folder;
  }catch{Dispose();throw;}}
  public void Dispose(){
   if(view!=null&&Marshal.IsComObject(view))Marshal.ReleaseComObject(view);
   if(browser!=null&&Marshal.IsComObject(browser))Marshal.ReleaseComObject(browser);
   if(dispatch!=null&&Marshal.IsComObject(dispatch))Marshal.ReleaseComObject(dispatch);
   if(windows!=null&&Marshal.IsComObject(windows))Marshal.ReleaseComObject(windows);
   view=browser=dispatch=windows=null;
  }
 }
 // [0] FOLDERFLAGS, [1] GetAutoArrange (0=OFF,1=ON).
 public static long[] ReadState(){using(var s=new Session()){
  uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
  int hr=s.Folder.GetAutoArrange();
  if(hr!=0&&hr!=1){Marshal.ThrowExceptionForHR(hr);throw new InvalidOperationException("unknown-autoarrange-state");}
  return new long[]{flags,hr==0?1:0};
 }}
 // Never exposed through the normal helper protocol. Hosted CI only.
 public static void SetFlagsForCI(uint mask,uint flags){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("folder-flags-setter-is-CI-only");
  using(var s=new Session())Marshal.ThrowExceptionForHR(s.Folder.SetCurrentFolderFlags(mask,flags));
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

function Find-Matches([IntPtr]$lv, [string[]]$Names, [int]$count, $reader) {
  $texts = @{}
  for ($i = 0; $i -lt $count; $i++) {
    $t = $reader.GetText($i)
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
# read-back -> retry verification with batched 40ms
# settle and the cold script's <= spacing tolerance. X/Y arrive as SCREEN
# coordinates (exactly what main passes the cold script).
# Icon-appear polling remains immediate first poll, then
# ~50ms (the warm-helper speed point), capped at ~8s like cold.
function Position-Icons([int]$X, [int]$Y, [string[]]$Names) {
  $result = @{ status = 'ok'; positioned = 0; detail = ''; appearMs = 0; workMs = 0 }
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
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

  $reader = New-Object OkibaDesk+Reader -ArgumentList $lv
  try {
    # Wait for the moved icons to appear (first poll immediate,
    # then ~50ms, ~8s cap — cold polls at 200ms to the same cap).
    # Prompt shell directory processing once; the normal poll remains the
    # authority for actual icon availability. Diagnostic opt-out for A/B tests.
    try {
      if ($env:OKIBA_POSITION_NOTIFY -eq 'directory' -or ($Names.Count -gt 3 -and $env:OKIBA_POSITION_NOTIFY -ne '0')) { [OkibaDesk]::NotifyDesktopDirectory() }
      elseif ($env:OKIBA_POSITION_NOTIFY -ne '0') { [OkibaDesk]::NotifyDesktopItems($Names) }
    } catch { } # A failed advisory notification must never prevent polling.
    $found = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ($true) {
      $count = [OkibaDesk]::GetItemCount($lv)
      $found = Find-Matches $lv $Names $count $reader
      if ($found.Slots.Count -ge $Names.Count) { break }
      if ([DateTime]::UtcNow -gt $deadline) { break }
      Start-Sleep -Milliseconds 50
    }
    $result.appearMs = $timer.ElapsedMilliseconds
    $workStart = $timer.ElapsedMilliseconds
    if ($found.Slots.Count -eq 0) {
      $result.status = 'no-item'
      $result.detail = "names=[$($Names -join ', ')] icons=$count texts=[$($found.Texts -join ', ')]"
      return $result
    }

    if ([OkibaDesk]::IsSnapToGrid($lv)) {
      $grid = [OkibaDesk]::ReadGridOrigin($reader, $count, $sx, $sy, [int[]]@($found.Slots.Values))
      $gx = [Math]::Min($maxX, $grid[0])
      $gy = [Math]::Min($maxY, $grid[1])
      $maxX = $gx + [Math]::Floor(($maxX - $gx) / $sx) * $sx
      $maxY = $gy + [Math]::Floor(($maxY - $gy) / $sy) * $sy
      # Explicit floor(+0.5) agrees with JS for both sides of the origin.
      $ax = [int][Math]::Max($gx, [Math]::Min($maxX, $gx + [Math]::Floor(($anchorX - $sx / 2 - $gx) / $sx + 0.5) * $sx))
      $ay = [int][Math]::Max($gy, [Math]::Min($maxY, $gy + [Math]::Floor(($anchorY - $sy / 2 - $gy) / $sy + 0.5) * $sy))
      $rowsPerCol = [int][Math]::Max(1, [Math]::Floor(($maxY - $ay) / $sy) + 1)
    }

    # Batch placement: one settle per pass, not per icon. Retry only
    # mismatches; preserve the proven <= spacing tolerance for grid snapping.
    $pending = @{}
    foreach ($entry in $found.Slots.GetEnumerator()) {
      $slot = [int]$entry.Key
      $col = [Math]::Floor($slot / $rowsPerCol)
      $row = $slot % $rowsPerCol
      $tx = [int][Math]::Max(0, [Math]::Min($maxX, $ax + $col * $sx))
      $ty = [int][Math]::Max(0, [Math]::Min($maxY, $ay + $row * $sy))
      $pending[[int]$entry.Value] = @($tx, $ty)
    }
    $targets = $pending.Clone()
    $verified = 0
    # Fast path: set the whole group and verify once. Explorer's grid layout
    # can move other icons while a large batch is settling; unresolved items
    # use the proven sequential 180ms retry rather than reporting false success.
    foreach ($idx in @($pending.Keys)) {
      $target = $pending[$idx]
      [OkibaDesk]::SetItemPosition($lv, $idx, $target[0], $target[1])
    }
    Start-Sleep -Milliseconds 40
    foreach ($idx in @($pending.Keys)) {
      $target = $pending[$idx]
      $pos = $reader.GetPosition($idx)
      if ($null -ne $pos -and [Math]::Abs($pos[0] - $target[0]) -le $sx -and [Math]::Abs($pos[1] - $target[1]) -le $sy) {
        $verified++
        $pending.Remove($idx)
      }
    }
    foreach ($idx in @($pending.Keys)) {
      $target = $pending[$idx]
      for ($attempt = 0; $attempt -lt 3; $attempt++) {
        [OkibaDesk]::SetItemPosition($lv, $idx, $target[0], $target[1])
        Start-Sleep -Milliseconds 180
        $pos = $reader.GetPosition($idx)
        if ($null -ne $pos -and [Math]::Abs($pos[0] - $target[0]) -le $sx -and [Math]::Abs($pos[1] - $target[1]) -le $sy) {
          $verified++
          $pending.Remove($idx)
          break
        }
      }
    }
    # Later placements can cause Explorer grid layout to move icons that
    # passed an earlier check. Count only a COMPLETE final read-back, never
    # accumulate historical per-item successes. Repair mismatches in bounded
    # rounds, then re-read the whole group after the last repair.
    for ($round = 0; $round -le 3; $round++) {
      # Let Explorer complete late grid alignment before the final snapshot.
      Start-Sleep -Milliseconds 40
      $verified = 0
      $mismatches = @{}
      foreach ($idx in @($targets.Keys)) {
        $target = $targets[$idx]
        $pos = $reader.GetPosition($idx)
        if ($null -ne $pos -and [Math]::Abs($pos[0] - $target[0]) -le $sx -and [Math]::Abs($pos[1] - $target[1]) -le $sy) {
          $verified++
        } else {
          $mismatches[$idx] = $target
        }
      }
      if ($mismatches.Count -eq 0 -or $round -eq 3) { break }
      foreach ($idx in @($mismatches.Keys)) {
        $target = $mismatches[$idx]
        [OkibaDesk]::SetItemPosition($lv, $idx, $target[0], $target[1])
        Start-Sleep -Milliseconds 180
      }
    }
    $result.workMs = $timer.ElapsedMilliseconds - $workStart
    $result.positioned = $verified
    if ($verified -eq 0) {
      $result.status = 'set-unverified'
      $result.detail = 'positions did not stick after retries'
    } elseif ($verified -lt $Names.Count) {
      $result.status = 'partial'
      $details = @()
      foreach ($idx in @($mismatches.Keys)) {
        $target = $mismatches[$idx]
        $pos = $reader.GetPosition($idx)
        $details += "index=$idx target=$($target -join ',') actual=$($pos -join ',')"
      }
      $result.detail = $details -join '; '
    }
    return $result
  } finally { $reader.Dispose() }
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
  $reader = New-Object OkibaDesk+Reader -ArgumentList $lv
  try {
    $count = [OkibaDesk]::GetItemCount($lv)
    $found = Find-Matches $lv $Names $count $reader
    foreach ($k in $found.Slots.Keys) {
      $pos = $reader.GetPosition([int]$found.Slots[$k])
      if ($null -ne $pos) {
        $out.positions[$Names[[int]$k]] = @{ x = [int]$pos[0]; y = [int]$pos[1] }
      }
    }
    return $out
  } finally { $reader.Dispose() }
}

# ---- Strict desktop transactions (no legacy fallback) -----------------
# Only the new transaction commands use these rules. They never set the
# position of an icon belonging to the pre-move snapshot.
Add-Type -AssemblyName System.Windows.Forms
function Get-RawStrictDesktopSnapshot {
  $lv = Find-BestListView
  if ($lv -eq [IntPtr]::Zero) { return @{ok=$false; reason='no-listview'} }
  $reader = New-Object OkibaDesk+Reader -ArgumentList $lv
  try {
    try { $shellState=[OkibaFolderView]::ReadState() } catch { return @{ok=$false;reason='shell-folder-state-unavailable'} }
    $sx = [OkibaDesk]::GetSpacingX($lv); $sy = [OkibaDesk]::GetSpacingY($lv)
    if ($sx -le 0 -or $sy -le 0) { return @{ok=$false;reason='unknown-spacing'} }
    $count = [OkibaDesk]::GetItemCount($lv)
    $icons = New-Object 'System.Collections.Generic.List[object]'
    for ($i=0; $i -lt $count; $i++) {
      $label = $reader.GetText($i); $pos = $reader.GetPosition($i)
      $labelAfter = $reader.GetText($i)
      if ($label -cne $labelAfter) { return @{ok=$false;reason='desktop-changing';detail='index-label-changed'} }
      if ([string]::IsNullOrEmpty($label) -or $null -eq $pos) { return @{ok=$false;reason='unreadable-icon'} }
      $icons.Add(@{label=$label;x=[int]$pos[0];y=[int]$pos[1];index=$i})
    }
    if ([OkibaDesk]::GetItemCount($lv) -ne $count) { return @{ok=$false;reason='desktop-changing'} }
    $grid = [OkibaDesk]::ReadGridOrigin($reader,$count,$sx,$sy,[int[]]@())
    $origin = [OkibaDesk]::ToClient($lv,0,0)
    $areas = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object DeviceName | ForEach-Object {
      $r=$_.WorkingArea
      $tl=[OkibaDesk]::ToClient($lv,$r.Left,$r.Top); $br=[OkibaDesk]::ToClient($lv,$r.Right,$r.Bottom)
      @{left=[int]$tl[0];top=[int]$tl[1];right=[int]$br[0];bottom=[int]$br[1]}
    })
    if ($areas.Count -eq 0) { return @{ok=$false;reason='unknown-monitors'} }
    return @{ok=$true;autoArrange=($shellState[1] -ne 0 -or ($shellState[0] -band 1) -ne 0 -or ([OkibaDesk]::GetWindowLong($lv,-16) -band 0x0100) -ne 0);
      snap=(($shellState[0] -band 4) -ne 0);folderFlags=$shellState[0];shellAutoArrange=($shellState[1] -ne 0);sx=$sx;sy=$sy;gx=$grid[0];gy=$grid[1];
      origin=@{x=$origin[0];y=$origin[1]};areas=$areas;icons=@($icons.ToArray())}
  } finally { $reader.Dispose() }
}
function Strict-IconKey($i) { return (@([string]$i.label,[int]$i.x,[int]$i.y) | ConvertTo-Json -Compress) }
function Strict-GeometryKey($s) {
  $areas=@($s.areas | ForEach-Object { @([int]$_.left,[int]$_.top,[int]$_.right,[int]$_.bottom) })
  return (@([bool]$s.autoArrange,[bool]$s.snap,[int]$s.sx,[int]$s.sy,[int]$s.gx,[int]$s.gy,[int]$s.origin.x,[int]$s.origin.y,$areas) | ConvertTo-Json -Compress -Depth 8)
}
function Strict-IconsKey($s) { return (@($s.icons | ForEach-Object { Strict-IconKey $_ } | Sort-Object) | ConvertTo-Json -Compress) }
function Get-StrictDesktopSnapshot {
  try {
    $a=Get-RawStrictDesktopSnapshot
    if (-not $a.ok) { return $a }
    Start-Sleep -Milliseconds 40
    $b=Get-RawStrictDesktopSnapshot
    if (-not $b.ok) { return $b }
    if ((Strict-GeometryKey $a) -cne (Strict-GeometryKey $b) -or (Strict-IconsKey $a) -cne (Strict-IconsKey $b)) {
      return @{ok=$false;reason='desktop-changing'}
    }
    return $b
  } catch { return @{ok=$false;reason='snapshot-error'} }
}
function Strict-PointValid($p) {
  if ($null -eq $p -or $null -eq $p.x -or $null -eq $p.y) { return $false }
  try { return [double]$p.x -eq [int]$p.x -and [double]$p.y -eq [int]$p.y } catch { return $false }
}
function Strict-PointInside($p,$s) {
  foreach($r in $s.areas) {
    if ($p.x -ge $r.left -and $p.y -ge $r.top -and $p.x+$s.sx -le $r.right -and $p.y+$s.sy -le $r.bottom) { return $true }
  }
  return $false
}
function Strict-Overlap($a,$b,$s) { return [Math]::Abs($a.x-$b.x) -lt ($s.sx-1) -and [Math]::Abs($a.y-$b.y) -lt ($s.sy-1) }
function Strict-Near($a,$b) { return [Math]::Abs($a.x-$b.x) -le 1 -and [Math]::Abs($a.y-$b.y) -le 1 }
function Get-StrictTransactionState($baseline,$current,$targets) {
  if (-not $current.ok -or (Strict-GeometryKey $baseline) -cne (Strict-GeometryKey $current)) { return @{ok=$false;reason='desktop-changed'} }
  $old=New-Object 'System.Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal)
  foreach($i in $baseline.icons) { $k=Strict-IconKey $i; if($old.ContainsKey($k)){$old[$k]++}else{$old[$k]=1} }
  $extra=New-Object 'System.Collections.Generic.List[object]'
  foreach($i in $current.icons) {
    $k=Strict-IconKey $i
    if($old.ContainsKey($k) -and $old[$k] -gt 0){$old[$k]--}else{$extra.Add($i)}
  }
  foreach($key in $old.Keys){if($old[$key] -ne 0){
    $missing=$key | ConvertFrom-Json
    $actual=@($current.icons | Where-Object {$_.label -ceq [string]$missing[0]} | ForEach-Object {@{x=$_.x;y=$_.y}})
    return @{ok=$false;reason='existing-icon-changed';changed=@{label=$missing[0];before=@{x=$missing[1];y=$missing[2]};after=$actual}}
  }}
  $new=@{}
  foreach($i in $extra) {
    $matches=@()
    for($n=0;$n -lt $targets.Count;$n++) {
      $name=[string]$targets[$n].name; $stem=[IO.Path]::GetFileNameWithoutExtension($name)
      if($i.label -ceq $name -or ($stem -and $i.label -ceq $stem)){$matches+= $n}
    }
    if($matches.Count -ne 1 -or $new.ContainsKey([int]$matches[0])) {return @{ok=$false;reason='ambiguous-new-icon'}}
    $new[[int]$matches[0]]=$i
  }
  return @{ok=$true;new=$new;current=$current}
}
function Position-DesktopPlan($baseline,$targets,$buffer) {
  $operation=[System.Diagnostics.Stopwatch]::StartNew()
  $targets=@($targets)
  if(-not $baseline.ok -or $baseline.autoArrange -or -not $baseline.snap -or $targets.Count -eq 0 -or -not (Strict-PointValid $buffer)) {return @{ok=$false;reason='invalid-plan'}}
  $all=@($targets)+@($buffer)
  for($n=0;$n -lt $all.Count;$n++) {
    $p=$all[$n]
    if(-not (Strict-PointValid $p) -or -not (Strict-PointInside $p $baseline)) {return @{ok=$false;reason='outside-desktop'}}
    if((($p.x-$baseline.gx)%$baseline.sx) -ne 0 -or (($p.y-$baseline.gy)%$baseline.sy) -ne 0) {return @{ok=$false;reason='off-grid'}}
    foreach($old in $baseline.icons){if(Strict-Overlap $p $old $baseline){return @{ok=$false;reason='occupied'}}}
    for($j=0;$j -lt $n;$j++){if(Strict-Overlap $p $all[$j] $baseline){return @{ok=$false;reason='overlapping-plan'}}}
  }
  for($n=0;$n -lt $targets.Count;$n++) {
    $name=[string]$targets[$n].name
    if([string]::IsNullOrEmpty($name) -or [IO.Path]::GetFileName($name) -cne $name) {return @{ok=$false;reason='invalid-name'}}
    try {
      $dest=[IO.Path]::GetFullPath([string]$targets[$n].path)
      $desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory')).TrimEnd('\')
      if([IO.Path]::GetDirectoryName($dest).TrimEnd('\') -ine $desktop -or [IO.Path]::GetFileName($dest) -cne $name -or -not (Test-Path -LiteralPath $dest)) {return @{ok=$false;reason='invalid-destination'}}
    } catch {return @{ok=$false;reason='invalid-destination'}}
    $stem=[IO.Path]::GetFileNameWithoutExtension($name)
    foreach($old in $baseline.icons){if($old.label -ieq $name -or $old.label -ieq $stem){return @{ok=$false;reason='ambiguous-name'}}}
    for($j=0;$j -lt $n;$j++){if($targets[$j].name -ieq $name){return @{ok=$false;reason='duplicate-name'}}}
  }
  try {
    # Do not force a shell refresh that might rearrange existing icons.
    $deadline=[DateTime]::UtcNow.AddSeconds(8)
    do {
      $current=Get-StrictDesktopSnapshot
      if(-not $current.ok -and $current.reason -eq 'desktop-changing') {
        Start-Sleep -Milliseconds 50
        continue
      }
      $state=Get-StrictTransactionState $baseline $current $targets
      if(-not $state.ok){$state.phase='arrival';return $state}
      if($state.new.Count -eq $targets.Count){break}
      Start-Sleep -Milliseconds 50
    } while([DateTime]::UtcNow -lt $deadline)
    if($state.new.Count -ne $targets.Count){return @{ok=$false;reason='new-icons-not-ready'}}
    if($null -eq $state -or -not $state.ok){return @{ok=$false;reason='desktop-changing'}}
    $maxSteps=$targets.Count*3+3
    for($step=0;$step -lt $maxSteps;$step++) {
      if($operation.ElapsedMilliseconds -ge 50000){return @{ok=$false;reason='position-deadline'}}
      $unfinished=@(0..($targets.Count-1) | Where-Object {-not (Strict-Near $state.new[$_] $targets[$_])})
      if($unfinished.Count -eq 0) {
        Start-Sleep -Milliseconds 180
        $last=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets
        if(-not $last.ok){$last.phase='final';return $last}
        if($last.new.Count -ne $targets.Count){return @{ok=$false;reason='desktop-changed';phase='final'}}
        foreach($n in 0..($targets.Count-1)){if(-not (Strict-Near $last.new[$n] $targets[$n])){return @{ok=$false;reason='late-position-change'}}}
        return @{ok=$true;positioned=$targets.Count;reason=''}
      }
      $chosen=-1; $destination=$null
      foreach($n in $unfinished) {
        $free=$true
        foreach($k in $state.new.Keys){if($k -ne $n -and (Strict-Overlap $targets[$n] $state.new[$k] $baseline)){$free=$false;break}}
        if($free){$chosen=$n;$destination=$targets[$n];break}
      }
      if($chosen -lt 0) {
        foreach($k in $state.new.Keys){if(Strict-Overlap $buffer $state.new[$k] $baseline){return @{ok=$false;reason='buffer-occupied'}}}
        $chosen=[int]$unfinished[0];$destination=$buffer
      }
      # Revalidate immediately before each write, including every new icon's
      # exact current location. A user move aborts, it is never overwritten.
      $fresh=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets
      if(-not $fresh.ok){$fresh.phase='before-set';return $fresh}
      if($fresh.new.Count -ne $targets.Count){return @{ok=$false;reason='desktop-changed';phase='before-set'}}
      foreach($k in $state.new.Keys){if(-not (Strict-Near $fresh.new[$k] $state.new[$k])){return @{ok=$false;reason='new-icon-changed'}}}
      $lv=Find-BestListView
      if($lv -eq [IntPtr]::Zero){return @{ok=$false;reason='no-listview'}}
      $guard=New-Object OkibaDesk+Reader -ArgumentList $lv
      try {
        $index=[int]$fresh.new[$chosen].index
        $label=$guard.GetText($index);$pos=$guard.GetPosition($index)
        if([OkibaDesk]::GetItemCount($lv) -ne @($fresh.current.icons).Count -or $label -cne $fresh.new[$chosen].label -or $null -eq $pos -or $pos[0] -ne $fresh.new[$chosen].x -or $pos[1] -ne $fresh.new[$chosen].y) {return @{ok=$false;reason='desktop-changed-before-write'}}
        if($operation.ElapsedMilliseconds -ge 50000){return @{ok=$false;reason='position-deadline'}}
        [OkibaDesk]::SetItemPosition($lv,$index,[int]$destination.x,[int]$destination.y)
      } finally {$guard.Dispose()}
      Start-Sleep -Milliseconds 180
      $after=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets
      if(-not $after.ok){$after.phase='after-set';$after.movedName=$targets[$chosen].name;return $after}
      if($after.new.Count -ne $targets.Count){return @{ok=$false;reason='desktop-changed';phase='after-set'}}
      if(-not (Strict-Near $after.new[$chosen] $destination)){return @{ok=$false;reason='position-unverified'}}
      foreach($k in $fresh.new.Keys){if($k -ne $chosen -and -not (Strict-Near $fresh.new[$k] $after.new[$k])){return @{ok=$false;reason='other-new-icon-changed'}}}
      $state=$after
    }
    return @{ok=$false;reason='position-step-limit'}
  } catch { return @{ok=$false;reason='position-error'} }
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
      'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot }
      'moveNoReplace'        {
        $code=[OkibaDesk]::MoveNoReplace([string]$req.source,[string]$req.destination)
        $result=@{ok=($code -eq 0);errorCode=$code;reason=$(if($code -eq 0){''}else{'move-no-replace-failed'})}
      }
      'positionDesktopPlan' { $result = Position-DesktopPlan $req.snapshot @($req.targets) $req.buffer }
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
