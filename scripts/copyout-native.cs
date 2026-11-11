// File-only copy adapter. Original handles are read-only; no Desktop APIs.
// Narrow scope: fixed local volumes, regular single-link files with attributes 32/34.
// Cross-volume copy is permitted; originals are never modified or removed.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OkibaCopyOutFiles {
 [StructLayout(LayoutKind.Sequential)] struct FT { public uint low,high; }
 [StructLayout(LayoutKind.Sequential)] struct INFO { public uint attr;public FT create,access,write;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out INFO info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int type,IntPtr buffer,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint length,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] static extern uint GetFileAttributesW(string path);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern uint GetDriveTypeW(string root);
 public sealed class Record {public string path,identity,volume,size,mtime;public uint attributes,linkCount;public bool hidden,regularFile,reparse;}
 public sealed class ParentRecord {public string path,identity,volume,ancestorKey;}
 static Exception Error(string op,int code){return new Win32Exception(code,op);}
 static Exception Error(string op){return Error(op,Marshal.GetLastWin32Error());}
 static string Full(string p){
  if(String.IsNullOrEmpty(p)||p.Length<3||!Char.IsLetter(p[0])||p[1]!=':'||(p[2]!='\\'&&p[2]!='/')||p.IndexOf(':',2)>=0||p.IndexOf('\0')>=0)throw new ArgumentException("resident-local-absolute-path-required");
  p=Path.GetFullPath(p).TrimEnd('\\');if(p.Length==2)p+="\\";
  if(GetDriveTypeW(Path.GetPathRoot(p))!=3)throw new InvalidOperationException("resident-fixed-local-volume-required");
  foreach(string c in p.Substring(3).Split('\\')){if(c.Length==0)continue;string stem=c.Split('.')[0].ToUpperInvariant();if(c.EndsWith(" ")||c.EndsWith(".")||stem=="CON"||stem=="PRN"||stem=="AUX"||stem=="NUL"||System.Text.RegularExpressions.Regex.IsMatch(stem,"^(COM|LPT)[1-9]$"))throw new ArgumentException("resident-path-component-unsupported");}
  return p;
 }
 static INFO Info(SafeFileHandle h){INFO i;if(!GetFileInformationByHandle(h,out i))throw Error("resident-file-information");return i;}
 static SafeFileHandle Open(string p,uint access,uint share){var h=CreateFileW("\\\\?\\"+p,access,share,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw Error("resident-open",e);}return h;}
 static string Canonical(SafeFileHandle h){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)throw Error("resident-final-path");string p=b.ToString();if(p.StartsWith("\\\\?\\"))p=p.Substring(4);return Full(p);}
 static string ID(INFO i){return i.volume.ToString("X8",CultureInfo.InvariantCulture)+":"+i.indexHigh.ToString("X8",CultureInfo.InvariantCulture)+i.indexLow.ToString("X8",CultureInfo.InvariantCulture);}
 static INFO Validate(SafeFileHandle h,string p,bool directory){var i=Info(h);if((i.attr&0x400)!=0)throw new InvalidOperationException("resident-reparse-refused");if(((i.attr&16)!=0)!=directory)throw new InvalidOperationException("resident-kind-mismatch");if(!directory&&(GetFileType(h)!=1||i.links!=1))throw new InvalidOperationException("resident-regular-single-link-required");if(!String.Equals(Canonical(h),Full(p),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("resident-path-resolved-elsewhere");return i;}
 static void AttrScope(uint attrs){if(attrs!=32&&attrs!=34)throw new InvalidOperationException("resident-archive-attributes-required");}
 static Record RecordOf(SafeFileHandle h,string p){var i=Validate(h,p,false);AttrScope(i.attr);return new Record{path=p,identity=ID(i),volume=i.volume.ToString("X8",CultureInfo.InvariantCulture),size=(((ulong)i.sizeHigh<<32)|i.sizeLow).ToString(CultureInfo.InvariantCulture),mtime=(((ulong)i.write.high<<32)|i.write.low).ToString(CultureInfo.InvariantCulture),attributes=i.attr,linkCount=i.links,hidden=(i.attr&2)!=0,regularFile=true,reparse=false};}
 sealed class Pins:IDisposable {
  public readonly List<SafeFileHandle> held=new List<SafeFileHandle>();public ParentRecord record;
  public Pins(string directory){try{
   directory=Full(directory);string root=Path.GetPathRoot(directory),at=root;var key=new StringBuilder();INFO last=new INFO();
   var parts=new List<string>();parts.Add(root);foreach(var part in directory.Substring(root.Length).Split('\\')){if(part.Length==0)continue;at=Path.Combine(at,part);parts.Add(at);}
   foreach(var p in parts){var h=Open(p,0x81,3);held.Add(h);last=Validate(h,p,true);string entry=Canonical(h).ToUpperInvariant()+"|"+ID(last);key.Append(entry.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(entry);}
   string digest;using(var sha=SHA256.Create()){digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(key.ToString()))).Replace("-","");}
   record=new ParentRecord{path=directory,identity=ID(last),volume=last.volume.ToString("X8",CultureInfo.InvariantCulture),ancestorKey=digest};
  }catch{Dispose();throw;}}
  public void Dispose(){for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();}
 }
 public static ParentRecord Parent(string directory){using(var p=new Pins(directory)){return p.record;}}
 public static Record Read(string path){path=Full(path);using(var p=new Pins(Path.GetDirectoryName(path)))using(var h=Open(path,0x81,3)){return RecordOf(h,path);}}
 public static Record ReadIfMissing(string path){try{return Read(path);}catch(Win32Exception e){if(e.NativeErrorCode==2||e.NativeErrorCode==3)return null;throw;}}
 static void Expect(Record r,string id,string size,string mtime,uint attrs,bool exact){AttrScope(attrs);if(String.IsNullOrEmpty(id)||r.identity!=id||r.size!=size||r.mtime!=mtime||(exact?r.attributes!=attrs:(r.attributes&~2u)!=(attrs&~2u)))throw new InvalidOperationException("resident-record-changed");}
 static void Ancestor(Pins p,string key){if(String.IsNullOrEmpty(key)||!String.Equals(p.record.ancestorKey,key,StringComparison.Ordinal))throw new InvalidOperationException("resident-ancestor-changed");}
 static void Absent(string p){uint a=GetFileAttributesW("\\\\?\\"+p);if(a!=UInt32.MaxValue)throw new InvalidOperationException("resident-name-occupied");int e=Marshal.GetLastWin32Error();if(e!=2&&e!=3)throw Error("resident-absence-unproven",e);}
 static Record Hidden(SafeFileHandle h,string p,string id,string size,string mtime,uint original,bool hidden){
  var r=RecordOf(h,p);Expect(r,id,size,mtime,original,false);uint attrs=hidden?34u:32u;if(r.attributes==attrs)return r;
  IntPtr b=Marshal.AllocHGlobal(40);try{for(int n=0;n<40;n++)Marshal.WriteByte(b,n,0);Marshal.WriteInt32(b,32,(int)attrs);if(!SetFileInformationByHandle(h,0,b,40))throw Error("resident-hidden-set");}finally{Marshal.FreeHGlobal(b);}
  r=RecordOf(h,p);Expect(r,id,size,mtime,attrs,true);return r;
 }
 static void Rename(SafeFileHandle h,string destination){byte[] name=Encoding.Unicode.GetBytes(destination);int root=IntPtr.Size==8?8:4,len=root+IntPtr.Size,start=len+4,bytes=start+name.Length+2;IntPtr b=Marshal.AllocHGlobal(bytes);try{for(int n=0;n<bytes;n++)Marshal.WriteByte(b,n,0);Marshal.WriteInt32(b,len,name.Length);Marshal.Copy(name,0,IntPtr.Add(b,start),name.Length);if(!SetFileInformationByHandle(h,3,b,(uint)bytes))throw Error("resident-no-replace-rename");}finally{Marshal.FreeHGlobal(b);}}

 public sealed class CopyResult {public string src,dest,reason,partialPath,sourceIdentity,destIdentity,sha256;public bool copied,skipped,cleanupVerified;public double copyMs;}
 static void DeleteOwned(SafeFileHandle h){IntPtr b=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(b,1);if(!SetFileInformationByHandle(h,4,b,1))throw Error("copy-owned-disposition");}finally{Marshal.FreeHGlobal(b);}}
 static string HashStream(Stream s){s.Position=0;using(var sha=SHA256.Create()){return BitConverter.ToString(sha.ComputeHash(s)).Replace("-","");}}
 // Pure path comparison; caller supplies OS-resolved known folders, not UI guesses.
 static void RejectDesktopDestination(string folder,string userDesktop,string commonDesktop){
  if(String.IsNullOrWhiteSpace(folder)||String.IsNullOrWhiteSpace(userDesktop)||String.IsNullOrWhiteSpace(commonDesktop))throw new InvalidOperationException("copy-desktop-location-unverified");
  string dest=Path.GetFullPath(folder).TrimEnd('\\','/');
  foreach(string desktop in new string[]{userDesktop,commonDesktop}){
   string known=Path.GetFullPath(desktop).TrimEnd('\\','/');
   if(String.Equals(dest,known,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("copy-desktop-destination-refused");
  }
 }
 public static CopyResult Copy(string source,string folder){
  var result=new CopyResult{src=source,cleanupVerified=true};SafeFileHandle dh=null;FileStream ds=null;bool owned=false;var clock=System.Diagnostics.Stopwatch.StartNew();
  try{
   folder=Full(folder);
   RejectDesktopDestination(folder,
    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory,Environment.SpecialFolderOption.DoNotVerify),
    Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory,Environment.SpecialFolderOption.DoNotVerify));
   source=Full(source);string dest=Full(Path.Combine(folder,Path.GetFileName(source)));result.dest=dest;
   if(String.Equals(source,dest,StringComparison.OrdinalIgnoreCase)){result.skipped=true;result.reason="same-path";return result;}
   using(var sourceParents=new Pins(Path.GetDirectoryName(source)))using(var destParents=new Pins(folder))using(var sh=Open(source,0x80000080,1)){
    var original=RecordOf(sh,source);result.sourceIdentity=original.identity;
    uint exists=GetFileAttributesW("\\\\?\\"+dest);if(exists!=UInt32.MaxValue){result.skipped=true;result.reason="destination-exists";return result;}int absentError=Marshal.GetLastWin32Error();if(absentError!=2)throw Error("copy-destination-check",absentError);
    string partial=Full(Path.Combine(folder,".okiba-copy-"+Guid.NewGuid().ToString("N")+".partial"));result.partialPath=partial;
    dh=CreateFileW("\\\\?\\"+partial,0xC0010180,1,IntPtr.Zero,1,0x00200022,IntPtr.Zero);
    if(dh.IsInvalid)throw Error("copy-create-exclusive");owned=true;result.cleanupVerified=false;
    var created=RecordOf(dh,partial);result.destIdentity=created.identity;
    using(var input=new FileStream(sh,FileAccess.Read,1024*1024,false)){
     ds=new FileStream(dh,FileAccess.ReadWrite,1024*1024,false);
     input.CopyTo(ds,1024*1024);ds.Flush(true);
     string sourceHash=HashStream(input),destHash=HashStream(ds);
     if(sourceHash!=destHash||ds.Length!=input.Length)throw new InvalidOperationException("copy-content-mismatch");
     result.sha256=sourceHash;
     Expect(RecordOf(sh,source),original.identity,original.size,original.mtime,original.attributes,true);
     var current=RecordOf(dh,partial);if(current.identity!=created.identity||current.size!=original.size)throw new InvalidOperationException("copy-destination-changed");
     Absent(dest);Rename(dh,dest);result.partialPath=dest;
     current=RecordOf(dh,dest);Hidden(dh,dest,current.identity,current.size,current.mtime,current.attributes,false);
     current=RecordOf(dh,dest);if(current.hidden||current.attributes!=32||current.identity!=created.identity||current.size!=original.size)throw new InvalidOperationException("copy-visibility-unverified");
     Expect(RecordOf(sh,source),original.identity,original.size,original.mtime,original.attributes,true);
     result.copied=true;result.cleanupVerified=true;result.partialPath=null;
    }
   }
  }catch(Exception e){result.reason=e.Message;result.copied=false;if(!owned)result.partialPath=null;if(owned&&dh!=null&&!dh.IsInvalid&&!dh.IsClosed){try{if(ID(Info(dh))!=result.destIdentity)throw new InvalidOperationException("copy-cleanup-identity-mismatch");DeleteOwned(dh);result.cleanupVerified=true;result.partialPath=null;}catch(Exception cleanup){result.reason+="; cleanup-unverified:"+cleanup.Message;}}}
  finally{if(ds!=null)ds.Dispose();else if(dh!=null)dh.Dispose();clock.Stop();result.copyMs=clock.Elapsed.TotalMilliseconds;}
  return result;
 }
}
