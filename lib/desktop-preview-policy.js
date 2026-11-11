'use strict';
function enabled({isPackaged,platform,env}) {
 return isPackaged===true && platform==='win32' && env?.OKIBA_DESKTOP_SAFE_PREVIEW==='1';
}
function unknownEnabled(options) {
 return enabled(options) && options.env?.OKIBA_DESKTOP_UNKNOWN_PREVIEW==='1';
}
function nativeEnv(env) {
 const copy={...env};
 for(const key of Object.keys(copy))if(/^OKIBA_(TEST_|FAKE_|UNKNOWN_|MIXED_)/i.test(key)||/^OKIBA_(HELPER_MODE|SNAP_LEASE)$/i.test(key)){copy[key]='';copy[key.toUpperCase()]='';}
 return copy;
}
// Read-only candidate selection. Native prepare/ledger/CAS remain authoritative.
function unknownCandidate({enabled:optIn,snapshot,items,payload,point,desktop,metadataPath,calibration,samePath}) {
 if(optIn!==true||payload?.automatic!==false||!snapshot?.ok||snapshot.snap!==true||snapshot.autoArrange!==false||!Array.isArray(items)||!items.length||items.length>32)return null;
 if(!point||!Number.isSafeInteger(point.x)||!Number.isSafeInteger(point.y)||!Array.isArray(payload.anchorCell)||payload.anchorCell.length!==2||!payload.anchorCell.every(Number.isSafeInteger))return null;
 if(!items.every(i=>typeof i.path==='string'&&typeof i.dest==='string'&&i.identity&&i.identity.dev!==undefined&&i.identity.ino!==undefined&&i.isLink===true&&i.hidden===true&&i.crossVolume===false&&samePath(i.path,i.dest)&&Array.isArray(i.cell)&&i.cell.length===2&&i.cell.every(Number.isSafeInteger)))return null;
 const anchors=items.filter(i=>i.cell.every((n,k)=>n===payload.anchorCell[k]));if(anchors.length!==1)return null;
 const candidates=(snapshot.areas||[]).map((area,index)=>({area,index})).filter(({area})=>Object.hasOwn(area,'grid')&&area.grid===null&&point.x>=area.left&&point.x<area.right&&point.y>=area.top&&point.y<area.bottom);
 if(candidates.length!==1)return null;const index=candidates[0].index,bounds=calibration.searchBounds(snapshot,index);if(!bounds.ok)return null;
 const plan=calibration.planCalibration({snapshot,areaIndex:index,probeId:items[0].dest,maxSpacing:bounds.maxSpacing,step:bounds.step});
 if(!plan.ok||!Array.isArray(plan.requests)||plan.requests.length>192)return null;
 return {version:2,kind:'samepath-hidden-unknown-grid',desktop,snapshot,targetAreaIndex:index,plan,metadataPaths:[metadataPath],
  items:items.map(i=>({path:i.path,destination:i.dest,hidden:true,fileIdentity:String(i.identity.dev)+':'+String(i.identity.ino)})),
  success:{anchorMode:'cursor-center',items:items.map(i=>({path:i.dest,cell:[...i.cell]})),anchorPath:anchors[0].dest,requestedAnchor:{x:point.x,y:point.y}}};
}
module.exports={enabled,unknownEnabled,nativeEnv,unknownCandidate};
