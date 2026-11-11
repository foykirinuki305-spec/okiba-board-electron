'use strict';
// Hosted-only diagnostic copy. No production helper modifications or icon writes.
const fs=require('fs'),path=require('path'),os=require('os');
function instrument(source){
 const anchor=' public static ShellReadRow[] ReadShellBatch(string generation=""){';
 if(source.split(anchor).length!==2)throw Error('spacing diagnostic anchor mismatch');
 const method=` public static int[] ReadSpacingDiagnostic(){
  using(var s=new Session()){
   IntPtr p=Marshal.AllocCoTaskMem(8);
   try {Marshal.WriteInt32(p,0,0);Marshal.WriteInt32(p,4,0);int current=s.Folder.GetSpacing(p);int x=Marshal.ReadInt32(p,0),y=Marshal.ReadInt32(p,4);
    Marshal.WriteInt32(p,0,0);Marshal.WriteInt32(p,4,0);int def=s.Folder.GetDefaultSpacing(p);return new int[]{current,x,y,def,Marshal.ReadInt32(p,0),Marshal.ReadInt32(p,4)};
   }finally{Marshal.FreeCoTaskMem(p);}
  }
 }
`;
 source=source.replace(anchor,method+anchor);
 const wire="'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot }";
 if(source.split(wire).length!==2)throw Error('snapshot diagnostic anchor mismatch');
 return source.replace(wire,"'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot; try {$result.spacingDiagnostic=@([OkibaFolderView]::ReadSpacingDiagnostic())}catch{$result.spacingDiagnosticError=$_.Exception.Message} }");
}
if(require.main===module){
 if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('hosted only');
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-dpi-metrics-'));
 fs.cpSync(path.join(root,'scripts'),path.join(temp,'scripts'),{recursive:true});
 const helper=path.join(temp,'scripts','shell-helper.ps1');fs.writeFileSync(helper,instrument(fs.readFileSync(helper,'utf8')));process.stdout.write(helper);
}
module.exports={instrument};
