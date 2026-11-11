// Research model ONLY. No OS/filesystem/Shell calls. Not a production proof verifier.
'use strict';
const assert=require('assert/strict');
const snap=(q,g)=>g.o+Math.floor((q-g.o)/g.s+.5)*g.s;
function identify(max,center,measure){
 let candidates=[];for(let s=8;s<=max;s++)for(let o=0;o<s;o++)candidates.push({s,o});
 const samples=[];
 for(let n=0;n<12&&candidates.length>1;n++){
  let best=center,score=Infinity;
  const choices=n===0?[center]:Array.from({length:25},(_,i)=>center+Math.round((i-12)*max/8));
  for(const q of choices){const counts=new Map();for(const g of candidates){const v=snap(q,g);counts.set(v,(counts.get(v)||0)+1);}const worst=Math.max(...counts.values());if(worst<score){score=worst;best=q;}}
  const observed=measure(best);samples.push({q:best,v:observed});candidates=candidates.filter(g=>snap(best,g)===observed);if(!candidates.length)return {ok:false,samples};
 }
 if(candidates.length!==1)return {ok:false,samples};const g=candidates[0],cell=snap(center,g),delta=Math.max(1,Math.floor(g.s/4));
 // Three adjacent cells, two plateaus, forward and reversed re-observations.
 // Unlike a fixed DPI estimate, every selected grid coordinate must be observed.
 const near=cell>=center?cell-g.s:cell+g.s,far=cell>=center?cell+g.s:cell-g.s;
 const forward=[near-delta,near+delta,cell-delta,cell+delta,far].sort((a,b)=>a-b);
 for(const q of [...forward,...forward.slice().reverse()]){const observed=measure(q);samples.push({q,v:observed});if(observed!==snap(q,g))return {ok:false,samples};}
 return {ok:true,g,samples};
}
let cases=0,maxSamples=0,total=0;
for(const s of [52,78,98,117,147,156,196])for(const o of [0,2,15,s-1])for(const center of [-1500,400,2200]){
 const actual={s,o:o%s};const r=identify(220,center,q=>snap(q,actual));assert(r.ok);assert.deepEqual(r.g,actual);cases++;maxSamples=Math.max(maxSamples,r.samples.length);total+=r.samples.length;
 // All model observations remain inside a 5*max patch. Native code must separately
 // enforce guard margins and recheck patch occupancy before each real mutation.
 assert(r.samples.every(v=>Math.abs(v.q-center)<=1.5*220&&Math.abs(v.v-center)<=2.5*220));
}
const unsnapped=identify(220,400,q=>q);assert(!unsnapped.ok);
let hits=0;const changed=identify(220,400,q=>snap(q,{s:117,o:15})+(++hits>5?3:0));assert(!changed.ok);
const clipped=identify(220,400,q=>Math.min(500,Math.max(300,snap(q,{s:117,o:15}))));assert(!clipped.ok);
console.log(JSON.stringify({cases,maxSamplesPerAxis:maxSamples,meanSamplesPerAxis:total/cases,unsnappedRejected:true,unstableRejected:true,clippedRejected:true,scope:'synthetic integer nearest-grid only; not Shell or mixed-DPI evidence'}));
