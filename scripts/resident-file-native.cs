// Resident lease native adapter. No Desktop/Shell setting or positioning APIs.
// Narrow scope: local same-volume regular single-link files with attributes 32/34.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OkibaResidentFiles {
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
 static Record Move(string from,string to,string id,string size,string mtime,uint original,string fromKey,string toKey,bool restore){
  from=Full(from);to=Full(to);AttrScope(original);if(String.Equals(from,to,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("resident-same-path");
  using(var a=new Pins(Path.GetDirectoryName(from)))using(var b=new Pins(Path.GetDirectoryName(to))){Ancestor(a,fromKey);Ancestor(b,toKey);if(a.record.volume!=b.record.volume)throw new InvalidOperationException("resident-cross-volume-refused");
   using(var h=Open(from,0x10181,1)){
    var r=RecordOf(h,from);Expect(r,id,size,mtime,original,!restore);if(r.volume!=b.record.volume)throw new InvalidOperationException("resident-volume-mismatch");Absent(to);
    Hidden(h,from,id,size,mtime,original,true);Expect(RecordOf(h,from),id,size,mtime,34,true);Absent(to);Rename(h,to);
    r=RecordOf(h,to);Expect(r,id,size,mtime,34,true);Absent(from);
    if(restore)r=Hidden(h,to,id,size,mtime,original,(original&2)!=0);
    return r;
   }
  }
 }
 public static Record Stage(string source,string dest,string id,string size,string mtime,uint originalAttrs,string sourceAncestorKey,string destAncestorKey){return Move(source,dest,id,size,mtime,originalAttrs,sourceAncestorKey,destAncestorKey,false);}
 public static Record RestoreMoved(string dest,string source,string id,string size,string mtime,uint originalAttrs,string sourceAncestorKey,string destAncestorKey){return Move(dest,source,id,size,mtime,originalAttrs,destAncestorKey,sourceAncestorKey,true);}
 public static Record RestoreUnmoved(string source,string id,string size,string mtime,uint originalAttrs,string sourceAncestorKey){source=Full(source);using(var p=new Pins(Path.GetDirectoryName(source))){Ancestor(p,sourceAncestorKey);using(var h=Open(source,0x181,1)){Expect(RecordOf(h,source),id,size,mtime,originalAttrs,false);return Hidden(h,source,id,size,mtime,originalAttrs,(originalAttrs&2)!=0);}}}
}
