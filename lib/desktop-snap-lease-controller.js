'use strict';
// NOT connected to main.js. This coordinator cannot change Shell flags/files itself.
// Adapter/watchdog must authenticate owner/token, invalidate aborted tokens, and
// atomically grant prepareCommit only after restoring snap and checking positions.
const {key,validReceipts}=require('./desktop-commit-receipt');
const path=require('path');
function validateScope(s){
 if(!s||s.kind!=='samepath-hidden'||!key(s.desktop)||!Array.isArray(s.items)||!s.items.length)return false;
 const seen=new Set();if(!s.items.every(i=>{const p=key(i.path);if(!p||p!==key(i.destination)||key(path.win32.dirname(p))!==key(s.desktop)||seen.has(p)||i.hidden!==true||typeof i.fileIdentity!=='string'||!i.fileIdentity)return false;seen.add(p);return true;}))return false;
 const snap=s.snapshot;if(!snap?.ok||snap.identityVersion!==1||snap.autoArrange!==false||snap.snap!==true||!Array.isArray(snap.areas)||!Array.isArray(snap.icons))return false;
 const grid=g=>g&&['gx','gy','sx','sy'].every(k=>Number.isInteger(g[k]))&&g.sx>0&&g.sy>0;
 const areaAt=p=>snap.areas.filter(a=>p.x>=a.left&&p.x<a.right&&p.y>=a.top&&p.y<a.bottom);
 const identities=new Set();
 if(!snap.icons.every(i=>{if(typeof i.identity!=='string'||!i.identity||identities.has(i.identity)||!Number.isInteger(i.x)||!Number.isInteger(i.y))return false;identities.add(i.identity);const aa=areaAt(i);if(aa.length!==1||!grid(aa[0].grid))return false;const g=aa[0].grid;return (i.x-g.gx)%g.sx===0&&(i.y-g.gy)%g.sy===0;}))return false;
 const a=snap.areas[s.targetAreaIndex];return !!a&&!!grid(a.grid)&&Array.isArray(s.metadataPaths)&&s.metadataPaths.length>0&&s.metadataPaths.every(key)&&new Set(s.metadataPaths.map(key)).size===s.metadataPaths.length;
}
async function runLease({scope,receipts,adapter}){
 if(!validateScope(scope)||!validReceipts(receipts,scope.metadataPaths))return {ok:false,phase:'preflight',reason:'unsupported-or-invalid-scope'};
 let phase='prepare',token,permit;let gateRequested=false;
 const checked=async(name,...args)=>{const r=await adapter[name](...args);if(!r?.ok)throw Error(r?.reason||name+'-failed');return r;};
 try{
  const p=await checked('prepare',scope);token=p.token;if(typeof token!=='string'||!token)throw Error('missing-token');
  phase='reveal';await checked('revealAndPlace',token);
  phase='restore';const v=await checked('restoreAndVerify',token);if(v.snapRestored!==true||v.oldUnchanged!==true||v.targetsExact!==true)throw Error('verification-incomplete');
  phase='commit-gate';gateRequested=true;
  // A transport timeout here could hide a granted permit. Never ordinary-abort it.
  const g=await checked('prepareCommit',token,receipts);permit=g.permit;if(typeof permit!=='string'||!permit)throw Error('missing-permit');
  phase='commit';await adapter.commit(permit,receipts);
  phase='commit-done';await checked('commitDone',token,permit);
  phase='release';await checked('release',token);
  return {ok:true,phase:'complete'};
 }catch(e){
  const reason=String(e.message||e);
  if(!token)return {ok:false,phase,reason,recovery:'watchdog-owned'};
  try{
   if(gateRequested){const resolution=await adapter.resolveCommit(token,permit||null,receipts);
    if(resolution?.state==='committed'&&resolution.snapRestored===true&&resolution.oldUnchanged===true&&resolution.targetsExact===true&&resolution.leaseReleased===true)return {ok:true,recovered:true,phase:'complete',resolution};
    return {ok:false,phase,reason,resolution,recovery:'watchdog-owned',pendingVerification:true,retrySafe:false};
   }
   const resolution=await adapter.abort(token,{phase,reason});return {ok:false,phase,reason,resolution,recovery:'watchdog-owned'};
  }catch(recoveryError){return {ok:false,phase,reason,recovery:'watchdog-owned',recoveryError:String(recoveryError.message||recoveryError),...(gateRequested?{pendingVerification:true,retrySafe:false}:{})};}
 }
}
module.exports={validateScope,runLease};
