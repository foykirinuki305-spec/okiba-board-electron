// Real native execution is restricted to disposable hosted Windows CI.
'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');const {fork,execFile}=require('child_process');const run=require('util').promisify(execFile);
const {build,ownedTempDirectory}=require('./unknown-grid-lease-copy-ci');const {createShellHelperClient}=require('../lib/shellhelper');const {planCalibration}=require('../lib/desktop-calibration');const {sameSnapshot}=require('../lib/safe-desktop');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),report={passed:false,cleanupVerified:false,scope:'prepare/probe/fixed samples/abort only; success commit unsupported; 100% only, not mixed-DPI',events:[]};
const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-unknown-ci-')),copy=path.join(temp,'okiba-unknown-ci-copy');fs.mkdirSync(copy);build(root,copy);
 // Drop one response after a completed mutation; only in a generated copy and only in the dedicated case.
 const hp=path.join(copy,'scripts/shell-helper.ps1');let source=fs.readFileSync(hp,'utf8');const anchor='    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 8))';assert.equal(source.split(anchor).length-1,1);source=source.replace(anchor,"    if($env:OKIBA_UNKNOWN_DROP_REPLY -eq '1' -and $req.cmd -ceq 'leaseUnknownBeginCalibration'){Start-Sleep -Seconds 30}\n"+anchor);fs.writeFileSync(hp,source);
 // One-shot fault after actual Hidden mutation but before its verification, with Snap still OFF.
 const extension=path.join(copy,'scripts/unknown-grid-lease-ci.ps1');let ext=fs.readFileSync(extension,'utf8');const hideAnchor='Lease-SetHidden $record $true}';assert.equal(ext.split(hideAnchor).length-1,1);
 ext=ext.replace(hideAnchor,`Lease-SetHidden $record $true
 if($env:OKIBA_UNKNOWN_HIDE_FAULT -and -not [IO.File]::Exists($env:OKIBA_UNKNOWN_HIDE_FAULT)){
  $faultSnapshot=Unknown-Current $r;if($r.flagState -cne 'off' -or ($faultSnapshot.folderFlags -band 4) -ne 0){throw 'hide-fault-not-off'}
  $faultRecord=Lease-CheckRecord $record;if(-not $faultRecord.hidden){throw 'hide-fault-not-hidden'}
  [IO.File]::WriteAllText($env:OKIBA_UNKNOWN_HIDE_FAULT,(@{flagState=$r.flagState;folderFlags=$faultSnapshot.folderFlags;hidden=$faultRecord.hidden}|ConvertTo-Json -Compress));Start-Sleep -Seconds 30
 }
 }`);fs.writeFileSync(extension,ext);
 const observer=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')],timeoutMs:15000});
 const owned=[],children=[];let baseline,unsafe=false;
 async function req(cmd,payload={}){const r=await observer.request(cmd,payload,{timeoutMs:15000});assert(r.ok,JSON.stringify(r));return r.result;}
 function guard(s){assert(s.ok);if(baseline){assert.equal(s.folderFlags,baseline.folderFlags);for(const old of baseline.icons){const i=s.icons.find(i=>i.identity===old.identity);assert(i&&i.x===old.x&&i.y===old.y,'old icon changed');}}}
 async function stable(phase){let previous;const deadline=Date.now()+15000;do{const s=await req('desktopSnapshot');note(phase,s);if(s.ok){guard(s);if(previous&&sameSnapshot(previous,s))return s;previous=s;}else{assert(s.reason==='desktop-changing','snapshot failure '+JSON.stringify(s));previous=null;}await sleep(100);}while(Date.now()<deadline);throw Error('stable timeout '+phase);}
 const receive=(child,timeout=90000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',on);reject(Error('owner message timeout'));},timeout);function on(m){clearTimeout(timer);child.off('message',on);resolve(m);}child.on('message',on);});
 async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,sleep(5000)]);assert(child.exitCode!==null||child.signalCode!==null,'owner stop unconfirmed');}
 async function terminal(journalDir){const deadline=Date.now()+60000;do{const files=fs.existsSync(journalDir)?fs.readdirSync(journalDir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)):[];for(const file of files){const j=JSON.parse(fs.readFileSync(path.join(journalDir,file),'utf8'));if(j.phase==='aborted')return j;if(j.phase==='blocked')throw Error('blocked recovery '+JSON.stringify(j));}await sleep(100);}while(Date.now()<deadline);throw Error('abort journal timeout');}
 try{
  baseline=await stable('baseline');assert(baseline.snap&&!baseline.autoArrange);assert.equal(baseline.areas.length,1);assert.equal(baseline.areas[0].scale,100);
  for(const scenario of ['explicit-abort','owner-death-probe','owner-death-sample','reply-loss','hide-reply-loss']){
   const caseDir=path.join(temp,scenario);fs.mkdirSync(caseDir);const journalDir=path.join(caseDir,'journal');const name='OkibaUnknown-'+crypto.randomBytes(6).toString('hex')+'.txt',staging=path.join(caseDir,name),dest=path.join(desktop,name);fs.writeFileSync(staging,'unknown lease owned fixture');
   const initial=await req('readHiddenFile',{path:staging});assert(initial.ok);const hidden=await req('setHiddenFile',{path:staging,expectedIdentity:initial.identity,expectedHidden:false,hidden:true});assert(hidden.ok);const moved=await req('moveNoReplace',{source:staging,destination:dest});assert(moved.ok);owned.push(dest);
   const before=await stable('before-case');assert.equal(before.icons.length,baseline.icons.length);const attrs=await req('readHiddenFile',{path:dest});assert(attrs.ok&&attrs.hidden);const hash=crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
   const plan=planCalibration({snapshot:before,areaIndex:0,probeId:dest,maxSpacing:{x:Math.ceil(before.sx*1.25),y:Math.ceil(before.sy*1.25)}});assert(plan.ok);
   const metadata=path.join(caseDir,'board.json');fs.writeFileSync(metadata,'{"unchanged":true}');const metadataBefore=fs.readFileSync(metadata);
   const scope={version:2,kind:'samepath-hidden-unknown-grid-ci',desktop,snapshot:before,targetAreaIndex:0,plan,items:[{path:dest,destination:dest,hidden:true,fileIdentity:attrs.identity}],metadataPaths:[metadata]};
   const owner=fork(path.join(root,'tools/unknown-grid-lease-host-ci.js'),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,OKIBA_UNKNOWN_GRID_CI:'1'}});children.push(owner);
   let response,deathProcesses;try{const pending=receive(owner);owner.send({cmd:'run',spec:{copy,scope,scenario,journalDir,hideFaultMarker:path.join(caseDir,'hide-fault.json')}});response=await pending;note('owner-response',{scenario,response});assert.notEqual(response.phase,'error',response.error);
    if(response.phase==='kill-owner'){
     const pid=response.watchdog.pid;assert(Number.isInteger(pid)&&pid>0);
     const script='$p=[Diagnostics.Process]::GetProcessById([int]$env:OKIBA_CHILD_PID);$null=$p.Handle;$p.StartTime.ToUniversalTime().Ticks.ToString()';
     const birth=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,env:{...process.env,OKIBA_CHILD_PID:String(pid)}})).stdout.trim();assert(/^\d+$/.test(birth));
     deathProcesses=[{pid,started:birth},...response.status.helper.history];assert(deathProcesses.every(p=>Number.isInteger(p.pid)&&p.pid>0&&/^\d+$/.test(p.started)));
     await stop(owner);
    }else{assert(response.aborted?.ok);assert.equal(response.status.phase,'aborted');if(['reply-loss','hide-reply-loss'].includes(scenario)){assert(response.status.helper.cumulativeRestartCount>=1);assert(response.status.helper.history.some(h=>h.stoppedConfirmed));}}
    if(scenario==='hide-reply-loss'){const fault=JSON.parse(fs.readFileSync(path.join(caseDir,'hide-fault.json'),'utf8'));assert(fault.hidden&&fault.flagState==='off'&&(fault.folderFlags&4)===0);note('hide-fault-proof',fault);}
    const j=await terminal(journalDir);note('terminal',{scenario,journal:j});
    if(deathProcesses){
     try{const proof=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/wait-owned-processes-ci.ps1')],{windowsHide:true,timeout:60000,env:{...process.env,OKIBA_CHILDREN:JSON.stringify(deathProcesses)}})).stdout);note('owner-death-exit-proof',{scenario,proof});assert(proof.ok&&proof.processes.length===deathProcesses.length&&proof.processes.every(p=>p.stopConfirmed));}
     catch(e){note('owner-death-exit-error',{scenario,message:e.message,stdout:e.stdout,stderr:e.stderr});throw e;}
    }
    const after=await stable('after-case');assert.equal(after.icons.length,before.icons.length);assert.deepEqual(after.icons.map(i=>[i.identity,i.x,i.y]).sort(),before.icons.map(i=>[i.identity,i.x,i.y]).sort());const current=await req('readHiddenFile',{path:dest});for(const k of ['identity','attributes','hidden','size','mtime'])assert.equal(current[k],attrs[k]);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'),hash);assert(fs.readFileSync(metadata).equals(metadataBefore));
    if(owner.connected){const closing=receive(owner,20000);owner.send({cmd:'close'});assert((await closing).result.ok);await stop(owner);}
   }catch(e){unsafe=true;throw e;}
  }
  report.passed=true;
 }finally{
  // Never cleanup files while an unverified live watchdog might still mutate them.
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){try{await stop(child);}catch{unsafe=true;}}}
  if(!unsafe){for(const file of owned){assert.equal(path.dirname(file),desktop);assert(path.basename(file).startsWith('OkibaUnknown-'));if(fs.existsSync(file))fs.unlinkSync(file);}if(baseline){const after=await stable('cleanup');assert.deepEqual(after.icons.map(i=>[i.identity,i.x,i.y]).sort(),baseline.icons.map(i=>[i.identity,i.x,i.y]).sort());report.cleanupVerified=true;}}
  if(!await observer.stopAndWait(10000))unsafe=true;
  const evidence=path.join(root,'unknown-grid-lease-slice-journals');fs.mkdirSync(evidence,{recursive:true});for(const scenario of ['explicit-abort','owner-death-probe','owner-death-sample','reply-loss','hide-reply-loss']){const journal=path.join(temp,scenario,'journal');if(fs.existsSync(journal))fs.cpSync(journal,path.join(evidence,scenario),{recursive:true});}
  if(unsafe){report.passed=false;report.cleanupError='watchdog recovery unverified; no blind cleanup/restoration';}
  fs.writeFileSync(path.join(root,'unknown-grid-lease-slice-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupError);
  const cleanupRoot=ownedTempDirectory(temp);fs.rmSync(cleanupRoot,{recursive:true,force:true});
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'unknown-grid-lease-slice-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
