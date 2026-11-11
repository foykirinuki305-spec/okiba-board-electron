'use strict';
const assert=require('assert/strict'),path=require('path');
const {verifyTargets}=require('./unknown-grid-success-model-ci');
function assertCalibrationResult({before,after,response,selected}){
 const {observed,resolved,committed}=response;
 assert(observed?.ok&&resolved?.ok,'calibration evidence missing');
 assert(committed?.ok&&committed.state==='committed'&&['snapRestored','oldUnchanged','targetsExact','leaseReleased'].every(k=>committed[k]===true),'native terminal evidence missing');
 assert.deepEqual(resolved.grid,observed.grid,'native validated grid differs from observations');
 const area=before.areas[0];if(area.grid!==null)assert.deepEqual(observed.grid,area.grid,'known grid regression');
 const anchorCell=selected[0].cell,shape=selected.map(i=>({path:i.path,dx:i.cell[0]-anchorCell[0],dy:i.cell[1]-anchorCell[1]}));
 assert.deepEqual(resolved.shape,shape,'fixed source shape changed');
 const old=before.icons.map(i=>{const a=before.areas.filter(a=>i.x>=a.left&&i.x<a.right&&i.y>=a.top&&i.y<a.bottom);assert(a.length===1&&a[0].grid,'unproven old grid');return {x:i.x,y:i.y,w:a[0].grid.sx,h:a[0].grid.sy};});
 assert(verifyTargets({shape,targets:resolved.targets,anchor:resolved.anchor,grid:observed.grid,area,old}).ok,'targets do not preserve calibrated shape');
 for(const i of before.icons)assert(after.icons.some(j=>j.identity===i.identity&&j.x===i.x&&j.y===i.y),'old icon moved');
 for(const t of resolved.targets){const icons=after.icons.filter(i=>i.path&&path.win32.resolve(i.path).toLowerCase()===path.win32.resolve(t.path).toLowerCase());assert(icons.length===1&&icons[0].x===t.x&&icons[0].y===t.y,'native target readback differs');}
 return true;
}
module.exports={assertCalibrationResult};
