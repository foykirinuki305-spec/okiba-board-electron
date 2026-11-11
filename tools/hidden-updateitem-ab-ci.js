'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only; real user Desktop forbidden');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {execFile}=require('child_process'),{promisify}=require('util'),run=promisify(execFile);
const {createShellHelperClient}=require('../lib/shellhelper');
const {planDesktop,sameSnapshot}=require('../lib/safe-desktop');
const {createAttribRunner}=require('../lib/links');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),attrs=createAttribRunner();
const mode=process.argv[3]||'none';assert(['none','update'].includes(mode));
const report={mode,scope:'CI-only dense self-created Windows shortcuts; all original OS icons protected; not mixed-DPI verification',passed:false,events:[]};
const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const identityValid=s=>s.identityVersion===1&&s.icons.every(i=>typeof i.identity==='string'&&i.identity.length)&&new Set(s.icons.map(i=>i.identity)).size===s.icons.length;
const differences=(before,after)=>before.icons.filter(old=>!after.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y)).map(old=>({identity:old.identity,label:old.label,before:{x:old.x,y:old.y},after:after.icons.filter(i=>i.identity===old.identity).map(i=>({label:i.label,x:i.x,y:i.y}))}));
const matchesFile=(icon,name)=>typeof icon.path==='string'&&path.resolve(icon.path).toLowerCase()===path.join(desktop,name).toLowerCase();
async function main(){
 const tag='OkibaDense-'+crypto.randomBytes(5).toString('hex'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-dense-ci-'))),owned=[];
 const c=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')],timeoutMs:100000});
 let unsafe=false,original;
 async function req(cmd,args={}){const r=await c.request(cmd,args,{timeoutMs:100000});if(!r.ok){unsafe=!await c.stopAndWait(10000);throw Error('helper transport '+JSON.stringify(r));}return r.result;}
 async function observe(phase,guard){const s=await req('desktopSnapshot');if(s.ok)assert(identityValid(s),'Missing or duplicate Shell identity during '+phase);if(s.ok&&guard){const diff=differences(guard,s);if(diff.length){note(phase,{before:guard,after:s,differences:diff});throw Error('EXISTING ICON SHIFT during '+phase);}}return s;}
 async function stable(phase,guard){let previous;for(let n=0;n<80;n++){const s=await observe(phase,guard);if(s.ok&&previous&&sameSnapshot(previous,s))return s;previous=s.ok?s:null;await sleep(100);}throw Error('unstable '+phase);}
 async function visible(names,want,phase,guard){for(let n=0;n<100;n++){const s=await observe(phase,guard);if(s.ok&&names.every(name=>s.icons.some(i=>matchesFile(i,name))===want))return stable(phase,guard);await sleep(50);}throw Error('visibility timeout '+phase);}
 async function notifyActual(item,expected,phase){
  const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'hidden-updateitem-notify-ci.ps1'),'-Path',item.dest,'-Mode',mode,'-Expected',expected],{windowsHide:true,timeout:15000});
  note(phase,{name:item.name,mode,result:result.stdout.trim()});
 }
 async function move(from,to){assert(fs.existsSync(from),'Fixture source missing before move: '+from);const r=await req('moveNoReplace',{source:from,destination:to});assert(r.ok,JSON.stringify({result:r,source:from,destination:to,sourceExists:fs.existsSync(from),destinationExists:fs.existsSync(to)}));}
 async function position(before,items,plan,phase){const r=await req('positionDesktopPlan',{snapshot:before,targets:plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest})),buffer:plan.buffer});assert(r.ok,phase+' '+JSON.stringify(r));const s=await stable(phase,before);for(const t of plan.targets){const i=s.icons.find(i=>matchesFile(i,t.name));assert(i&&Math.abs(i.x-t.x)<=1&&Math.abs(i.y-t.y)<=1,phase+' target not exact');}return s;}
 try{
  original=await stable('initial');assert(original.ok&&!original.autoArrange&&original.snap);
  const dense=Array.from({length:42},(_,i)=>{const name=tag+'-'+String(i).padStart(2,'0')+(i%7===0?'-\u65e5\u672c\u8a9e':'')+'.lnk';return {name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[Math.floor(i/6),i%6]};});
  note('shortcut-fixture-start',{temp,tempExists:fs.existsSync(temp),tempBase:os.tmpdir(),firstSource:dense[0].path});
  const asciiPaths=dense.map((_,i)=>path.join(temp,'fixture-'+i+'.lnk'));
  const ps="$ErrorActionPreference='Stop';$w=New-Object -ComObject WScript.Shell;foreach($p in (ConvertFrom-Json $env:OKIBA_CI_LINK_PATHS)){$s=$w.CreateShortcut($p);$s.TargetPath=Join-Path $env:WINDIR 'System32\\notepad.exe';$s.Save()}";
  const created=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:30000,env:{...process.env,OKIBA_CI_LINK_PATHS:JSON.stringify(asciiPaths)}});
  for(let i=0;i<dense.length;i++){assert(fs.existsSync(asciiPaths[i]),'ASCII shortcut missing: '+asciiPaths[i]);const bytes=fs.readFileSync(asciiPaths[i]);assert(bytes.length>76&&bytes.readUInt32LE(0)===76,'Invalid shortcut header');assert.equal(bytes.subarray(4,20).toString('hex'),'0114020000000000c000000000000046','Invalid Shell Link CLSID');fs.renameSync(asciiPaths[i],dense[i].path);assert(fs.readFileSync(dense[i].path).equals(bytes),'Renaming changed shortcut contents');}
  const missing=dense.filter(i=>!fs.existsSync(i.path));note('shortcut-fixture-created',{expected:dense.length,files:fs.readdirSync(temp),stderr:created.stderr,missing:missing.map(i=>i.path)});assert.equal(missing.length,0,'Shortcut creation incomplete; no Desktop mutation attempted');
  const densePlan=planDesktop({snapshot:original,items:dense,automatic:true});assert(densePlan.ok,'Runner cannot fit required dense 42-shortcut fixture: '+JSON.stringify(densePlan));
  for(const i of dense){owned.push(i.dest);await move(i.path,i.dest);}
  const seeded=await position(original,dense,densePlan,'dense-seed');note('dense-seeded',{created:42,originalCount:original.icons.length,total:seeded.icons.length});
  const selected=[6,7,8,12,13,14].map(n=>({...dense[n]}));
  selected.forEach((i,n)=>i.offset=[Math.floor(n/3),n%3]);
  const hashes=new Map(selected.map(i=>[i.dest,crypto.createHash('sha256').update(fs.readFileSync(i.dest)).digest('hex')]));
  const remaining={...seeded,icons:seeded.icons.filter(i=>!selected.some(t=>matchesFile(i,t.name)))};
  for(const i of selected)assert((await attrs.setHidden(i.dest,true)).ok);
  await visible(selected.map(i=>i.name),false,'hide-initial',remaining);
  // Occupy three previous cached cells; do not move any old icon to create space.
  for(const victim of selected.slice(0,3)){
   const before=await stable('guard-before',remaining),old=densePlan.targets.find(t=>t.name===victim.name),name=victim.name+'.guard.txt';
   const item={name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[0,0]};fs.writeFileSync(item.path,'old-cell guard');owned.push(item.dest);
   const area=before.areas.find(a=>old.x>=a.left&&old.x<a.right&&old.y>=a.top&&old.y<a.bottom),g=area.grid;
   const p=planDesktop({snapshot:before,items:[item],point:{x:old.x+g.sx/2,y:old.y+g.sy/2}});assert(p.ok);assert.equal(p.targets[0].x,old.x);assert.equal(p.targets[0].y,old.y);
   await move(item.path,item.dest);await position(before,[item],p,'guard-position');
  }
  for(let cycle=0;cycle<3;cycle++){
   const before=await stable('cycle-before',remaining);note('before-unhide',{cycle,snapshot:before});
   for(const item of selected){await notifyActual(item,'hidden','while-hidden-update-'+cycle);await observe('while-hidden-guard-'+cycle,before);}
   await visible(selected.map(i=>i.name),false,'before-unhide-absent-stable-'+cycle,before);
   const p=planDesktop({snapshot:before,items:selected,automatic:true});assert(p.ok,'No space for selected relative shape');
   for(const item of selected){assert((await attrs.setHidden(item.dest,false)).ok);await notifyActual(item,'visible','after-unhide-update-'+cycle);await observe('arrival-before-position-'+cycle,before);}
   const arrival=await visible(selected.map(i=>i.name),true,'arrival-before-position-'+cycle,before);
   note('arrival-before-position',{cycle,snapshot:arrival,differences:differences(before,arrival)});
   const after=await position(before,selected,p,'after-position-'+cycle);note('after-position',{cycle,snapshot:after,differences:differences(before,after)});
   for(const item of selected){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.dest)).digest('hex'),hashes.get(item.dest));assert((await attrs.setHidden(item.dest,true)).ok);}
   const hidden=await visible(selected.map(i=>i.name),false,'rehide-'+cycle,before);assert.equal(hidden.icons.length,before.icons.length);
  }
  report.passed=true;note('PASS',{denseShortcuts:42,hiddenPerCycle:6,oldCellGuards:3,cycles:3,oldIconsUnchanged:true});
 }finally{
  if(!await c.stopAndWait(10000))unsafe=true;
  if(!unsafe){for(const f of owned){assert.equal(path.dirname(f),desktop);assert(path.basename(f).startsWith(tag));if(fs.existsSync(f))fs.unlinkSync(f);}const p=path.resolve(temp);assert(p.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep)&&path.basename(p).startsWith('okiba-dense-ci-'));fs.rmSync(p,{recursive:true,force:true});}
  else {report.passed=false;report.cleanupError='helper not stopped; cleanup withheld';}
  if(!unsafe&&original){try{for(let n=0;n<60;n++){const s=await observe('cleanup',original);if(s.ok&&s.icons.length===original.icons.length){note('cleanup',{originalIconsUnchanged:true});break;}if(n===59)throw Error('fixture icons remain after cleanup');await sleep(100);}}finally{if(!await c.stopAndWait(10000))unsafe=true;}}
  fs.writeFileSync(path.join(root,'hidden-updateitem-'+mode+'-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupError);
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'hidden-updateitem-'+mode+'-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
