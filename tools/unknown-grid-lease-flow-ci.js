// Dependency-injected research flow. Not imported by production runtime.
'use strict';
const crypto=require('crypto');
const transitions={
 revealProbe:{from:['unknown-prepared'],intent:'probe-reveal-intent',done:'probe-visible-off',command:'leaseUnknownRevealProbe'},
 beginCalibration:{from:['probe-visible-off'],intent:'probe-snap-intent',done:'calibrating',command:'leaseUnknownBeginCalibration'},
 resolveTargets:{from:['calibrating'],intent:'resolve-targets-intent',done:'targets-resolved',command:'leaseUnknownResolveTargets'},
 revealResolvedAndPlace:{from:['targets-resolved'],intent:'placement-off-intent',done:'resolved-placed',command:'leaseUnknownRevealResolvedAndPlace'},
 restoreResolvedAndVerify:{from:['resolved-placed'],intent:'placement-on-intent',done:'resolved-restored',command:'leaseUnknownRestoreResolvedAndVerify'},
 calibrationSample:{from:['calibrating'],intent:'calibrating',done:'calibrating',command:'leaseUnknownCalibrationSample'}
};
function validateUnknownScope(scope){
 if(scope?.kind!=='samepath-hidden-unknown-grid-ci'||scope.version!==2||!scope.snapshot?.ok||scope.snapshot.autoArrange!==false||scope.snapshot.snap!==true||!Array.isArray(scope.items)||!scope.items.length||scope.items.length>1000)return false;
 if(!Number.isInteger(scope.targetAreaIndex)||!scope.snapshot.areas?.[scope.targetAreaIndex]||!scope.plan?.ok||scope.plan.areaIndex!==scope.targetAreaIndex)return false;
 if(!Array.isArray(scope.metadataPaths)||!scope.metadataPaths.length||scope.targets!==undefined)return false;
 const paths=new Set();return scope.items.every(i=>{if(typeof i.path!=='string'||i.path!==i.destination||i.hidden!==true||typeof i.fileIdentity!=='string'||!i.fileIdentity||paths.has(i.path.toLowerCase()))return false;paths.add(i.path.toLowerCase());return true;});
}
function createUnknownFlow(io){
 async function requireLive(token){const a=io.get();if(!a||a.mode!=='unknown-ci'||a.token!==token||['aborted','released','blocked'].includes(a.phase))throw Error('unknown-token-invalid');const owner=await io.ownerState();if(owner.state!=='alive')throw Error('unknown-owner-not-alive');return a;}
 return {
  async prepare(scope){
   if(!validateUnknownScope(scope))throw Error('unknown-invalid-scope');const previous=io.get();if(previous&&!['aborted','released'].includes(previous.phase))throw Error('lease-already-active');
   const owner=await io.ownerState();if(owner.state!=='alive')throw Error('unknown-owner-not-alive');const token=crypto.randomBytes(16).toString('hex');await io.begin(token);
   let prepared=false;
   try{const r=await io.native('leaseUnknownPrepare',{token,scope});if(!r.ok||!r.recovery)throw Error('unknown-prepare-failed');prepared=true;io.set({version:1,mode:'unknown-ci',token,scope,recovery:r.recovery,phase:'unknown-prepared',permit:null});await io.save();return {ok:true,token};}
   catch(e){/* leaseUnknownPrepare is strictly read-only: uncertain replies may leave helper-local state, never Desktop mutation. The adapter must stop/restart transport failures before throwing. */if(!prepared)await io.release(token);throw e;}
  },
  async step(name,token,payload={}){
   if(Object.prototype.hasOwnProperty.call(payload,'id')||Object.prototype.hasOwnProperty.call(payload,'cmd'))throw Error('reserved-transport-field');
   const rule=transitions[name];if(!rule)throw Error('unknown-step');const a=await requireLive(token);if(!rule.from.includes(a.phase))throw Error('unknown-phase-invalid');
   a.phase=rule.intent;if(['revealProbe','revealResolvedAndPlace'].includes(name))a.recovery.flagState='off-intent';if(['beginCalibration','restoreResolvedAndVerify'].includes(name))a.recovery.flagState='on-intent';await io.save(); // Before every mutating native request.
   const r=await io.native(rule.command,{...payload,token});if(!r.ok)throw Error(r.reason||'unknown-native-failed');
   if(r.recovery)a.recovery=r.recovery;if(['revealProbe','revealResolvedAndPlace'].includes(name))a.recovery.flagState='off';if(['beginCalibration','restoreResolvedAndVerify'].includes(name))a.recovery.flagState='on';a.phase=rule.done;await io.save();return r;
  },
  async abort(token,receiptResolution=false){
   const a=io.get();if(!a||a.mode!=='unknown-ci'||a.token!==token||(a.permit&&!(receiptResolution&&io.canRollbackPermit&&await io.canRollbackPermit(a))))throw Error('unknown-abort-invalid');if(a.phase==='aborted')return io.lockOwned?.()?{ok:false,state:'blocked',reason:'terminal-global-lock-unreleased'}:{ok:true,state:'aborted'};
   a.phase='abort-hide-intent';await io.save(); // Keep exact old flag through hiding and any helper loss.
   const hidden=await io.native('leaseUnknownHideAndVerify',{token});
   if(!hidden.ok||!hidden.oldUnchanged||!hidden.selectedHidden||!hidden.recovery||!['on','off'].includes(hidden.recovery.flagState))throw Error('unknown-hide-unverified');
   a.recovery=hidden.recovery;a.phase='abort-hidden';await io.save();
   a.recovery.abortFromFlagState=a.recovery.flagState;a.recovery.flagState='restore-on-intent';a.phase='abort-restore-intent';a.restoreAttempted=true;await io.save();
   const r=await io.native('leaseUnknownRestoreAndVerify',{token});
   if(!r.ok||!r.oldUnchanged||!r.selectedHidden||!r.snapRestored||!r.recovery)throw Error('unknown-rollback-unverified');
   a.recovery=r.recovery;a.phase='abort-restored';await io.save();
   const released=await io.native('leaseUnknownRelease',{token});if(!released?.ok)throw Error('unknown-release-unverified');a.phase='aborted';await io.save();await io.release(token);return {ok:true,state:'aborted'};
  }
 };
}
module.exports={createUnknownFlow,validateUnknownScope,transitions};
