// Caller must prove identity, parents, attributes and completed rename before notification.
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class OkibaMixedRenameNotify {
 [DllImport("shell32.dll", EntryPoint="SHChangeNotify", CharSet=CharSet.Unicode, ExactSpelling=true)]
 private static extern void Notify(uint eventId, uint flags, string oldPath, string newPath);
 public static void Validate(string oldPath,string newPath) {
  if(Environment.GetEnvironmentVariable("OKIBA_MIXED_LEASE")!="1")throw new InvalidOperationException("mixed-lease-disabled");
  foreach(string p in new string[]{oldPath,newPath}) {
   if(String.IsNullOrEmpty(p)||p.Length>=260||p.IndexOf('\0')>=0||!Path.IsPathRooted(p)||p.Length<3||p[1]!=':'||p[2]!='\\'||!String.Equals(Path.GetFullPath(p),p,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("mixed-notify-invalid-path");
  }
  if(String.Equals(oldPath,newPath,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("mixed-notify-same-path");
 }
 public static void Renamed(string oldPath,string newPath) {
  Validate(oldPath,newPath);
  Notify(0x00000001,0x00001005,oldPath,newPath); // SHCNE_RENAMEITEM; PATHW | FLUSH.
 }
}
