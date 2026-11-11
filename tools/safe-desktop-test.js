'use strict';
// Never run against a user Desktop; even the JS entry point has the CI gate.
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted') {
  console.error('Safe Desktop integration requires GitHub-hosted Windows CI.');process.exit(2);
}
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {execFile}=require('child_process'),{promisify}=require('util');
const {createShellHelperClient}=require('../lib/shellhelper');
const {planDesktop,sameSnapshot,executeDesktop}=require('../lib/safe-desktop');
const {createAttribRunner}=require('../lib/links');
const run=promisify(execFile),desktop=path.resolve(process.argv[2]),ROOT=path.resolve(__dirname,'..');
const log=[];function note(s){log.push(s);console.log(s)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const signature=s=>{assert.equal(s.identityVersion,1);assert(s.icons.every(i=>typeof i.identity==='string'&&i.identity));assert.equal(new Set(s.icons.map(i=>i.identity)).size,s.icons.length);return s.icons.map(i=>JSON.stringify([i.identity,i.x,i.y])).sort();};
function matches(label,name){return label===name||label===path.parse(name).name;}
async function main(){
 const tag='OkibaSafe-'+crypto.randomBytes(6).toString('hex');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-safe-ci-')),owned=[];
 const client=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','shell-helper.ps1')],timeoutMs:65000});
 let unsafeHelper=false;
 const request=async(cmd,args={})=>{const r=await client.request(cmd,args,{timeoutMs:65000});if(!r.ok){const stopped=await client.stopAndWait(10000);if(!stopped){unsafeHelper=true;return {ok:false,unsafe:true,reason:'helper-not-stopped'};}}assert(r.ok&&r.result,'helper '+cmd+' failed '+JSON.stringify(r));return r.result;};
 const snap=()=>request('desktopSnapshot');
 async function stable(){let a=await snap();for(let n=0;n<30;n++){await sleep(200);const b=await snap();if(sameSnapshot(a,b))return b;a=b;}throw Error('desktop did not stabilize');}
 async function cold(name){const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','position-desktop-icons.ps1'),'-GetPosition','0','0',name],{windowsHide:true,timeout:30000});return JSON.parse(stdout.split(/\r?\n/).filter(x=>/^\s*\{/.test(x)).pop());}
 try {
  const collisionSource=path.join(temp,'no-replace-source.txt'),collisionDest=path.join(temp,'no-replace-dest.txt');
  fs.writeFileSync(collisionSource,'original source');fs.writeFileSync(collisionDest,'existing destination');
  const refused=await request('moveNoReplace',{source:collisionSource,destination:collisionDest});
  assert(!refused.ok,'atomic move must reject an existing destination');assert.equal(fs.readFileSync(collisionSource,'utf8'),'original source');assert.equal(fs.readFileSync(collisionDest,'utf8'),'existing destination');
  note('PASS native atomic move refuses destination collision without overwriting either file');
  const guardName=tag+'-existing.txt',guard=path.join(desktop,guardName);owned.push(guard);fs.writeFileSync(guard,'sentinel');
  let before;for(let n=0;n<50;n++){before=await snap();if(before.ok&&before.icons.some(i=>matches(i.label,guardName)))break;await sleep(200);}
  before=await stable();assert(before.ok&&!before.autoArrange&&before.snap,'need readable manual grid desktop');
  const sentinel=before.icons.find(i=>matches(i.label,guardName));assert(sentinel,'sentinel absent');
  const guardCold=await cold(guardName);assert.equal(guardCold.status,'ok');
  const offsets=[[0,0],[0,1],[1,1]];
  const names=[tag+'-A.txt',tag+' B.txt',tag+' 日本語.txt'];
  const items=names.map((name,i)=>({path:path.join(temp,name),dest:path.join(desktop,name),name,offset:offsets[i]}));
  for(const [i,item]of items.entries()){fs.writeFileSync(item.path,'source-'+i);owned.push(item.dest);}
  const metadata=path.join(temp,'.okiba-board.json'),history=path.join(temp,'.move-history.json');
  fs.writeFileSync(metadata,JSON.stringify({version:6,positions:{'A.txt':{col:3,row:7}},links:[]}));fs.writeFileSync(history,'[]');
  const metaBefore=fs.readFileSync(metadata),historyBefore=fs.readFileSync(history);let moved=0,committed=0;
  const atomicMove=async(source,destination)=>{const result=await request('moveNoReplace',{source,destination});assert(result.ok,'atomic move failed '+JSON.stringify(result));};
  const adapter={snapshot:snap,move:async item=>{moved++;await atomicMove(item.path,item.dest);},position:async(s,p)=>request('positionDesktopPlan',{snapshot:s,targets:p.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest})),buffer:p.buffer}),commit:async()=>{committed++;fs.writeFileSync(metadata,'committed');},rollback:async item=>{if(fs.existsSync(item.dest))await atomicMove(item.dest,item.path);}};
  const invalid=planDesktop({snapshot:before,items,point:{x:sentinel.x+before.sx/2,y:sentinel.y+before.sy/2}});
  assert.equal(invalid.ok,false,'occupied drop must be blocked');
  const blocked=await executeDesktop({items,plan:invalid,snapshot:before,adapter});assert(blocked.blocked&&!blocked.ok);
  assert.equal(moved,0);assert.equal(committed,0);assert.deepEqual(fs.readFileSync(metadata),metaBefore);assert.deepEqual(fs.readFileSync(history),historyBefore);
  for(const i of items){assert(fs.existsSync(i.path));assert(!fs.existsSync(i.dest));}
  assert.deepEqual(signature(await stable()),signature(before));note('PASS invalid occupied drop: zero moves, metadata/history and every existing icon unchanged');
  const valid=planDesktop({snapshot:before,items,automatic:true});assert(valid.ok,'runner has no safe sparse group space');
  const started=Date.now();const result=await executeDesktop({items,plan:valid,snapshot:before,adapter});note('3-file strict transaction elapsed_ms='+ (Date.now()-started));assert(result.ok,'strict placement failed '+JSON.stringify(result));assert.equal(committed,1);
  const after=await stable();const previous=after.icons.filter(i=>!names.some(n=>matches(i.label,n)));
  assert.deepEqual(previous.map(i=>JSON.stringify([i.identity,i.x,i.y])).sort(),signature(before),'existing icons changed');
  for(const t of valid.targets){const read=await cold(t.name);assert.equal(read.status,'ok');assert(Math.abs(read.x-t.x)<=1&&Math.abs(read.y-t.y)<=1,'not exact planned grid cell: '+JSON.stringify({target:t,read}));}
  const guardAfter=await cold(guardName);assert.equal(guardAfter.x,guardCold.x);assert.equal(guardAfter.y,guardCold.y);
  for(const [i,item]of items.entries()){assert(!fs.existsSync(item.path));assert.equal(fs.readFileSync(item.dest,'utf8'),'source-'+i);}
  note('PASS sparse group: all original icons unchanged; independent cold reads equal exact planned grid cells; relative layout preserved');
  const batchBefore=await stable();
  const existingDiff=(baseline,current)=>baseline.icons.map(old=>{
    const matchesNow=(current.icons||[]).filter(i=>i.identity===old.identity);
    const kind=matches(old.label,guardName)?'guard':names.some(n=>matches(old.label,n))?'previous-3-files':'original-OS-icon';
    return {identity:old.identity,label:old.label,kind,before:{x:old.x,y:old.y},after:matchesNow.map(i=>({x:i.x,y:i.y})),unchanged:matchesNow.some(i=>i.x===old.x&&i.y===old.y)};
  }).filter(i=>!i.unchanged);
  note('10-file before create '+JSON.stringify({snapshot:batchBefore,diffSinceFirstBatch:existingDiff(after,batchBefore)}));
  const batch=Array.from({length:10},(_,i)=>{const name=tag+'-batch'+i+'.txt';return {name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[Math.floor(i/5),i%5]};});
  for(const item of batch){fs.writeFileSync(item.path,item.name);owned.push(item.dest);}
  const batchPlan=planDesktop({snapshot:batchBefore,items:batch,automatic:true});assert(batchPlan.ok,'runner has no safe 10-file group space');
  const batchStart=Date.now();
  const batchResult=await executeDesktop({items:batch,plan:batchPlan,snapshot:batchBefore,adapter:{...adapter,position:async(s,p)=>{
    const justCreated=await snap();note('10-file after create, before position '+JSON.stringify({snapshot:justCreated,diff:existingDiff(s,justCreated)}));
    const result=await request('positionDesktopPlan',{snapshot:s,targets:p.targets.map(t=>({...t,path:batch.find(i=>i.name===t.name).dest})),buffer:p.buffer});
    if(!result.ok&&!result.unsafe){const current=await snap();note('10-file failure diagnostics '+JSON.stringify({result,before:s,current,plan:p,diff:existingDiff(s,current)}));}
    return result;
  }}});
  note('10-file strict transaction elapsed_ms='+(Date.now()-batchStart));assert(batchResult.ok,'10-file placement failed '+JSON.stringify(batchResult));
  const batchAfter=await stable();
  assert.deepEqual(batchAfter.icons.filter(i=>!batch.some(t=>matches(i.label,t.name))).map(i=>JSON.stringify([i.identity,i.x,i.y])).sort(),signature(batchBefore),'10-file transaction moved an existing icon');
  for(const t of batchPlan.targets){const icon=batchAfter.icons.find(i=>matches(i.label,t.name));assert(icon&&Math.abs(icon.x-t.x)<=1&&Math.abs(icon.y-t.y)<=1,'10-file target not exact');}
  note('PASS 10-file group: every old icon unchanged and every target exact');
  // The primary product path: linked Desktop files stay at the same path,
  // hidden while on the board, then reappear via attrib -H (not a rename).
  const attrs=createAttribRunner();
  const linkedNames=[tag+'-linked-\u65e5\u672c\u8a9e.txt',tag+'-linked-second.txt'];
  const mixNames=[...linkedNames,tag+'-resident.txt'];
  const seedBefore=await stable();
  const seed=linkedNames.map((name,i)=>({name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[0,i]}));
  for(const item of seed){fs.writeFileSync(item.path,item.name);owned.push(item.dest);}
  const seedPlan=planDesktop({snapshot:seedBefore,items:seed,automatic:true});assert(seedPlan.ok);
  const mixedPosition=async(s,p,its)=>{
    const result=await request('positionDesktopPlan',{snapshot:s,targets:p.targets.map(t=>({...t,path:its.find(i=>i.name===t.name).dest})),buffer:p.buffer});
    if(!result.ok&&!result.unsafe){const current=await snap();note('hidden-path failure '+JSON.stringify({result,before:s,current,plan:p,diff:existingDiff(s,current)}));}
    if(result.ok){const current=await stable();assert.deepEqual(current.icons.filter(i=>!its.some(t=>matches(i.label,t.name))).map(i=>JSON.stringify([i.identity,i.x,i.y])).sort(),signature(s),'existing icons changed while hidden items were visible');for(const t of p.targets){const found=current.icons.find(i=>matches(i.label,t.name));assert(found&&Math.abs(found.x-t.x)<=1&&Math.abs(found.y-t.y)<=1,'mixed position not exact before commit');}}
    return result;
  };
  const seeded=await executeDesktop({items:seed,plan:seedPlan,snapshot:seedBefore,adapter:{...adapter,position:(s,p)=>mixedPosition(s,p,seed)}});assert(seeded.ok,'hidden seed positioning failed '+JSON.stringify(seeded));
  const mix=seed.map(i=>({...i,path:i.dest,hidden:true}));
  const resident={name:mixNames[2],path:path.join(temp,mixNames[2]),dest:path.join(desktop,mixNames[2]),offset:[1,1],hidden:false};
  fs.writeFileSync(resident.path,resident.name);owned.push(resident.dest);mix.push(resident);
  const waitVisibility=async(visible)=>{for(let n=0;n<60;n++){const s=await stable();if(mixNames.every(name=>s.icons.some(i=>matches(i.label,name))===visible))return s;await sleep(100);}throw Error('mixed item visibility not reflected in Explorer');};
  const hideLinked=async()=>{for(const item of mix.filter(i=>i.hidden)){assert((await attrs.setHidden(item.path,true)).ok);assert((await attrs.readHidden(item.path)).hidden);}};
  await hideLinked();await waitVisibility(false);
  // Occupy a hidden item's previous Shell-cached cell before unhiding it.
  // This is the real collision path that a brand-new rename never exercises.
  const collisionGuardName=tag+'-hidden-old-cell-guard.txt';
  const collisionGuard={name:collisionGuardName,path:path.join(temp,collisionGuardName),dest:path.join(desktop,collisionGuardName),offset:[0,0]};
  fs.writeFileSync(collisionGuard.path,'old-cell sentinel');owned.push(collisionGuard.dest);
  const collisionBefore=await stable(),oldCell=seedPlan.targets[0];
  const collisionPlan=planDesktop({snapshot:collisionBefore,items:[collisionGuard],point:{x:oldCell.x+collisionBefore.sx/2,y:oldCell.y+collisionBefore.sy/2}});
  assert(collisionPlan.ok,'hidden previous cell must be available for collision guard');
  assert.equal(collisionPlan.targets[0].x,oldCell.x);assert.equal(collisionPlan.targets[0].y,oldCell.y);
  const collisionResult=await executeDesktop({items:[collisionGuard],plan:collisionPlan,snapshot:collisionBefore,adapter:{...adapter,position:(s,p)=>mixedPosition(s,p,[collisionGuard])}});
  assert(collisionResult.ok,'cannot seed guard at hidden previous cell');
  note('Hidden-path collision fixture: prior cell occupied by '+collisionGuardName+' at '+JSON.stringify({x:oldCell.x,y:oldCell.y}));
  const mixedAdapter={snapshot:snap,move:async item=>{if(item.hidden){assert((await attrs.setHidden(item.path,false)).ok);}else await atomicMove(item.path,item.dest);},position:(s,p)=>mixedPosition(s,p,mix),commit:async()=>{fs.writeFileSync(metadata,'mixed committed');},rollback:async item=>{if(item.hidden)assert((await attrs.setHidden(item.path,true)).ok);else if(fs.existsSync(item.dest))await atomicMove(item.dest,item.path);}};
  for(let cycle=0;cycle<3;cycle++){
    const hiddenBefore=await stable();fs.writeFileSync(metadata,'hidden board metadata');fs.writeFileSync(history,'hidden board history');
    const blockedPlan=planDesktop({snapshot:hiddenBefore,items:mix,point:{x:sentinel.x+hiddenBefore.sx/2,y:sentinel.y+hiddenBefore.sy/2}});
    assert(!blockedPlan.ok);const blockedMix=await executeDesktop({items:mix,plan:blockedPlan,snapshot:hiddenBefore,adapter:mixedAdapter});assert(blockedMix.blocked);
    assert.equal(fs.readFileSync(metadata,'utf8'),'hidden board metadata');assert.equal(fs.readFileSync(history,'utf8'),'hidden board history');
    for(const item of mix.filter(i=>i.hidden))assert((await attrs.readHidden(item.path)).hidden);
    let mixedPlan;
    for(let x=hiddenBefore.areas[0].right-2*hiddenBefore.sx;x>=hiddenBefore.areas[0].left;x-=hiddenBefore.sx){const candidate=planDesktop({snapshot:hiddenBefore,items:mix,point:{x,y:hiddenBefore.sy*2}});if(candidate.ok){mixedPlan=candidate;break;}}
    assert(mixedPlan,'no alternate valid mixed-group location');
    const startedMix=Date.now();const injected=cycle===1;
    const result=await executeDesktop({items:mix,plan:mixedPlan,snapshot:hiddenBefore,adapter:injected?{...mixedAdapter,commit:async()=>{throw Error('injected metadata failure');}}:mixedAdapter});
    note('hidden mixed cycle='+cycle+' injectedFailure='+injected+' elapsed_ms='+(Date.now()-startedMix)+' result='+JSON.stringify(result));
    if(injected){assert(!result.ok&&result.recovery.length===0);assert.equal(fs.readFileSync(metadata,'utf8'),'hidden board metadata');assert.equal(fs.readFileSync(history,'utf8'),'hidden board history');assert(fs.existsSync(resident.path)&&!fs.existsSync(resident.dest));await waitVisibility(false);}
    else {assert(result.ok,'hidden mixed placement failed '+JSON.stringify(result));const shown=await waitVisibility(true);for(const t of mixedPlan.targets){const icon=shown.icons.find(i=>matches(i.label,t.name));assert(icon&&Math.abs(icon.x-t.x)<=1&&Math.abs(icon.y-t.y)<=1,'hidden mixed target not exact');}await hideLinked();await atomicMove(resident.dest,resident.path);await waitVisibility(false);}
    const recovered=await stable();assert.deepEqual(signature(recovered),signature(hiddenBefore),'hidden cycle changed an existing icon');
    for(const item of mix.filter(i=>i.hidden)){assert((await attrs.readHidden(item.path)).hidden);assert.equal(fs.readFileSync(item.path,'utf8'),item.name);}
    assert.equal(fs.readFileSync(resident.path,'utf8'),resident.name);
  }
  note('PASS hidden Desktop links + resident mixed group: Japanese names, exact alternate cells, repeated hide/show, failure rehide, original icons and data unchanged');
  note('SAFE DESKTOP CI PASS');
 } finally {
  const stopped=await client.stopAndWait(10000);
  if(!stopped||unsafeHelper){note('FAIL helper exit not confirmed: cleanup intentionally withheld');fs.writeFileSync(path.join(ROOT,'safe-desktop-diagnostics.txt'),log.join('\n')+'\n');throw Error('helper exit not confirmed; no cleanup performed');}
  client.dispose();
  for(const file of owned){assert.equal(path.dirname(file),desktop);assert(path.basename(file).startsWith(tag));if(fs.existsSync(file))fs.unlinkSync(file);}
  const resolved=path.resolve(temp);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('okiba-safe-ci-'));fs.rmSync(resolved,{recursive:true,force:true});
  fs.writeFileSync(path.join(ROOT,'safe-desktop-diagnostics.txt'),log.join('\n')+'\n');
 }
}
main().catch(e=>{note('FAIL '+e.stack);fs.appendFileSync(path.join(ROOT,'safe-desktop-diagnostics.txt'),'FAIL '+e.stack+'\n');process.exitCode=1;});
