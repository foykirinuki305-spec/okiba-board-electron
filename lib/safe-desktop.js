'use strict';
const finite = Number.isFinite;
const near = (a,b) => Math.abs(a-b) <= 1;
const overlap = (a,b,sx,sy) => Math.abs(a.x-b.x)<sx-1 && Math.abs(a.y-b.y)<sy-1;
function sameSnapshot(a,b) {
  if(!a?.ok || !b?.ok || a.autoArrange!==b.autoArrange || a.snap!==b.snap) return false;
  for(const k of ['sx','sy','gx','gy','viewDpi','folderFlags','shellAutoArrange','explorerPid','explorerStarted','listviewHwnd']) if(a[k]!==b[k]) return false;
  if(JSON.stringify(a.areas)!==JSON.stringify(b.areas)||JSON.stringify(a.origin)!==JSON.stringify(b.origin)) return false;
  const list=s=>(s.icons||[]).map(i=>JSON.stringify([i.label,i.x,i.y])).sort();
  return JSON.stringify(list(a))===JSON.stringify(list(b));
}
function planDesktop({snapshot:s,items,point,automatic=false}) {
  const no=reason=>({ok:false,reason});
  if(!s?.ok || s.autoArrange || !s.snap || !Array.isArray(s.areas)||!s.areas.length||!Array.isArray(s.icons))return no('unknown-desktop');
  if(!items?.length || items.some(i=>!i.path||!i.name||!Array.isArray(i.offset)||i.offset.length!==2||!i.offset.every(Number.isInteger)))return no('unknown-layout');
  if(new Set(items.map(i=>i.path.toLowerCase())).size!==items.length || new Set(items.map(i=>i.name.toLowerCase())).size!==items.length)return no('ambiguous-items');
  if(s.icons.some(i=>typeof i.label!=='string'||![i.x,i.y].every(finite)))return no('unknown-desktop');
  const labels=s.icons.map(i=>i.label.toLowerCase());
  for(const i of items){const n=i.name.toLowerCase(),stem=n.replace(/\.[^.]+$/,'');if(labels.includes(n)||labels.includes(stem))return no('ambiguous-name');}
  const perMonitor=s.areas.some(r=>Object.hasOwn(r,'grid'));
  const areas=s.areas.map(r=>({rect:r,grid:perMonitor?r.grid:{sx:s.sx,sy:s.sy,gx:s.gx,gy:s.gy}}));
  const valid=a=>a.grid&&[a.grid.sx,a.grid.sy,a.grid.gx,a.grid.gy].every(Number.isInteger)&&a.grid.sx>0&&a.grid.sy>0&&[a.rect.left,a.rect.top,a.rect.right,a.rect.bottom].every(finite)&&a.rect.right>a.rect.left&&a.rect.bottom>a.rect.top;
  if(!automatic&&(!point||![point.x,point.y].every(finite)))return no('unknown-point');
  const candidates=automatic?areas:areas.filter(a=>point.x>=a.rect.left&&point.x<a.rect.right&&point.y>=a.rect.top&&point.y<a.rect.bottom);
  if(!candidates.length)return no('occupied-or-outside');
  if(!automatic&&(candidates.length!==1||!valid(candidates[0])))return no('unknown-desktop');
  let scanned=0;
  for(const area of candidates) {
    if(!valid(area))continue;
    const r=area.rect,{sx,sy,gx,gy}=area.grid;
    // A complete selected shape and its temporary buffer remain on one monitor.
    const inside=p=>p.x>=r.left&&p.y>=r.top&&p.x+sx<=r.right&&p.y+sy<=r.bottom;
    const free=p=>inside(p)&&!s.icons.some(i=>overlap(p,i,sx,sy));
    const all=[];
    const x0=gx+Math.ceil((r.left-gx)/sx)*sx,y0=gy+Math.ceil((r.top-gy)/sy)*sy;
    for(let x=x0;x+sx<=r.right;x+=sx)for(let y=y0;y+sy<=r.bottom;y+=sy){if(++scanned>50000)return no('unknown-desktop');const p={x,y};if(free(p))all.push(p);}
    const attempt=a=>{
      const targets=items.map(i=>({path:i.path,name:i.name,x:a.x+i.offset[0]*sx,y:a.y+i.offset[1]*sy}));
      if(targets.some(p=>!free(p))||targets.some((p,k)=>targets.some((q,j)=>j<k&&overlap(p,q,sx,sy))))return null;
      const buffer=all.find(p=>!targets.some(q=>overlap(p,q,sx,sy)));
      return buffer?{ok:true,targets,buffer}:null;
    };
    if(automatic){for(const anchor of all){const plan=attempt(anchor);if(plan)return plan;}}
    else {const anchor={x:gx+Math.floor((point.x-sx/2-gx)/sx+0.5)*sx,y:gy+Math.floor((point.y-sy/2-gy)/sy+0.5)*sy};return attempt(anchor)||no('occupied-or-outside');}
  }
  return no(areas.some(valid)?'no-space':'unknown-desktop');
}

async function executeDesktop({items,plan,snapshot,adapter}) {
  if(!plan?.ok)return {ok:false,blocked:true,reason:plan?.reason||'no-plan',recovery:[]};
  try {if(!sameSnapshot(snapshot,await adapter.snapshot()))return {ok:false,blocked:true,reason:'desktop-changed',recovery:[]};}
  catch(e){return {ok:false,blocked:true,reason:'snapshot-unavailable',recovery:[]};}
  const changed=[];let positioned;
  try {
    for(const [index,item] of items.entries()){
      changed.push(item);await adapter.move(item);
      if(index===0&&adapter.completePlanAfterFirstMove){
        const completed=await adapter.completePlanAfterFirstMove(item);
        if(completed?.unsafe){const e=Error('calibration-helper-state-unknown');e.unsafe=true;throw e;}
        if(!completed?.ok)throw Error(completed?.reason||'calibration-plan-failed');
        plan=completed;
      }
    }
    positioned=await adapter.position(snapshot,plan);
    if(positioned?.unsafe)return {ok:false,blocked:false,reason:'helper-not-stopped',position:positioned,recovery:changed.map(i=>({path:i.recoveryPath||i.dest||i.path,error:'position-helper-state-unknown'}))};
    if(!positioned?.ok)throw Error(positioned?.reason||'position-failed');
    await adapter.commit();
    return {ok:true,position:positioned,recovery:[]};
  } catch(error) {
    if(error.unsafe)return {ok:false,blocked:false,reason:'helper-not-stopped',recovery:changed.map(i=>({path:i.recoveryPath||i.dest||i.path,error:'helper-state-unknown'}))};
    const recovery=[];
    for(const item of changed.reverse()){try{await adapter.rollback(item);}catch(e){if(e.unsafe)return {ok:false,blocked:false,reason:'helper-not-stopped',recovery:changed.map(i=>({path:i.recoveryPath||i.dest||i.path,error:'helper-state-unknown'}))};recovery.push({path:item.recoveryPath||item.dest||item.path,error:String(e.message||e)});}}
    return {ok:false,blocked:false,reason:String(error.message||error),position:positioned,recovery};
  }
}
module.exports={planDesktop,sameSnapshot,executeDesktop};
