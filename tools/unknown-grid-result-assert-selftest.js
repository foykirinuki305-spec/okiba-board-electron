'use strict';const assert=require('assert/strict'),{assertCalibrationResult}=require('./unknown-grid-result-assert-ci');
const g={sx:113,sy:161,gx:20,gy:2},selected=[{path:'C:\\a.txt',cell:[0,0]},{path:'C:\\b.txt',cell:[2,0]},{path:'C:\\c.txt',cell:[1,2]}];
const targets=selected.map(i=>({path:i.path,x:20+i.cell[0]*113,y:2+i.cell[1]*161}));
const f={selected,before:{areas:[{left:0,top:0,right:1920,bottom:1080,grid:null}],icons:[]},after:{icons:targets.map((t,i)=>({...t,identity:String(i)}))},response:{observed:{ok:true,grid:g},resolved:{ok:true,grid:g,anchor:{x:20,y:2},shape:selected.map(i=>({path:i.path,dx:i.cell[0],dy:i.cell[1]})),targets},committed:{ok:true,state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true}}};
const copy=()=>JSON.parse(JSON.stringify(f));let n=0;const test=(fn)=>{fn();n++;};
test(()=>{const orig=JSON.stringify(f);assert(assertCalibrationResult(f));assert.equal(JSON.stringify(f),orig)});
test(()=>{const v=copy();v.before.areas[0].grid={...g};assert(assertCalibrationResult(v))});
for(const mutate of [v=>v.response.committed.leaseReleased=false,v=>v.response.resolved.grid.sx++,v=>v.after.icons[0].x++,v=>v.response.resolved.shape[1].dx++,v=>v.before.areas[0].grid={...g,sx:75},v=>v.before.icons.push({identity:'old',x:1,y:1})])test(()=>{const v=copy();mutate(v);assert.throws(()=>assertCalibrationResult(v))});
console.log('calibrated result assertion '+n+' cases PASS; no native/Desktop access');
