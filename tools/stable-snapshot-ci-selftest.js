'use strict';
const assert=require('assert/strict'),{stableSnapshot}=require('./stable-snapshot-ci');
(async()=>{
 let checks=0;
 const good=n=>({ok:true,result:{ok:true,n}}),transient={ok:true,result:{ok:false,reason:'desktop-changing'}};
 async function run(values,guard=()=>{}){let i=0;return stableSnapshot({read:async()=>values[Math.min(i++,values.length-1)],guard,same:(a,b)=>a.n===b.n,sleep:async()=>{},attempts:4});}
 assert.equal((await run([transient,good(1),good(1)])).n,1);checks++;
 let seen=0;await run([good(1),transient,good(2),good(2)],()=>seen++);assert.equal(seen,3);checks++;
 for(const v of [{ok:false,reason:'timeout'},{ok:true,result:{ok:false,reason:'snapshot-error'}},{ok:true,result:{ok:false,reason:'desktop-changing',hresult:-1}},transient]){await assert.rejects(run([v]));checks++;}
 await assert.rejects(run([good(1)],()=>{throw Error('old changed')}),/old changed/);checks++;
 await assert.rejects(run([good(1),good(2),good(3),good(4)]),/bounded/);checks++;
 console.log('stable snapshot CI '+checks+' PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
