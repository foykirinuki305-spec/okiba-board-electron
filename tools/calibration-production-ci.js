'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only; user Desktop execution forbidden');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const {createShellHelperClient}=require('../lib/shellhelper');
const {planCalibration,inferCalibration}=require('../lib/desktop-calibration');
const {planDesktop}=require('../lib/safe-desktop');
const cache=require('../lib/desktop-calibration-cache');
const ROOT=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]);
const report={scope:'Production calibration API on a single known 100% display deliberately treated as unknown. NOT mixed-DPI validation.',passed:false,events:[]};
const note=(name,value)=>{report.events.push({name,value});console.log(name+' '+JSON.stringify(value));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clone=x=>JSON.parse(JSON.stringify(x));
const sig=s=>(s.icons||[]).map(i=>JSON.stringify([i.label,i.x,i.y])).sort();
const matches=(label,name)=>label===name||label===path.parse(name).name;
const clients=[];let unsafe=false,originalGuard=null;
function client(){const c=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts/shell-helper.ps1')],timeoutMs:100000});clients.push(c);return c;}
async function req(c,cmd,args={}){const r=await c.request(cmd,args,{timeoutMs:100000});if(!r.ok){if(!await c.stopAndWait(10000))unsafe=true;throw Error(cmd+' transport '+JSON.stringify(r));}return r.result;}
async function stable(c){let last;for(let n=0;n<50;n++){const s=await req(c,'desktopSnapshot');if(s.ok&&originalGuard){const changed=originalGuard.icons.filter(old=>!s.icons.some(i=>i.label===old.label&&i.x===old.x&&i.y===old.y));if(changed.length){note('existing-icon-changed',{before:changed,current:s});throw Error('Original icon moved during snapshot stabilization');}}if(s.ok&&last&&JSON.stringify(sig(s))===JSON.stringify(sig(last)))return s;if(!s.ok)note('snapshot-not-ready',s);last=s.ok?s:null;await sleep(150);}throw Error('No stable Desktop snapshot');}
async function main(){
 const tag='OkibaCalibration-'+crypto.randomBytes(6).toString('hex'),owned=[],temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-calibration-ci-'));
 let c=client(),baseline;
 try{
  baseline=await stable(c);originalGuard=clone(baseline);assert(!baseline.autoArrange&&baseline.snap);assert.equal(baseline.areas.length,1,'this fixture proves one display only');
  const known=baseline.areas[0].grid;assert(known,'runner reference grid must be known');
  const name=tag+'-probe.txt',dest=path.join(desktop,name);owned.push(dest);
  const unknown=clone(baseline);unknown.areas[0].grid=null;
  const plan=planCalibration({snapshot:unknown,areaIndex:0,probeId:dest,maxSpacing:{x:96,y:112},step:8});assert(plan.ok,'No guarded empty patch '+JSON.stringify(plan));
  fs.writeFileSync(dest,'probe content');
  const start=Date.now(),result=await req(c,'calibrateDesktopGrid',{snapshot:unknown,probe:{path:dest,name},plan});
  assert(result.ok,'Production calibration failed '+JSON.stringify(result));
  const inferred=inferCalibration({plan,samples:result.samples});assert(inferred.ok,JSON.stringify(inferred));assert.deepEqual(inferred.grid,known,'calibration disagrees with independently known grid');
  note('calibrate-and-infer',{elapsedMs:Date.now()-start,samples:result.samples.length,grid:inferred.grid});
  const damaged=clone(result.samples);damaged[0].x++;assert(!inferCalibration({plan,samples:damaged}).ok,'corrupt observations accepted');
  const measured=clone(unknown);measured.areas[0].grid=inferred.grid;
  const placement=planDesktop({snapshot:measured,items:[{path:dest,name,offset:[0,0]}],automatic:true});assert(placement.ok);
  const positioned=await req(c,'positionDesktopPlan',{snapshot:unknown,targets:placement.targets,buffer:placement.buffer,calibration:{token:result.token,grid:inferred.grid}});assert(positioned.ok,'Token placement failed '+JSON.stringify(positioned));
  const after=await stable(c);assert.deepEqual(after.icons.filter(i=>!matches(i.label,name)).map(i=>JSON.stringify([i.label,i.x,i.y])).sort(),sig(baseline));
  const probeIcon=after.icons.find(i=>matches(i.label,name));assert(probeIcon&&Math.abs(probeIcon.x-placement.targets[0].x)<=1&&Math.abs(probeIcon.y-placement.targets[0].y)<=1);
  note('token-placement',{oldIconsUnchanged:true,exact:true});
  const exported=await req(c,'exportDesktopCalibration');assert(exported.ok&&exported.entries.length===1,'No exported calibration proof');
  const file=path.join(temp,'cache.json');assert(cache.save(file,exported));const saved=cache.load(file);assert(saved&&saved.entries.length===1);
  assert(await c.stopAndWait(10000));c=client();
  const imported=await req(c,'importDesktopCalibration',saved);assert(imported.ok&&imported.accepted===1&&imported.rejected===0,JSON.stringify(imported));
  const beforeAgain=await stable(c),name2=tag+'-after-import.txt',dest2=path.join(desktop,name2);owned.push(dest2);
  const next=planDesktop({snapshot:beforeAgain,items:[{path:dest2,name:name2,offset:[0,0]}],automatic:true});assert(next.ok);fs.writeFileSync(dest2,'second content');
  const placedAgain=await req(c,'positionDesktopPlan',{snapshot:beforeAgain,targets:next.targets,buffer:next.buffer});assert(placedAgain.ok,JSON.stringify(placedAgain));
  const again=await stable(c);assert.deepEqual(again.icons.filter(i=>!matches(i.label,name2)).map(i=>JSON.stringify([i.label,i.x,i.y])).sort(),sig(beforeAgain));const second=again.icons.find(i=>matches(i.label,name2));assert(second&&Math.abs(second.x-next.targets[0].x)<=1&&Math.abs(second.y-next.targets[0].y)<=1);
  note('export-import-and-position',{accepted:imported.accepted,oldIconsUnchanged:true,exact:true});
  const corrupt=clone(saved);corrupt.entries[0].grid.sx++;
  const fresh=client(),refused=await req(fresh,'importDesktopCalibration',corrupt);assert(!refused.ok||refused.accepted===0,'Corrupt cached grid accepted');
  assert.deepEqual(sig(await stable(c)),sig(again),'corrupt import mutated icon positions');
  note('corrupt-proof-rejected',refused);report.passed=true;
 }finally{
  for(const c of clients){if(!await c.stopAndWait(10000))unsafe=true;}
  if(!unsafe){for(const f of owned){assert.equal(path.dirname(f),desktop);assert(path.basename(f).startsWith(tag));if(fs.existsSync(f))fs.unlinkSync(f);}const p=path.resolve(temp);assert(p.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(p).startsWith('okiba-calibration-ci-'));fs.rmSync(p,{recursive:true,force:true});}
  else {report.passed=false;report.cleanupError='helper termination unconfirmed; cleanup withheld';}
  if(!unsafe&&baseline){const verify=client();try{let restored=false;for(let n=0;n<40;n++){const s=await stable(verify);if(JSON.stringify(sig(s))===JSON.stringify(sig(baseline))){restored=true;break;}await sleep(150);}assert(restored,'original Desktop icon state differs after cleanup');note('cleanup',{originalIconsUnchanged:true});}finally{if(!await verify.stopAndWait(10000))unsafe=true;}}
  fs.writeFileSync(path.join(ROOT,'calibration-production-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupError);
 }
}
main().then(()=>console.log('PRODUCTION CALIBRATION CI PASS')).catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(ROOT,'calibration-production-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
