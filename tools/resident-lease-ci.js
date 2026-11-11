'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto'),{execFile,fork}=require('child_process'),{promisify}=require('util');
const {createDesktopLeaseClient}=require('../lib/desktop-lease-client'),{createShellHelperClient}=require('../lib/shellhelper'),{runLease}=require('../lib/desktop-snap-lease-controller'),{planDesktop,sameSnapshot}=require('../lib/safe-desktop');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),run=promisify(execFile),report={passed:false,cleanupVerified:false,cases:[],scope:'Hosted native resident new kind; main default unchanged'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-resident-ci-'))),tag='OkibaResident-'+crypto.randomBytes(8).toString('hex'),owned=[],hosts=[];
 const observer=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')],timeoutMs:20000});
 let client=null,unsafe=false,baseline;
 async function snapshot(){const r=await observer.request('desktopSnapshot');assert(r.ok&&r.result?.ok,JSON.stringify(r));return r.result;}
 function oldGuard(s){if(baseline){for(const i of baseline.icons)assert(s.icons.some(n=>n.identity===i.identity&&n.x===i.x&&n.y===i.y),'existing icon changed');assert.equal(s.folderFlags,baseline.folderFlags);}}
 async function stable(){let previous;for(let i=0;i<100;i++){const s=await snapshot();oldGuard(s);if(previous&&sameSnapshot(previous,s))return s;previous=s;await sleep(100);}throw Error('unstable snapshot');}
 async function attributes(paths,desired){const code="$ErrorActionPreference='Stop';$paths=ConvertFrom-Json $env:OKIBA_OWN_PATHS;foreach($p in $paths){if($env:OKIBA_OWN_ATTR -ne ''){[IO.File]::SetAttributes($p,[IO.FileAttributes][int]$env:OKIBA_OWN_ATTR)}};@($paths|ForEach-Object{[int][IO.File]::GetAttributes($_)})|ConvertTo-Json -Compress";const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,env:{...process.env,OKIBA_OWN_PATHS:JSON.stringify(paths),OKIBA_OWN_ATTR:desired===undefined?'':String(desired)}});return JSON.parse(r.stdout);}
 async function returnedToBaseline(){for(let i=0;i<100;i++){const s=await stable();if(s.icons.length===baseline.icons.length)return;await sleep(100);}throw Error('owned Desktop items remain');}
 try{
  baseline=await stable();assert(baseline.snap&&!baseline.autoArrange&&baseline.identityVersion===1);
  for(const [index,name] of ['success32','success34','abort-placed','abort-after-restore','fault-after-hide','fault-first-move','hang-first-move','owner-death','source-occupied','cached-destination'].entries()){
   const dir=path.join(temp,name);fs.mkdirSync(dir);const attrs=name==='success34'?34:32;
   const items=Array.from({length:3},(_,n)=>{const base=tag+'-'+index+'-'+n+'.txt',source=path.join(dir,base),dest=path.join(desktop,base);fs.writeFileSync(source,'resident fixture '+index+' '+n);owned.push(dest);return {name:base,path:source,dest,offset:[0,n]};});
   await attributes(items.map(i=>i.path),attrs);const contents=items.map(i=>fs.readFileSync(i.path));
   let before=await stable(),plan=planDesktop({snapshot:before,items,automatic:true});assert(plan.ok,JSON.stringify(plan));
   let helperPath=path.join(root,'scripts/shell-helper.ps1');
   if(name.startsWith('fault-')||name==='hang-first-move'){
    const hd=path.join(dir,'helper');fs.mkdirSync(hd);for(const f of ['shell-helper.ps1','snap-lease.ps1','resident-lease.ps1','resident-file-native.cs'])fs.copyFileSync(path.join(root,'scripts',f),path.join(hd,f));helperPath=path.join(hd,'shell-helper.ps1');
    if(name==='fault-first-move'||name==='hang-first-move'){
     const f=path.join(hd,'resident-lease.ps1');let s=fs.readFileSync(f,'utf8');const marker='  $null=[OkibaResidentFiles]::Stage($i.source,$i.destination,$i.identity,$i.size,$i.mtime,[uint32]$i.originalAttributes,$i.sourceParentID,$i.destParentID)';assert.equal(s.split(marker).length-1,1);s=s.replace(marker,marker+"\n  if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'};"+(name==='hang-first-move'?'Start-Sleep -Seconds 60':"throw 'CI after first stage'"));fs.writeFileSync(f,s);
    }else{
     const f=path.join(hd,'resident-file-native.cs');let s=fs.readFileSync(f,'utf8');const marker='Hidden(h,from,id,size,mtime,original,true);Expect';assert.equal(s.split(marker).length-1,1);s=s.replace(marker,'Hidden(h,from,id,size,mtime,original,true);if(!restore){if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");throw new InvalidOperationException("CI after hide before rename");}Expect');fs.writeFileSync(f,s);
    }
   }
   const journalDir=path.join(dir,'journal');client=createDesktopLeaseClient({journalDir,helperTimeoutMs:name==='hang-first-move'?4000:15000,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperPath]}});assert((await client.ready()).ok);
   let targets=plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest}));let area=before.areas.findIndex(a=>targets.every(t=>t.x>=a.left&&t.x<a.right&&t.y>=a.top&&t.y<a.bottom));
   const metadata=path.join(dir,'board.json'),beforeText='{"resident":true}',afterText='{"resident":false}';fs.writeFileSync(metadata,beforeText);const receipts=[{path:metadata,beforeHash:hash(beforeText),afterHash:hash(afterText)}];
   let scope=await client.prepareScope({kind:'resident-archive-samevolume',desktop,items:items.map(i=>({path:i.path,destination:i.dest})),snapshot:before,targetAreaIndex:area,targets,metadataPaths:[metadata]});
   const adapter=client.adapter(async()=>{const tmp=metadata+'.tmp';fs.writeFileSync(tmp,afterText);fs.renameSync(tmp,metadata);});
   let cachedGuard=null;
   if(name==='cached-destination'){
    const seeded=await runLease({scope,receipts,adapter});assert(seeded.ok,JSON.stringify(seeded));const seededCell={x:targets[0].x,y:targets[0].y};
    for(const i of items){assert(fs.existsSync(i.dest)&&!fs.existsSync(i.path));fs.renameSync(i.dest,i.path);}await returnedToBaseline();await attributes(items.map(i=>i.path),attrs);fs.writeFileSync(metadata,beforeText);
    const guardName=tag+'-cached-guard.txt',guardSource=path.join(dir,guardName),guardDest=path.join(desktop,guardName);fs.writeFileSync(guardSource,'owned cached-cell guard');owned.push(guardDest);
    const guardBefore=await stable(),gArea=guardBefore.areas.find(a=>seededCell.x>=a.left&&seededCell.x<a.right&&seededCell.y>=a.top&&seededCell.y<a.bottom),g=gArea.grid;
    const guardItem={name:guardName,path:guardSource,dest:guardDest,offset:[0,0]},guardPlan=planDesktop({snapshot:guardBefore,items:[guardItem],point:{x:seededCell.x+g.sx/2,y:seededCell.y+g.sy/2}});assert(guardPlan.ok);assert.equal(guardPlan.targets[0].x,seededCell.x);assert.equal(guardPlan.targets[0].y,seededCell.y);
    fs.renameSync(guardSource,guardDest);const placed=await observer.request('positionDesktopPlan',{snapshot:guardBefore,targets:guardPlan.targets.map(t=>({...t,path:guardDest})),buffer:guardPlan.buffer});assert(placed.ok&&placed.result?.ok,JSON.stringify(placed));
    before=await stable();const icon=before.icons.find(i=>i.path&&path.resolve(i.path).toLowerCase()===guardDest.toLowerCase());assert(icon&&icon.x===seededCell.x&&icon.y===seededCell.y);cachedGuard={...icon,dest:guardDest};
    plan=planDesktop({snapshot:before,items,automatic:true});assert(plan.ok);targets=plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest}));area=before.areas.findIndex(a=>targets.every(t=>t.x>=a.left&&t.x<a.right&&t.y>=a.top&&t.y<a.bottom));
    scope=await client.prepareScope({...scope,snapshot:before,targetAreaIndex:area,targets});report.cachedSeed={seededCell,guard:cachedGuard,finalTargets:targets};
   }
   let result;
   if(name.startsWith('success')||name.startsWith('fault-')||name==='hang-first-move'||name==='cached-destination')result=await runLease({scope,receipts,adapter});
   else if(name==='owner-death'){
    unsafe=true;
    const host=fork(path.join(root,'tools/desktop-lease-protocol-host-ci.js'),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});hosts.push(host);
    const answer=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('resident owner timeout')),120000);host.once('message',m=>{clearTimeout(timer);resolve(m);});});
    const deathJournal=path.join(dir,'death-journal');host.send({cmd:'run',spec:{kind:'resident-archive-samevolume',desktop,journalDir:deathJournal,helperPath,commitCase:'kill-reveal',selected:scope.items,baseline:before,targetAreaIndex:area,targets,receipts}});
    const m=await answer;assert.equal(m.phase,'revealed',JSON.stringify(m));report.ownerDeath={message:m};
    const birthScript="$p=[Diagnostics.Process]::GetProcessById([int]$env:OKIBA_CHILD_PID);$null=$p.Handle;$p.StartTime.ToUniversalTime().Ticks.ToString()";
    const birth=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',birthScript],{windowsHide:true,env:{...process.env,OKIBA_CHILD_PID:String(m.watchdog.pid)}})).stdout.trim();
    const dead=new Promise(r=>host.once('exit',r));host.kill();await Promise.race([dead,sleep(5000)]);assert(host.exitCode!==null||host.signalCode!==null);
    let jr;for(let n=0;n<300;n++){const files=fs.existsSync(deathJournal)?fs.readdirSync(deathJournal).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)):[];if(files.length){jr=JSON.parse(fs.readFileSync(path.join(deathJournal,files[0]),'utf8'));if(['aborted','blocked','released'].includes(jr.phase))break;}await sleep(100);}assert.equal(jr?.phase,'aborted',JSON.stringify(jr));report.ownerDeath.journal=jr;
    try {
     const proof=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/wait-owned-processes-ci.ps1')],{windowsHide:true,timeout:40000,env:{...process.env,OKIBA_CHILDREN:JSON.stringify([{pid:m.watchdog.pid,started:birth},m.status.helper.history.at(-1)])}});
     report.ownerDeath.processExit=JSON.parse(proof.stdout);assert(report.ownerDeath.processExit.ok);assert.equal(report.ownerDeath.processExit.processes.length,2);assert(report.ownerDeath.processExit.processes.every(p=>p.stopConfirmed===true));
    } catch(e) {report.ownerDeath.processExitError={message:e.message,code:e.code,signal:e.signal,stdout:e.stdout,stderr:e.stderr};throw e;}
    unsafe=false;result={ok:true,state:'aborted',ownerDeathVerified:true};
   }
   else{
    const p=await adapter.prepare(scope);assert(p.ok,JSON.stringify(p));assert((await adapter.revealAndPlace(p.token)).ok);if(name==='abort-after-restore')assert((await adapter.restoreAndVerify(p.token)).ok);
    if(name==='source-occupied'){fs.writeFileSync(items[1].path,'foreign owned fixture');const refused=await adapter.abort(p.token);assert(!refused.ok);assert.equal(fs.readFileSync(items[1].path,'utf8'),'foreign owned fixture');fs.unlinkSync(items[1].path);}
    result=await adapter.abort(p.token);
   }
   const status=await client.status();if(name==='hang-first-move'){assert(status.helper.cumulativeRestartCount>=1);const h=status.helper.history;assert(h.length>=2&&h.at(-2).stoppedConfirmed);assert(h.at(-2).pid!==h.at(-1).pid||h.at(-2).started!==h.at(-1).started);}report.cases.push({name,result,status});console.log('resident-case '+JSON.stringify(report.cases.at(-1)));
   if(name.startsWith('success')||name==='cached-destination'){assert(result.ok,JSON.stringify(result));assert.equal(fs.readFileSync(metadata,'utf8'),afterText);for(const [n,i] of items.entries()){assert(!fs.existsSync(i.path));assert(fs.readFileSync(i.dest).equals(contents[n]));}assert.deepEqual(await attributes(items.map(i=>i.dest)),[32,32,32]);}
   else{if(name.startsWith('fault-')||name==='hang-first-move')assert(!result.ok&&result.resolution?.state==='aborted',JSON.stringify(result));else assert(result.ok&&result.state==='aborted',JSON.stringify(result));assert.equal(fs.readFileSync(metadata,'utf8'),beforeText);for(const [n,i] of items.entries()){assert(!fs.existsSync(i.dest));assert(fs.readFileSync(i.path).equals(contents[n]));}assert.deepEqual(await attributes(items.map(i=>i.path)),[attrs,attrs,attrs]);}
   if(cachedGuard){const now=await stable();assert(now.icons.some(i=>i.identity===cachedGuard.identity&&i.x===cachedGuard.x&&i.y===cachedGuard.y),'cached guard displaced');assert.equal(status.helper.generation,1);report.cachedGuardUnchanged=true;}
   assert((await client.close()).ok);client=null;if(cachedGuard){assert.equal(fs.readFileSync(cachedGuard.dest,'utf8'),'owned cached-cell guard');fs.unlinkSync(cachedGuard.dest);}for(const i of items){if(fs.existsSync(i.dest)){assert.equal(path.dirname(i.dest),desktop);assert(path.basename(i.dest).startsWith(tag));fs.unlinkSync(i.dest);}}
   await returnedToBaseline();
  }
  report.passed=true;
 }catch(e){report.error=String(e.stack||e);if(client){const s=await client.status();report.failedStatus=s;if(!s.ok||s.unsafe||!['idle','released','aborted'].includes(s.phase))unsafe=true;else{const c=await client.close();unsafe=unsafe||!c.ok;client=null;}}throw e;
 }finally{
  for(const h of hosts){if(h.exitCode===null&&h.signalCode===null){const exited=new Promise(r=>h.once('exit',r));h.kill();await Promise.race([exited,sleep(5000)]);if(h.exitCode===null&&h.signalCode===null)unsafe=true;}}
  if(!unsafe){for(const file of owned){assert.equal(path.dirname(file),desktop);assert(path.basename(file).startsWith(tag));if(fs.existsSync(file))fs.unlinkSync(file);}if(baseline){await returnedToBaseline();report.cleanupVerified=true;}}
  assert(await observer.stopAndWait(10000));fs.writeFileSync(path.join(root,'resident-lease-ci.json'),JSON.stringify(report,null,2));
  // Preserve exact own records and journals as evidence before any TEMP cleanup.
  fs.cpSync(temp,path.join(root,'resident-lease-ci-journals'),{recursive:true});
  if(!unsafe){assert(path.basename(temp).startsWith('okiba-resident-ci-'));fs.rmSync(temp,{recursive:true,force:true});}
 }
}
main().catch(e=>{report.passed=false;report.error=String(e.stack||e);fs.writeFileSync(path.join(root,'resident-lease-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
