'use strict';
const {verifyProof}=require('./unknown-grid-success-model-ci');
const snap=(q,g)=>g.o+Math.floor((q-g.o)/g.s+.5)*g.s;
async function collectAdaptive(p,measure){const samples=[],c=p.center,max=p.maxSpacing;
 for(const axis of ['x','y']){let candidates=[];for(let s=8;s<=max[axis];s++)for(let o=0;o<s;o++)candidates.push({s,o});
  const emit=async(q,pass)=>{const point={...c,[axis]:q};const result=await measure({sampleId:samples.length,axis,pass,point});if(!result?.ok||!result.sample)throw Error('sample-failed');samples.push(result.sample);return result.sample[axis];};
  for(let n=0;n<12&&candidates.length>1;n++){let best=c[axis],score=Infinity;const choices=n===0?[best]:Array.from({length:25},(_,i)=>c[axis]+Math.round((i-12)*max[axis]/8));for(const q of choices){const counts=new Map();for(const g of candidates){const v=snap(q,g);counts.set(v,(counts.get(v)||0)+1);}const worst=Math.max(...counts.values());if(worst<score){score=worst;best=q;}}const value=await emit(best,'candidate');candidates=candidates.filter(g=>snap(best,g)===value);if(!candidates.length)throw Error('non-model');}
  if(candidates.length!==1)throw Error('ambiguous-grid');const g=candidates[0],cell=snap(c[axis],g),delta=Math.max(1,Math.floor(g.s/4)),near=cell>=c[axis]?cell-g.s:cell+g.s,far=cell>=c[axis]?cell+g.s:cell-g.s;
  const forward=[near-delta,near+delta,cell-delta,cell+delta,far].sort((a,b)=>a-b);for(const pass of ['forward','reverse'])for(const q of pass==='forward'?forward:[...forward].reverse()){if(await emit(q,pass)!==snap(q,g))throw Error('proof-mismatch');}
 }
 const result=verifyProof({...p,samples});if(!result.ok)throw Error(result.reason);return {...result,samples};}
module.exports={collectAdaptive};
