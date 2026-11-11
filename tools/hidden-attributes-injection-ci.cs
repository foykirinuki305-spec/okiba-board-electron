// CI-only truthful attribute notification. Never invent create/delete events.
[DllImport("shell32.dll",EntryPoint="SHChangeNotify",ExactSpelling=true,CharSet=CharSet.Unicode)]static extern void SHChangeNotifyAttributesCI(uint change,uint flags,string item,IntPtr other);
public static long[] UnhideAttributesCI(string path,bool notify) {
 if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");
 string desktop=System.IO.Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
 path=System.IO.Path.GetFullPath(path);
 if(!String.Equals(System.IO.Path.GetDirectoryName(path),desktop,StringComparison.OrdinalIgnoreCase)||!System.IO.Path.GetFileName(path).StartsWith("OkibaDense-",StringComparison.Ordinal)||!System.IO.File.Exists(path))throw new InvalidOperationException("Not an owned fixture");
 var before=System.IO.File.GetAttributes(path);if((before&System.IO.FileAttributes.Hidden)==0)throw new InvalidOperationException("Expected hidden original");
 var desired=before&~System.IO.FileAttributes.Hidden;System.IO.File.SetAttributes(path,desired);
 var after=System.IO.File.GetAttributes(path);if(after!=desired)throw new InvalidOperationException("Unexpected attributes after unhide");
 if(notify)SHChangeNotifyAttributesCI(0x800u,0x1005u,path,IntPtr.Zero);
 if(System.IO.File.GetAttributes(path)!=desired)throw new InvalidOperationException("Notification changed attributes");
 return new long[]{(long)before,(long)after};
}
