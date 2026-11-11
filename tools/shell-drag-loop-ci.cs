// Disposable hosted CI experiment. No product integration, no restoration/deletion.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Windows.Forms;
using System.Drawing;
using System.Text.RegularExpressions;
[ComVisible(true),Guid("00000121-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOkibaDropSource {
 [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape,uint keys);
 [PreserveSig] int GiveFeedback(uint effect);
}
[ComImport,Guid("3D8B0590-F691-11D2-8EA9-006097DF5BD4"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOkibaAsyncData {
 [PreserveSig] int SetAsyncMode([MarshalAs(UnmanagedType.Bool)]bool value);
 [PreserveSig] int GetAsyncMode([MarshalAs(UnmanagedType.Bool)]out bool value);
 [PreserveSig] int StartOperation(IntPtr context);
 [PreserveSig] int InOperation([MarshalAs(UnmanagedType.Bool)]out bool value);
 [PreserveSig] int EndOperation(int hr,IntPtr context,uint effects);
}
[ComVisible(true),ClassInterface(ClassInterfaceType.None)]
public sealed class OkibaDropSourceCI : IOkibaDropSource {
 public int QueryContinueDrag(bool escape,uint keys){return escape?0x40101:((keys&1)==0?0x40100:0);}
 public int GiveFeedback(uint effect){return 0x40102;}
}
public static class OkibaShellDragCI {
 [StructLayout(LayoutKind.Sequential)] public struct Pt {public int x,y;}
 [StructLayout(LayoutKind.Explicit,Size=40)] struct Input {
  [FieldOffset(0)] public uint type;
  [FieldOffset(8)] public int dx;
  [FieldOffset(12)] public int dy;
  [FieldOffset(20)] public uint flags;
 }
 public sealed class Result {public int hresult;public uint effect;public bool loopReturned;public string inputError;public string topLeftSemantics="POINT[0]=group top-left at source cursor; remaining relative offsets";public int startX,startY,targetX,targetY;public string targetClass;public bool asyncSupported;public bool asyncDisabled;public bool inOperation;public string asyncDiagnostic;public uint? performedEffect,logicalEffect;}
 [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr p);
 [DllImport("ole32.dll")] static extern void OleUninitialize();
 [DllImport("ole32.dll",PreserveSig=true)] static extern int DoDragDrop(System.Runtime.InteropServices.ComTypes.IDataObject data,IOkibaDropSource source,uint allowed,out uint effect);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=true)] static extern int SHParseDisplayName(string name,IntPtr context,out IntPtr pidl,uint attrs,out uint outAttrs);
 [DllImport("shell32.dll")] static extern IntPtr ILFindLastID(IntPtr pidl);
 [DllImport("shell32.dll",PreserveSig=true)] static extern int SHCreateDataObject(IntPtr parent,uint count,IntPtr[] children,IntPtr inner,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out System.Runtime.InteropServices.ComTypes.IDataObject data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string format);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out Pt p);
 [DllImport("user32.dll")] static extern uint SendInput(uint n,Input[] data,int size);
 [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Pt p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint mode);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int count);
 static void Gate(){if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new Exception("hosted CI only");}
 static void Move(int x,int y){Pt p;if(!SetCursorPos(x,y)||!GetCursorPos(out p)||p.x!=x||p.y!=y)throw new Exception("physical cursor mismatch");}
 static void Button(uint flags){if(SendInput(1,new[]{new Input{flags=flags}},40)!=1)throw new Exception("SendInput failed");}
 static void Check(int hr){if(hr<0)Marshal.ThrowExceptionForHR(hr);}
 static uint? ReadEffect(System.Runtime.InteropServices.ComTypes.IDataObject data,string name){
  var f=new FORMATETC{cfFormat=unchecked((short)RegisterClipboardFormat(name)),dwAspect=DVASPECT.DVASPECT_CONTENT,lindex=-1,tymed=TYMED.TYMED_HGLOBAL};STGMEDIUM medium;
  if(data.QueryGetData(ref f)!=0)return null;data.GetData(ref f,out medium);
  try{var p=GlobalLock(medium.unionmember);if(p==IntPtr.Zero)return null;try{return unchecked((uint)Marshal.ReadInt32(p));}finally{GlobalUnlock(medium.unionmember);}}finally{ReleaseStgMedium(ref medium);}
 }
 [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref STGMEDIUM value);
 static void Offsets(System.Runtime.InteropServices.ComTypes.IDataObject data,int x,int y,int sx,int sy){
  uint format=RegisterClipboardFormat("Shell Object Offsets");if(format==0)throw new Exception("clipboard format failed");
  IntPtr mem=GlobalAlloc(0x42,(UIntPtr)32);if(mem==IntPtr.Zero)throw new Exception("global allocation failed");
  try {IntPtr ptr=GlobalLock(mem);if(ptr==IntPtr.Zero)throw new Exception("global lock failed");
   try {Marshal.Copy(new[]{x,y,0,0,sx,sy,2*sx,2*sy},0,ptr,8);}finally{GlobalUnlock(mem);}
   var f=new FORMATETC{cfFormat=unchecked((short)format),dwAspect=DVASPECT.DVASPECT_CONTENT,lindex=-1,tymed=TYMED.TYMED_HGLOBAL};
   var medium=new STGMEDIUM{tymed=TYMED.TYMED_HGLOBAL,unionmember=mem,pUnkForRelease=null};
   data.SetData(ref f,ref medium,true);mem=IntPtr.Zero;
  }finally{if(mem!=IntPtr.Zero)GlobalFree(mem);}
 }
 public static Result Run(string[] paths,int x,int y,int offsetX,int offsetY,int left,int top,int right,int bottom,bool cancel){
  Gate();if(paths.Length!=3||Thread.CurrentThread.GetApartmentState()!=ApartmentState.STA||IntPtr.Size!=8)throw new Exception("three STA x64 required");
  string parent=Path.GetDirectoryName(paths[0]);foreach(string p in paths)if(Path.GetDirectoryName(p)!=parent||!File.Exists(p))throw new Exception("same parent existing files required");
  string desktop=Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),tmp=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\');
  if(!String.Equals(parent,desktop,StringComparison.OrdinalIgnoreCase)&&(!parent.StartsWith(tmp+"\\",StringComparison.OrdinalIgnoreCase)||!new DirectoryInfo(parent).Parent.Name.StartsWith("okiba-shell-drop-")||new DirectoryInfo(parent).Name!="files"))throw new Exception("owned fixture parent only");
  foreach(string p in paths){if(!Regex.IsMatch(Path.GetFileName(p),"^OkibaShellDrop-[a-f0-9]{24}-[1-3]\\.txt$"))throw new Exception("owned fixture names only");}
  if(x<left||x>=right||y<top||y>=bottom||right-left<900||bottom-top<500)throw new Exception("physical target/area invalid");
  IntPtr oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));if(oldDpi==IntPtr.Zero)throw new Exception("DPI scope failed");
  Check(OleInitialize(IntPtr.Zero));IntPtr parentID=IntPtr.Zero;IntPtr[] full=new IntPtr[3];System.Runtime.InteropServices.ComTypes.IDataObject data=null;
  var result=new Result{targetX=x,targetY=y};var started=new ManualResetEvent(false);var finished=new ManualResetEvent(false);Pt cursor;GetCursorPos(out cursor);
  try{
   uint attr;Check(SHParseDisplayName(parent,IntPtr.Zero,out parentID,0,out attr));var child=new IntPtr[3];
   for(int i=0;i<3;i++){Check(SHParseDisplayName(paths[i],IntPtr.Zero,out full[i],0,out attr));child[i]=ILFindLastID(full[i]);}
   Guid iid=new Guid("0000010e-0000-0000-C000-000000000046");Check(SHCreateDataObject(parentID,3,child,IntPtr.Zero,ref iid,out data));
   IOkibaAsyncData asyncData=data as IOkibaAsyncData;result.asyncSupported=asyncData!=null;
   if(asyncData!=null){Check(asyncData.SetAsyncMode(false));bool mode;Check(asyncData.GetAsyncMode(out mode));if(mode)throw new Exception("async transfer not disabled");result.asyncDisabled=true;}
   Thread inputThread=null;
   using(var form=new Form()){
    form.Text="Okiba hosted Shell drop owned source";form.StartPosition=FormStartPosition.Manual;form.Bounds=new Rectangle(right-420,top+40,400,240);
    form.TopMost=true;form.BackColor=Color.LightBlue;
    var label=new Label{Text="Hosted disposable Shell drag fixture",Dock=DockStyle.Top,Height=30};form.Controls.Add(label);
    form.MouseDown+=(sender,e)=>{if(e.Button!=MouseButtons.Left)return;try{Offsets(data,result.startX,result.startY,offsetX,offsetY);started.Set();uint effect;result.hresult=DoDragDrop(data,new OkibaDropSourceCI(),2,out effect);result.effect=effect;result.loopReturned=true;}catch(Exception ex){result.inputError=ex.ToString();}finally{finished.Set();form.BeginInvoke(new Action(()=>form.Close()));}};
    form.Shown+=(sender,e)=>{
     IntPtr hwnd=form.Handle;Pt start=new Pt{x=form.Left+100,y=form.Top+100};result.startX=start.x;result.startY=start.y;
     var thread=new Thread(()=>{
      IntPtr workerDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));bool down=false;
      try{
       Thread.Sleep(500);if(GetForegroundWindow()!=hwnd||GetAncestor(WindowFromPoint(start),2)!=hwnd)throw new Exception("owned foreground/source HWND mismatch");
       Pt target=new Pt{x=x,y=y};var cls=new StringBuilder(128);GetClassName(WindowFromPoint(target),cls,128);result.targetClass=cls.ToString();if(result.targetClass!="SysListView32"&&result.targetClass!="WorkerW"&&result.targetClass!="Progman")throw new Exception("not exposed Desktop: "+result.targetClass);
       Move(start.x,start.y);Button(2);down=true;if(!started.WaitOne(10000))throw new Exception("drag loop not entered");
       for(int n=1;n<=24;n++){Move(start.x+(x-start.x)*n/24,start.y+(y-start.y)*n/24);Thread.Sleep(25);if(cancel&&n==8){keybd_event(27,0,0,UIntPtr.Zero);keybd_event(27,0,2,UIntPtr.Zero);break;}}
       Thread.Sleep(300);Button(4);down=false;if(!finished.WaitOne(20000))throw new Exception("Explorer completion unproven; no cleanup allowed");
      }catch(Exception ex){result.inputError=ex.ToString();keybd_event(27,0,0,UIntPtr.Zero);keybd_event(27,0,2,UIntPtr.Zero);if(!started.WaitOne(0))form.BeginInvoke(new Action(()=>form.Close()));}
      finally{try{if(down)Button(4);Move(cursor.x,cursor.y);}catch(Exception ex){result.inputError=(result.inputError??"")+" cursor restore: "+ex.Message;}if(workerDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(workerDpi);}
     });inputThread=thread;thread.IsBackground=true;thread.Start();
    };
    Application.Run(form);
   }
   if(inputThread!=null&&!inputThread.Join(3000))result.inputError=(result.inputError??"")+" input thread stop unconfirmed";
   try{result.performedEffect=ReadEffect(data,"Performed DropEffect");result.logicalEffect=ReadEffect(data,"Logical Performed DropEffect");if(asyncData!=null){bool active;Check(asyncData.InOperation(out active));result.inOperation=active;}}catch(Exception ex){result.asyncDiagnostic=ex.ToString();}
   return result;
  }finally{if(data!=null)Marshal.ReleaseComObject(data);foreach(IntPtr p in full)if(p!=IntPtr.Zero)Marshal.FreeCoTaskMem(p);if(parentID!=IntPtr.Zero)Marshal.FreeCoTaskMem(parentID);OleUninitialize();SetThreadDpiAwarenessContext(oldDpi);}
 }
}
