'use strict';
// Renderer / Electron bounds are DIP. Native helpers and the pre-resolve
// cache use physical screen pixels. Convert exactly once at IPC boundaries.
function point(p) {
  const x=Number(p?.x),y=Number(p?.y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error('invalid-screen-point');
  return {x:Math.round(x),y:Math.round(y)};
}
function dipToPhysical(screen,p,platform=process.platform) {
  const q=point(p);
  return platform==='win32'?point(screen.dipToScreenPoint(q)):q;
}
function physicalToDip(screen,p,platform=process.platform) {
  const q=point(p);
  return platform==='win32'?point(screen.screenToDipPoint(q)):q;
}
function physicalDropPayload(screen,payload,platform=process.platform) {
  const p=dipToPhysical(screen,{x:payload?.screenX,y:payload?.screenY},platform);
  return {...payload,screenX:p.x,screenY:p.y};
}
function outsideDipBounds(screen,physical,bounds,platform=process.platform) {
  if(!bounds)return true;
  const p=physicalToDip(screen,physical,platform);
  return p.x<bounds.x||p.y<bounds.y||p.x>=bounds.x+bounds.width||p.y>=bounds.y+bounds.height;
}
function coldResolveSafe(screen,platform=process.platform) {
  if(platform!=='win32')return true;
  try { const ds=screen.getAllDisplays();return ds.length>0&&ds.every(d=>d.scaleFactor===1); } catch (_) {return false;}
}
module.exports={coldResolveSafe,dipToPhysical,physicalToDip,physicalDropPayload,outsideDipBounds};
