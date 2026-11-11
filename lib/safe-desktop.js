'use strict';
const finite = Number.isFinite;
const near = (a,b) => Math.abs(a-b) <= 1;
const overlap = (a,b,sx,sy) => Math.abs(a.x-b.x)<sx-1 && Math.abs(a.y-b.y)<sy-1;
function sameSnapshot(a,b) {
  if(!a?.ok || !b?.ok || a.autoArrange!==b.autoArrange || a.snap!==b.snap) return false;
  for(const k of ['sx','sy','gx','gy']) if(a[k]!==b[k]) return false;
  if(JSON.stringify(a.areas)!==JSON.stringify(b.areas)||JSON.stringify(a.origin)!==JSON.stringify(b.origin)) return false;
  const list=s=>(s.icons||[]).map(i=>JSON.stringify([i.label,i.x,i.y])).sort();
  return JSON.stringify(list(a))===JSON.stringify(list(b));
}
function planDesktop({snapshot:s,items,point,automatic=false}) {
  const no=reason=>({ok:false,reason});
  if(!s?.ok || s.autoArrange || !s.snap || ![s.sx,s.sy,s.gx,s.gy].every(Number.isInteger) || s.sx<=0 || s.sy<=0 || !Array.isArray(s.areas)||!s.areas.length||!Array.isArray(s.icons)) return no('unknown-desktop');
  if(!items?.length || items.some(i=>!i.path||!i.name||!Array.isArray(i.offset)||i.offset.length!==2||!i.offset.every(Number.isInteger))) return no('unknown-layout');
  if(new Set(items.map(i=>i.path.toLowerCase())).size!==items.length || new Set(items.map(i=>i.name.toLowerCase())).size!==items.length) return no('ambiguous-items');
  if(s.icons.some(i=>typeof i.label!=='string'||![i.x,i.y].every(finite))) return no('unknown-desktop');
  const labels=s.icons.map(i=>i.label.toLowerCase());
  for(const i of items) {const n=i.name.toLowerCase(),stem=n.replace(/\.[^.]+$/,'');if(labels.includes(n)||labels.includes(stem))return no('ambiguous-name');}
  const inside=p=>s.areas.some(r=>[r.left,r.top,r.right,r.bottom].every(finite)&&p.x>=r.left&&p.y>=r.top&&p.x+s.sx<=r.right&&p.y+s.sy<=r.bottom);
  const free=p=>inside(p)&&!s.icons.some(i=>overlap(p,i,s.sx,s.sy));
  const all=[];
  for(const r of s.areas) {
    const x0=s.gx+Math.ceil((r.left-s.gx)/s.sx)*s.sx;
    const y0=s.gy+Math.ceil((r.top-s.gy)/s.sy)*s.sy;
    for(let x=x0;x+s.sx<=r.right;x+=s.sx)for(let y=y0;y+s.sy<=r.bottom;y+=s.sy){if(all.length>50000)return no('unknown-desktop');const p={x,y};if(free(p))all.push(p);}
  }
  const attempt=a=> {
    const targets=items.map(i=>({path:i.path,name:i.name,x:a.x+i.offset[0]*s.sx,y:a.y+i.offset[1]*s.sy}));
    if(targets.some(p=>!free(p)))return null;
    if(targets.some((p,k)=>targets.some((q,j)=>j<k&&overlap(p,q,s.sx,s.sy))))return null;
    // One spare cell makes cycles between newly arrived icons safe.
    const buffer=all.find(p=>!targets.some(q=>overlap(p,q,s.sx,s.sy)));
    return buffer?{ok:true,targets,buffer}:null;
  };
  if(automatic){for(const a of all){const p=attempt(a);if(p)return p;}return no('no-space');}
  if(!point||![point.x,point.y].every(finite))return no('unknown-point');
  const a={x:s.gx+Math.floor((point.x-s.sx/2-s.gx)/s.sx+0.5)*s.sx,y:s.gy+Math.floor((point.y-s.sy/2-s.gy)/s.sy+0.5)*s.sy};
  return attempt(a)||no('occupied-or-outside');
}
async function executeDesktop({items,plan,snapshot,adapter}) {
  if(!plan?.ok)return {ok:false,blocked:true,reason:plan?.reason||'no-plan',recovery:[]};
  try {if(!sameSnapshot(snapshot,await adapter.snapshot()))return {ok:false,blocked:true,reason:'desktop-changed',recovery:[]};}
  catch(e){return {ok:false,blocked:true,reason:'snapshot-unavailable',recovery:[]};}
  const changed=[];
  try {
    for(const item of items){changed.push(item);await adapter.move(item);}
    const positioned=await adapter.position(snapshot,plan);
    if(positioned?.unsafe)return {ok:false,blocked:false,reason:'helper-not-stopped',recovery:changed.map(i=>({path:i.recoveryPath||i.dest||i.path,error:'position-helper-state-unknown'}))};
    if(!positioned?.ok)throw Error(positioned?.reason||'position-failed');
    await adapter.commit();
    return {ok:true,position:positioned,recovery:[]};
  } catch(error) {
    if(error.unsafe)return {ok:false,blocked:false,reason:'helper-not-stopped',recovery:changed.map(i=>({path:i.recoveryPath||i.dest||i.path,error:'helper-state-unknown'}))};
    const recovery=[];
    for(const item of changed.reverse()){try{await adapter.rollback(item);}catch(e){if(e.unsafe)return {ok:false,blocked:false,reason:'helper-not-stopped',recovery:changed.map(i=>({path:i.recoveryPath||i.dest||i.path,error:'helper-state-unknown'}))};recovery.push({path:item.recoveryPath||item.dest||item.path,error:String(e.message||e)});}}
    return {ok:false,blocked:false,reason:String(error.message||error),recovery};
  }
}
module.exports={planDesktop,sameSnapshot,executeDesktop};
