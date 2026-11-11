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
public static class OkibaLeaseOwner {
 public sealed class Status { public bool ok; public string state; public int pid; public string started; public string error; }
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint low,high;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out FT creation,out FT exit,out FT kernel,out FT user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static IntPtr handle=IntPtr.Zero; static int ownerPid; static string birth; static string terminal;
 static Status Result(string state,string error=null){return new Status{ok=state!="unknown",state=state,pid=ownerPid,started=birth,error=error};}
 public static void Release(){if(handle!=IntPtr.Zero)CloseHandle(handle);handle=IntPtr.Zero;terminal=null;ownerPid=0;birth=null;}
 public static Status Pin(int pid,string expectedStarted){
  if(pid<=0)return new Status{ok=false,state="unknown",error="invalid-pid"};
  Release();ownerPid=pid;birth=expectedStarted;
  IntPtr h=OpenProcess(0x00101000,false,pid);
  if(h==IntPtr.Zero){int e=Marshal.GetLastWin32Error();if(e==87&&!String.IsNullOrEmpty(expectedStarted)){terminal="exited";return Result("exited");}return Result("unknown","OpenProcess:"+e);}
  FT c,e1,k,u;if(!GetProcessTimes(h,out c,out e1,out k,out u)){int e=Marshal.GetLastWin32Error();CloseHandle(h);return Result("unknown","GetProcessTimes:"+e);}
  long fileTime=((long)c.high<<32)|c.low;string actual=DateTime.FromFileTimeUtc(fileTime).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
  if(!String.IsNullOrEmpty(expectedStarted)&&actual!=expectedStarted){CloseHandle(h);terminal="exited";return Result("exited");}
  birth=actual;handle=h;return Read();
 }
 public static Status Read(){
  if(terminal=="exited")return Result("exited");
  if(handle==IntPtr.Zero)return Result("unknown","owner-not-pinned");
  uint w=WaitForSingleObject(handle,0);if(w==0){terminal="exited";return Result("exited");}if(w==258)return Result("alive");return Result("unknown","WaitForSingleObject:"+Marshal.GetLastWin32Error());
 }
}
'@

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
// Handle-bound attribute operations. The app has not enabled these commands yet.
public static class OkibaFileAttributes {
 [StructLayout(LayoutKind.Sequential)] struct FileTime {public uint low,high;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint attributes;public FileTime created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long created,accessed,written,changed;public uint attributes;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int type,ref Basic info,uint size);
 [DllImport("shell32.dll",EntryPoint="SHChangeNotify",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern void NotifyAttributes(uint eventId,uint flags,string path,IntPtr second);
 public sealed class Snapshot {public string identity,size,mtime;public bool hidden;public uint attributes;public bool directory;}
 static string CheckPath(string path) {
  path=Path.GetFullPath(path);
  if(path.StartsWith(@"\\",StringComparison.Ordinal))throw new InvalidOperationException("unsupported-network-path");
  string component=path;
  while(!String.IsNullOrEmpty(component)){
   var attrs=File.GetAttributes(component);
   if((attrs&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("reparse-path");
   var parent=Path.GetDirectoryName(component);
   if(parent==component)break;component=parent;
  }
  return path;
 }
 static SafeFileHandle Open(string path,bool write){
  // READ_DATA / LIST_DIRECTORY access makes Windows enforce sharing (attributes-only handles do not).
  // No file content is read. No FILE_SHARE_DELETE: replacement is blocked while the handle lives.
  var h=CreateFile(path,write?0x181u:0x81u,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}
  return h;
 }
 static Snapshot Capture(SafeFileHandle h){
  Info info;if(!GetFileInformationByHandle(h,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
  if((info.attributes&0x400)!=0)throw new InvalidOperationException("reparse-path");
  return new Snapshot{identity=info.volume.ToString("X8")+":"+info.indexHigh.ToString("X8")+info.indexLow.ToString("X8"),size=(((ulong)info.sizeHigh<<32)|info.sizeLow).ToString(System.Globalization.CultureInfo.InvariantCulture),mtime=(((ulong)info.written.high<<32)|info.written.low).ToString(System.Globalization.CultureInfo.InvariantCulture),hidden=(info.attributes&2)!=0,attributes=info.attributes,directory=(info.attributes&16)!=0};
 }
 public static Snapshot Read(string path){path=CheckPath(path);using(var h=Open(path,false))return Capture(h);}
 public static Snapshot Set(string path,string expectedIdentity,bool expectedHidden,bool hidden){return SetRecorded(path,expectedIdentity,expectedHidden,hidden,null,null,0);}
 public static Snapshot SetRecorded(string path,string expectedIdentity,bool expectedHidden,bool hidden,string expectedSize,string expectedMtime,uint expectedOtherAttributes){return SetRecordedCore(path,expectedIdentity,expectedHidden,hidden,expectedSize,expectedMtime,expectedOtherAttributes,false);}
 public static Snapshot SetRecordedAndNotify(string path,string expectedIdentity,bool expectedHidden,bool hidden,string expectedSize,string expectedMtime,uint expectedOtherAttributes){return SetRecordedCore(path,expectedIdentity,expectedHidden,hidden,expectedSize,expectedMtime,expectedOtherAttributes,true);}
 static Snapshot SetRecordedCore(string path,string expectedIdentity,bool expectedHidden,bool hidden,string expectedSize,string expectedMtime,uint expectedOtherAttributes,bool notify){
  path=CheckPath(path);using(var h=Open(path,true)){
   var before=Capture(h);
   if(String.IsNullOrEmpty(expectedIdentity)||!String.Equals(before.identity,expectedIdentity,StringComparison.Ordinal))throw new InvalidOperationException("file-identity-changed");
   if(before.hidden!=expectedHidden)throw new InvalidOperationException("hidden-state-changed");
   // NORMAL is a placeholder for no substantive attributes; Hidden-only -> NORMAL is legal.
   if(expectedSize!=null&&(before.size!=expectedSize||before.mtime!=expectedMtime||(before.attributes&~130u)!=(expectedOtherAttributes&~130u)))throw new InvalidOperationException("file-metadata-changed");
   uint desired=hidden?(before.attributes|2u):(before.attributes&~2u);
   // NORMAL is valid only by itself; all substantive flags are retained.
   if((desired&~128u)!=0)desired&=~128u;else desired=128u;
   if(before.hidden!=hidden){
    var basic=new Basic{attributes=desired};
    // Zero time fields mean do not change file timestamps.
    if(!SetFileInformationByHandle(h,0,ref basic,(uint)Marshal.SizeOf(typeof(Basic))))throw new Win32Exception(Marshal.GetLastWin32Error());
   }
   var after=Capture(h);
   if(after.identity!=before.identity||after.hidden!=hidden||((after.attributes^before.attributes)&~130u)!=0)throw new InvalidOperationException("attribute-verification-failed");
   // Truthful attribute event only after a real, verified mutation. No Refresh or fake delete.
   // Keep the identity handle open through notification so the path cannot be replaced here.
   if(notify&&before.hidden!=after.hidden)NotifyAttributes(0x800u,0x1005u,path,IntPtr.Zero);
   return after;
  }
 }
}
'@

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OkibaWin32 {
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static IntPtr EnterPhysicalScope() {
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    if(previous==IntPtr.Zero)throw new InvalidOperationException("physical-dpi-context-unavailable");
    return previous;
  }
  public static void LeavePhysicalScope(IntPtr previous) {
    if(previous!=IntPtr.Zero && SetThreadDpiAwarenessContext(previous)==IntPtr.Zero)
      throw new InvalidOperationException("dpi-context-restore-failed");
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO {public int cbSize;public RECT monitor,work;public uint flags;}
  delegate bool MonitorProc(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorProc callback,IntPtr data);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
  [DllImport("shcore.dll")] static extern int GetScaleFactorForMonitor(IntPtr monitor,out int scale);
  public static int[][] MonitorAreas() {
    var rows=new System.Collections.Generic.List<int[]>(); bool valid=true;
    MonitorProc callback=delegate(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data){
      MONITORINFO info=new MONITORINFO();info.cbSize=Marshal.SizeOf(typeof(MONITORINFO));
      if(!GetMonitorInfo(monitor,ref info)){valid=false;return false;}
      int scale;if(GetScaleFactorForMonitor(monitor,out scale)!=0)scale=0;
      rows.Add(new int[]{info.work.Left,info.work.Top,info.work.Right,info.work.Bottom,info.monitor.Left,info.monitor.Top,scale});return true;
    };
    if(!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero)||!valid)throw new InvalidOperationException("monitor-geometry-unavailable");
    rows.Sort(delegate(int[]a,int[]b){int c=a[0].CompareTo(b[0]);return c!=0?c:a[1].CompareTo(b[1]);});
    return rows.ToArray();
  }

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
  public static extern bool GetPhysicalCursorPos(out POINT pt);

  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);

  public static int[] CursorState() {
    POINT pt;
    if (!GetPhysicalCursorPos(out pt)) return null;
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
 [ComImport,Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellItem {
  [PreserveSig] int BindToHandler(IntPtr context,ref Guid handler,ref Guid iid,out IntPtr result);
  [PreserveSig] int GetParent(out IntPtr parent);
  [PreserveSig] int GetDisplayName(uint type,out IntPtr name);
  [PreserveSig] int GetAttributes(uint mask,out uint attributes);
  [PreserveSig] int Compare(IntPtr other,uint hint,out int order);
 }
 [DllImport("shell32.dll",PreserveSig=true)]
 static extern int SHCreateItemWithParent(IntPtr parentPidl,IntPtr parentFolder,IntPtr child,ref Guid iid,out IntPtr item);
 static string GetItemFilePath(IFolderView2 view,IntPtr child) {
  Guid folderId=new Guid("000214e6-0000-0000-c000-000000000046"),itemId=typeof(IShellItem).GUID;
  IntPtr folder=IntPtr.Zero,item=IntPtr.Zero,name=IntPtr.Zero;
  object obj=null;
  try {
   Marshal.ThrowExceptionForHR(view.GetFolder(ref folderId,out folder));
   Marshal.ThrowExceptionForHR(SHCreateItemWithParent(IntPtr.Zero,folder,child,ref itemId,out item));
   obj=Marshal.GetObjectForIUnknown(item);
   Marshal.ThrowExceptionForHR(((IShellItem)obj).GetDisplayName(0x80058000,out name)); // SIGDN_FILESYSPATH
   return Marshal.PtrToStringUni(name);
  } finally {
   if(name!=IntPtr.Zero)Marshal.FreeCoTaskMem(name);
   if(obj!=null&&Marshal.IsComObject(obj))Marshal.ReleaseComObject(obj);
   if(item!=IntPtr.Zero)Marshal.Release(item);
   if(folder!=IntPtr.Zero)Marshal.Release(folder);
  }
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
// Strict snapshots use Shell PIDL identities, never label-only fallback.
 [ComImport,Guid("000214f2-0000-0000-c000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IEnumIDListRead {
  [PreserveSig] int Next(uint count,IntPtr array,out uint fetched);
  [PreserveSig] int Skip(uint count);
  [PreserveSig] int Reset();
  [PreserveSig] int Clone(out IntPtr copy);
 }
 [DllImport("shell32.dll")] static extern uint ILGetSize(IntPtr pidl);
 static readonly System.Collections.Generic.Dictionary<string,string> ReadNameCache=new System.Collections.Generic.Dictionary<string,string>(StringComparer.Ordinal);
 static readonly System.Collections.Generic.Dictionary<string,string> ReadPathCache=new System.Collections.Generic.Dictionary<string,string>(StringComparer.Ordinal);
 static string ReadCacheGeneration=null;
 public static void ClearReadNameCache(){ReadNameCache.Clear();ReadPathCache.Clear();}
 public sealed class ShellReadRow {public string label;public int x;public int y;public string identity;public string path;public int index;}
 static string PidlKey(IntPtr p){uint size=ILGetSize(p);if(size<2||size>65536)throw new InvalidOperationException("bad-pidl-size");byte[] bytes=new byte[size];Marshal.Copy(p,bytes,0,(int)size);return Convert.ToBase64String(bytes);}
 // Only two successful ALLVIEW count observations can prove an empty view.
 public static bool VerifyEmptyCounts(int firstHr,int firstCount,int secondHr,int secondCount){
  if(firstHr!=0){Marshal.ThrowExceptionForHR(firstHr);throw new InvalidOperationException("item-count-not-s-ok");}
  if(firstCount<0)throw new InvalidOperationException("bad-item-count");
  if(firstCount!=0)return false;
  if(secondHr!=0){Marshal.ThrowExceptionForHR(secondHr);throw new InvalidOperationException("item-count-not-s-ok");}
  if(secondCount!=0)throw new InvalidOperationException("item-count-changed");
  return true;
 }
 // Only this known missing-enumerator HRESULT can use independent empty proof.
 public static bool ResolveEmptyItems(int itemsHr,IntPtr ptr,Func<int[]> readCount){
  if(itemsHr==0){if(ptr==IntPtr.Zero)throw new InvalidOperationException("missing-items-enumerator");return false;}
  Exception original=Marshal.GetExceptionForHR(itemsHr)??new InvalidOperationException("items-not-s-ok");
  if(itemsHr==unchecked((int)0x80070490)&&ptr==IntPtr.Zero){
   try{
    int[] first=readCount();
    if(first==null||first.Length!=2)throw new InvalidOperationException("bad-count-proof");
    original.Data["firstCountHr"]=first[0];original.Data["firstCount"]=first[1];
    if(first[0]==0&&first[1]==0){
     int[] second=readCount();
     if(second==null||second.Length!=2)throw new InvalidOperationException("bad-count-proof");
     original.Data["secondCountHr"]=second[0];original.Data["secondCount"]=second[1];
     if(second[0]==0&&second[1]==0)return true;
    }
   }catch(Exception detail){original.Data["countProofError"]=detail.Message;}
  }
  throw original;
 }
 static IntPtr[] EnumerateRead(IFolderView2 view){
  Guid iid=typeof(IEnumIDListRead).GUID;IntPtr ptr=IntPtr.Zero,array=IntPtr.Zero;object obj=null;
  var result=new System.Collections.Generic.List<IntPtr>();
  try {
   int itemsHr=view.Items(0x80000002u,ref iid,out ptr);
   if(ResolveEmptyItems(itemsHr,ptr,delegate(){int count;int hr=view.ItemCount(2u,out count);return new int[]{hr,count};}))return new IntPtr[0];
   obj=Marshal.GetObjectForIUnknown(ptr);array=Marshal.AllocCoTaskMem(256*IntPtr.Size);
   while(true){uint fetched;int hr=((IEnumIDListRead)obj).Next(256,array,out fetched);Marshal.ThrowExceptionForHR(hr);if(fetched>256)throw new InvalidOperationException("bad-enum-count");for(int i=0;i<fetched;i++)result.Add(Marshal.ReadIntPtr(array,i*IntPtr.Size));if(result.Count>10000)throw new InvalidOperationException("too-many-items");if(hr==1||fetched==0)break;}
   return result.ToArray();
  }catch{foreach(var p in result)Marshal.FreeCoTaskMem(p);throw;}
  finally{if(array!=IntPtr.Zero)Marshal.FreeCoTaskMem(array);if(obj!=null&&Marshal.IsComObject(obj))Marshal.ReleaseComObject(obj);if(ptr!=IntPtr.Zero)Marshal.Release(ptr);}
 }
 static IntPtr FindChildByIdentity(IFolderView2 view,string identity){
  IntPtr[] children=EnumerateRead(view);IntPtr found=IntPtr.Zero;
  try {
   foreach(var child in children)if(String.Equals(PidlKey(child),identity,StringComparison.Ordinal)){
    if(found!=IntPtr.Zero)throw new InvalidOperationException("duplicate-shell-identity");found=child;
   }
   if(found==IntPtr.Zero)throw new InvalidOperationException("shell-item-identity-missing");
   return found;
  }catch{found=IntPtr.Zero;throw;}
  finally{foreach(var child in children)if(child!=found)Marshal.FreeCoTaskMem(child);}
 }
 public static int[] ReadIdentityPosition(string identity){
  using(var s=new Session()){
   IntPtr child=IntPtr.Zero,point=IntPtr.Zero;
   try{child=FindChildByIdentity(s.Folder,identity);point=Marshal.AllocCoTaskMem(8);Marshal.ThrowExceptionForHR(s.Folder.GetItemPosition(child,point));return new int[]{Marshal.ReadInt32(point,0),Marshal.ReadInt32(point,4)};}
   finally{if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);if(child!=IntPtr.Zero)Marshal.FreeCoTaskMem(child);}
  }
 }
 static string ReadDisplayLabel(IFolderView2 view,IntPtr child){
  Guid fid=new Guid("000214e6-0000-0000-c000-000000000046"),iid=typeof(IShellItem).GUID;IntPtr folder=IntPtr.Zero,item=IntPtr.Zero,name=IntPtr.Zero;object obj=null;
  try{Marshal.ThrowExceptionForHR(view.GetFolder(ref fid,out folder));Marshal.ThrowExceptionForHR(SHCreateItemWithParent(IntPtr.Zero,folder,child,ref iid,out item));obj=Marshal.GetObjectForIUnknown(item);Marshal.ThrowExceptionForHR(((IShellItem)obj).GetDisplayName(0,out name));return Marshal.PtrToStringUni(name);}
  finally{if(name!=IntPtr.Zero)Marshal.FreeCoTaskMem(name);if(obj!=null&&Marshal.IsComObject(obj))Marshal.ReleaseComObject(obj);if(item!=IntPtr.Zero)Marshal.Release(item);if(folder!=IntPtr.Zero)Marshal.Release(folder);}
 }
 public static ShellReadRow[] ReadShellBatch(string generation=""){
  // Explorer/view restart and display-name preference changes invalidate names.
  string context=generation+"|"+Convert.ToString(Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced","HideFileExt",null));
  if(!String.Equals(context,ReadCacheGeneration,StringComparison.Ordinal)){ClearReadNameCache();ReadCacheGeneration=context;}
  using(var s=new Session()){
   IntPtr[] first=null,second=null;IntPtr point=IntPtr.Zero;
   try {
    first=EnumerateRead(s.Folder);var seen=new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);var rows=new ShellReadRow[first.Length];point=Marshal.AllocCoTaskMem(8);
    for(int i=0;i<first.Length;i++){
     string key=PidlKey(first[i]),label; if(!seen.Add(key))throw new InvalidOperationException("duplicate-shell-identity");
     if(!ReadNameCache.TryGetValue(key,out label)){label=ReadDisplayLabel(s.Folder,first[i]);if(String.IsNullOrEmpty(label))throw new InvalidOperationException("empty-label");string filePath=null;try{filePath=GetItemFilePath(s.Folder,first[i]);}catch(COMException){}catch(ArgumentException){} ReadPathCache[key]=filePath;ReadNameCache[key]=label;}
     Marshal.ThrowExceptionForHR(s.Folder.GetItemPosition(first[i],point));rows[i]=new ShellReadRow{identity=key,label=label,path=ReadPathCache[key],index=i,x=Marshal.ReadInt32(point,0),y=Marshal.ReadInt32(point,4)};
    }
    second=EnumerateRead(s.Folder);if(first.Length!=second.Length)throw new InvalidOperationException("item-count-changed");
    for(int i=0;i<second.Length;i++)if(rows[i].identity!=PidlKey(second[i]))throw new InvalidOperationException("pidl-order-changed");
    var expired=new System.Collections.Generic.List<string>();foreach(var key in ReadNameCache.Keys)if(!seen.Contains(key))expired.Add(key);
    foreach(var key in expired){ReadNameCache.Remove(key);ReadPathCache.Remove(key);}
    if(ReadNameCache.Count>10000)ClearReadNameCache();return rows;
   }finally{if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);if(first!=null)foreach(var p in first)Marshal.FreeCoTaskMem(p);if(second!=null)foreach(var p in second)Marshal.FreeCoTaskMem(p);}
  }
 }

 public static long[] ReadState(){using(var s=new Session()){
  uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
  int hr=s.Folder.GetAutoArrange();
  if(hr!=0&&hr!=1){Marshal.ThrowExceptionForHR(hr);throw new InvalidOperationException("unknown-autoarrange-state");}
  return new long[]{flags,hr==0?1:0};
 }}
 // Strict path only: persist placement through the Shell view, not merely
 // its underlying ListView. PIDL identity and old coordinates must match.
 public static void PositionNewItem(int index,string expectedPath,int oldX,int oldY,int x,int y,string expectedIdentity=null) {
  using(var s=new Session()) {
   uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
   if(s.Folder.GetAutoArrange()!=1||(flags&1)!=0||(flags&4)==0)throw new InvalidOperationException("unsafe-shell-state");
   IntPtr child=IntPtr.Zero,point=IntPtr.Zero,array=IntPtr.Zero;
   try {
    if(expectedIdentity!=null)child=FindChildByIdentity(s.Folder,expectedIdentity);
    else Marshal.ThrowExceptionForHR(s.Folder.Item(index,out child));
    if(child==IntPtr.Zero)throw new InvalidOperationException("missing-shell-item");
    if(expectedIdentity!=null&&!String.Equals(PidlKey(child),expectedIdentity,StringComparison.Ordinal))throw new InvalidOperationException("shell-item-identity-changed");
    string actual=GetItemFilePath(s.Folder,child);
    if(String.IsNullOrEmpty(actual)||!String.Equals(System.IO.Path.GetFullPath(actual),System.IO.Path.GetFullPath(expectedPath),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("shell-item-path-mismatch");
    point=Marshal.AllocCoTaskMem(8);
    Marshal.ThrowExceptionForHR(s.Folder.GetItemPosition(child,point));
    if(Marshal.ReadInt32(point,0)!=oldX||Marshal.ReadInt32(point,4)!=oldY)throw new InvalidOperationException("shell-item-position-changed");
    Marshal.WriteInt32(point,0,x);Marshal.WriteInt32(point,4,y);
    array=Marshal.AllocCoTaskMem(IntPtr.Size);Marshal.WriteIntPtr(array,child);
    // ShObjIdl_core.h SVSI_POSITIONITEM = 0x80. No selection/focus flags.
    Marshal.ThrowExceptionForHR(s.Folder.SelectAndPositionItems(1,array,point,0x80));
   } finally {
    if(array!=IntPtr.Zero)Marshal.FreeCoTaskMem(array);
    if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);
    if(child!=IntPtr.Zero)Marshal.FreeCoTaskMem(child);
   }
  }
 }
 // Free-wave batch: all identities/paths/old positions are checked BEFORE any set.
 public static void PositionNewItems(string[] identities,string[] paths,int[] oldX,int[] oldY,int[] newX,int[] newY) {
  int count=identities==null?0:identities.Length;
  if(count<1||count>10000||paths==null||oldX==null||oldY==null||newX==null||newY==null||paths.Length!=count||oldX.Length!=count||oldY.Length!=count||newX.Length!=count||newY.Length!=count)throw new ArgumentException("invalid-batch");
  using(var s=new Session()) {
   IntPtr[] children=null;IntPtr array=IntPtr.Zero,points=IntPtr.Zero,point=IntPtr.Zero;
   try {
    uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
    if(s.Folder.GetAutoArrange()!=1||(flags&1)!=0||(flags&4)==0)throw new InvalidOperationException("unsafe-shell-state");
    children=EnumerateRead(s.Folder);
    var byId=new System.Collections.Generic.Dictionary<string,IntPtr>(StringComparer.Ordinal);
    foreach(var child in children){string key=PidlKey(child);if(byId.ContainsKey(key))throw new InvalidOperationException("duplicate-shell-identity");byId.Add(key,child);}
    var chosen=new IntPtr[count];var seen=new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);var cells=new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
    point=Marshal.AllocCoTaskMem(8);
    for(int i=0;i<count;i++) {
     if(String.IsNullOrEmpty(identities[i])||!seen.Add(identities[i])||!byId.TryGetValue(identities[i],out chosen[i]))throw new InvalidOperationException("batch-identity-mismatch");
     string actual=GetItemFilePath(s.Folder,chosen[i]);
     if(String.IsNullOrEmpty(actual)||!String.Equals(System.IO.Path.GetFullPath(actual),System.IO.Path.GetFullPath(paths[i]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("batch-path-mismatch");
     Marshal.ThrowExceptionForHR(s.Folder.GetItemPosition(chosen[i],point));
     if(Marshal.ReadInt32(point,0)!=oldX[i]||Marshal.ReadInt32(point,4)!=oldY[i])throw new InvalidOperationException("batch-position-changed");
     if(!cells.Add(newX[i].ToString(System.Globalization.CultureInfo.InvariantCulture)+","+newY[i].ToString(System.Globalization.CultureInfo.InvariantCulture)))throw new InvalidOperationException("batch-destination-overlap");
    }
    array=Marshal.AllocCoTaskMem(IntPtr.Size*count);points=Marshal.AllocCoTaskMem(8*count);
    for(int i=0;i<count;i++){Marshal.WriteIntPtr(array,i*IntPtr.Size,chosen[i]);Marshal.WriteInt32(points,i*8,newX[i]);Marshal.WriteInt32(points,i*8+4,newY[i]);}
    Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
    if(s.Folder.GetAutoArrange()!=1||(flags&1)!=0||(flags&4)==0)throw new InvalidOperationException("unsafe-shell-state");
    // Not assumed atomic. Caller keeps metadata/originals and verifies every old icon.
    Marshal.ThrowExceptionForHR(s.Folder.SelectAndPositionItems((uint)count,array,points,0x80));
   }finally{if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);if(points!=IntPtr.Zero)Marshal.FreeCoTaskMem(points);if(array!=IntPtr.Zero)Marshal.FreeCoTaskMem(array);if(children!=null)foreach(var child in children)Marshal.FreeCoTaskMem(child);}
  }
 }
 [ComImport,Guid("000214E3-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellViewWindowLease {[PreserveSig]int GetWindow(out IntPtr hwnd);[PreserveSig]int ContextSensitiveHelp(bool enter);}
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
 static void AssertLeaseSession(Session s,long expectedLv,int expectedPid,string expectedStarted){
  IntPtr hwnd;Marshal.ThrowExceptionForHR(((IShellViewWindowLease)s.Folder).GetWindow(out hwnd));
  uint pid;GetWindowThreadProcessId(hwnd,out pid);
  if(pid!=(uint)expectedPid||(hwnd.ToInt64()!=expectedLv&&!IsChild(hwnd,new IntPtr(expectedLv))))throw new InvalidOperationException("lease-view-changed");
  using(var p=System.Diagnostics.Process.GetProcessById(expectedPid)){if(p.StartTime.ToUniversalTime().Ticks.ToString()!=expectedStarted)throw new InvalidOperationException("lease-explorer-changed");}
 }
 // Read-only per-item lease witness. Never changes settings or positions.
 public static void AssertLeaseSessionFlags(uint expectedFlags,long expectedLv,int expectedPid,string expectedStarted){
  using(var s=new Session()){
   AssertLeaseSession(s,expectedLv,expectedPid,expectedStarted);
   uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
   if(flags!=expectedFlags||(flags&5)!=0||s.Folder.GetAutoArrange()!=1)throw new InvalidOperationException("lease-flags-changed");
  }
 }
 // Read-only exact witness for rollback disappearance, where Snap can be ON or OFF.
 // The existing OFF-only witness above intentionally remains unchanged.
 static void ValidateExactLeaseFlags(uint flags,uint expectedFlags,int autoArrange){
  if(flags!=expectedFlags||(flags&1)!=0||autoArrange!=1)throw new InvalidOperationException("lease-flags-changed");
 }
 public static void AssertLeaseExactSessionFlags(uint expectedFlags,long expectedLv,int expectedPid,string expectedStarted){
  using(var s=new Session()){
   AssertLeaseSession(s,expectedLv,expectedPid,expectedStarted);
   uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
   ValidateExactLeaseFlags(flags,expectedFlags,s.Folder.GetAutoArrange());
  }
 }
 public static void SetLeaseSnap(uint expectedFlags,bool enabled,long expectedLv,int expectedPid,string expectedStarted,string[] identities,int[] xs,int[] ys){
  if(identities==null||xs==null||ys==null||identities.Length!=xs.Length||xs.Length!=ys.Length)throw new ArgumentException("lease-invalid-guard");
  using(var s=new Session()){
   AssertLeaseSession(s,expectedLv,expectedPid,expectedStarted);
   uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
   if(flags!=expectedFlags||s.Folder.GetAutoArrange()!=1||(flags&1)!=0)throw new InvalidOperationException("lease-flags-changed");
   IntPtr[] children=null;IntPtr point=IntPtr.Zero;
   try{
    children=EnumerateRead(s.Folder);if(children.Length!=identities.Length)throw new InvalidOperationException("lease-items-changed");
    var lookup=new System.Collections.Generic.Dictionary<string,int>(StringComparer.Ordinal);
    for(int i=0;i<identities.Length;i++)lookup.Add(identities[i],i);
    point=Marshal.AllocCoTaskMem(8);
    foreach(var child in children){int i;if(!lookup.TryGetValue(PidlKey(child),out i))throw new InvalidOperationException("lease-identity-changed");Marshal.ThrowExceptionForHR(s.Folder.GetItemPosition(child,point));if(Marshal.ReadInt32(point,0)!=xs[i]||Marshal.ReadInt32(point,4)!=ys[i])throw new InvalidOperationException("lease-position-changed");}
    Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));if(flags!=expectedFlags||s.Folder.GetAutoArrange()!=1)throw new InvalidOperationException("lease-flags-changed");
    Marshal.ThrowExceptionForHR(s.Folder.SetCurrentFolderFlags(4,enabled?4u:0u));
    Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));if(flags!=((expectedFlags&~4u)|(enabled?4u:0u))||s.Folder.GetAutoArrange()!=1)throw new InvalidOperationException("lease-flags-unverified");
   }finally{if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);if(children!=null)foreach(var child in children)Marshal.FreeCoTaskMem(child);}
  }
 }
 public static void PositionLeaseItems(string[] identities,string[] paths,int[] oldX,int[] oldY,int[] newX,int[] newY,uint expectedFlags,long expectedLv,int expectedPid,string expectedStarted) {
  int count=identities==null?0:identities.Length;
  if(count<1||count>10000||paths==null||oldX==null||oldY==null||newX==null||newY==null||paths.Length!=count||oldX.Length!=count||oldY.Length!=count||newX.Length!=count||newY.Length!=count)throw new ArgumentException("invalid-batch");
  using(var s=new Session()) {
   AssertLeaseSession(s,expectedLv,expectedPid,expectedStarted);
   IntPtr[] children=null;IntPtr array=IntPtr.Zero,points=IntPtr.Zero,point=IntPtr.Zero;
   try {
    uint flags;Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
    if(s.Folder.GetAutoArrange()!=1||flags!=expectedFlags||(flags&5)!=0)throw new InvalidOperationException("unsafe-shell-state");
    children=EnumerateRead(s.Folder);
    var byId=new System.Collections.Generic.Dictionary<string,IntPtr>(StringComparer.Ordinal);
    foreach(var child in children){string key=PidlKey(child);if(byId.ContainsKey(key))throw new InvalidOperationException("duplicate-shell-identity");byId.Add(key,child);}
    var chosen=new IntPtr[count];var seen=new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);var cells=new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
    point=Marshal.AllocCoTaskMem(8);
    for(int i=0;i<count;i++) {
     if(String.IsNullOrEmpty(identities[i])||!seen.Add(identities[i])||!byId.TryGetValue(identities[i],out chosen[i]))throw new InvalidOperationException("batch-identity-mismatch");
     string actual=GetItemFilePath(s.Folder,chosen[i]);
     if(String.IsNullOrEmpty(actual)||!String.Equals(System.IO.Path.GetFullPath(actual),System.IO.Path.GetFullPath(paths[i]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("batch-path-mismatch");
     Marshal.ThrowExceptionForHR(s.Folder.GetItemPosition(chosen[i],point));
     if(Marshal.ReadInt32(point,0)!=oldX[i]||Marshal.ReadInt32(point,4)!=oldY[i])throw new InvalidOperationException("batch-position-changed");
     if(!cells.Add(newX[i].ToString(System.Globalization.CultureInfo.InvariantCulture)+","+newY[i].ToString(System.Globalization.CultureInfo.InvariantCulture)))throw new InvalidOperationException("batch-destination-overlap");
    }
    array=Marshal.AllocCoTaskMem(IntPtr.Size*count);points=Marshal.AllocCoTaskMem(8*count);
    for(int i=0;i<count;i++){Marshal.WriteIntPtr(array,i*IntPtr.Size,chosen[i]);Marshal.WriteInt32(points,i*8,newX[i]);Marshal.WriteInt32(points,i*8+4,newY[i]);}
    Marshal.ThrowExceptionForHR(s.Folder.GetCurrentFolderFlags(out flags));
    if(s.Folder.GetAutoArrange()!=1||flags!=expectedFlags||(flags&5)!=0)throw new InvalidOperationException("unsafe-shell-state");
    // Not assumed atomic. Caller keeps metadata/originals and verifies every old icon.
    Marshal.ThrowExceptionForHR(s.Folder.SelectAndPositionItems((uint)count,array,points,0x80));
   }finally{if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);if(points!=IntPtr.Zero)Marshal.FreeCoTaskMem(points);if(array!=IntPtr.Zero)Marshal.FreeCoTaskMem(array);if(children!=null)foreach(var child in children)Marshal.FreeCoTaskMem(child);}
  }
 }
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
$script:CalibratedDesktopGrids=@{}
Add-Type -AssemblyName System.Windows.Forms
# ListView spacing is valid only for the actual view-window DPI. A single
# icon on another-DPI monitor cannot establish that monitor's spacing.
function Strict-InferAreaGrid($members,[int]$sx,[int]$sy,[int]$scale,[int]$viewDpi) {
  if($sx -le 0 -or $sy -le 0 -or $scale -le 0 -or $viewDpi -le 0 -or $scale*96 -ne $viewDpi*100){return $null}
  $residues=@($members | ForEach-Object { '{0},{1}' -f (($_.x%$sx+$sx)%$sx),(($_.y%$sy+$sy)%$sy) } | Select-Object -Unique)
  if($residues.Count -ne 1){return $null}
  $xy=$residues[0].Split(',');return @{gx=[int]$xy[0];gy=[int]$xy[1];sx=$sx;sy=$sy}
}
Add-Type -TypeDefinition @'
// Pure snapshot grid arithmetic. No Shell calls, caching or policy relaxation.
using System;
public static class OkibaStrictAreaGrid {
 public static int[][] Infer(int[] xs,int[] ys,int[][] areas,int sx,int sy,int dpi) {
  if(xs==null||ys==null||areas==null||xs.Length!=ys.Length)throw new ArgumentException("shape");
  var result=new int[areas.Length][];
  for(int a=0;a<areas.Length;a++) {
   var r=areas[a];if(r==null||r.Length!=5)throw new ArgumentException("area-shape");
   if(sx<=0||sy<=0||r[4]<=0||dpi<=0||(long)r[4]*96!=(long)dpi*100)continue;
   bool found=false,mismatch=false;int gx=0,gy=0;
   for(int i=0;i<xs.Length;i++) {
    if(xs[i]<r[0]||xs[i]>=r[2]||ys[i]<r[1]||ys[i]>=r[3])continue;
    int x=(int)(((long)xs[i]%sx+sx)%sx),y=(int)(((long)ys[i]%sy+sy)%sy);
    if(!found){found=true;gx=x;gy=y;}else if(x!=gx||y!=gy){mismatch=true;break;}
   }
   if(found&&!mismatch)result[a]=new int[]{gx,gy,sx,sy};
  }
  return result;
 }
}
'@
function Set-StrictAreaGrids($icons,$areas,[int]$sx,[int]$sy,[int]$viewDpi) {
 $xs=New-Object 'System.Collections.Generic.List[int]';$ys=New-Object 'System.Collections.Generic.List[int]'
 foreach($i in $icons){$xs.Add([int]$i.x);$ys.Add([int]$i.y)}
 $bounds=New-Object 'System.Collections.Generic.List[int[]]'
 foreach($area in $areas){$bounds.Add([int[]]@($area.left,$area.top,$area.right,$area.bottom,$area.scale))}
 $grids=[OkibaStrictAreaGrid]::Infer($xs.ToArray(),$ys.ToArray(),$bounds.ToArray(),$sx,$sy,$viewDpi)
 for($a=0;$a -lt @($areas).Count;$a++){
  $g=$grids[$a]
  if($null -eq $g){$areas[$a].grid=$null}else{$areas[$a].grid=@{gx=$g[0];gy=$g[1];sx=$g[2];sy=$g[3]}}
 }
}

# Observer-only timings. Durations overlap (inclusive), never sum categories.
$script:DesktopPerf=$null
function Add-DesktopPerf([string]$name,$clock) {
  if($null -eq $script:DesktopPerf){return}
  $m=$script:DesktopPerf.metrics
  if(-not $m.ContainsKey($name)){$m[$name]=@{count=0;ms=0.0}}
  $m[$name].count++;$m[$name].ms+=$clock.Elapsed.TotalMilliseconds
}
function Set-DesktopPerfPhase([string]$name) {
  if($null -eq $script:DesktopPerf){return}
  if($null -ne $script:DesktopPerf.phaseClock){Add-DesktopPerf ('phase_'+$script:DesktopPerf.phase) $script:DesktopPerf.phaseClock}
  $script:DesktopPerf.phase=$name;$script:DesktopPerf.phaseClock=[Diagnostics.Stopwatch]::StartNew()
}
function Wait-DesktopPerf([int]$ms) {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try{Start-Sleep -Milliseconds $ms}finally{Add-DesktopPerf 'settle' $clock}
}
function Get-RawStrictDesktopSnapshot {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try{return Get-RawStrictDesktopSnapshotCore}finally{Add-DesktopPerf 'rawSnapshot' $clock}
}
function Get-StrictDesktopSnapshot {
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try{return Get-StrictDesktopSnapshotCore}finally{Add-DesktopPerf 'strictSnapshot' $clock}
}
function Get-ShellSnapshotFailure([Exception]$exception) {
  # Only the reader's two explicit enumeration consistency failures are retryable.
  # COM, permissions, duplicate identities and all other errors remain fatal.
  $inner=$exception
  while($null -ne $inner.InnerException){$inner=$inner.InnerException}
  $reason='shell-snapshot-error'
  if($inner -is [InvalidOperationException] -and @('item-count-changed','pidl-order-changed') -ccontains $inner.Message){$reason='desktop-changing'}
  return @{ok=$false;reason=$reason;detail=$exception.Message;innerDetail=$inner.Message;errorType=$inner.GetType().FullName;hresult=('0x{0:X8}' -f $inner.HResult)}
}
function Get-RawStrictDesktopSnapshotCore {
  $lv = Find-BestListView
  if ($lv -eq [IntPtr]::Zero) { return @{ok=$false; reason='no-listview'} }
  $reader = New-Object OkibaDesk+Reader -ArgumentList $lv
  try {
    $stateClock=[Diagnostics.Stopwatch]::StartNew()
    try { $shellState=[OkibaFolderView]::ReadState() } catch { return @{ok=$false;reason='shell-folder-state-unavailable'} } finally{Add-DesktopPerf 'shellState' $stateClock}
    $sx = [OkibaDesk]::GetSpacingX($lv); $sy = [OkibaDesk]::GetSpacingY($lv)
    if ($sx -le 0 -or $sy -le 0) { return @{ok=$false;reason='unknown-spacing'} }
    $viewDpi=[int][OkibaWin32]::GetDpiForWindow($lv)
    $explorerProcess=[uint32]0;[void][OkibaDesk]::GetWindowThreadProcessId($lv,[ref]$explorerProcess)
    $explorerStarted=[Diagnostics.Process]::GetProcessById([int]$explorerProcess).StartTime.ToUniversalTime().Ticks.ToString()
    $generation=('{0}:{1}:{2}' -f $explorerProcess,$explorerStarted,$lv.ToInt64())
    $batchClock=[Diagnostics.Stopwatch]::StartNew()
    try {$shellIcons=[OkibaFolderView]::ReadShellBatch($generation)}catch{return (Get-ShellSnapshotFailure $_.Exception)}finally{Add-DesktopPerf 'shellRead' $batchClock}
    $count=@($shellIcons).Count
    $icons = New-Object 'System.Collections.Generic.List[object]'
    foreach($item in $shellIcons){$icons.Add(@{label=$item.label;x=$item.x;y=$item.y;index=$item.index;identity=$item.identity;path=$item.path})}
    $grid = [OkibaDesk]::ReadGridOrigin($reader,$count,$sx,$sy,[int[]]@())
    $origin = [OkibaDesk]::ToClient($lv,0,0)
    $areas = @([OkibaWin32]::MonitorAreas() | ForEach-Object {
      $r=$_
      $tl=[OkibaDesk]::ToClient($lv,$r[0],$r[1]); $br=[OkibaDesk]::ToClient($lv,$r[2],$r[3])
      $monitorOrigin=[OkibaDesk]::ToClient($lv,$r[4],$r[5])
      $areaGrid=$null # Filled by pure batch arithmetic below.
      @{left=[int]$tl[0];top=[int]$tl[1];right=[int]$br[0];bottom=[int]$br[1];grid=$areaGrid;scale=[int]$r[6];monitorOrigin=@{x=$monitorOrigin[0];y=$monitorOrigin[1]}}
    })
    if ($areas.Count -eq 0) { return @{ok=$false;reason='unknown-monitors'} }
    Set-StrictAreaGrids $icons $areas $sx $sy $viewDpi
    $snapshot=@{ok=$true;identityVersion=1;explorerPid=$explorerProcess;explorerStarted=$explorerStarted;listviewHwnd=$lv.ToInt64();autoArrange=($shellState[1] -ne 0 -or ($shellState[0] -band 1) -ne 0 -or ([OkibaDesk]::GetWindowLong($lv,-16) -band 0x0100) -ne 0);
      snap=(($shellState[0] -band 4) -ne 0);viewDpi=$viewDpi;folderFlags=$shellState[0];shellAutoArrange=($shellState[1] -ne 0);sx=$sx;sy=$sy;gx=$grid[0];gy=$grid[1];
      origin=@{x=$origin[0];y=$origin[1]};areas=$areas;icons=@($icons.ToArray())}
    $physicalKey=Strict-GeometryKey $snapshot
    foreach($key in @($script:CalibratedDesktopGrids.Keys)){
      $cached=$script:CalibratedDesktopGrids[$key]
      if($cached.geometry -cne $physicalKey -or [DateTime]::Parse([string]$cached.expiresUtc).ToUniversalTime() -le [DateTime]::UtcNow){$script:CalibratedDesktopGrids.Remove($key);continue}
      $area=$areas[[int]$key];$g=$cached.grid;$valid=$true
      foreach($i in $icons){
        if($i.x -ge $area.left -and $i.x -lt $area.right -and $i.y -ge $area.top -and $i.y -lt $area.bottom){
          if((($i.x-$g.gx)%$g.sx) -ne 0 -or (($i.y-$g.gy)%$g.sy) -ne 0){$valid=$false;break}
        }
      }
      if($valid){$area.grid=$g}else{$script:CalibratedDesktopGrids.Remove($key)}
    }
    return $snapshot
  } finally { $reader.Dispose() }
}
function Strict-IconKey($i) {
  if([string]::IsNullOrEmpty([string]$i.identity)){throw 'missing-icon-identity'}
  return (@([string]$i.identity,[int]$i.x,[int]$i.y) | ConvertTo-Json -Compress)
}
function Strict-GeometryKey($s) {
  $areas=@($s.areas | ForEach-Object { @([int]$_.left,[int]$_.top,[int]$_.right,[int]$_.bottom,$_.scale,@([int]$_.monitorOrigin.x,[int]$_.monitorOrigin.y)) })
  return (@($s.explorerPid,$s.explorerStarted,$s.listviewHwnd,$s.folderFlags,[bool]$s.autoArrange,[bool]$s.snap,[int]$s.sx,[int]$s.sy,[int]$s.viewDpi,[int]$s.origin.x,[int]$s.origin.y,$areas) | ConvertTo-Json -Compress -Depth 8)
}
function Strict-AreaGrid($area,$s) {
  if(($area -is [System.Collections.IDictionary] -and $area.Contains('grid')) -or $null -ne $area.PSObject.Properties['grid']) {return $area.grid}
  return @{gx=$s.gx;gy=$s.gy;sx=$s.sx;sy=$s.sy}
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Globalization;
public static class OkibaSnapshotKey {
 public static string Key(string[] ids,int[] xs,int[] ys){
  if(ids==null||xs==null||ys==null||ids.Length!=xs.Length||ids.Length!=ys.Length)throw new ArgumentException("invalid-icon-arrays");
  var seen=new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
  var rows=new string[ids.Length];
  for(int i=0;i<ids.Length;i++){
   if(String.IsNullOrEmpty(ids[i]))throw new ArgumentException("missing-icon-identity");
   if(!seen.Add(ids[i]))throw new ArgumentException("duplicate-shell-identity");
   rows[i]=ids[i].Length.ToString(CultureInfo.InvariantCulture)+":"+ids[i]+":"+xs[i].ToString(CultureInfo.InvariantCulture)+":"+ys[i].ToString(CultureInfo.InvariantCulture);
  }
  Array.Sort(rows,StringComparer.Ordinal);
  var b=new StringBuilder();b.Append(rows.Length.ToString(CultureInfo.InvariantCulture)).Append(';');
  foreach(var row in rows)b.Append(row.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(row);
  return b.ToString();
 }
}
'@
function Strict-IconsKey($s) {
  # Pure canonical equality only. All raw reads and stability guards remain intact.
  $ids=New-Object 'System.Collections.Generic.List[string]';$xs=New-Object 'System.Collections.Generic.List[int]';$ys=New-Object 'System.Collections.Generic.List[int]'
  foreach($i in $s.icons){$ids.Add([string]$i.identity);$xs.Add([int]$i.x);$ys.Add([int]$i.y)}
  return [OkibaSnapshotKey]::Key($ids.ToArray(),$xs.ToArray(),$ys.ToArray())
}
function Get-StrictDesktopSnapshotCore {
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
  } catch { return @{ok=$false;reason='snapshot-error';detail=$_.Exception.Message} }
}
function Strict-PointValid($p) {
  if ($null -eq $p -or $null -eq $p.x -or $null -eq $p.y) { return $false }
  try { return [double]$p.x -eq [int]$p.x -and [double]$p.y -eq [int]$p.y } catch { return $false }
}
function Strict-PointInside($p,$s) {
  foreach($r in $s.areas) {
    $g=Strict-AreaGrid $r $s
    if($null -ne $g -and $p.x -ge $r.left -and $p.y -ge $r.top -and $p.x+$g.sx -le $r.right -and $p.y+$g.sy -le $r.bottom) { return $true }
  }
  return $false
}
function Strict-Overlap($a,$b,$s) {
  $sx=[int]$s.sx;$sy=[int]$s.sy
  foreach($p in @($a,$b)){foreach($area in $s.areas){
    if($p.x -ge $area.left -and $p.x -lt $area.right -and $p.y -ge $area.top -and $p.y -lt $area.bottom){
      $g=Strict-AreaGrid $area $s
      if($null -ne $g){$sx=[Math]::Max($sx,[int]$g.sx);$sy=[Math]::Max($sy,[int]$g.sy)}
    }
  }}
  return [Math]::Abs($a.x-$b.x) -lt ($sx-1) -and [Math]::Abs($a.y-$b.y) -lt ($sy-1)
}
function Strict-Near($a,$b) { return [Math]::Abs($a.x-$b.x) -le 1 -and [Math]::Abs($a.y-$b.y) -le 1 }
function Get-StrictTransactionState($baseline,$current,$targets) {
  if(-not $current.ok){return @{ok=$false;reason='desktop-changed';detailKind='current-snapshot-unavailable';snapshotReason=$current.reason;snapshotDetail=$current.detail}}
  if((Strict-GeometryKey $baseline) -cne (Strict-GeometryKey $current)){return @{ok=$false;reason='desktop-changed';detailKind='physical-geometry-changed'}}
  foreach($snapshot in @($baseline,$current)){
    $seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach($i in $snapshot.icons){if([string]::IsNullOrEmpty([string]$i.identity) -or -not $seen.Add([string]$i.identity)){return @{ok=$false;reason='missing-or-duplicate-icon-identity'}}}
  }
  $old=New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach($i in $baseline.icons){$old[[string]$i.identity]=$i}
  $extra=New-Object 'System.Collections.Generic.List[object]'
  foreach($i in $current.icons){
    if($old.ContainsKey([string]$i.identity)){
      $before=$old[[string]$i.identity]
      if($before.x -ne $i.x -or $before.y -ne $i.y){return @{ok=$false;reason='existing-icon-changed';changed=@{identity=$i.identity;label=$before.label;before=@{x=$before.x;y=$before.y};after=@(@{x=$i.x;y=$i.y})}}}
      $old.Remove([string]$i.identity)|Out-Null
    }else{$extra.Add($i)}
  }
  if($old.Count -gt 0){$missing=@($old.Values)[0];return @{ok=$false;reason='existing-icon-changed';changed=@{identity=$missing.identity;label=$missing.label;before=@{x=$missing.x;y=$missing.y};after=@()}}}
  $new=@{}
  foreach($i in $extra){
    if([string]::IsNullOrEmpty([string]$i.path)){return @{ok=$false;reason='unidentified-new-icon'}}
    $matches=@()
    for($n=0;$n -lt $targets.Count;$n++){
      try{$actual=[IO.Path]::GetFullPath([string]$i.path);$expected=[IO.Path]::GetFullPath([string]$targets[$n].path)}catch{return @{ok=$false;reason='invalid-target-path'}}
      if([string]::Equals($actual,$expected,[StringComparison]::OrdinalIgnoreCase)){$matches+=$n}
    }
    if($matches.Count -ne 1 -or $new.ContainsKey([int]$matches[0])){return @{ok=$false;reason='ambiguous-new-icon'}}
    $new[[int]$matches[0]]=$i
  }
  return @{ok=$true;new=$new;current=$current}
}

# One transaction-local proof only. Never persist calibration from another
# desktop state, and never accept caller-supplied grid without measured proof.
$script:DesktopCalibration=$null
function Wait-CalibrationSettled($baseline,$probe,$patch,$clock) {
  $settle=[Diagnostics.Stopwatch]::StartNew();$candidate=$null;$candidateAt=0;$lastIssue=$null
  Start-Sleep -Milliseconds 180
  while($settle.ElapsedMilliseconds -lt 1500 -and $clock.ElapsedMilliseconds -lt 90000){
    $now=Get-StrictDesktopSnapshot
    if(-not $now.ok){
      $lastIssue=$now
      if($now.reason -ne 'desktop-changing'){return @{ok=$false;reason='calibration-snapshot-failed';snapshotDetail=$now}}
      # An internally inconsistent read is not evidence of an old-icon move.
      # A separately readable raw snapshot still must preserve all old icons.
      $raw=Get-RawStrictDesktopSnapshot
      if($raw.ok){
        $guard=Get-StrictTransactionState $baseline $raw @($probe)
        if(-not $guard.ok){$guard.snapshotDetail=$raw.reason;return $guard}
        if($guard.new.Count -eq 1){$i=$guard.new[0];if($i.x -lt $patch.left -or $i.y -lt $patch.top -or $i.x -gt $patch.right -or $i.y -gt $patch.bottom){return @{ok=$false;reason='calibration-left-patch';observed=@{x=$i.x;y=$i.y}}}}
      }elseif($raw.reason -ne 'desktop-changing'){return @{ok=$false;reason='calibration-raw-snapshot-failed';snapshotDetail=$raw}}
      $candidate=$null;Start-Sleep -Milliseconds 150;continue
    }
    $current=Get-StrictTransactionState $baseline $now @($probe)
    if(-not $current.ok){return $current}
    if($current.new.Count -ne 1){return @{ok=$false;reason='calibration-probe-disappeared'}}
    $i=$current.new[0]
    if($i.x -lt $patch.left -or $i.y -lt $patch.top -or $i.x -gt $patch.right -or $i.y -gt $patch.bottom){return @{ok=$false;reason='calibration-left-patch';observed=@{x=$i.x;y=$i.y}}}
    if($null -ne $candidate -and (Strict-Near $candidate.new[0] $i) -and $settle.ElapsedMilliseconds-$candidateAt -ge 150){return $current}
    $candidate=$current;$candidateAt=$settle.ElapsedMilliseconds
    Start-Sleep -Milliseconds 150
  }
  return @{ok=$false;reason='calibration-settle-timeout';elapsedMs=$clock.ElapsedMilliseconds;snapshotDetail=$lastIssue;lastProbe=$(if($null -ne $candidate){@{x=$candidate.new[0].x;y=$candidate.new[0].y}}else{$null})}
}
function Calibrate-DesktopGrid($baseline,$probe,$plan) {
  $script:DesktopCalibration=$null
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try {
    if(-not $baseline.ok -or $baseline.autoArrange -or -not $baseline.snap){return @{ok=$false;reason='invalid-calibration-baseline'}}
    $areaIndex=[int]$plan.areaIndex
    if($areaIndex -lt 0 -or $areaIndex -ge @($baseline.areas).Count){return @{ok=$false;reason='invalid-calibration-area'}}
    $area=$baseline.areas[$areaIndex];$patch=$plan.patch
    $maxX=[int]$plan.maxSpacing.x;$maxY=[int]$plan.maxSpacing.y
    if($maxX -lt 8 -or $maxY -lt 8 -or $maxX -gt 512 -or $maxY -gt 512 -or $null -eq $patch -or $patch.left -lt $area.left -or $patch.top -lt $area.top -or $patch.right -gt $area.right -or $patch.bottom -gt $area.bottom){return @{ok=$false;reason='unsafe-calibration-patch'}}
    foreach($i in $baseline.icons){if($i.x -ge $patch.left-$maxX -and $i.x -le $patch.right+$maxX -and $i.y -ge $patch.top-$maxY -and $i.y -le $patch.bottom+$maxY){return @{ok=$false;reason='calibration-patch-occupied'}}}
    $dest=[IO.Path]::GetFullPath([string]$probe.path)
    $desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory')).TrimEnd('\')
    if([IO.Path]::GetDirectoryName($dest).TrimEnd('\') -ine $desktop -or [IO.Path]::GetFileName($dest) -cne [string]$probe.name -or -not (Test-Path -LiteralPath $dest) -or $plan.probeId -cne $dest){return @{ok=$false;reason='invalid-calibration-probe'}}
    $requests=@($plan.requests)
    if($requests.Count -lt 12 -or $requests.Count -gt 192){return @{ok=$false;reason='calibration-sample-limit'}}
    foreach($q in $requests){
      if(-not (Strict-PointValid $q) -or $q.x -lt $patch.left+$maxX -or $q.y -lt $patch.top+$maxY -or $q.x -gt $patch.right-$maxX -or $q.y -gt $patch.bottom-$maxY -or @('x','y') -notcontains $q.axis -or @('forward','reverse') -notcontains $q.pass){return @{ok=$false;reason='invalid-calibration-request'}}
    }
    $samples=New-Object 'System.Collections.Generic.List[object]'
    $state=$null
    foreach($q in $requests){
      if($clock.ElapsedMilliseconds -ge 90000){return @{ok=$false;reason='calibration-deadline'}}
      $until=[DateTime]::UtcNow.AddSeconds(8)
      do {
        $now=Get-StrictDesktopSnapshot
        if(-not $now.ok -and $now.reason -eq 'desktop-changing'){Start-Sleep -Milliseconds 50;continue}
        $fresh=Get-StrictTransactionState $baseline $now @($probe)
        if(-not $fresh.ok){$fresh.phase='calibration-before';return $fresh}
        if($fresh.new.Count -eq 1){break}
        Start-Sleep -Milliseconds 50
      }while([DateTime]::UtcNow -lt $until)
      if($fresh.new.Count -ne 1){return @{ok=$false;reason='calibration-probe-not-ready'}}
      if($null -ne $state -and -not (Strict-Near $state.new[0] $fresh.new[0])){
        return @{ok=$false;reason='calibration-probe-changed';phase='before-next-sample';sampleId=$q.id;axis=$q.axis;pass=$q.pass;elapsedMs=$clock.ElapsedMilliseconds;sampleCount=$samples.Count;previous=@{x=$state.new[0].x;y=$state.new[0].y;index=$state.new[0].index};current=@{x=$fresh.new[0].x;y=$fresh.new[0].y;index=$fresh.new[0].index};lastSample=$(if($samples.Count){$samples[$samples.Count-1]}else{$null});request=@{x=$q.x;y=$q.y}}
      }
      $i=$fresh.new[0]
      if($clock.ElapsedMilliseconds -ge 90000){return @{ok=$false;reason='calibration-deadline'}}
      [OkibaFolderView]::PositionNewItem([int]$i.index,$dest,[int]$i.x,[int]$i.y,[int]$q.x,[int]$q.y,[string]$i.identity)
      $after=Wait-CalibrationSettled $baseline $probe $patch $clock
      if(-not $after.ok){$after.phase='calibration-after';$after.sampleId=$q.id;$after.axis=$q.axis;$after.pass=$q.pass;$after.elapsedMs=$clock.ElapsedMilliseconds;return $after}
      if($after.new.Count -ne 1){return @{ok=$false;reason='calibration-probe-disappeared'}}
      $i=$after.new[0]
      if($i.x -lt $patch.left -or $i.y -lt $patch.top -or $i.x -gt $patch.right -or $i.y -gt $patch.bottom){return @{ok=$false;reason='calibration-left-patch'}}
      $samples.Add(@{id=$q.id;axis=$q.axis;pass=$q.pass;probeId=$plan.probeId;geometryKey=$plan.geometryKey;iconsKey=$plan.iconsKey;requestX=$q.x;requestY=$q.y;x=$i.x;y=$i.y})
      $state=$after
    }
    $token=[Guid]::NewGuid().ToString('N')
    $script:DesktopCalibration=@{token=$token;expires=[DateTime]::UtcNow.AddMinutes(2);geometry=(Strict-GeometryKey $baseline);oldIcons=(Strict-IconsKey $baseline);areaIndex=$areaIndex;probePath=$dest;probeName=$probe.name;probePosition=$state.new[0];samples=@($samples.ToArray());maxSpacing=@{x=$maxX;y=$maxY}}
    return @{ok=$true;token=$token;samples=@($samples.ToArray());snapshot=$state.current;elapsedMs=$clock.ElapsedMilliseconds}
  }catch{return @{ok=$false;reason='calibration-error';detail=$_.Exception.Message}}
}
function Confirm-CalibrationGrid($e,$g) {
  if($null -eq $g -or $g.sx -lt 2 -or $g.sy -lt 2 -or $g.sx -gt $e.maxSpacing.x -or $g.sy -gt $e.maxSpacing.y){return $false}
  foreach($key in @('gx','gy','sx','sy')){if([double]$g.$key -ne [int]$g.$key){return $false}}
  if($g.gx -lt 0 -or $g.gx -ge $g.sx -or $g.gy -lt 0 -or $g.gy -ge $g.sy){return $false}
  foreach($s in $e.samples){if((($s.x-$g.gx)%$g.sx) -ne 0 -or (($s.y-$g.gy)%$g.sy) -ne 0){return $false}}
  foreach($axis in @('x','y')){
    $rows=@($e.samples | Where-Object {$_.axis -eq $axis -and $_.pass -eq 'forward'})
    $back=@($e.samples | Where-Object {$_.axis -eq $axis -and $_.pass -eq 'reverse'})
    $values=@($rows | ForEach-Object {$_.$axis} | Sort-Object -Unique)
    $pitch=if($axis -eq 'x'){$g.sx}else{$g.sy}
    if($values.Count -lt 3 -or $rows.Count -ne $back.Count -or @($rows|Group-Object {$_.$axis}|Where-Object {$_.Count -gt 1}).Count -lt 2){return $false}
    for($n=1;$n -lt $values.Count;$n++){if($values[$n]-$values[$n-1] -ne $pitch){return $false}}
    $other=if($axis -eq 'x'){'y'}else{'x'}
    if(@($rows|ForEach-Object {$_.$other}|Select-Object -Unique).Count -ne 1){return $false}
    foreach($r in $rows){$match=@($back|Where-Object {$_.requestX -eq $r.requestX -and $_.requestY -eq $r.requestY});if($match.Count -ne 1 -or $match[0].x -ne $r.x -or $match[0].y -ne $r.y){return $false}}
  }
  return $true
}
function Import-DesktopCalibration($version,$entries) {
  $accepted=0;$rejected=0
  try {
    $entries=@($entries)
    if($version -ne 1 -or $entries.Count -gt 4 -or [Text.Encoding]::UTF8.GetByteCount(($entries|ConvertTo-Json -Depth 12 -Compress)) -gt 1048576){return @{ok=$false;reason='calibration-cache-limit'}}
    $snapshot=Get-StrictDesktopSnapshot
    if(-not $snapshot.ok){return @{ok=$false;reason='calibration-cache-snapshot'}}
    $physical=Strict-GeometryKey $snapshot
    foreach($e in $entries){
      try {
        $n=[int]$e.areaIndex;$created=[DateTime]::Parse([string]$e.createdUtc).ToUniversalTime();$expires=[DateTime]::Parse([string]$e.expiresUtc).ToUniversalTime()
        if($n -lt 0 -or $n -ge @($snapshot.areas).Count -or $e.geometry -cne $physical -or $created -gt [DateTime]::UtcNow.AddMinutes(5) -or $expires -le [DateTime]::UtcNow -or $expires -le $created -or ($expires-$created).TotalHours -gt 24 -or @($e.proof.samples).Count -gt 192 -or -not (Confirm-CalibrationGrid $e.proof $e.grid)){throw 'invalid-evidence'}
        $a=$snapshot.areas[$n];$g=$e.grid
        foreach($i in $snapshot.icons){if($i.x -ge $a.left -and $i.x -lt $a.right -and $i.y -ge $a.top -and $i.y -lt $a.bottom){if((($i.x-$g.gx)%$g.sx) -ne 0 -or (($i.y-$g.gy)%$g.sy) -ne 0){throw 'icon-grid-mismatch'}}}
        $script:CalibratedDesktopGrids[$n]=$e;$accepted++
      }catch{$rejected++}
    }
    return @{ok=$true;accepted=$accepted;rejected=$rejected}
  }catch{return @{ok=$false;reason='calibration-cache-invalid'}}
}
function Export-DesktopCalibration {
  try {
    $snapshot=Get-StrictDesktopSnapshot
    if(-not $snapshot.ok){return @{ok=$false;reason='calibration-cache-snapshot'}}
    $entries=@($script:CalibratedDesktopGrids.Values | Select-Object -First 4)
    return @{ok=$true;version=1;entries=$entries}
  }catch{return @{ok=$false;reason='calibration-cache-unavailable'}}
}
# Pure free-wave selection. Never assume a multi-item Shell call resolves cycles.
function Get-StrictFreeWave($state,$targets,$unfinished,$buffer,$baseline) {
  $wave=New-Object 'System.Collections.Generic.List[object]'
  foreach($n in $unfinished){
    $free=$true
    foreach($k in $state.new.Keys){if($k -ne $n -and (Strict-Overlap $targets[$n] $state.new[$k] $baseline)){$free=$false;break}}
    if($free){$wave.Add(@{index=[int]$n;destination=$targets[$n]})}
  }
  if($wave.Count -eq 0){
    foreach($k in $state.new.Keys){if(Strict-Overlap $buffer $state.new[$k] $baseline){return @{ok=$false;reason='buffer-occupied'}}}
    if(@($unfinished).Count -eq 0){return @{ok=$false;reason='empty-wave'}}
    $wave.Add(@{index=[int]$unfinished[0];destination=$buffer})
  }
  return @{ok=$true;items=@($wave.ToArray())}
}
function Position-DesktopPlanCore($baseline,$targets,$buffer,$calibration=$null) {
  $operation=[System.Diagnostics.Stopwatch]::StartNew()
  $targets=@($targets)
  if(-not $baseline.ok -or $baseline.autoArrange -or -not $baseline.snap -or $targets.Count -eq 0 -or -not (Strict-PointValid $buffer)) {return @{ok=$false;reason='invalid-plan'}}
  $proof=$null
  if($null -ne $calibration){
    $proof=$script:DesktopCalibration;$script:DesktopCalibration=$null
    if($null -eq $proof -or $proof.token -cne $calibration.token -or $proof.expires -lt [DateTime]::UtcNow -or $proof.geometry -cne (Strict-GeometryKey $baseline) -or $proof.oldIcons -cne (Strict-IconsKey $baseline) -or -not (Confirm-CalibrationGrid $proof $calibration.grid)){return @{ok=$false;reason='invalid-calibration-proof'}}
    if(@($targets|Where-Object {$_.path -ieq $proof.probePath -and $_.name -ceq $proof.probeName}).Count -ne 1){return @{ok=$false;reason='calibration-probe-not-selected'}}
    $baseline=$baseline|ConvertTo-Json -Depth 12|ConvertFrom-Json
    $baseline.areas[$proof.areaIndex].grid=$calibration.grid
    $a=$baseline.areas[$proof.areaIndex];$g=$calibration.grid
    foreach($i in $baseline.icons){if($i.x -ge $a.left -and $i.x -lt $a.right -and $i.y -ge $a.top -and $i.y -lt $a.bottom){if((($i.x-$g.gx)%$g.sx) -ne 0 -or (($i.y-$g.gy)%$g.sy) -ne 0){return @{ok=$false;reason='calibration-existing-grid-mismatch'}}}}
  }
  $all=@($targets)+@($buffer)
  $selectedArea=$null
  foreach($area in $baseline.areas){
    $g=Strict-AreaGrid $area $baseline
    if($null -eq $g){continue}
    $fits=$true
    foreach($p in $all){if(-not (Strict-PointValid $p) -or $p.x -lt $area.left -or $p.y -lt $area.top -or $p.x+$g.sx -gt $area.right -or $p.y+$g.sy -gt $area.bottom){$fits=$false;break}}
    if($fits){$selectedArea=$area;break}
  }
  if($null -eq $selectedArea){return @{ok=$false;reason='unknown-or-cross-monitor-grid'}}
  $selectedGrid=Strict-AreaGrid $selectedArea $baseline
  for($n=0;$n -lt $all.Count;$n++) {
    $p=$all[$n]
    if(-not (Strict-PointValid $p) -or -not (Strict-PointInside $p $baseline)) {return @{ok=$false;reason='outside-desktop'}}
    if((($p.x-$selectedGrid.gx)%$selectedGrid.sx) -ne 0 -or (($p.y-$selectedGrid.gy)%$selectedGrid.sy) -ne 0) {return @{ok=$false;reason='off-grid'}}
    foreach($old in $baseline.icons){if(Strict-Overlap $p $old $selectedGrid){return @{ok=$false;reason='occupied'}}}
    for($j=0;$j -lt $n;$j++){if(Strict-Overlap $p $all[$j] $selectedGrid){return @{ok=$false;reason='overlapping-plan'}}}
  }
  for($n=0;$n -lt $targets.Count;$n++) {
    $name=[string]$targets[$n].name
    if([string]::IsNullOrEmpty($name) -or [IO.Path]::GetFileName($name) -cne $name) {return @{ok=$false;reason='invalid-name'}}
    try {
      $dest=[IO.Path]::GetFullPath([string]$targets[$n].path)
      $desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory')).TrimEnd('\')
      if([IO.Path]::GetDirectoryName($dest).TrimEnd('\') -ine $desktop -or [IO.Path]::GetFileName($dest) -cne $name -or -not (Test-Path -LiteralPath $dest)) {return @{ok=$false;reason='invalid-destination'}}
    } catch {return @{ok=$false;reason='invalid-destination'}}
    foreach($old in $baseline.icons){if(-not [string]::IsNullOrEmpty([string]$old.path) -and [string]::Equals([IO.Path]::GetFullPath([string]$old.path),$dest,[StringComparison]::OrdinalIgnoreCase)){return @{ok=$false;reason='destination-already-visible'}}}
    for($j=0;$j -lt $n;$j++){if($targets[$j].name -ieq $name){return @{ok=$false;reason='duplicate-name'}}}
  }
  try {
    # Do not force a shell refresh that might rearrange existing icons.
    Set-DesktopPerfPhase 'arrival'
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
    if($null -ne $proof){
      $pn=@(0..($targets.Count-1)|Where-Object {$targets[$_].path -ieq $proof.probePath})[0]
      if(-not (Strict-Near $state.new[$pn] $proof.probePosition)){return @{ok=$false;reason='calibration-probe-changed'}}
    }
    Set-DesktopPerfPhase 'waves'
    $batchSizes=New-Object 'System.Collections.Generic.List[int]'
    $maxSteps=$targets.Count*3+3
    for($step=0;$step -lt $maxSteps;$step++) {
      if($operation.ElapsedMilliseconds -ge 50000){return @{ok=$false;reason='position-deadline'}}
      $unfinished=@(0..($targets.Count-1) | Where-Object {-not (Strict-Near $state.new[$_] $targets[$_])})
      if($unfinished.Count -eq 0) {
        Set-DesktopPerfPhase 'final'
        Wait-DesktopPerf 180
        $last=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets
        if(-not $last.ok){$last.phase='final';return $last}
        if($last.new.Count -ne $targets.Count){return @{ok=$false;reason='desktop-changed';phase='final'}}
        foreach($n in 0..($targets.Count-1)){if(-not (Strict-Near $last.new[$n] $targets[$n])){return @{ok=$false;reason='late-position-change'}}}
        if($null -ne $proof){$cacheNow=[DateTime]::UtcNow;$script:CalibratedDesktopGrids[[int]$proof.areaIndex]=@{areaIndex=[int]$proof.areaIndex;geometry=(Strict-GeometryKey $last.current);grid=$calibration.grid;proof=@{samples=$proof.samples;maxSpacing=$proof.maxSpacing};createdUtc=$cacheNow.ToString("o");expiresUtc=$cacheNow.AddHours(24).ToString("o")}}
        return @{ok=$true;positioned=$targets.Count;reason='';batchSizes=@($batchSizes.ToArray())}
      }
      $waveClock=[Diagnostics.Stopwatch]::StartNew()
      try{$wave=Get-StrictFreeWave $state $targets $unfinished $buffer $selectedGrid}finally{Add-DesktopPerf 'wavePlanning' $waveClock}
      if(-not $wave.ok){return $wave}
      # Revalidate immediately before each write, including every new icon's
      # exact current location. A user move aborts, it is never overwritten.
      $fresh=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets
      if(-not $fresh.ok){$fresh.phase='before-set';return $fresh}
      if($fresh.new.Count -ne $targets.Count){return @{ok=$false;reason='desktop-changed';phase='before-set'}}
      foreach($k in $state.new.Keys){if($fresh.new[$k].identity -cne $state.new[$k].identity -or -not (Strict-Near $fresh.new[$k] $state.new[$k])){return @{ok=$false;reason='new-icon-changed'}}}
      $lv=Find-BestListView
      if($lv -eq [IntPtr]::Zero){return @{ok=$false;reason='no-listview'}}
      $ids=@();$paths=@();$oldX=@();$oldY=@();$newX=@();$newY=@();$waveIndexes=@{}
      foreach($entry in $wave.items){
        $n=[int]$entry.index;$item=$fresh.new[$n]
        if([string]::IsNullOrEmpty([string]$item.identity)){return @{ok=$false;reason='missing-icon-identity'}}
        $ids+=[string]$item.identity;$paths+=[string]$targets[$n].path;$oldX+=[int]$item.x;$oldY+=[int]$item.y;$newX+=[int]$entry.destination.x;$newY+=[int]$entry.destination.y;$waveIndexes[$n]=$true
      }
      if($operation.ElapsedMilliseconds -ge 50000){return @{ok=$false;reason='position-deadline'}}
      $comClock=[Diagnostics.Stopwatch]::StartNew()
      try {try {[OkibaFolderView]::PositionNewItems([string[]]$ids,[string[]]$paths,[int[]]$oldX,[int[]]$oldY,[int[]]$newX,[int[]]$newY)} catch {
        $failed=@{ok=$false;reason='batch-call-failed';phase='batch-call-failed';partialPossible=$true;detail=$_.Exception.Message}
        try {$diagnostic=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets;$failed.afterState=$diagnostic;if($null -ne $diagnostic.changed){$failed.changed=$diagnostic.changed}}catch{$failed.afterState=@{ok=$false;reason='diagnostic-unavailable'}}
        return $failed
      }
      }finally{Add-DesktopPerf 'COMset' $comClock}
      $batchSizes.Add($ids.Count)
      Wait-DesktopPerf 180
      $after=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) $targets
      if(-not $after.ok){$after.phase='after-batch';$after.batchCount=$wave.items.Count;return $after}
      if($after.new.Count -ne $targets.Count){return @{ok=$false;reason='desktop-changed';phase='after-batch'}}
      foreach($k in $fresh.new.Keys){if($fresh.new[$k].identity -cne $after.new[$k].identity){return @{ok=$false;reason='new-icon-identity-changed'}}}
      foreach($entry in $wave.items){if(-not (Strict-Near $after.new[[int]$entry.index] $entry.destination)){return @{ok=$false;reason='position-unverified';phase='after-batch'}}}
      foreach($k in $fresh.new.Keys){if(-not $waveIndexes.ContainsKey([int]$k) -and -not (Strict-Near $fresh.new[$k] $after.new[$k])){return @{ok=$false;reason='other-new-icon-changed'}}}
      $state=$after
    }
    return @{ok=$false;reason='position-step-limit'}
  } catch { return @{ok=$false;reason='position-error';detail=$_.Exception.Message} }
}

function Position-DesktopPlan($baseline,$targets,$buffer,$calibration=$null) {
  $previous=$script:DesktopPerf
  $script:DesktopPerf=@{inclusive=$true;metrics=@{};phase='validation';phaseClock=[Diagnostics.Stopwatch]::StartNew()}
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try {
    $answer=Position-DesktopPlanCore $baseline $targets $buffer $calibration
    Set-DesktopPerfPhase 'complete'
    Add-DesktopPerf 'total' $clock
    foreach($m in $script:DesktopPerf.metrics.Values){$m.ms=[Math]::Round($m.ms,2)}
    if($answer -is [System.Collections.IDictionary]){$answer.perf=@{inclusive=$true;metrics=$script:DesktopPerf.metrics}}
    return $answer
  }finally{$script:DesktopPerf=$previous}
}

# ---- cursorState (v2.2.2: drag pre-resolution witness) -------------
function Get-CursorState {
  $s = [OkibaWin32]::CursorState()
  if ($null -eq $s) { return @{ x = 0; y = 0; lbtn = $false } }
  return @{ x = [int]$s[0]; y = [int]$s[1]; lbtn = ($s[2] -ne 0) }
}

# Optional protocol commands; no existing app call site uses them yet.
function Invoke-HiddenFileRequest($req,[bool]$write) {
  if($req.path -isnot [string] -or [string]::IsNullOrWhiteSpace($req.path)){return @{ok=$false;reason='invalid-path'}}
  if($write -and ($req.expectedIdentity -isnot [string] -or [string]::IsNullOrWhiteSpace($req.expectedIdentity) -or $req.expectedHidden -isnot [bool] -or $req.hidden -isnot [bool])){return @{ok=$false;reason='invalid-attribute-contract'}}
  try {
    if($write){$value=[OkibaFileAttributes]::Set($req.path,$req.expectedIdentity,$req.expectedHidden,$req.hidden)}else{$value=[OkibaFileAttributes]::Read($req.path)}
    return @{ok=$true;identity=$value.identity;hidden=$value.hidden;attributes=$value.attributes;directory=$value.directory;size=$value.size;mtime=$value.mtime}
  }catch{
    $inner=$_.Exception;while($null -ne $inner.InnerException){$inner=$inner.InnerException}
    $code=$null;if($inner -is [ComponentModel.Win32Exception]){$code=$inner.NativeErrorCode}elseif($inner -is [IO.IOException]){$code=$inner.HResult -band 0xffff}
    # Keep this new command's wire ASCII; localized OS messages can break legacy console decoding.
    $detail=$inner.GetType().Name;if($inner -is [InvalidOperationException]){$detail=$inner.Message}
    return @{ok=$false;reason='attribute-operation-failed';detail=$detail;errorCode=$code;errorType=$inner.GetType().Name}
  }
}

# ---- Main loop ------------------------------------------------------
if($env:OKIBA_SNAP_LEASE -eq '1'){
  $leaseScript=Join-Path $PSScriptRoot 'snap-lease.ps1'
  if(-not (Test-Path -LiteralPath $leaseScript -PathType Leaf)){throw 'lease-script-missing'}
  . $leaseScript
}
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  $dpiPrevious=[IntPtr]::Zero
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = $null
    if($req.cmd -like 'lease*' -or @('resolveDrop','cursorState','desktopSnapshot','positionDesktopPlan','calibrateDesktopGrid','importDesktopCalibration','exportDesktopCalibration') -contains $req.cmd){$dpiPrevious=[OkibaWin32]::EnterPhysicalScope()}
    switch ($req.cmd) {
      'resolveDrop'         { $result = Resolve-DropTarget ([int]$req.x) ([int]$req.y) }
      'positionIcons'       { $result = Position-Icons ([int]$req.x) ([int]$req.y) ([string[]]@($req.names)) }
      'getDesktopPositions' { $result = Get-DesktopPositions ([string[]]@($req.names)) }
      'cursorState'         { $result = Get-CursorState }
      'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot }
      {$_ -like 'lease*'}    { if($env:OKIBA_SNAP_LEASE -eq '1'){$result = Invoke-SnapLeaseRequest $req}else{$result=@{ok=$false;reason='lease-dedicated-helper-required'}} }
      'readHiddenFile'       { $result = Invoke-HiddenFileRequest $req $false }
      'setHiddenFile'        { $result = Invoke-HiddenFileRequest $req $true }
      'moveNoReplace'        {
        $code=[OkibaDesk]::MoveNoReplace([string]$req.source,[string]$req.destination)
        $result=@{ok=($code -eq 0);errorCode=$code;reason=$(if($code -eq 0){''}else{'move-no-replace-failed'})}
      }
      'positionDesktopPlan' { $result = Position-DesktopPlan $req.snapshot @($req.targets) $req.buffer $req.calibration }
      'calibrateDesktopGrid' { $result = Calibrate-DesktopGrid $req.snapshot $req.probe $req.plan }
      'importDesktopCalibration' { $result = Import-DesktopCalibration $req.version @($req.entries) }
      'exportDesktopCalibration' { $result = Export-DesktopCalibration }
      default               { throw "unknown-cmd: $($req.cmd)" }
    }
    $resp = @{ id = $id; result = $result }
  } catch {
    $resp = @{ id = $id; error = "$($_.Exception.Message)" }
  } finally {
    if($dpiPrevious -ne [IntPtr]::Zero){[OkibaWin32]::LeavePhysicalScope($dpiPrevious)}
  }
  try {
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
  } catch { break }
}
