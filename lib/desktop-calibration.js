'use strict';
// Pure evidence checks only. No filesystem, Shell, desktop or settings operations.
const {createHash}=require('crypto');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
const fail=reason=>({ok:false,reason});
const integer=n=>Number.isSafeInteger(n);
const inside=(p,r)=>p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom;
const geometryFingerprint=s=>fingerprint([s.autoArrange,s.snap,s.viewDpi,s.folderFlags,s.origin,(s.areas||[]).map(a=>[a.left,a.top,a.right,a.bottom,a.scale,a.monitorOrigin])]);
const iconsFingerprint=s=>fingerprint((s.icons||[]).map(i=>[i.label,i.x,i.y]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
function planCalibration({snapshot:s,areaIndex,probeId,maxSpacing,step}) {
 if(!s?.ok||s.autoArrange||!s.snap||!Array.isArray(s.icons)||!Array.isArray(s.areas))return fail('unknown-desktop');
 if(!integer(areaIndex)||!s.areas[areaIndex]||typeof probeId!=='string'||!probeId)return fail('unknown-probe-or-area');
 if(step===undefined&&maxSpacing)step=Math.max(4,Math.ceil(3*Math.max(maxSpacing.x,maxSpacing.y)/45));
 if(!maxSpacing||![maxSpacing.x,maxSpacing.y,step].every(integer)||Math.min(maxSpacing.x,maxSpacing.y)<8||step<1||step>Math.min(maxSpacing.x,maxSpacing.y)/4)return fail('invalid-probe-bounds');
 const a=s.areas[areaIndex],mx=maxSpacing.x,my=maxSpacing.y;
 if(![a.left,a.top,a.right,a.bottom].every(integer)||a.right-a.left<5*mx||a.bottom-a.top<5*my)return fail('insufficient-safe-probe-area');
 // maxSpacing is a search limit, NOT proof of the Shell grid.
 // Reserve a patch before material is moved; keep a full extra search-limit
 // margin from every old icon anchor, including icons on adjacent monitors.
 if(s.icons.some(i=>![i.x,i.y].every(integer)))return fail('unknown-existing-icon');
 const w=5*mx,h=5*my;
 function* starts(lo,hi,size,stride){const middle=Math.floor((lo+hi-size)/2);yield middle;for(let v=lo;v<=hi-size;v+=stride)if(v!==middle)yield v;if((hi-lo-size)%stride!==0&&hi-size!==middle)yield hi-size;}
 let patch=null,guard=null,scanned=0;
 for(const x of starts(a.left,a.right,w,mx)) {
  for(const y of starts(a.top,a.bottom,h,my)) {
   if(++scanned>50000)return fail('probe-search-budget-exceeded');
   const g={left:x-mx,top:y-my,right:x+w+mx,bottom:y+h+my};
   if(s.icons.some(i=>inside(i,g)))continue;
   patch={left:x,top:y,right:x+w,bottom:y+h};guard=g;break;
  }
  if(patch)break;
 }
 if(!patch)return fail('no-safe-probe-patch');
 const cx=Math.floor((patch.left+patch.right)/2),cy=Math.floor((patch.top+patch.bottom)/2);
 const requests=[];
 for(const axis of ['x','y']) {
  const radius=Math.floor(1.5*maxSpacing[axis]),forward=[];
  for(let d=-radius;d<=radius;d+=step)forward.push({axis,pass:'forward',x:cx+(axis==='x'?d:0),y:cy+(axis==='y'?d:0)});
  requests.push(...forward,...forward.slice().reverse().map(r=>({...r,pass:'reverse'})));
 }
 if(requests.length>192)return fail('probe-budget-exceeded');
 requests.forEach((r,id)=>r.id=id);
 return {ok:true,areaIndex,probeId,geometryKey:geometryFingerprint(s),iconsKey:iconsFingerprint(s),patch,guard,maxSpacing:{x:mx,y:my},step,requests};
}
function inferCalibration({plan:p,samples}) {
 if(!p?.ok||!Array.isArray(samples)||samples.length!==p.requests.length)return fail('incomplete-calibration');
 for(let i=0;i<samples.length;i++) {
  const r=p.requests[i],s=samples[i];
  if(s?.id!==r.id||s.probeId!==p.probeId||s.geometryKey!==p.geometryKey||s.iconsKey!==p.iconsKey)return fail('calibration-state-changed');
  if(s.requestX!==r.x||s.requestY!==r.y||![s.x,s.y].every(integer)||!inside(s,p.patch))return fail('invalid-probe-observation');
 }
 const result={};
 for(const axis of ['x','y']) {
  const indexes=p.requests.map((r,i)=>({r,s:samples[i]})).filter(v=>v.r.axis===axis),forward=indexes.filter(v=>v.r.pass==='forward'),reverse=indexes.filter(v=>v.r.pass==='reverse');
  if(reverse.length!==forward.length)return fail('missing-reverse-observations');
  for(let i=0;i<forward.length;i++){const f=forward[i].s,b=reverse[reverse.length-1-i].s;if(f.x!==b.x||f.y!==b.y)return fail('nonreproducible-snap');}
  const other=axis==='x'?'y':'x';
  if(new Set(forward.map(v=>v.s[other])).size!==1)return fail('cross-axis-motion');
  const values=forward.map(v=>v.s[axis]);
  if(values.some((n,i)=>i&&n<values[i-1]))return fail('nonmonotonic-snap');
  const unique=[...new Set(values)];
  if(unique.length<3)return fail('insufficient-snap-cells');
  const pitch=unique[1]-unique[0];
  if(pitch<=p.step||pitch>p.maxSpacing[axis]||unique.some((n,i)=>i&&n-unique[i-1]!==pitch))return fail('nonuniform-or-unsnapped');
  const plateaus=unique.filter(n=>values.filter(v=>v===n).length>=2).length;
  if(plateaus<2)return fail('missing-snap-plateaus');
  result[axis]={pitch,origin:((unique[0]%pitch)+pitch)%pitch,cells:unique.length,plateaus};
 }
 return {ok:true,grid:{sx:result.x.pitch,sy:result.y.pitch,gx:result.x.origin,gy:result.y.origin},evidence:result};
}
module.exports={planCalibration,inferCalibration,geometryFingerprint,iconsFingerprint};
