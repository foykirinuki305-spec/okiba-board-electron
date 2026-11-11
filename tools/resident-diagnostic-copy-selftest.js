'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const {diagnosticCopy}=require('./resident-diagnostic-copy-ci');
const source=path.resolve(__dirname,'../scripts/resident-lease.ps1'),before=fs.readFileSync(source),d=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-resident-diag-pure-'));
try{
 const h=diagnosticCopy(path.resolve(__dirname,'../scripts/shell-helper.ps1'),d),file=path.join(path.dirname(h),'resident-lease.ps1'),s=fs.readFileSync(file,'utf8');
 for(const marker of ['before-restore','after-restore','rollback-start','rollback-verified',"Resident-CITrace 'visibility'",'AddSeconds(15)','$stable -ge 2','Lease-Guard $r $s'])assert(s.includes(marker));
 assert(s.indexOf("Resident-CITrace 'after-restore'")<s.indexOf('$s=Resident-CIWaitVisibility'));
 assert(fs.readFileSync(source).equals(before));assert.throws(()=>diagnosticCopy(path.resolve(__dirname,'../scripts/shell-helper.ps1'),d),/destination exists/);
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($env:OKIBA_PARSE_FILE,[ref]$t,[ref]$e);if($e.Count){$e|ConvertTo-Json;exit 1};exit 0'],{windowsHide:true,env:{...process.env,OKIBA_PARSE_FILE:file}});
 console.log('resident diagnostic copy PASS; source unchanged, AST only, native not invoked');
}finally{assert(path.basename(d).startsWith('okiba-resident-diag-pure-'));fs.rmSync(d,{recursive:true,force:true});}
