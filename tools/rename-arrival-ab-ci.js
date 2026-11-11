'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only; user Desktop forbidden');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {createShellHelperClient}=require('../lib/shellhelper'),{planDesktop,sameSnapshot}=require('../lib/safe-desktop');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),mode=process.argv[3];assert(['none','notify'].includes(mode));
const report={mode,passed:false,scope:'CI owned files only; no user Desktop; not mixed DPI verification',samples:[],events:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data))};
async function main(){
 const tag='OkibaRename-'+crypto.randomBytes(5).toString('hex');const temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-rename-ci-')));const owned=[];report.owned=owned;
 const args=file=>['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file];
 const c=createShellHelperClient({command:'powershell.exe',args:args(path.join(root,'scripts/shell-helper.ps1')),timeoutMs:100000});
 const notifier=createShellHelperClient({command:'powershell.exe',args:args(path.join(__dirname,'rename-arrival-notify-host-ci.ps1')),env:{...process.env,OKIBA_RENAME_SOURCE_ROOT:temp},timeoutMs:10000});
 let unsafe=false,original;
 async function req(client,cmd,args={}){const r=await client.request(cmd,args,{timeoutMs:100000});if(!r.ok){unsafe=!await client.stopAndWait(10000);throw Error('transport '+JSON.stringify(r));}return r.result;}
 function guard(before,after){assert(after.ok);assert.equal(after.identityVersion,1);const ids=new Set();for(const i of after.icons){assert(i.identity&&!ids.has(i.identity));ids.add(i.identity)}for(const old of before?.icons||[]){const now=after.icons.find(i=>i.identity===old.identity);assert(now&&now.x===old.x&&now.y===old.y,'old identity/xy changed '+JSON.stringify(old));}}
 const matches=(icon,item)=>typeof icon.path==='string'&&path.resolve(icon.path).toLowerCase()===item.dest.toLowerCase();
 async function snapshot(before){const s=await req(c,'desktopSnapshot');guard(before,s);return s;}
 async function stable(before){let last;for(let i=0;i<80;i++){const s=await snapshot(before);if(last&&sameSnapshot(last,s))return s;last=s;await sleep(50)}throw Error('not stable')}
 try{
  assert((await req(notifier,'ping')).ok);original=await stable();assert(!original.autoArrange&&original.snap);note('initial',{icons:original.icons.length,helper:c.stats(),notifier:notifier.stats()});
  for(let rep=0;rep<3;rep++)for(const n of [1,3,10]){
   const before=await stable(original);const items=Array.from({length:n},(_,i)=>{const name=tag+'-'+rep+'-'+n+'-'+i+'-\u65e5\u672c\u8a9e.txt';return {name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[Math.floor(i/5),i%5]}});
   for(const i of items)fs.writeFileSync(i.path,'owned rename benchmark '+i.name);
   const plan=planDesktop({snapshot:before,items,automatic:true});assert(plan.ok,'No room for planned fixture: '+JSON.stringify(plan));
   const sample={rep,n,mode,notifications:[],moveMs:[],arrivalPolls:0};report.samples.push(sample);const begun=performance.now();
   for(const i of items){const st=fs.statSync(i.path);owned.push(i.dest);const t=performance.now();const moved=await req(c,'moveNoReplace',{source:i.path,destination:i.dest});sample.moveMs.push(performance.now()-t);assert(moved.ok,JSON.stringify(moved));assert(!fs.existsSync(i.path)&&fs.existsSync(i.dest));const dst=fs.statSync(i.dest);assert(st.dev===dst.dev&&st.ino===dst.ino&&st.size===dst.size,'move changed file identity');const nt=performance.now();const nr=await req(notifier,'actualRename',{source:i.path,destination:i.dest,mode});assert(nr.ok);sample.notifications.push({...nr,roundTripMs:performance.now()-nt});}
   const afterMoves=performance.now();let arrived;
   for(let poll=0;poll<200;poll++){sample.arrivalPolls++;const s=await snapshot(before);if(items.every(i=>s.icons.some(ic=>matches(ic,i)))){arrived=s;break}await sleep(20)}
   assert(arrived,'arrival timed out');sample.arrivalAfterMovesMs=performance.now()-afterMoves;sample.moveToArrivalMs=performance.now()-begun;
   const pt=performance.now();const pos=await req(c,'positionDesktopPlan',{snapshot:before,targets:plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest})),buffer:plan.buffer});sample.positionMs=performance.now()-pt;sample.positionResult=pos;assert(pos.ok,JSON.stringify(pos));
   const after=await stable(before);for(const target of plan.targets){const actual=after.icons.find(ic=>matches(ic,items.find(i=>i.name===target.name)));assert(actual&&Math.abs(actual.x-target.x)<=1&&Math.abs(actual.y-target.y)<=1,'final target mismatch')}
   sample.oldIdentityXYUnchanged=true;note('sample',sample);
  }
  report.passed=true;note('PASS',{samples:report.samples.length,owned:owned.length,helper:c.stats(),notifier:notifier.stats()});
 }finally{
  if(!await c.stopAndWait(10000))unsafe=true;if(!await notifier.stopAndWait(10000))unsafe=true;
  if(!unsafe){for(const f of owned){assert.equal(path.dirname(f),desktop);assert(path.basename(f).startsWith(tag));if(fs.existsSync(f))fs.unlinkSync(f)}assert(temp.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('okiba-rename-ci-'));fs.rmSync(temp,{recursive:true,force:true});}else report.cleanupError='helper not stopped; cleanup withheld';
  fs.writeFileSync(path.join(root,'rename-arrival-'+mode+'-ci.json'),JSON.stringify(report,null,2));if(unsafe)throw Error(report.cleanupError);
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'rename-arrival-'+mode+'-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1});
