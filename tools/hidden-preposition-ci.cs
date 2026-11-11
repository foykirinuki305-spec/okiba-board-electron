#pragma warning disable 9191 // Marshal.QueryInterface is ref Guid on .NET Framework, in Guid on newer .NET.
 [DllImport("shell32.dll")] static extern void SHGetSettings(out uint state,uint mask);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern void SHChangeNotify(uint change,uint flags,string item,IntPtr other);
 public static bool ShowHiddenForCIRead(){uint state;SHGetSettings(out state,1);return (state&1)!=0;}
 public static void NotifyActualChangeForCI(string path,bool deleted){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");
  if(deleted&&System.IO.File.Exists(path))throw new InvalidOperationException("File still exists");
  SHChangeNotify(deleted?4u:0x2000u,0x1005u,path,IntPtr.Zero);
 }
 // CI-only experiment: non-visible items are NOT guaranteed by the API contract.
 [ComImport,Guid("000214e6-0000-0000-c000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellFolderParse {
  [PreserveSig] int ParseDisplayName(IntPtr hwnd,IntPtr bind,[MarshalAs(UnmanagedType.LPWStr)]string name,ref uint eaten,out IntPtr pidl,ref uint attributes);
 }
 [ComImport,Guid("37A378C0-F82D-11CE-AE65-08002B2E1262"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface ILegacyFolderView {
  [PreserveSig]int Rearrange(IntPtr p);[PreserveSig]int GetArrangeParam(out IntPtr p);[PreserveSig]int ArrangeGrid();[PreserveSig]int AutoArrange();[PreserveSig]int GetAutoArrange();
  [PreserveSig]int AddObject(IntPtr p,out uint n);[PreserveSig]int GetObject(out IntPtr p,uint n);[PreserveSig]int RemoveObject(IntPtr p,out uint n);[PreserveSig]int GetObjectCount(out uint n);[PreserveSig]int SetObjectCount(uint n,uint flags);
  [PreserveSig]int UpdateObject(IntPtr a,IntPtr b,out uint n);[PreserveSig]int RefreshObject(IntPtr p,out uint n);[PreserveSig]int SetRedraw([MarshalAs(UnmanagedType.Bool)]bool redraw);[PreserveSig]int GetSelectedCount(out uint n);[PreserveSig]int GetSelectedObjects(out IntPtr p,out uint n);
  [PreserveSig]int IsDropOnSource(IntPtr p);[PreserveSig]int GetDragPoint(IntPtr p);[PreserveSig]int GetDropPoint(IntPtr p);[PreserveSig]int MoveIcons(IntPtr data);
  [PreserveSig]int SetItemPos(IntPtr child,IntPtr point);
 }
 public static int[] PrepositionHiddenForCI(string path,int x,int y,int mode){
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI-only experiment");
  if((System.IO.File.GetAttributes(path)&System.IO.FileAttributes.Hidden)==0)throw new InvalidOperationException("Probe must remain hidden");
  using(var s=new Session()){
   IntPtr folder=IntPtr.Zero,child=IntPtr.Zero,point=IntPtr.Zero,array=IntPtr.Zero;object obj=null;
   try{
    Guid iid=typeof(IShellFolderParse).GUID;Marshal.ThrowExceptionForHR(s.Folder.GetFolder(ref iid,out folder));
    obj=Marshal.GetObjectForIUnknown(folder);uint eaten=0,attributes=0;
    int parse=((IShellFolderParse)obj).ParseDisplayName(IntPtr.Zero,IntPtr.Zero,System.IO.Path.GetFileName(path),ref eaten,out child,ref attributes);
    Marshal.ThrowExceptionForHR(parse);
    if(child==IntPtr.Zero)throw new InvalidOperationException("ParseDisplayName returned no PIDL");
    string actual=GetItemFilePath(s.Folder,child);
    if(!String.Equals(System.IO.Path.GetFullPath(actual),System.IO.Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Hidden PIDL path mismatch");
    point=Marshal.AllocCoTaskMem(8);Marshal.WriteInt32(point,0,Int32.MinValue);Marshal.WriteInt32(point,4,Int32.MinValue);
    int before=s.Folder.GetItemPosition(child,point);int bx=Marshal.ReadInt32(point,0),by=Marshal.ReadInt32(point,4);
    Marshal.WriteInt32(point,0,x);Marshal.WriteInt32(point,4,y);array=Marshal.AllocCoTaskMem(IntPtr.Size);Marshal.WriteIntPtr(array,child);
    int set,rawQi=-1,sameIdentity=-1;
    if(mode==1){
      IntPtr viaFolder=Marshal.GetIUnknownForObject(s.Folder),viaView=Marshal.GetIUnknownForObject(s.RawViewForCI),legacy=IntPtr.Zero;object legacyObj=null;
      try{sameIdentity=viaFolder==viaView?1:0;Guid legacyId=typeof(ILegacyFolderView).GUID;rawQi=Marshal.QueryInterface(viaView,ref legacyId,out legacy);set=rawQi;
       if(rawQi==0){legacyObj=Marshal.GetObjectForIUnknown(legacy);set=((ILegacyFolderView)legacyObj).SetItemPos(child,point);}
      }finally{if(legacyObj!=null&&Marshal.IsComObject(legacyObj))Marshal.ReleaseComObject(legacyObj);if(legacy!=IntPtr.Zero)Marshal.Release(legacy);Marshal.Release(viaView);Marshal.Release(viaFolder);}
    }else{set=s.Folder.SelectAndPositionItems(1,array,point,0x80);}
    Marshal.WriteInt32(point,0,Int32.MinValue);Marshal.WriteInt32(point,4,Int32.MinValue);
    int after=s.Folder.GetItemPosition(child,point);int ax=Marshal.ReadInt32(point,0),ay=Marshal.ReadInt32(point,4);
    return new int[]{parse,before,bx,by,set,after,ax,ay,rawQi,sameIdentity};
   }finally{
    if(array!=IntPtr.Zero)Marshal.FreeCoTaskMem(array);if(point!=IntPtr.Zero)Marshal.FreeCoTaskMem(point);if(child!=IntPtr.Zero)Marshal.FreeCoTaskMem(child);
    if(obj!=null&&Marshal.IsComObject(obj))Marshal.ReleaseComObject(obj);if(folder!=IntPtr.Zero)Marshal.Release(folder);
   }
  }
 }
