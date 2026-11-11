'use strict';
// Dedicated Node/Electron child; never terminated merely because IPC disconnects.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const {createShellHelperClient}=require('./shellhelper');
const {validateScope}=require('./desktop-snap-lease-controller');
const {validReceipts,classifyReceipt,hash}=require('./desktop-commit-receipt');
const {createLeaseJournal}=require('./desktop-lease-journal');
const {createDesktopLeaseLock}=require('./desktop-lease-global-lock');
const {validLegacyProof,legacyTerminal}=require('./desktop-legacy-reservation');
const {matchLeaseFileRecords}=require('./desktop-lease-file-records');
let config,helper,journal,owner,active=null,unsafe=false,initialized=false,queue=Promise.resolve(),pollQueued=false;
let globalLock=null,helperEnvironment=null;
let helperGeneration=0,cumulativeRestartCount=0;const helperHistory=[],nativeTimings=[];
function compactPerf(p){if(!p?.metrics)return null;const metrics={};for(const [name,v] of Object.entries(p.metrics).slice(0,64)){if(Number.isFinite(v?.count)&&Number.isFinite(v?.ms))metrics[name]={count:v.count,ms:v.ms};}return {inclusive:p.inclusive===true,metrics};}
const done=a=>a&&['released','aborted'].includes(a.phase)&&!globalLock?.owned();
function save(){active.updatedAt=new Date().toISOString();try{journal.write(active);if(globalLock?.owned())globalLock.update({token:active.token,journalPath:path.join(journal.dir,active.token+'.json'),phase:active.phase,owner,watchdogPid:process.pid,helperHistory});}catch(e){unsafe=true;throw e;}}
function responseError(e){return {ok:false,reason:String(e.message||e),pendingVerification:!!active&&!done(active),retrySafe:!active||done(active),...(e.nativeDetail?{nativeDetail:e.nativeDetail}:{})};}
async function direct(cmd,payload={}){const started=Date.now();const r=await helper.request(cmd,payload,{timeoutMs:config.helperTimeoutMs||15000});nativeTimings.push({generation:helperGeneration,command:cmd,elapsedMs:Date.now()-started,transportOk:r.ok,nativeOk:r.result?.ok,perf:compactPerf(r.result?.perf)});if(nativeTimings.length>100)nativeTimings.shift();if(!r.ok){const e=Error('helper-transport:'+r.error);e.transport=true;throw e;}if(!r.result?.ok){const e=Error(r.result?.reason||r.result?.error||cmd+'-failed');e.nativeDetail={command:cmd,...r.result};throw e;}return r.result;}
function makeHelper(){
 const entry={generation:++helperGeneration,spawnPid:null,pid:null,started:null,stoppedConfirmed:false};helperHistory.push(entry);if((!active||done(active))&&helperHistory.length>20)helperHistory.splice(0,helperHistory.length-20);
 helper=createShellHelperClient({...config.helper,env:{...process.env,...config.helper.env,OKIBA_SNAP_LEASE:'1'},timeoutMs:config.helperTimeoutMs||15000,spawnFn:(command,args,opts)=>{const child=spawn(command,args,opts);entry.spawnPid=child.pid;return child;}});
}
async function identifyHelper(){const r=await direct('leaseHelperIdentity');const entry=helperHistory[helperHistory.length-1];if(r.pid!==entry.spawnPid||typeof r.started!=='string'||!/^\d+$/.test(r.started))throw Error('helper-identity-mismatch');entry.pid=r.pid;entry.started=r.started;const env={desktop:r.desktop,sessionId:r.sessionId,localAppData:r.localAppData};if(helperEnvironment&&JSON.stringify(env)!==JSON.stringify(helperEnvironment))throw Error('helper-desktop-session-changed');helperEnvironment=env;}
async function repin(){
 let childBirth=null;if(!owner.started){const self=await direct('leaseOwnerPin',{pid:process.pid});if(self.state!=='alive'||!self.started)throw Error('watchdog-birth-unavailable');childBirth=BigInt(self.started);}
 const r=await direct('leaseOwnerPin',owner);if(!['alive','exited'].includes(r.state))throw Error('owner-state-unknown');
 if(childBirth!==null&&(r.state!=='alive'||!r.started||BigInt(r.started)>childBirth))throw Error('initial-owner-pid-reused');
 owner={pid:r.pid,started:r.started};return r;
}
async function restart(){
 if(!await helper.stopAndWait(10000)){unsafe=true;throw Error('helper-stop-unconfirmed');}
 const old=helperHistory[helperHistory.length-1];old.stoppedConfirmed=true;old.stopCause='restart';
 makeHelper();await identifyHelper();const current=helperHistory[helperHistory.length-1];if(current.pid===old.pid&&current.started===old.started){unsafe=true;throw Error('helper-restart-identity-not-new');}cumulativeRestartCount++;await repin();if(active&&!done(active)&&active.mode!=='legacy-reservation')await direct('leaseAdopt',{recovery:active.recovery,restorationState:active.restored?'verified':active.restoreAttempted?'attempted':'not-attempted'});
}
async function native(cmd,payload){if(unsafe)throw Error('unsafe-helper-state');try{return await direct(cmd,payload);}catch(e){if(e.nativeDetail&&active){active.lastNativeError=e.nativeDetail;save();}if(e.transport){await restart();e.message+='; helper stopped and scope re-adopted';}throw e;}}
async function ownerState(){try{return await direct('leaseOwnerState');}catch(e){if(!e.transport)throw e;await restart();return direct('leaseOwnerState');}}
function requireToken(token){if(!active||active.token!==token)throw Error('unknown-lease-token');return active;}
function receiptsNow(receipts){return receipts.map(r=>{try{const st=fs.statSync(r.path);if(!st.isFile()||st.size>16*1024*1024)throw Error('metadata-size-or-type');return {path:r.path,hash:hash(fs.readFileSync(r.path))};}catch{return {path:r.path,hash:null};}});}
function allHash(receipts,current,which){return receipts.every(r=>current.some(c=>c.path===r.path&&c.hash===r[which]));}
async function verifyVisible(){if(!active.restoreAttempted){active.restoreAttempted=true;save();}const r=await native('leaseRestoreVerify',{token:active.token});if(!r.snapRestored||!r.oldUnchanged||!r.targetsExact)throw Error('native-verification-incomplete');if(!active.restored){active.restored=true;save();}return r;}
async function finishVisible(){
 if(active.helperReleased)throw Error('metadata-changed-after-helper-release');
 await verifyVisible();
 if(!allHash(active.receipts,receiptsNow(active.receipts),'afterHash')){active.phase='blocked';save();throw Error('receipt-changed-before-release');}
 active.phase='committed';save();await native('leaseRelease',{token:active.token,expectedOutcome:'visible'});active.helperReleased=true;
 if(!allHash(active.receipts,receiptsNow(active.receipts),'afterHash')){active.phase='blocked';save();throw Error('receipt-changed-after-release');}
active.phase='released';active.outcome='committed';save();await globalLock.release(active.token);return {ok:true,state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true};}
function terminal(){if(globalLock?.owned())return null;if(active?.mode==='legacy-reservation')return legacyTerminal(active,false);return active?.phase==='released'?{ok:true,state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true}:active?.phase==='aborted'?{ok:true,state:'aborted',action:'rollback-selected'}:null;}
async function rollback(){
 if(active.permit)throw Error('ordinary-rollback-after-permit-forbidden');active.phase='aborting';active.restoreAttempted=true;save();
 const r=await native('leaseRollback',{token:active.token});if(!r.ok)throw Error('rollback-unverified');await native('leaseRelease',{token:active.token,expectedOutcome:active.scope.kind==='resident-archive-samevolume'?'source-restored':'hidden'});active.phase='aborted';save();await globalLock.release(active.token);return terminal();
}
async function resolve(){
 if(active?.mode==='legacy-reservation')return {ok:false,state:'blocked',reason:'legacy-operation-requires-explicit-confirmed-release',retrySafe:false};
 const t=terminal();if(t)return t;
 if(!active.permit)return rollback();
 const o=await ownerState();
 if(o.state==='alive'){
  // Never re-run metadata commit. A lost acknowledgement can be finalized only
  // through the same receipt + native exact verification as commitDone.
  if(allHash(active.receipts,receiptsNow(active.receipts),'afterHash'))return finishVisible();
  return {ok:false,state:'pending',reason:'live-owner-metadata-unconfirmed',retrySafe:false};
 }
 if(o.state!=='exited')return {ok:false,state:'pending',reason:'owner-not-confirmed-exited',retrySafe:false};
 const r=classifyReceipt({receipts:active.receipts,allowedPaths:active.scope.metadataPaths,current:receiptsNow(active.receipts),ownerExited:true});
 if(r.action==='keep-visible')return finishVisible();
 if(r.action==='rollback-selected'){
  active.phase='resolving-before';active.restoreAttempted=true;save();const v=await native('leaseRollback',{token:active.token});if(!v.ok)throw Error('rollback-unverified');await native('leaseRelease',{token:active.token,expectedOutcome:active.scope.kind==='resident-archive-samevolume'?'source-restored':'hidden'});active.phase='aborted';active.outcome='rollback-selected';save();await globalLock.release(active.token);return terminal();
 }
 active.phase='blocked';active.outcome=r;save();return {ok:false,state:'blocked',...r,retrySafe:false};
}
async function dispatch(method,args=[]){
 if(method==='init'){
  if(initialized)throw Error('already-initialized');config=args[0];if(!config?.helper?.command||!config.journalDir||config.owner?.pid!==process.ppid)throw Error('invalid-owner-config');
  journal=createLeaseJournal(config.journalDir);if(journal.pending().length)throw Error('unresolved-existing-journal');owner=config.owner;makeHelper();await identifyHelper();globalLock=createDesktopLeaseLock({...helperEnvironment,onLost:reason=>{unsafe=true;if(active)active.globalLockError=reason;}});const p=await repin();if(p.state!=='alive')throw Error('owner-not-alive');initialized=true;return {ok:true,owner};
 }
 if(!initialized)throw Error('not-initialized');
 if(unsafe&&method!=='status')throw Error('unsafe-or-journal-failure');
 if(method==='desktopState'){const blocked=globalLock.hasUnresolved()||globalLock.owned()||!!active&&!done(active);return {ok:true,blocked,desktop:globalLock.desktop,sessionId:globalLock.sessionId,reason:blocked?'desktop-lease-active-or-unresolved':null};}
 if(method==='status')return {ok:true,phase:active?.phase||'idle',owner,helper:{...helper.stats(),generation:helperGeneration,cumulativeRestartCount,history:helperHistory.map(x=>({...x}))},nativeTimings:[...nativeTimings],unsafe,lastNativeError:active?.lastNativeError||null};
 if(method==='reserveLegacy'){
  if(active&&!done(active))throw Error('lease-already-active');if(journal.pending().length)throw Error('unresolved-existing-journal');
  const scope=args[0];if(!scope||typeof scope.desktop!=='string'||fs.realpathSync.native(scope.desktop).toLowerCase()!==globalLock.desktop)throw Error('legacy-desktop-mismatch');
  if(!process.connected||(await ownerState()).state!=='alive')throw Error('owner-not-alive');
  const token=crypto.randomBytes(16).toString('hex');
  await globalLock.begin({token,mode:'legacy-reservation',journalPath:path.join(journal.dir,token+'.json'),phase:'legacy-reserved',owner,watchdogPid:process.pid,helperHistory});
  active={version:1,mode:'legacy-reservation',token,scope:{desktop:globalLock.desktop},owner,phase:'legacy-reserved',permit:null};save();return {ok:true,token};
 }
 if(method==='releaseLegacy'){
  requireToken(args[0]);if(active.mode!=='legacy-reservation')throw Error('not-legacy-reservation');const finished=terminal();if(finished)return finished;
  if(active.phase!=='legacy-reserved'||!process.connected)throw Error('legacy-release-state-unknown');
  const proof=args[1];if(!validLegacyProof(proof))throw Error('legacy-completion-unconfirmed');
  if((await ownerState()).state!=='alive')throw Error('owner-not-alive');
  if(!process.connected)throw Error('legacy-owner-disconnected');
  active.proof={outcome:proof.outcome,mutationsSettled:true,metadataSettled:true,oldUnchanged:true,helper:{allRequestsCompleted:proof.helper.allRequestsCompleted===true,stopConfirmed:proof.helper.stopConfirmed===true}};active.outcome=proof.outcome;active.phase='released';save();await globalLock.release(active.token);return terminal();
 }
 if(method==='prepareScope'){const s=args[0],r=await native(s.kind==='resident-archive-samevolume'?'leaseReadResidentFiles':'leaseReadFiles',{paths:s.items.map(i=>i.path)});return {ok:true,scope:{...s,items:matchLeaseFileRecords(s.items,r.records,undefined,s.kind==='resident-archive-samevolume')}};}
 if(method==='prepare'){
  if(active&&!done(active))throw Error('lease-already-active');if(journal.pending().length)throw Error('unresolved-existing-journal');if(helperHistory.length>20)helperHistory.splice(0,helperHistory.length-20);const scope=args[0];if(!validateScope(scope))throw Error('invalid-scope');const o=await ownerState();if(o.state!=='alive')throw Error('owner-not-alive');const token=crypto.randomBytes(16).toString('hex');
  await globalLock.begin({token,journalPath:path.join(journal.dir,token+'.json'),phase:'preparing',owner,watchdogPid:process.pid,helperHistory});
  let r;try{r=await native('leasePrepare',{token,scope});}catch(e){if(!unsafe)await globalLock.release(token);throw e;}
  active={version:1,token,scope,recovery:r.recovery,owner,phase:'prepared',permit:null};if(!r.recovery){unsafe=true;throw Error('missing-recovery');}save();return {ok:true,token};
 }
 if(method==='close'){
  if(active&&!done(active))return {ok:false,reason:'active-lease'};if(!await helper.stopAndWait(10000))return {ok:false,reason:'helper-stop-unconfirmed'};return {ok:true,closing:true};
 }
 requireToken(args[0]);
 if(active.mode==='legacy-reservation')throw Error('legacy-operation-requires-explicit-confirmed-release');
 if(method==='revealAndPlace'){if(active.phase!=='prepared')throw Error('invalid-reveal-phase');active.phase='revealing';save();const r=await native('leaseRevealPlace',{token:active.token});active.phase='placed';save();return r;}
 if(method==='restoreAndVerify'){const r=await verifyVisible();active.phase='restored';save();return r;}
 if(method==='prepareCommit'){
  if(active.permit)return {ok:true,permit:active.permit};if(active.phase!=='restored')throw Error('not-restored');const receipts=args[1];if(!validReceipts(receipts,active.scope.metadataPaths))throw Error('invalid-receipts');
  if((await ownerState()).state!=='alive')throw Error('owner-not-alive');await verifyVisible();if(!allHash(receipts,receiptsNow(receipts),'beforeHash'))throw Error('before-receipt-changed');
  active.receipts=receipts;active.permit=crypto.randomBytes(16).toString('hex');active.phase='permitted';save();return {ok:true,permit:active.permit};
 }
 if(method==='commitDone'){
  if(!active.permit||args[1]!==active.permit)throw Error('invalid-permit');const t=terminal();if(t)return t;
  if(!allHash(active.receipts,receiptsNow(active.receipts),'afterHash'))throw Error('after-receipt-mismatch');return finishVisible();
 }
 if(method==='release'){const t=terminal();if(!t)throw Error('not-finalized');return t;}
 if(method==='abort'){if(active.permit)return resolve();if(done(active))return terminal();return rollback();}
 if(method==='resolveCommit'){if(args[1]&&args[1]!==active.permit)throw Error('invalid-permit');return resolve();}
 throw Error('unknown-method');
}
function enqueue(fn){const result=queue.then(fn);queue=result.catch(()=>{});return result;}
function reply(id,result){if(!process.connected)return;try{process.send({id,result},()=>{});}catch{/* IPC loss does not cancel recovery. */}}
process.on('error',()=>{});
process.on('message',m=>{if(!m||!Number.isSafeInteger(m.id)||typeof m.method!=='string')return;enqueue(()=>dispatch(m.method,m.args)).then(r=>{reply(m.id,r);if(r.closing)setTimeout(()=>process.exit(0),20);},e=>reply(m.id,responseError(e)));});
// IPC loss never authorizes rollback. Only an idle child can close its helper.
// Evaluate after queued initialization completes, not at disconnect event time.
async function closeDisconnectedIdle(){
 if(process.connected||active&&!done(active)||globalLock?.owned())return false;
 if(helper&&!await helper.stopAndWait(10000)){unsafe=true;return false;}
 // Preserve any global pointer: it may belong to another watchdog or a prior run.
 // This idle child never adopted that transaction and has made no Desktop changes.
 process.exit(0);return true;
}
process.on('disconnect',()=>{enqueue(closeDisconnectedIdle).catch(()=>{});});
setInterval(()=>{if(pollQueued)return;pollQueued=true;enqueue(async()=>{
 if(!initialized){await closeDisconnectedIdle();return;}
 if(!active||done(active)){await closeDisconnectedIdle();return;}
 if(unsafe||active.phase==='blocked')return;const o=await ownerState();if(o.state==='exited'){if(active.mode==='legacy-reservation'){active.phase='blocked';active.lastError='legacy-owner-exited-operation-state-unknown';save();}else await resolve();}
}).catch(e=>{if(active){active.lastError=String(e.message||e);try{save();}catch{}}}).finally(()=>{pollQueued=false;});},500);
