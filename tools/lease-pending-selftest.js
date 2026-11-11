'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const receipts=require('../lib/desktop-commit-receipt'),controller=require('../lib/desktop-snap-lease-controller');
const src=fs.readFileSync(path.join(__dirname,'../lib/desktop-lease-watchdog.js'),'utf8');const resolveBody=src.slice(src.indexOf('async function resolve(){'),src.indexOf('async function dispatch('));
const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8').split('// BEGIN tested-main-lease-verification')[1].split('// END tested-main-lease-verification')[0];
let n=0;const check=x=>{assert.ok(x);n++;};
const after=receipts.hash('after'),before=receipts.hash('before'),r=[{path:'C:\\board.json',beforeHash:before,afterHash:after}];
const good={ok:true,state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true};
async function resolution(owner,current,fail=false){const calls=[];const ctx={active:{token:'t',permit:'p',receipts:r,scope:{metadataPaths:[r[0].path]}},terminal:()=>null,ownerState:async()=>({state:owner}),allHash:(rr,c,k)=>rr.every(x=>c.some(v=>x.path===v.path&&x[k]===v.hash)),receiptsNow:()=>[{path:r[0].path,hash:current}],finishVisible:async()=>{calls.push('verify-native-and-release');if(fail)throw Error('transient-native');return good;},classifyReceipt:receipts.classifyReceipt,save:()=>calls.push('save'),globalLock:{release:async()=>calls.push('global-release')},native:async cmd=>{calls.push(cmd);return {ok:true};},rollback:async()=>{throw Error('ordinary rollback forbidden');}};const fn=vm.runInNewContext(resolveBody+';resolve',ctx);return {calls,run:fn};}
(async()=>{
 for(const owner of ['alive','exited','unknown'])for(const h of [before,after,'foreign']){const f=await resolution(owner,h);const result=await f.run();if(h===after&&owner!=='unknown'){check(result.state==='committed');check(f.calls.includes('verify-native-and-release'));}else if(owner==='exited'&&h===before){check(f.calls.includes('leaseRollback'));}else{check(!f.calls.includes('leaseRollback'));check(!f.calls.includes('verify-native-and-release'));check(['pending','blocked'].includes(result.state));}}
 const verifyBody=src.slice(src.indexOf('async function verifyVisible(){'),src.indexOf('async function finishVisible(){'));
 for(const fail of [false,true]){
  const observations=[],ctx={active:{token:'t'},save:()=>observations.push({attempted:ctx.active.restoreAttempted,restored:ctx.active.restored}),native:async()=>{check(ctx.active.restoreAttempted===true&&observations.length===1);if(fail)throw Error('lost-restore-response');return {snapRestored:true,oldUnchanged:true,targetsExact:true};}};
  const verify=vm.runInNewContext(verifyBody+';verifyVisible',ctx);
  if(fail){await assert.rejects(verify,/lost-restore-response/);n++;check(ctx.active.restoreAttempted&&!ctx.active.restored&&observations.length===1);}
  else{await verify();check(ctx.active.restored&&observations.length===2&&observations[1].restored);}
 }
 const finishBody=src.slice(src.indexOf('async function finishVisible(){'),src.indexOf('function terminal(){'));
 for(const fail of [false,true]){
  const calls=[],ctx={active:{token:'t',receipts:r},verifyVisible:async()=>calls.push('verify'),allHash:()=>true,receiptsNow:()=>[],save:()=>calls.push('save'),globalLock:{release:async()=>calls.push('global-release')},native:async(cmd,p)=>{check(cmd==='leaseRelease'&&p.expectedOutcome==='visible');calls.push('release');if(fail)throw Error('lease-target-not-exact');return {ok:true};}};
  const finish=vm.runInNewContext(finishBody+';finishVisible',ctx);
  if(fail){await assert.rejects(finish,/lease-target-not-exact/);n++;check(!ctx.active.helperReleased&&!calls.includes('global-release'));check(ctx.active.phase!=='released');}
  else{check((await finish()).targetsExact);check(ctx.active.helperReleased&&calls.includes('global-release'));}
 }
 const bad=await resolution('alive',after,true);await assert.rejects(bad.run,/transient-native/);n++;check(!bad.calls.includes('leaseRollback'));
 let commits=0;const adapter={resolveCommit:async()=>good,commit:()=>commits++};const recovered=await controller.resumeLeaseVerification({adapter,context:{token:'t',permit:'p',receipts:r}});check(recovered.ok&&recovered.recovered&&commits===0);
 const uncertain=await controller.resumeLeaseVerification({adapter:{resolveCommit:async()=>({state:'committed',snapRestored:true})},context:{token:'t',permit:'p'}});check(uncertain.pendingVerification&&uncertain.retrySafe===false);
 for(const mode of ['later-success','permanent','aborted']){
  const timers=[],events=[];let callback=0,attempts=0;
  const ctx={desktopLeasePending:false,desktopLeaseVerification:null,leaseController:{resumeLeaseVerification:async()=>{attempts++;return mode==='later-success'&&attempts===2?{ok:true}:mode==='aborted'?{ok:false,verifiedAborted:true}:{ok:false,pendingVerification:true};}},win:{isDestroyed:()=>false,webContents:{send:(...v)=>events.push(v)}},setTimeout:fn=>{timers.push(fn);return {unref(){}};}};
  const begin=vm.runInNewContext(main+';beginLeaseVerification',ctx);begin({result:{verificationContext:{token:'t'}},adapter:{},onCommitted:()=>callback++,diagnostic:()=>{}});check(ctx.desktopLeasePending===true);
  while(timers.length)await timers.shift()();
  if(mode==='later-success'){check(callback===1&&attempts===2&&!ctx.desktopLeasePending);check(events.some(e=>e[0]==='fs-changed'));}
  else if(mode==='permanent'){check(callback===0&&attempts===3&&ctx.desktopLeasePending);check(events.some(e=>e[0]==='status'&&e[1].includes('確認できませんでした')));}
  else check(callback===0&&attempts===1&&!ctx.desktopLeasePending);
 }
 console.log('lease pending '+n+' checks PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
