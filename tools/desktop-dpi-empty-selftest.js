'use strict';const assert=require('assert/strict'),{allowed}=require('./desktop-dpi-empty-fixture-ci');
const p='C:\\Users\\Public\\Desktop';
assert(allowed(p+'\\Firefox.lnk',p));
for(const v of [p+'\\mine.lnk','C:\\Users\\keiya\\Desktop\\Firefox.lnk',p+'\\x\\Firefox.lnk',p+'\\Firefox.exe',null])assert(!allowed(v,p));
console.log('fixture allowlist 6 checks PASS; no Desktop access');
(async()=>{const {waitForEmpty}=require('./desktop-dpi-empty-fixture-ci');let n=0,checked=0;const v=await waitForEmpty(async()=>({ok:true,icons:++n<3?[{}]:[]}),async()=>{checked++;},{sleep:async()=>{}});assert.equal(n,3);assert.equal(checked,3);assert.equal(v.icons.length,0);await assert.rejects(waitForEmpty(async()=>({ok:false,reason:'unknown-error'}),async()=>{},{sleep:async()=>{}}),/unavailable/);await assert.rejects(waitForEmpty(async()=>({ok:true,icons:[{}]}),async()=>{},{attempts:2,sleep:async()=>{}}),/timeout/);await assert.rejects(waitForEmpty(async()=>({ok:true,icons:[]}),async()=>{throw Error('identity');},{sleep:async()=>{}}),/identity/);console.log('empty bounded poll 4 cases PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
