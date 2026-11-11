'use strict';
const assert=require('assert/strict'),{stableSnapshot}=require('./stable-snapshot-ci');
(async()=>{
 let checks=0;
 const good=n=>({ok:true,result:{ok:true,n}}),transient={ok:true,result:{ok:false,reason:'desktop-changing'}};
 async function run(values,guard=()=>{},cleanupEvidence=null){let i=0;return stableSnapshot({read:async()=>values[Math.min(i++,values.length-1)],guard,same:(a,b)=>a.n===b.n,sleep:async()=>{},attempts:4,cleanupEvidence});}
 assert.equal((await run([transient,good(1),good(1)])).n,1);checks++;
 let seen=0;await run([good(1),transient,good(2),good(2)],()=>seen++);assert.equal(seen,3);checks++;
 for(const v of [{ok:false,reason:'timeout'},{ok:true,result:{ok:false,reason:'snapshot-error'}},{ok:true,result:{ok:false,reason:'desktop-changing',hresult:-1}},transient]){await assert.rejects(run([v]));checks++;}
 await assert.rejects(run([good(1)],()=>{throw Error('old changed')}),/old changed/);checks++;
 await assert.rejects(run([good(1),good(2),good(3),good(4)]),/bounded/);checks++;
 const records=[],evidence={phase:'terminal-owned-removal',terminalConfirmed:true,record:e=>records.push(e)};
 const com=code=>({ok:true,result:{ok:false,reason:'shell-snapshot-error',errorType:'System.Runtime.InteropServices.COMException',hresult:code,detail:'Exception calling ReadShellBatch',innerDetail:'COM read failure'}});
 for(const code of ['0x80004005','0x80070490']){await assert.rejects(run([com(code),good(1),good(1)]));checks++;assert.equal((await run([com(code),good(1),good(1)],()=>{},evidence)).n,1);checks++;}
 assert.equal(records.length,2);checks++;
 await assert.rejects(run([com('0x80070005')],()=>{},evidence));checks++;
 await assert.rejects(run([com('0x80004005')],()=>{},evidence),/bounded/);checks++;
 await assert.rejects(run([com('0x80004005'),good(1)],()=>{throw Error('old changed')},evidence),/old changed/);checks++;
 await assert.rejects(run([good(1),com('0x80004005'),good(2),good(3)],()=>{},evidence),/bounded/);checks++;
 for(const invalid of [{...evidence,terminalConfirmed:false},{...evidence,phase:'active'},{...evidence,record:null}]){await assert.rejects(run([com('0x80004005'),good(1),good(1)],()=>{},invalid));checks++;}
 for(const result of [{...com('0x80004005').result,reason:'lease-operation-failed'},{...com('0x80004005').result,detail:'Other native operation'}]){await assert.rejects(run([{ok:true,result}],()=>{},evidence));checks++;}
 await assert.rejects(run([{ok:false,reason:'timeout'}],()=>{},evidence));checks++;
 const countChange={ok:true,result:{ok:false,reason:'desktop-changing',errorType:'System.InvalidOperationException',hresult:'0x80131509',innerDetail:'item-count-changed',detail:'Exception calling "ReadShellBatch" with "1" argument(s): "item-count-changed"'}};
 await assert.rejects(run([countChange,good(1),good(1)]));checks++;
 assert.equal((await run([countChange,good(1),good(1)],()=>{},evidence)).n,1);checks++;
 await assert.rejects(run([countChange],()=>{},evidence),/bounded/);checks++;
 await assert.rejects(run([good(1),countChange,good(2),good(3)],()=>{},evidence),/bounded/);checks++;
 await assert.rejects(run([countChange,good(1)],()=>{throw Error('old changed')},evidence),/old changed/);checks++;
 for(const patch of [{innerDetail:'unexpected'},{hresult:'0x80004005'},{reason:'lease-operation-failed'},{detail:'Other operation'},{errorType:'System.Exception'}]){await assert.rejects(run([{ok:true,result:{...countChange.result,...patch}}],()=>{},evidence));checks++;}
 console.log('stable snapshot CI '+checks+' PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
