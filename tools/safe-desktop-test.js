'use strict';
// Never run against a user Desktop; even the JS entry point has the CI gate.
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted') {
  console.error('Safe Desktop integration requires GitHub-hosted Windows CI.');process.exit(2);
}
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {execFile}=require('child_process'),{promisify}=require('util');
const {createShellHelperClient}=require('../lib/shellhelper');
const {planDesktop,sameSnapshot,executeDesktop}=require('../lib/safe-desktop');
const run=promisify(execFile),desktop=path.resolve(process.argv[2]),ROOT=path.resolve(__dirname,'..');
const log=[];function note(s){log.push(s);console.log(s)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const signature=s=>s.icons.map(i=>JSON.stringify([i.label,i.x,i.y])).sort();
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
  const adapter={snapshot:snap,move:async item=>{moved++;fs.renameSync(item.path,item.dest);},position:async(s,p)=>request('positionDesktopPlan',{snapshot:s,targets:p.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest})),buffer:p.buffer}),commit:async()=>{committed++;fs.writeFileSync(metadata,'committed');},rollback:async item=>{if(fs.existsSync(item.dest))fs.renameSync(item.dest,item.path);}};
  const invalid=planDesktop({snapshot:before,items,point:{x:sentinel.x+before.sx/2,y:sentinel.y+before.sy/2}});
  assert.equal(invalid.ok,false,'occupied drop must be blocked');
  const blocked=await executeDesktop({items,plan:invalid,snapshot:before,adapter});assert(blocked.blocked&&!blocked.ok);
  assert.equal(moved,0);assert.equal(committed,0);assert.deepEqual(fs.readFileSync(metadata),metaBefore);assert.deepEqual(fs.readFileSync(history),historyBefore);
  for(const i of items){assert(fs.existsSync(i.path));assert(!fs.existsSync(i.dest));}
  assert.deepEqual(signature(await stable()),signature(before));note('PASS invalid occupied drop: zero moves, metadata/history and every existing icon unchanged');
  const valid=planDesktop({snapshot:before,items,automatic:true});assert(valid.ok,'runner has no safe sparse group space');
  const started=Date.now();const result=await executeDesktop({items,plan:valid,snapshot:before,adapter});note('3-file strict transaction elapsed_ms='+ (Date.now()-started));assert(result.ok,'strict placement failed '+JSON.stringify(result));assert.equal(committed,1);
  const after=await stable();const previous=after.icons.filter(i=>!names.some(n=>matches(i.label,n)));
  assert.deepEqual(previous.map(i=>JSON.stringify([i.label,i.x,i.y])).sort(),signature(before),'existing icons changed');
  for(const t of valid.targets){const read=await cold(t.name);assert.equal(read.status,'ok');assert(Math.abs(read.x-t.x)<=1&&Math.abs(read.y-t.y)<=1,'not exact planned grid cell: '+JSON.stringify({target:t,read}));}
  const guardAfter=await cold(guardName);assert.equal(guardAfter.x,guardCold.x);assert.equal(guardAfter.y,guardCold.y);
  for(const [i,item]of items.entries()){assert(!fs.existsSync(item.path));assert.equal(fs.readFileSync(item.dest,'utf8'),'source-'+i);}
  note('PASS sparse group: all original icons unchanged; independent cold reads equal exact planned grid cells; relative layout preserved');
  const batchBefore=await stable();
  const batch=Array.from({length:10},(_,i)=>{const name=tag+'-batch'+i+'.txt';return {name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[Math.floor(i/5),i%5]};});
  for(const item of batch){fs.writeFileSync(item.path,item.name);owned.push(item.dest);}
  const batchPlan=planDesktop({snapshot:batchBefore,items:batch,automatic:true});assert(batchPlan.ok,'runner has no safe 10-file group space');
  const batchStart=Date.now();
  const batchResult=await executeDesktop({items:batch,plan:batchPlan,snapshot:batchBefore,adapter:{...adapter,position:async(s,p)=>request('positionDesktopPlan',{snapshot:s,targets:p.targets.map(t=>({...t,path:batch.find(i=>i.name===t.name).dest})),buffer:p.buffer})}});
  note('10-file strict transaction elapsed_ms='+(Date.now()-batchStart));assert(batchResult.ok,'10-file placement failed '+JSON.stringify(batchResult));
  const batchAfter=await stable();
  assert.deepEqual(batchAfter.icons.filter(i=>!batch.some(t=>matches(i.label,t.name))).map(i=>JSON.stringify([i.label,i.x,i.y])).sort(),signature(batchBefore),'10-file transaction moved an existing icon');
  for(const t of batchPlan.targets){const icon=batchAfter.icons.find(i=>matches(i.label,t.name));assert(icon&&Math.abs(icon.x-t.x)<=1&&Math.abs(icon.y-t.y)<=1,'10-file target not exact');}
  note('PASS 10-file group: every old icon unchanged and every target exact');
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
