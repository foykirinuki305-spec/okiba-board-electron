'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const {diagnosticCopy,instrumentResident}=require('./resident-diagnostic-copy-ci');
const source=path.resolve(__dirname,'../scripts/resident-lease.ps1'),before=fs.readFileSync(source),d=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-resident-diag-pure-'));
try{
 const h=diagnosticCopy(path.resolve(__dirname,'../scripts/shell-helper.ps1'),d),file=path.join(path.dirname(h),'resident-lease.ps1'),s=fs.readFileSync(file,'utf8');
 for(const marker of ['before-restore','after-restore','rollback-start','rollback-verified',"Resident-CITrace 'visibility'",'AddSeconds(15)','$stable -ge 2','Lease-Guard $r $s'])assert(s.includes(marker));
 assert(s.indexOf("Resident-CITrace 'after-restore'")<s.indexOf('$s=Resident-WaitRestoredInvisible $r $expectedFlags'));
 assert(!s.includes('Resident-CIWaitVisibility'));assert.equal((s.match(/function Resident-WaitRestoredInvisible\(/g)||[]).length,1);
 for(const marker of ['Resident-IsDisappearanceReadFailure $_','$failures -gt 3','Resident-AssertRestoredSources $r;Resident-AssertExactSessionFlags $r $expectedFlags',"Resident-CITrace 'disappearance-read-error'"])assert(s.includes(marker));
 // Each source anchor must match exactly once: missing/duplicated anchors fail closed.
 for(const anchor of [' $initial=Lease-Snapshot;Resident-Validate $r $initial;',
 '  $null=Lease-Guard $r (Lease-Snapshot);$n=Resident-Locate $i',
 '  else{$null=[OkibaResidentFiles]::RestoreUnmoved($i.source,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID)}',
 '  $selected=Lease-Guard $r $s','   $stable=0;$failures++',' Lease-MarkRestored $r;return']){
  const original=before.toString('utf8');assert.throws(()=>instrumentResident(original.replace(anchor,''),'trace'),/anchor drift/);assert.throws(()=>instrumentResident(original+'\n'+anchor,'trace'),/anchor drift/);
 }
 assert(fs.readFileSync(path.join(path.dirname(h),'snap-lease.ps1')).equals(fs.readFileSync(path.resolve(__dirname,'../scripts/snap-lease.ps1'))));
 assert(fs.readFileSync(source).equals(before));assert.throws(()=>diagnosticCopy(path.resolve(__dirname,'../scripts/shell-helper.ps1'),d),/destination exists/);
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($env:OKIBA_PARSE_FILE,[ref]$t,[ref]$e);if($e.Count){$e|ConvertTo-Json;exit 1};exit 0'],{windowsHide:true,env:{...process.env,OKIBA_PARSE_FILE:file}});
 console.log('resident diagnostic copy PASS; source unchanged, AST only, native not invoked');
}finally{assert(path.basename(d).startsWith('okiba-resident-diag-pure-'));fs.rmSync(d,{recursive:true,force:true});}
