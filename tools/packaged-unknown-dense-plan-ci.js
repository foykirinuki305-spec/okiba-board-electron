'use strict';
const assert=require('assert/strict');
function densePlan(area,g,firstTarget,secondTarget){
 assert.equal(area.scale,150);for(const k of ['sx','sy'])assert(Number.isFinite(g[k])&&g[k]>0);
 const cells=[];for(let c=0;c<128;c++)for(let r=0;r<128;r++){const x=g.gx+c*g.sx,y=g.gy+r*g.sy;if(x>=area.left&&y>=area.top&&x+g.sx<=area.right&&y+g.sy<=area.bottom)cells.push({c,r,x,y});}
 const at=(c,r)=>cells.find(i=>i.c===c&&i.r===r);
 const groups=[8,12].map(c=>Array.from({length:24},(_,n)=>{const v=at(c+Math.floor(n/6),n%6);assert(v,'dense-51 fixture does not fit complete cells');return v;}));
 const anchor=t=>({c:Math.floor((t.x-g.sx/2-g.gx)/g.sx+.5),r:Math.floor((t.y-g.sy/2-g.gy)/g.sy+.5)});
 const reserved=[firstTarget,secondTarget].flatMap(t=>{const a=anchor(t);return Array.from({length:3},(_,n)=>{const v=at(a.c,a.r+n);assert(v);return v;});});
 const all=[...groups.flat(),...reserved];assert.equal(new Set(all.map(v=>v.c+':'+v.r)).size,54);
 for(const target of [firstTarget,secondTarget,{x:secondTarget.x,y:area.bottom-5}])for(const v of groups.flat())assert(Math.abs(target.x-v.x)>=Math.max(g.sx,120)||Math.abs(target.y-v.y)>=Math.max(g.sy,120),'dense guard intersects pointer exclusion');
 return {groups,capacity:cells.length,oldCount:51,selectedCount:3,scope:'single 150 percent only; not 202 icons or mixed DPI'};
}
module.exports={densePlan};
