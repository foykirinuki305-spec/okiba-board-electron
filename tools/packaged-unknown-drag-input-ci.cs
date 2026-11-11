using System;using System.Runtime.InteropServices;using System.Threading;using System.Text;
public static class OkibaDragInputCI {
 [StructLayout(LayoutKind.Sequential)]public struct P {public int x,y;}
 [StructLayout(LayoutKind.Sequential)]public struct R {public int l,t,r,b;}
 [StructLayout(LayoutKind.Explicit,Size=40)]struct INPUT {[FieldOffset(0)]public uint type;[FieldOffset(8)]public int dx;[FieldOffset(12)]public int dy;[FieldOffset(20)]public uint flags;}
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]static extern bool GetCursorPos(out P p);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(P p);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr w,uint f);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr w,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr w,out R r);
 [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint n,INPUT[] i,int size);
 public static void Drag(int pid,int x,int y,int tx,int ty,int l,int t,int r,int b){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new Exception("hosted only");
  var old=SetThreadDpiAwarenessContext(new IntPtr(-4));if(old==IntPtr.Zero)throw new Exception("physical DPI context unavailable");
  try{DragPhysical(pid,x,y,tx,ty,l,t,r,b);}finally{if(SetThreadDpiAwarenessContext(old)==IntPtr.Zero)throw new Exception("DPI context restoration failed");}
 }
 static void MoveExact(int x,int y){P p;if(!SetCursorPos(x,y)||!GetCursorPos(out p)||p.x!=x||p.y!=y)throw new Exception("physical cursor mismatch");}
 static void DragPhysical(int pid,int x,int y,int tx,int ty,int l,int t,int r,int b){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new Exception("hosted only");
  if(IntPtr.Size!=8)throw new Exception("x64 only");uint got;var w=GetForegroundWindow();GetWindowThreadProcessId(w,out got);if(got!=pid)throw new Exception("foreground mismatch");
  if(GetAncestor(WindowFromPoint(new P{x=x,y=y}),2)!=w)throw new Exception("start outside owned window");R wr;GetWindowRect(w,out wr);
  if(tx<l||tx>=r||ty<t||ty>=b||(tx>=wr.l&&tx<wr.r&&ty>=wr.t&&ty<wr.b))throw new Exception("drop outside workarea or in app");
  var hit=WindowFromPoint(new P{x=tx,y=ty});var kind=new StringBuilder(256);GetClassName(hit,kind,256);if(kind.ToString()!="SysListView32"&&kind.ToString()!="WorkerW"&&kind.ToString()!="Progman")throw new Exception("drop is not exposed desktop");
  P original;if(!GetCursorPos(out original))throw new Exception("original cursor unknown");bool down=false;
  try{MoveExact(x,y);Thread.Sleep(150);if(GetForegroundWindow()!=w)throw new Exception("foreground changed");
   if(SendInput(1,new[]{new INPUT{flags=2}},40)!=1)throw new Exception("down failed");down=true;
   for(int i=1;i<=24;i++){if(GetForegroundWindow()!=w)throw new Exception("foreground changed");MoveExact(x+(tx-x)*i/24,y+(ty-y)*i/24);Thread.Sleep(25);}
   Thread.Sleep(350);if(GetForegroundWindow()!=w)throw new Exception("foreground changed before release");if(SendInput(1,new[]{new INPUT{flags=4}},40)!=1)throw new Exception("up failed");down=false;
  }finally{if(down)SendInput(1,new[]{new INPUT{flags=4}},40);MoveExact(original.x,original.y);}
 }
}