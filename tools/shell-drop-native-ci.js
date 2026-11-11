'use strict';
// Research only: each case gets a disposable VM. No file rollback, no old-icon writes.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process'),assert=require('assert/strict'),{promisify}=require('util');
const {hosted}=require('./packaged-preview-policy-ci');hosted(process.env,process.platform);
const {createShellHelperClient}=require('../lib/shellhelper'),{planDesktop,sameSnapshot}=require('../lib/safe-desktop'),{stableSnapshot}=require('./stable-snapshot-ci');
const kind=process.env.OKIBA_SHELL_DROP_CASE;assert(['resident','hidden','cancel'].includes(kind));
const root=path.resolve(__dirname,'..'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-shell-drop-'))),folder=path.join(temp,'files'),tag='OkibaShellDrop-'+crypto.randomBytes(12).toString('hex'),run=promisify(cp.execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={kind,temp,tag,completed:false,passed:false,suitable:false,noCleanup:true,noCleanupReason:'Explorer quiescence is not inferred from DoDragDrop or source exit. Disposable hosted VM retains owned files; no source double deletion or old-position restoration.'};
let client,baseline,records=[];
(async()=>{try{
 fs.mkdirSync(folder);fs.writeFileSync(path.join(temp,'fixture.json'),JSON.stringify({tag,kind}),{flag:'wx'});
 client=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')]});
 async function request(cmd,payload={}){const r=await client.request(cmd,payload);assert(r.ok&&r.result?.ok,JSON.stringify(r));return r.result;}
 function oldGuard(s){if(!baseline)return;for(const key of ['areas','origin','viewDpi','sx','sy','gx','gy','snap','autoArrange','shellAutoArrange','explorerPid','identityVersion'])assert.deepEqual(s[key],baseline[key],'Desktop geometry/state changed: '+key);assert.equal(s.folderFlags,baseline.folderFlags,'old flags changed');assert.equal(s.explorerStarted,baseline.explorerStarted);assert.equal(s.listviewHwnd,baseline.listviewHwnd);for(const old of baseline.icons)assert(s.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y),'EXISTING ICON MOVED; no restoration attempted');}
 async function snapshot(){return stableSnapshot({read:()=>client.request('desktopSnapshot'),guard:oldGuard,same:sameSnapshot,sleep});}
 baseline=await snapshot();report.baseline=baseline;assert(baseline.areas.length===1&&baseline.areas[0].grid&&baseline.areas[0].scale===100&&baseline.snap&&!baseline.autoArrange,'requires existing normal known100 desktop without settings changes');
 const desktop=JSON.parse((await run('powershell.exe',['-NoProfile','-Command',"[Environment]::GetFolderPath('DesktopDirectory')|ConvertTo-Json -Compress"],{windowsHide:true})).stdout),area=baseline.areas[0],grid=area.grid;
 assert.equal(path.parse(temp).root.toLowerCase(),path.parse(desktop).root.toLowerCase(),'same-volume candidate root required');
 const items=Array.from({length:3},(_,i)=>({name:tag+'-'+(i+1)+'.txt',path:path.join(folder,tag+'-'+(i+1)+'.txt'),dest:path.join(desktop,tag+'-'+(i+1)+'.txt'),offset:[0,i]}));
 let plan;
 for(let y=area.top+grid.sy;y+3*grid.sy<area.bottom;y+=grid.sy)for(let x=area.left+grid.sx;x<area.right-500;x+=grid.sx){if(plan)break;const p=planDesktop({snapshot:baseline,items,point:{x,y}});if(p.ok&&p.targets.every(t=>t.x<area.right-450)&&!baseline.icons.some(i=>Math.abs(i.x-p.targets[0].x)<grid.sx&&Math.abs(i.y-p.targets[0].y)<grid.sy))plan=p;}
 assert(plan,'no safe exposed 3-cell fixture fit; no files created');report.plan=plan;
 for(const item of items){
  assert(!fs.existsSync(item.dest));fs.writeFileSync(item.path,'owned Shell drag content '+item.name,{flag:'wx'});
  let rec=await request('readHiddenFile',{path:item.path});assert.equal(rec.attributes,32);
  if(kind==='hidden'){await request('setHiddenFile',{path:item.path,expectedIdentity:rec.identity,expectedHidden:false,hidden:true});await request('moveNoReplace',{source:item.path,destination:item.dest});rec=await request('readHiddenFile',{path:item.dest});assert.equal(rec.attributes,34);}
  records.push({...item,record:rec,source:kind==='hidden'?item.dest:item.path,sha:crypto.createHash('sha256').update(fs.readFileSync(kind==='hidden'?item.dest:item.path)).digest('hex')});
 }
 const before=await snapshot();assert(sameSnapshot(baseline,before),'hidden setup became visible or old changed');report.before=before;report.records=records;
 const spec={root:temp,tag,kind,paths:records.map(f=>f.source),target:{x:plan.targets[0].x,y:plan.targets[0].y},sy:grid.sy,area};
 try{await run('powershell.exe',['-NoProfile','-STA','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'shell-drag-loop-ci.ps1')],{windowsHide:true,timeout:90000,env:{...process.env,OKIBA_SHELL_DROP_SPEC:JSON.stringify(spec)}});}catch(e){report.inputError={message:e.message,stdout:e.stdout,stderr:e.stderr,killed:e.killed};throw e;}
 report.input=JSON.parse(fs.readFileSync(path.join(temp,'input-result.json')));assert(report.input.input.loopReturned&&!report.input.input.inputError&&!report.input.input.inOperation,JSON.stringify(report.input));
 // Read-only observation window, not proof that Explorer can no longer mutate.
 report.observations=[];for(let n=0;n<10;n++){const s=await snapshot();report.observations.push(s);await sleep(250);}
 const final=report.observations.at(-1);report.final=final;report.paths=[];
 for(const f of records){const item={source:f.source,destination:f.dest,sourceExists:fs.existsSync(f.source),destinationExists:fs.existsSync(f.dest)};for(const [name,p]of [['source',f.source],['destination',f.dest]])if(fs.existsSync(p)){item[name]=await request('readHiddenFile',{path:p});item[name+'Hash']=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');assert.equal(item[name].identity,f.record.identity,'identity changed');assert.equal(item[name].size,f.record.size);assert.equal(item[name].mtime,f.record.mtime);assert.equal(item[name+'Hash'],f.sha,'bytes changed');}report.paths.push(item);}
 const icons=records.map(f=>final.icons.find(i=>i.path?.toLowerCase()===f.dest.toLowerCase()));
 report.relativeExact=icons.every(Boolean)&&icons.every((i,n)=>i.x===icons[0].x&&i.y===icons[0].y+n*grid.sy);
 report.requestedTopLeftExact=icons.every(Boolean)&&icons.every((i,n)=>i.x===plan.targets[n].x&&i.y===plan.targets[n].y);
 report.oldUnchanged=true;report.observedOnly=true;report.asyncCompletionGuarantee=false;
 if(kind==='cancel'){assert(sameSnapshot(baseline,final));assert(report.paths.every(p=>p.sourceExists&&!p.destinationExists&&p.source.attributes===32));report.suitable=true;}
 else if(kind==='resident'){report.suitable=report.paths.every(p=>!p.sourceExists&&p.destinationExists&&p.destination.attributes===32)&&report.relativeExact&&report.requestedTopLeftExact;}
 else {assert(report.paths.every(p=>p.sourceExists&&p.destinationExists));report.hiddenWasReleased=report.paths.every(p=>p.destination.attributes===32);report.suitable=report.hiddenWasReleased&&report.relativeExact&&report.requestedTopLeftExact;}
 report.completed=true;report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}finally{
 if(fs.existsSync(path.join(temp,'input-result.json')))report.input=JSON.parse(fs.readFileSync(path.join(temp,'input-result.json')));
 if(client)report.readonlyObserverStopped=await client.stopAndWait(15000);
 fs.mkdirSync(path.join(root,'shell-drop-evidence'),{recursive:true});fs.writeFileSync(path.join(root,'shell-drop-evidence',kind+'.json'),JSON.stringify(report,null,2));
}})();
