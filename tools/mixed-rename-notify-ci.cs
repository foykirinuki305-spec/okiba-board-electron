// Disposable hosted-CI research only. Caller must prove a completed rename first.
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class OkibaMixedRenameNotify {
 [DllImport("shell32.dll", EntryPoint="SHChangeNotify", CharSet=CharSet.Unicode, ExactSpelling=true)]
 private static extern void Notify(uint eventId, uint flags, string oldPath, string newPath);
 public static void Validate(string oldPath,string newPath) {
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true" || Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows" || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("mixed-notify-hosted-only");
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
