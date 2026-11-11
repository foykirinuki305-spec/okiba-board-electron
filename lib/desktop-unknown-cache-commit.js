'use strict';
// Optional cache activation only after the existing receipt/durable-release path.
// Failure never retries placement or converts a committed transaction to rollback.
function createUnknownCacheCommit(io){
 const candidates=new Map();
 return {
  async native(command,payload){
   const result=await io.native(command,payload);
   if(command==='leaseUnknownReleaseVisible'){
    candidates.clear();
    if(result?.ok&&typeof result.cacheCandidateId==='string'&&/^[a-f0-9]{32}$/.test(result.cacheCandidateId))candidates.set(payload.token,result.cacheCandidateId);
   }
   return result;
  },
  async release(token){
   await io.release(token);
   const candidateId=candidates.get(token);candidates.clear();
   if(!candidateId)return;
   let result;
   try{result=await io.native('leaseUnknownCommitSessionCalibration',{token,candidateId});}
   catch(error){result={ok:false,reason:error.message||'cache-activation-failed'};}
   if(io.record)io.record({ok:result?.ok===true,reason:result?.reason||null});
  }
 };
}
module.exports={createUnknownCacheCommit};
