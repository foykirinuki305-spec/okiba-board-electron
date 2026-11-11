// CI-only injection inside OkibaFolderView. IShellView inherits IOleWindow.
[ComImport,Guid("000214E3-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellViewRefreshCI {
 [PreserveSig] int GetWindow(out IntPtr hwnd);
 [PreserveSig] int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter);
 [PreserveSig] int TranslateAccelerator(IntPtr message);
 [PreserveSig] int EnableModeless([MarshalAs(UnmanagedType.Bool)] bool enable);
 [PreserveSig] int UIActivate(uint state);
 [PreserveSig] int Refresh();
}
public static int RefreshViewForCI(bool refresh) {
 if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");
 using(var session=new Session()){return session.RefreshForCI(refresh);}
}
