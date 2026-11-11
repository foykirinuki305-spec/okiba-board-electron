// CI research only: no OS, mutation, receipt authority, or native-proof authenticity.
'use strict';
const snap=(q,g)=>g.o+Math.floor((q-g.o)/g.s+.5)*g.s;
const int=Number.isSafeInteger;
const rect=r=>r&&['left','top','right','bottom'].every(k=>int(r[k]))&&r.right>r.left&&r.bottom>r.top&&int(r.right-r.left)&&int(r.bottom-r.top);
function verifyProof(p){try{
 const {binding:b,samples,maxSpacing:max,center:c,patch}=p;
 if(!b||!['token','probeId','geometryKey','iconsKey'].every(k=>typeof b[k]==='string'&&b[k])||!Array.isArray(samples))throw Error('binding');
 if(!rect(patch)||!max||!c)throw Error('geometry');
 if(!['x','y'].every(a=>int(max[a])&&max[a]>=8&&max[a]<=512&&int(c[a])))throw Error('search-bounds');
 if(patch.right-patch.left<5*max.x||patch.bottom-patch.top<5*max.y||c.x<patch.left+max.x||c.x>patch.right-max.x||c.y<patch.top+max.y||c.y>patch.bottom-max.y)throw Error('patch-bounds');
 const axes={},otherValues={};let cursor=0;
 for(const axis of ['x','y']){
  const other=axis==='x'?'y':'x';let candidates=[];
  for(let s=8;s<=max[axis];s++)for(let o=0;o<s;o++)candidates.push({s,o});
  let fixedOther=null;const take=pass=>{
   const v=samples[cursor];if(!v||v.id!==cursor++||v.axis!==axis||v.pass!==pass||Object.keys(b).some(k=>v[k]!==b[k]))throw Error('sample-binding-order');
   if(!['requestX','requestY','x','y'].every(k=>int(v[k])))throw Error('sample-coordinate');
   if(v.requestX<patch.left+max.x||v.requestX>patch.right-max.x||v.requestY<patch.top+max.y||v.requestY>patch.bottom-max.y||v.x<patch.left||v.x>patch.right||v.y<patch.top||v.y>patch.bottom)throw Error('patch');
   const q=axis==='x'?v.requestX:v.requestY;if((other==='x'?v.requestX:v.requestY)!==c[other])throw Error('cross-axis-request');
   if(fixedOther===null)fixedOther=v[other];else if(v[other]!==fixedOther)throw Error('cross-axis-motion');return {q,value:v[axis]};
  };
  let discoveries=0;
  while(cursor<samples.length&&samples[cursor].axis===axis&&samples[cursor].pass==='candidate'){
   if(++discoveries>12)throw Error('discovery-budget');const v=take('candidate');candidates=candidates.filter(g=>snap(v.q,g)===v.value);if(!candidates.length)throw Error('non-model');
  }
  if(!discoveries||candidates.length!==1)throw Error('ambiguous-grid');
  const g=candidates[0],cell=snap(c[axis],g),delta=Math.max(1,Math.floor(g.s/4));
  const near=cell>=c[axis]?cell-g.s:cell+g.s,far=cell>=c[axis]?cell+g.s:cell-g.s;
  const forward=[near-delta,near+delta,cell-delta,cell+delta,far].sort((a,b)=>a-b),values=[];
  for(const pass of ['forward','reverse'])for(const q of pass==='forward'?forward:forward.slice().reverse()){
   const v=take(pass);if(v.q!==q||v.value!==snap(q,g))throw Error('proof-or-reverse-mismatch');if(pass==='forward')values.push(v.value);
  }
  const cells=[...new Set(values)];if(cells.length!==3||cells.some((v,i)=>i&&v-cells[i-1]!==g.s)||cells.filter(v=>values.filter(x=>x===v).length>=2).length!==2)throw Error('cells-plateaus');
  axes[axis]=g;otherValues[axis]=fixedOther;
 }
 if(cursor!==samples.length)throw Error('extra-samples');if(otherValues.x!==snap(c.y,axes.y)||otherValues.y!==snap(c.x,axes.x))throw Error('cross-axis-grid-inconsistent');return {ok:true,grid:{sx:axes.x.s,sy:axes.y.s,gx:axes.x.o,gy:axes.y.o},sampleCount:cursor};
}catch(e){return {ok:false,reason:e.message};}}
function fixShape(items,anchorPath){
 if(!Array.isArray(items)||!items.length)throw Error('empty-shape');const paths=new Set(),cells=new Set();
 const copy=items.map(i=>{if(typeof i.path!=='string'||!i.path||!Array.isArray(i.cell)||i.cell.length!==2||!i.cell.every(int))throw Error('invalid-shape');const k=i.path.toLowerCase(),cell=i.cell.join(',');if(paths.has(k)||cells.has(cell))throw Error('duplicate-shape');paths.add(k);cells.add(cell);return {path:i.path,cell:[...i.cell]};});
 const a=copy.find(i=>i.path.toLowerCase()===String(anchorPath).toLowerCase());if(!a)throw Error('missing-anchor');
 return Object.freeze(copy.map(i=>{const dx=i.cell[0]-a.cell[0],dy=i.cell[1]-a.cell[1];if(!int(dx)||!int(dy))throw Error('shape-overflow');return Object.freeze({path:i.path,dx,dy});}));
}
function verifyTargets({shape,targets,anchor,grid:g,area,old=[]}){try{
 if(!rect(area)||!g||!anchor||!Array.isArray(old))throw Error('geometry');
 if(!Array.isArray(shape)||!shape.length||!Array.isArray(targets)||targets.length!==shape.length||!['sx','sy','gx','gy'].every(k=>int(g[k]))||g.sx<=0||g.sy<=0||!int(anchor.x)||!int(anchor.y)||(anchor.x-g.gx)%g.sx||(anchor.y-g.gy)%g.sy)throw Error('target-input');
 const shapePaths=new Set(),shapeCells=new Set();for(const s of shape){if(!s||typeof s.path!=='string'||!s.path||!int(s.dx)||!int(s.dy)||shapePaths.has(s.path.toLowerCase())||shapeCells.has(s.dx+','+s.dy))throw Error('invalid-source-shape');shapePaths.add(s.path.toLowerCase());shapeCells.add(s.dx+','+s.dy);}if(!shapeCells.has('0,0'))throw Error('missing-shape-anchor');
 const seen=new Set();const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
 for(const s of shape){const t=targets.find(t=>typeof t.path==='string'&&t.path.toLowerCase()===s.path.toLowerCase());if(!t||seen.has(t.path.toLowerCase())||t.x!==anchor.x+s.dx*g.sx||t.y!==anchor.y+s.dy*g.sy)throw Error('shape-changed');seen.add(t.path.toLowerCase());
  if(!int(t.x)||!int(t.y)||!int(t.x+g.sx)||!int(t.y+g.sy)||t.x<area.left||t.y<area.top||t.x+g.sx>area.right||t.y+g.sy>area.bottom)throw Error('no-fit');
  const box={x:t.x,y:t.y,w:g.sx,h:g.sy};for(const o of old){if(!o||![o.x,o.y,o.w,o.h,o.x+o.w,o.y+o.h].every(int)||o.w<=0||o.h<=0)throw Error('unknown-old-occupancy');if(overlap(box,o))throw Error('collision');}
 }
 return {ok:true};
}catch(e){return {ok:false,reason:e.message};}}
module.exports={verifyProof,fixShape,verifyTargets};
