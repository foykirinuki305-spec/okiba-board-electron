// CI research only. References: Windows SDK 10.0.26100.0 um/ShlObj_core.h,
// SHELLSTATEW, SHELLFLAGSTATE, SSF_SHOWALLOBJECTS; Microsoft Learn SHGetSetSettings.
// No production helper dependency. Never call setter on a user's Desktop.
using System;
using System.Runtime.InteropServices;
public static class OkibaShowHiddenFixture {
 const uint ShowAll=1;
 // Windows BOOL/LONG/UINT/DWORD remain 32 bits on x64. SDK explicitly uses LONG,
 // not LPARAM, for lParamSort. Both BOOL bitfield groups occupy one DWORD each.
 [StructLayout(LayoutKind.Sequential)] public struct ShellState {
  public uint bits,dwWin95Unused,uWin95Unused; public int lParamSort,iSortDirection;
  public uint version,uNotUsed,bits2;
 }
 [DllImport("shell32.dll",ExactSpelling=true)] static extern void SHGetSettings(out uint flags,uint mask);
 [DllImport("shell32.dll",ExactSpelling=true)] static extern void SHGetSetSettings(ref ShellState state,uint mask,[MarshalAs(UnmanagedType.Bool)]bool set);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd,uint message,UIntPtr wparam,string lparam,uint flags,uint timeout,out UIntPtr result);
 public sealed class Evidence {public bool before,requested,after; public bool broadcastCompleted;public int broadcastError;public int stateBytes;}
 public static int StateBytes(){return Marshal.SizeOf(typeof(ShellState));}
 public static bool Read(){
  if(StateBytes()!=32)throw new InvalidOperationException("unexpected-SHELLSTATE-layout");
  uint flags;SHGetSettings(out flags,ShowAll);var s=new ShellState();SHGetSetSettings(ref s,ShowAll,false);
  if((flags&ShowAll)!=(s.bits&ShowAll))throw new InvalidOperationException("shell-hidden-read-disagreement");
  return (flags&ShowAll)!=0;
 }
 public static Evidence SetForCI(bool expected,bool enabled){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("hosted-CI-only-no-user-desktop");
  bool before=Read();if(before!=expected)throw new InvalidOperationException("show-hidden-setting-changed");
  var evidence=new Evidence{before=before,requested=enabled,stateBytes=StateBytes(),broadcastCompleted=true};
  if(before!=enabled){
   var state=new ShellState();SHGetSetSettings(ref state,ShowAll,false);
   if(((state.bits&ShowAll)!=0)!=expected)throw new InvalidOperationException("show-hidden-setting-changed-before-set");
   state.bits=enabled?(state.bits|ShowAll):(state.bits&~ShowAll);
   SHGetSetSettings(ref state,ShowAll,true);
   // SDK describes Shell setting notifications as WM_SETTINGCHANGE / ShellState.
   // This is a truthful setting notification, never IShellView.Refresh.
   UIntPtr result;IntPtr sent=SendMessageTimeoutW(new IntPtr(0xffff),0x001a,UIntPtr.Zero,"ShellState",0x0002,2000,out result);
   evidence.broadcastCompleted=sent!=IntPtr.Zero;evidence.broadcastError=evidence.broadcastCompleted?0:Marshal.GetLastWin32Error();
  }
  evidence.after=Read();if(evidence.after!=enabled)throw new InvalidOperationException("show-hidden-readback-failed");
  return evidence;
 }
}
