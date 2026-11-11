'use strict';
const assert=require('assert/strict'),{createUnknownCacheCommit}=require('../lib/desktop-unknown-cache-commit'),{createUnknownSuccessFlow}=require('../lib/desktop-unknown-success-flow');
const id='a'.repeat(32),token='b'.repeat(32);
(async()=>{
 let events=[],failLock=false,failCache=false,records=[],resultId=id;
 const io={native:async(cmd,p)=>{events.push(cmd);if(cmd==='leaseUnknownCommitSessionCalibration'){assert.deepEqual(p,{token,candidateId:id});if(failCache)throw Error('helper-restarted');return {ok:true};}return {ok:true,cacheCandidateId:resultId};},release:async t=>{assert.equal(t,token);events.push('lock-release');if(failLock)throw Error('lock-failed');},record:r=>records.push(r)};
 let w=createUnknownCacheCommit(io);await w.native('leaseUnknownReleaseVisible',{token});assert.deepEqual(events,['leaseUnknownReleaseVisible']);await w.release(token);assert.deepEqual(events,['leaseUnknownReleaseVisible','lock-release','leaseUnknownCommitSessionCalibration']);assert(records[0].ok);
 events=[];await w.release(token);assert.deepEqual(events,['lock-release'],'duplicate does not activate again');
 events=[];w=createUnknownCacheCommit(io);await w.native('leaseUnknownReleaseVisible',{token});failLock=true;await assert.rejects(w.release(token),/lock-failed/);assert(!events.includes('leaseUnknownCommitSessionCalibration'));failLock=false;
 events=[];failCache=true;await w.release(token);assert.equal(records.at(-1).ok,false);assert(events.includes('leaseUnknownCommitSessionCalibration'));failCache=false;
 for(resultId of [undefined,'','../fake','A'.repeat(32),'a'.repeat(31)]){events=[];w=createUnknownCacheCommit(io);await w.native('leaseUnknownReleaseVisible',{token});await w.release(token);assert(!events.includes('leaseUnknownCommitSessionCalibration'));}
 resultId=id;events=[];w=createUnknownCacheCommit(io);await w.native('leaseUnknownReleaseVisible',{token});const fresh=createUnknownCacheCommit(io);await fresh.release(token);assert(!events.includes('leaseUnknownCommitSessionCalibration'),'restart loses candidate');
 const a={mode:'unknown-grid',token,phase:'resolved-restored',scope:{metadataPaths:['meta']},recovery:{}};let hash='before',locked=true;events=[];
 const wrap=createUnknownCacheCommit({native:async cmd=>{events.push(cmd);return {ok:true,cacheCandidateId:id,snapRestored:true,oldUnchanged:true,targetsExact:true,recovery:{}};},release:async()=>{events.push('lock-release');locked=false;}});
 const flow=createUnknownSuccessFlow({get:()=>a,native:wrap.native,release:wrap.release,save:async()=>events.push('durable-'+a.phase),lockOwned:()=>locked,ownerState:async()=>({state:'alive'}),receiptsNow:()=>[{path:'meta',hash}],validReceipts:()=>true},{});
 const gate=await flow.prepareCommit(token,[{path:'meta',beforeHash:'before',afterHash:'after'}]);assert(!events.includes('leaseUnknownCommitSessionCalibration'));hash='after';assert.equal((await flow.commitDone(token,gate.permit)).state,'committed');
 assert(events.indexOf('leaseUnknownCommitSessionCalibration')>events.indexOf('durable-released'));assert(events.indexOf('leaseUnknownCommitSessionCalibration')>events.indexOf('lock-release'));
 const n=events.length;await flow.commitDone(token,gate.permit);assert.equal(events.length,n);
 const source=require('fs').readFileSync(require('path').join(__dirname,'../lib/desktop-lease-watchdog.js'),'utf8');
 const region=source.slice(source.indexOf(' // BEGIN formal unknown dispatch'),source.indexOf(' // END formal unknown dispatch'));
 const dispatch=new (Object.getPrototypeOf(async function(){}).constructor)('method','args','config','active','done','journal','formalUnknownFlow','formalUnknownSuccess','globalLock','native',region);
 const call=(cfg,a,pending,unresolved,owned)=>dispatch('unknown-sessionSnapshot',[],cfg,a,x=>x.phase==='released',{pending:()=>pending},{},{},{hasUnresolved:()=>unresolved,owned:()=>owned},async name=>{assert.equal(name,'leaseUnknownSessionSnapshot');return {ok:true,snapshot:'fresh'};});
 await assert.rejects(call({},null,[],false,false),/disabled/);
 for(const args of [[{phase:'active'},[],false,false],[null,['stale'],false,false],[null,[],true,false],[null,[],false,true]])await assert.rejects(call({allowUnknownGrid:true},...args),/unresolved/);
 assert.deepEqual(await call({allowUnknownGrid:true},{phase:'released'},[],false,false),{ok:true,snapshot:'fresh'});
 console.log('PASS optional cache activation after durable receipts/global release; malformed, restart, lock failure, cache failure and duplicates');
})().catch(e=>{console.error(e);process.exitCode=1;});
