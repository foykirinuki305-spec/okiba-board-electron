'use strict';
// Dedicated Node/Electron child; never terminated merely because IPC disconnects.
const fs=require('fs'),crypto=require('crypto');
const {createShellHelperClient}=require('./shellhelper');
const {validateScope}=require('./desktop-snap-lease-controller');
const {validReceipts,classifyReceipt,hash}=require('./desktop-commit-receipt');
const {createLeaseJournal}=require('./desktop-lease-journal');
let config,helper,journal,owner,active=null,unsafe=false,initialized=false,queue=Promise.resolve(),pollQueued=false;
const done=a=>a&&['released','aborted'].includes(a.phase);
function save(){active.updatedAt=new Date().toISOString();try{journal.write(active);}catch(e){unsafe=true;throw e;}}
function responseError(e){return {ok:false,reason:String(e.message||e),pendingVerification:!!active&&!done(active),retrySafe:!active||done(active),...(e.nativeDetail?{nativeDetail:e.nativeDetail}:{})};}
async function direct(cmd,payload={}){const r=await helper.request(cmd,payload,{timeoutMs:config.helperTimeoutMs||15000});if(!r.ok){const e=Error('helper-transport:'+r.error);e.transport=true;throw e;}if(!r.result?.ok){const e=Error(r.result?.reason||r.result?.error||cmd+'-failed');e.nativeDetail={command:cmd,...r.result};throw e;}return r.result;}
function makeHelper(){helper=createShellHelperClient({...config.helper,env:{...process.env,...config.helper.env,OKIBA_SNAP_LEASE:'1'},timeoutMs:config.helperTimeoutMs||15000});}
async function repin(){
 let childBirth=null;if(!owner.started){const self=await direct('leaseOwnerPin',{pid:process.pid});if(self.state!=='alive'||!self.started)throw Error('watchdog-birth-unavailable');childBirth=BigInt(self.started);}
 const r=await direct('leaseOwnerPin',owner);if(!['alive','exited'].includes(r.state))throw Error('owner-state-unknown');
 if(childBirth!==null&&(r.state!=='alive'||!r.started||BigInt(r.started)>childBirth))throw Error('initial-owner-pid-reused');
 owner={pid:r.pid,started:r.started};return r;
}
async function restart(){
 if(!await helper.stopAndWait(10000)){unsafe=true;throw Error('helper-stop-unconfirmed');}
 makeHelper();await repin();if(active&&!done(active))await direct('leaseAdopt',{recovery:active.recovery});
}
async function native(cmd,payload){if(unsafe)throw Error('unsafe-helper-state');try{return await direct(cmd,payload);}catch(e){if(e.nativeDetail&&active){active.lastNativeError=e.nativeDetail;save();}if(e.transport){await restart();e.message+='; helper stopped and scope re-adopted';}throw e;}}
async function ownerState(){try{return await direct('leaseOwnerState');}catch(e){if(!e.transport)throw e;await restart();return direct('leaseOwnerState');}}
function requireToken(token){if(!active||active.token!==token)throw Error('unknown-lease-token');return active;}
function receiptsNow(receipts){return receipts.map(r=>{try{const st=fs.statSync(r.path);if(!st.isFile()||st.size>16*1024*1024)throw Error('metadata-size-or-type');return {path:r.path,hash:hash(fs.readFileSync(r.path))};}catch{return {path:r.path,hash:null};}});}
function allHash(receipts,current,which){return receipts.every(r=>current.some(c=>c.path===r.path&&c.hash===r[which]));}
async function verifyVisible(){const r=await native('leaseRestoreVerify',{token:active.token});if(!r.snapRestored||!r.oldUnchanged||!r.targetsExact)throw Error('native-verification-incomplete');return r;}
async function finishVisible(){await verifyVisible();active.phase='committed';save();await native('leaseRelease',{token:active.token});active.phase='released';active.outcome='committed';save();return {ok:true,state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true};}
function terminal(){return active?.phase==='released'?{ok:true,state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true}:active?.phase==='aborted'?{ok:true,state:'aborted',action:'rollback-selected'}:null;}
async function rollback(){
 if(active.permit)throw Error('ordinary-rollback-after-permit-forbidden');active.phase='aborting';save();
 const r=await native('leaseRollback',{token:active.token});if(!r.ok)throw Error('rollback-unverified');await native('leaseRelease',{token:active.token});active.phase='aborted';save();return terminal();
}
async function resolve(){
 const t=terminal();if(t)return t;
 if(!active.permit)return rollback();
 const o=await ownerState();if(o.state!=='exited')return {ok:false,state:'pending',reason:'owner-not-confirmed-exited',retrySafe:false};
 const r=classifyReceipt({receipts:active.receipts,allowedPaths:active.scope.metadataPaths,current:receiptsNow(active.receipts),ownerExited:true});
 if(r.action==='keep-visible')return finishVisible();
 if(r.action==='rollback-selected'){
  active.phase='resolving-before';save();const v=await native('leaseRollback',{token:active.token});if(!v.ok)throw Error('rollback-unverified');await native('leaseRelease',{token:active.token});active.phase='aborted';active.outcome='rollback-selected';save();return terminal();
 }
 active.phase='blocked';active.outcome=r;save();return {ok:false,state:'blocked',...r,retrySafe:false};
}
async function dispatch(method,args=[]){
 if(method==='init'){
  if(initialized)throw Error('already-initialized');config=args[0];if(!config?.helper?.command||!config.journalDir||config.owner?.pid!==process.ppid)throw Error('invalid-owner-config');
  journal=createLeaseJournal(config.journalDir);if(journal.pending().length)throw Error('unresolved-existing-journal');owner=config.owner;makeHelper();const p=await repin();if(p.state!=='alive')throw Error('owner-not-alive');initialized=true;return {ok:true,owner};
 }
 if(!initialized)throw Error('not-initialized');
 if(unsafe&&method!=='status')throw Error('unsafe-or-journal-failure');
 if(method==='status')return {ok:true,phase:active?.phase||'idle',owner,helper:helper.stats(),unsafe,lastNativeError:active?.lastNativeError||null};
 if(method==='prepareScope'){const s=args[0],r=await native('leaseReadFiles',{paths:s.items.map(i=>i.path)});return {ok:true,scope:{...s,items:s.items.map(i=>{const matches=r.records.filter(x=>x.path.toLowerCase()===i.path.toLowerCase());if(matches.length!==1)throw Error('file-record-missing');return {...i,fileIdentity:matches[0].identity};})}};}
 if(method==='prepare'){
  if(active&&!done(active))throw Error('lease-already-active');if(journal.pending().length)throw Error('unresolved-existing-journal');const scope=args[0];if(!validateScope(scope))throw Error('invalid-scope');const o=await ownerState();if(o.state!=='alive')throw Error('owner-not-alive');const token=crypto.randomBytes(16).toString('hex');
  const r=await native('leasePrepare',{token,scope});active={version:1,token,scope,recovery:r.recovery,owner,phase:'prepared',permit:null};if(!r.recovery)throw Error('missing-recovery');save();return {ok:true,token};
 }
 if(method==='close'){
  if(active&&!done(active))return {ok:false,reason:'active-lease'};if(!await helper.stopAndWait(10000))return {ok:false,reason:'helper-stop-unconfirmed'};return {ok:true,closing:true};
 }
 requireToken(args[0]);
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
// IPC is not evidence of owner death. Keep this independent child alive for native checks.
process.on('disconnect',()=>{if(!initialized)enqueue(async()=>{if(helper&&!await helper.stopAndWait(10000))return;process.exit(0);}).catch(()=>{});});
setInterval(()=>{if(!initialized||pollQueued)return;pollQueued=true;enqueue(async()=>{
 if(!active||done(active)){if(!process.connected){await helper.stopAndWait(10000);process.exit(0);}return;}
 if(unsafe||active.phase==='blocked')return;const o=await ownerState();if(o.state==='exited')await resolve();
}).catch(e=>{if(active){active.lastError=String(e.message||e);try{save();}catch{}}}).finally(()=>{pollQueued=false;});},500);
