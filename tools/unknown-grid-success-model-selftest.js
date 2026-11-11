'use strict';const assert=require('assert/strict');const {verifyProof,fixShape,verifyTargets}=require('./unknown-grid-success-model-ci');
const snap=(q,g)=>g.o+Math.floor((q-g.o)/g.s+.5)*g.s;
function proof(actual){
 const p={binding:{token:'owned-token',probeId:'owned-probe',geometryKey:'physical-geometry',iconsKey:'old-identities-xy'},maxSpacing:{x:160,y:160},center:{x:400,y:400},patch:{left:0,top:0,right:800,bottom:800},samples:[]};
 for(const axis of ['x','y']){const other=axis==='x'?'y':'x',g=actual[axis];let candidates=[];for(let s=8;s<=160;s++)for(let o=0;o<s;o++)candidates.push({s,o});
  const emit=(q,pass)=>{const request={x:400,y:400,[axis]:q},v={...p.binding,id:p.samples.length,axis,pass,requestX:request.x,requestY:request.y,x:snap(request.x,actual.x),y:snap(request.y,actual.y)};p.samples.push(v);return v[axis];};
  for(let n=0;n<12&&candidates.length>1;n++){let best=400,score=Infinity;for(const q of n===0?[400]:Array.from({length:25},(_,i)=>400+Math.round((i-12)*160/8))){const counts=new Map();for(const g of candidates){const v=snap(q,g);counts.set(v,(counts.get(v)||0)+1);}const worst=Math.max(...counts.values());if(worst<score){score=worst;best=q;}}const v=emit(best,'candidate');candidates=candidates.filter(g=>snap(best,g)===v);}
  assert.equal(candidates.length,1);const cell=snap(400,g),delta=Math.max(1,Math.floor(g.s/4)),near=cell>=400?cell-g.s:cell+g.s,far=cell>=400?cell+g.s:cell-g.s;
  const f=[near-delta,near+delta,cell-delta,cell+delta,far].sort((a,b)=>a-b);for(const q of f)emit(q,'forward');for(const q of [...f].reverse())emit(q,'reverse');
 }return p;
}
const p=proof({x:{s:78,o:15},y:{s:98,o:2}});assert.deepEqual(verifyProof(p).grid,{sx:78,sy:98,gx:15,gy:2});
const clone=x=>JSON.parse(JSON.stringify(x));let rejected=0;
function bad(mutate){const x=clone(p);mutate(x);assert.equal(verifyProof(x).ok,false);rejected++;}
bad(x=>x.samples.pop());bad(x=>x.samples.push({...x.samples.at(-1)}));bad(x=>x.samples[0].token='foreign');bad(x=>x.samples[0].geometryKey='changed');bad(x=>x.samples[0].iconsKey='changed');bad(x=>x.samples[0].probeId='other');bad(x=>x.samples[0].id=1);bad(x=>x.samples[0].x+=1);bad(x=>x.samples.find(s=>s.pass==='reverse').x+=78);bad(x=>x.samples.find(s=>s.pass==='forward').requestX+=1);bad(x=>x.samples[1].y+=98);bad(x=>x.samples[0].requestX=-100);bad(x=>x.samples=x.samples.filter(s=>s.pass!=='candidate'));bad(x=>{for(const s of x.samples){s.x=s.requestX;s.y=s.requestY;}});
bad(x=>{for(const s of x.samples.filter(s=>s.axis==='x'))s.y+=98;});bad(x=>x.patch={});bad(x=>x.patch.left=NaN);bad(x=>x.patch.right=Infinity);bad(x=>x.patch.right=x.patch.left);bad(x=>x.patch.right=700);
for(const g of [{x:{s:117,o:15},y:{s:147,o:2}}]){const q=proof(g);assert(verifyProof(q).ok);}
// A small-pitch lattice can remain ambiguous under the bounded query set: reject, never guess.
assert.throws(()=>proof({x:{s:9,o:2},y:{s:10,o:1}}));
const items=[{path:'A',cell:[3,4]},{path:'B',cell:[5,4]},{path:'C',cell:[4,6]}],shape=fixShape(items,'A');items[1].cell[0]=99;assert.equal(shape[1].dx,2);assert(Object.isFrozen(shape)&&shape.every(Object.isFrozen));
const params={shape,grid:{sx:78,sy:98,gx:15,gy:2},area:{left:0,top:0,right:1000,bottom:1000},anchor:{x:93,y:100},targets:[{path:'A',x:93,y:100},{path:'B',x:249,y:100},{path:'C',x:171,y:296}],old:[{x:700,y:700,w:78,h:98}]};assert(verifyTargets(params).ok);
for(const mutate of [x=>x.targets[1].x+=78,x=>x.targets.pop(),x=>x.area.right=200,x=>x.old=[{x:100,y:110,w:78,h:98}],x=>x.old=[{x:700,y:700}],x=>x.anchor.x+=1]){const x=clone(params);mutate(x);assert(!verifyTargets(x).ok);}
for(const mutate of [x=>x.area={},x=>x.area.left=NaN,x=>x.area.right=Infinity,x=>x.area.bottom=x.area.top,x=>x.anchor={},x=>x.grid.sx=NaN,x=>x.shape[0].dx=undefined,x=>x.shape[0].dy=NaN,x=>x.shape[1].path='A',x=>x.old=[{x:0,y:0,w:NaN,h:98}],x=>{x.area={};x.anchor={x:100011,y:100060};for(const t of x.targets){t.x+=99918;t.y+=99960;}}]){const x=clone(params);mutate(x);assert(!verifyTargets(x).ok);}
assert.throws(()=>fixShape([{path:'A',cell:[0,0]},{path:'a',cell:[1,0]}],'A'));assert.throws(()=>fixShape([{path:'A',cell:[0,0]},{path:'B',cell:[0,0]}],'A'));assert.throws(()=>fixShape(items,'missing'));
console.log(JSON.stringify({passed:true,proofRejections:rejected,nativeExecuted:false,nativeAuthenticityNotProven:true,normalSampleCount:p.samples.length}));
