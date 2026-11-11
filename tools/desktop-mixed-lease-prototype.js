'use strict';
// DESIGN PROTOTYPE ONLY: no imports from production dispatch and no filesystem writes.
const path=require('path');
const {prepareResidentMetadata}=require('../lib/desktop-resident-selection');
const key=p=>typeof p==='string'?path.win32.resolve(p).toLowerCase():null;
function planMixed(scope){
 if(scope?.kind!=='mixed-hidden-resident-prototype'||!Array.isArray(scope.items)||scope.items.length<2)throw Error('mixed-scope');
 const modes=new Set(scope.items.map(i=>i.mode));if(modes.size!==2||!modes.has('hidden-link')||!modes.has('resident-file'))throw Error('mixed-modes');
 const grid=scope.grid;if(!grid||!['gx','gy','sx','sy'].every(k=>Number.isInteger(grid[k]))||grid.sx<=0||grid.sy<=0)throw Error('mixed-known-grid-required');
 const identities=new Set(),names=new Set(),sources=new Set();
 for(const i of scope.items){
  if(typeof i.source!=='string'||typeof i.destination!=='string'||!/^[a-z]:\\/i.test(i.source)||!/^[a-z]:\\/i.test(i.destination)||typeof i.identity!=='string'||!i.identity||identities.has(i.identity)||names.has(key(i.destination))||sources.has(key(i.source)))throw Error('mixed-identity-path');
  identities.add(i.identity);names.add(key(i.destination));sources.add(key(i.source));
  if(key(path.win32.dirname(i.destination))!==key(scope.desktop)||!Array.isArray(i.offset)||i.offset.length!==2||!i.offset.every(Number.isInteger))throw Error('mixed-layout');
  if(i.mode==='hidden-link'){if(key(i.source)!==key(i.destination)||i.originalHidden!==true)throw Error('mixed-hidden-source');}
  else if(key(i.source)===key(i.destination)||i.crossVolume!==false||i.regularFile!==true||i.reparse!==false||i.linkCount!==1||![32,34].includes(i.originalAttributes))throw Error('mixed-resident-source');
 }
 for(const i of scope.items)for(const j of scope.items)if(i!==j&&key(i.source)===key(j.destination))throw Error('mixed-path-overlap');
 if(!Array.isArray(scope.targets)||scope.targets.length!==scope.items.length)throw Error('mixed-targets');
 const occupied=new Set(),targets=new Map();for(const t of scope.targets){if(targets.has(key(t.path))||!Number.isInteger(t.x)||!Number.isInteger(t.y)||(t.x-grid.gx)%grid.sx||(t.y-grid.gy)%grid.sy||occupied.has(t.x+','+t.y))throw Error('mixed-target-grid');targets.set(key(t.path),t);occupied.add(t.x+','+t.y);}
 const first=scope.items[0],anchor=targets.get(key(first.destination));if(!anchor)throw Error('mixed-target-missing');
 for(const i of scope.items){const t=targets.get(key(i.destination));if(!t||t.x-anchor.x!==(i.offset[0]-first.offset[0])*grid.sx||t.y-anchor.y!==(i.offset[1]-first.offset[1])*grid.sy)throw Error('mixed-shape-changed');}
 return Object.freeze({kind:scope.kind,count:scope.items.length,rollbackModes:scope.items.map(i=>i.mode==='hidden-link'?'rehide-samepath':'restore-source-no-replace'),requiresOneGlobalLease:true,requiresOneReceiptGate:true});
}
function mixedMetadata(before,scope,boardFolder){
 planMixed(scope);
 const residents=scope.items.filter(i=>i.mode==='resident-file').map(i=>i.source);
 const data=JSON.parse(prepareResidentMetadata(before,residents,boardFolder));
 const links=scope.items.filter(i=>i.mode==='hidden-link');
 for(const i of links)if(data.links.filter(l=>l&&key(l.path)===key(i.source)).length!==1)throw Error('mixed-link-missing-or-duplicate');
 data.links=data.links.filter(l=>!links.some(i=>key(i.source)===key(l?.path)));
 return JSON.stringify(data,null,2);
}
// Journal phase is durable BEFORE its corresponding native mutation/permission.
// No per-subgroup commit. Once permission may exist, only receipt authority resolves.
function recoveryRoute(phase){
 if(['prepared','off-intent','staging','placing','restoring'].includes(phase))return 'invalidate-token-stop-helper-then-recover-whole-group';
 if(['permit-intent','permitted','committed'].includes(phase))return 'receipt-authority-only-no-ordinary-rollback';
 if(['released','aborted'].includes(phase))return 'verify-terminal-global-release';
 return 'blocked-unknown-no-mutation';
}
module.exports={planMixed,mixedMetadata,recoveryRoute};
