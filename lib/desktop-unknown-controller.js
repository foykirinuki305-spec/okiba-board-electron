'use strict';
// Disabled-preview coordinator; adapter owns native commands and atomic metadata CAS.
const {validateUnknownScope}=require('./desktop-unknown-lease-flow');
const {validReceipts}=require('./desktop-commit-receipt');
const {collectAdaptive}=require('./desktop-unknown-adaptive-driver');
const committed=r=>r?.ok===true&&r.state==='committed'&&['snapRestored','oldUnchanged','targetsExact','leaseReleased'].every(k=>r[k]===true);
function createUnknownAdapter(client,commit){
 if(typeof commit!=='function')throw Error('commit callback required');
 const adapter={commit};
 for(const name of ['prepare','revealProbe','beginCalibration','calibrationSample','resolveTargets','revealResolvedAndPlace','restoreResolvedAndVerify','prepareCommit','commitDone','abort'])adapter[name]=(...args)=>client.unknown(name,...args);
 adapter.resolveCommit=token=>client.unknown('resolveCommit',token);
 return adapter;
}
async function runUnknownLease({scope,receipts,adapter,collect=collectAdaptive}){
 if(!validateUnknownScope(scope)||!validReceipts(receipts,scope.metadataPaths))return {ok:false,phase:'preflight',reason:'unsupported-unknown-scope'};
 let phase='prepare',token,permit,gateRequested=false;
 const check=async(name,...args)=>{const r=await adapter[name](...args);if(!r?.ok)throw Error(r?.reason||name+'-failed');return r;};
 try{
  const prepared=await check('prepare',scope);token=prepared.token;if(typeof token!=='string'||!token)throw Error('missing-token');
  phase='probe';await check('revealProbe',token);
  phase='calibration';const begun=await check('beginCalibration',token);let previous=begun.probe;
  const recovery=begun.recovery,patch=recovery.plan.patch,proof={binding:recovery.success.binding,maxSpacing:recovery.plan.maxSpacing,patch,center:{x:Math.floor((patch.left+patch.right)/2),y:Math.floor((patch.top+patch.bottom)/2)}};
  const observed=await collect(proof,async query=>{const value=await check('calibrationSample',token,{...query,previous:{x:previous.x,y:previous.y}});previous=value.probe;return value;});
  if(!observed?.ok)throw Error('calibration-proof-incomplete');
  phase='targets';await check('resolveTargets',token);
  phase='place';await check('revealResolvedAndPlace',token);
  phase='restore';const verified=await check('restoreResolvedAndVerify',token);if(!['snapRestored','oldUnchanged','targetsExact'].every(k=>verified[k]===true))throw Error('verification-incomplete');
  phase='commit-gate';gateRequested=true;const gate=await check('prepareCommit',token,receipts);permit=gate.permit;if(typeof permit!=='string'||!permit)throw Error('missing-permit');
  phase='commit';await adapter.commit(permit,receipts);
  phase='commit-done';const resolution=await check('commitDone',token,permit);if(!committed(resolution))throw Error('terminal-proof-incomplete');
  return {ok:true,phase:'complete',resolution};
 }catch(e){
  const reason=String(e.message||e),context=token?{token,permit:permit||null,receipts}:undefined;
  if(!token)return {ok:false,phase,reason,recovery:'watchdog-owned',pendingVerification:true,retrySafe:false};
  try{
   const resolution=gateRequested?await adapter.resolveCommit(token,permit||null,receipts):await adapter.abort(token);
   if(committed(resolution))return {ok:true,recovered:true,phase:'complete',resolution};
   if(resolution?.ok&&resolution.state==='aborted')return {ok:false,phase,reason,resolution,verifiedAborted:true,pendingVerification:false,retrySafe:true};
   return {ok:false,phase,reason,resolution,verificationContext:context,pendingVerification:true,retrySafe:false};
  }catch(recoveryError){return {ok:false,phase,reason,recoveryError:String(recoveryError.message||recoveryError),verificationContext:context,pendingVerification:true,retrySafe:false};}
 }
}
module.exports={createUnknownAdapter,runUnknownLease};
