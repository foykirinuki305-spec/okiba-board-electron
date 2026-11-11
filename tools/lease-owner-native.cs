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
