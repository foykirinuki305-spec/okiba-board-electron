'use strict';const assert=require('assert/strict'),{allowed}=require('./desktop-dpi-empty-fixture-ci');
const p='C:\\Users\\Public\\Desktop';
assert(allowed(p+'\\Firefox.lnk',p));
for(const v of [p+'\\mine.lnk','C:\\Users\\keiya\\Desktop\\Firefox.lnk',p+'\\x\\Firefox.lnk',p+'\\Firefox.exe',null])assert(!allowed(v,p));
console.log('fixture allowlist 6 checks PASS; no Desktop access');
(async()=>{const {waitForEmpty}=require('./desktop-dpi-empty-fixture-ci');let n=0,checked=0;const v=await waitForEmpty(async()=>({ok:true,icons:++n<3?[{}]:[]}),async()=>{checked++;},{sleep:async()=>{}});assert.equal(n,3);assert.equal(checked,3);assert.equal(v.icons.length,0);await assert.rejects(waitForEmpty(async()=>({ok:false,reason:'unknown-error'}),async()=>{},{sleep:async()=>{}}),/unavailable/);await assert.rejects(waitForEmpty(async()=>({ok:true,icons:[{}]}),async()=>{},{attempts:2,sleep:async()=>{}}),/timeout/);await assert.rejects(waitForEmpty(async()=>({ok:true,icons:[]}),async()=>{throw Error('identity');},{sleep:async()=>{}}),/identity/);console.log('empty bounded poll 4 cases PASS');})().catch(e=>{console.error(e);process.exitCode=1;});

(async()=>{
 const {waitForRestored}=require('./desktop-dpi-empty-fixture-ci'),formal=require('./formal-unknown-dpi-empty-fixture-ci');
 assert.equal(waitForRestored.toString(),formal.waitForRestored.toString());
 const before={icons:[{identity:'a',x:1,y:2},{identity:'b',x:3,y:4}]};let read=0,check=0,sleeps=0;const observations=[];
 const sequence=[{ok:false,reason:'desktop-changing'},{ok:true,icons:before.icons.slice(0,1)},{ok:true,icons:[...before.icons].reverse()}];
 const result=await waitForRestored(async()=>sequence[read++],async()=>{check++;},before,{sleep:async ms=>{assert.equal(ms,250);sleeps++;},observe:v=>observations.push(v)});
 assert.equal(read,3);assert.equal(check,3);assert.equal(sleeps,2);assert.equal(result.icons.length,2);assert.equal(observations.length,3);
 for(const v of [{ok:false,reason:'shell-snapshot-error'},{ok:false,reason:'unknown-error'},{ok:true,icons:[{identity:'a',x:2,y:2}]},{ok:true,icons:[{identity:'foreign',x:1,y:2}]},{ok:true,icons:[before.icons[0],before.icons[0]]},null]){
  let calls=0;await assert.rejects(waitForRestored(async()=>{calls++;return v;},async()=>{},before,{sleep:async()=>{}}));assert.equal(calls,1);
 }
 let count=0;await assert.rejects(waitForRestored(async()=>{count++;return {ok:false,reason:'desktop-changing'}},async()=>{},before,{sleep:async()=>{}}),/timeout/);assert.equal(count,20);
 await assert.rejects(waitForRestored(async()=>({ok:true,icons:[]}),async()=>{},before,{attempts:2,sleep:async()=>{}}),/timeout/);
 let r=0;await assert.rejects(waitForRestored(async()=>{r++;return {ok:true,icons:before.icons}},async()=>{throw Error('identity/attrs/hash mismatch')},before,{sleep:async()=>{}}),/mismatch/);assert.equal(r,0);
 console.log('restored poll positive + 9 fail-closed cases PASS; no Desktop access');
})().catch(e=>{console.error(e);process.exitCode=1;});
