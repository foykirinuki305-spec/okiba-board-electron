'use strict';
const assert=require('assert/strict');
const {planCalibration,inferCalibration}=require('../lib/desktop-calibration');
let n=0;function ok(v,m){assert(v,m);console.log('ok - '+m);n++;}
const snapshot={ok:true,autoArrange:false,snap:true,viewDpi:96,origin:{x:0,y:0},areas:[{left:0,top:0,right:1920,bottom:1080,scale:150,grid:null}],icons:[]};
const args={snapshot,areaIndex:0,probeId:'C:\\fixture.txt',maxSpacing:{x:180,y:180}};
const plan=planCalibration(args);ok(plan.ok,'safe empty 150% area accepts bounded physical requests');
function observations(p,sx=151,sy=100,gx=9,gy=17){return p.requests.map(r=>({id:r.id,axis:r.axis,pass:r.pass,probeId:p.probeId,geometryKey:p.geometryKey,iconsKey:p.iconsKey,requestX:r.x,requestY:r.y,x:gx+Math.round((r.x-gx)/sx)*sx,y:gy+Math.round((r.y-gy)/sy)*sy}));}
let samples=observations(plan),result=inferCalibration({plan,samples});ok(result.ok&&result.grid.sx===151&&result.grid.sy===100&&result.grid.gx===9,'unknown pitch recovered from plateaus, not DPI scaling');
function reject(mutate,reason){let s=structuredClone(samples);mutate(s);const r=inferCalibration({plan,samples:s});ok(!r.ok,reason);}
reject(s=>s.forEach(v=>{v.x=v.requestX;v.y=v.requestY;}),'echoing arbitrary requests is not a measured grid');
reject(s=>s[10].geometryKey+='changed','geometry change rejected');
reject(s=>s[10].iconsKey+='changed','existing icon change rejected');
reject(s=>s[10].probeId='other','wrong probe identity rejected');
reject(s=>s[10].x+=1,'nonuniform or reverse mismatch rejected');
reject(s=>s.pop(),'incomplete sample sequence rejected');
reject(s=>s[1].requestX++,'request mismatch rejected');
reject(s=>s[1].x=plan.patch.right+1,'outside patch rejected');
ok(planCalibration({...args,snapshot:{...snapshot,icons:[{label:'old',x:5,y:5}]}}).ok,'old icon outside reserved patch may stay unchanged');
const small={...snapshot,areas:[{left:0,top:0,right:900,bottom:900,scale:150}],icons:[{label:'edge',x:-50,y:5}]};
ok(!planCalibration({...args,snapshot:small}).ok,'adjacent-monitor icon within only available guard blocks calibration');
ok(!planCalibration({...args,snapshot:{...small,icons:[{label:'old',x:450,y:450}]}}).ok,'no safe empty patch aborts');
const occupied=planCalibration({...args,snapshot:{...snapshot,icons:[{label:'old',x:700,y:500}]}});
ok(occupied.ok&&!(700>=occupied.guard.left&&700<=occupied.guard.right&&500>=occupied.guard.top&&500<=occupied.guard.bottom),'alternative safe patch searched without changing old icon');
ok(!planCalibration({...args,snapshot:{...snapshot,autoArrange:true}}).ok,'auto arrange rejected');
ok(!planCalibration({...args,maxSpacing:{x:400,y:400}}).ok,'insufficient reserved area rejected');
const negative=planCalibration({...args,snapshot:{...snapshot,areas:[{left:-1920,right:0,top:-1080,bottom:0,scale:150}]}});result=inferCalibration({plan:negative,samples:observations(negative)});ok(result.ok&&result.grid.gx===9&&result.grid.gy===17,'negative screen coordinates preserve normalized origin');

const crowded={...snapshot,areas:[{left:0,top:0,right:1920,bottom:1080,scale:100},{left:1920,top:0,right:3840,bottom:1080,scale:150}],icons:Array.from({length:202},(_,i)=>({label:'video_material_'+String(i).padStart(3,'0')+'_example_file.mp4',x:(i%15)*100,y:Math.floor(i/15)*67}))};
const compact=planCalibration({...args,snapshot:crowded,areaIndex:1});
ok(compact.ok&&compact.iconsKey.length===64&&compact.geometryKey.length===64,'202-icon snapshot fingerprints have fixed size');
const cache=[{areaIndex:1,geometry:compact.geometryKey,proof:{samples:observations(compact),maxSpacing:compact.maxSpacing}}];
const bytes=Buffer.byteLength(JSON.stringify(cache));
ok(bytes<1048576/4,'202-icon calibration evidence remains under quarter of 1MiB limit');
console.log('202-icon evidence bytes: '+bytes);

let accepted=0,rejected=0,bad=0;
for(const maxSpacing of [{x:180,y:180},{x:190,y:140},{x:156,y:196}]){
 const p=planCalibration({...args,maxSpacing});ok(p.ok&&p.requests.length>=50&&p.requests.length<=64,'coarser default stays within stable-snapshot time budget');
 for(let sx=20;sx<=maxSpacing.x;sx+=7)for(let sy=20;sy<=maxSpacing.y;sy+=7)for(const origin of [0,7,19]){
  const z=inferCalibration({plan:p,samples:observations(p,sx,sy,origin,origin)});
  if(z.ok){accepted++;if(z.grid.sx!==sx||z.grid.sy!==sy)bad++;}else rejected++;
 }
}
ok(accepted===3018&&rejected===1479&&bad===0,'4497 varied pitch/origin cases have no false accepted grid');
ok(!inferCalibration({plan,samples:observations(plan,10,10)}).ok,'undersampled tiny pitch fails closed');
for(const pitches of [[78,98],[101,67],[151,100],[156,196]]){
 for(const origin of [0,7,19,41,66]){
  const p=planCalibration({...args,maxSpacing:{x:180,y:200}}),z=inferCalibration({plan:p,samples:observations(p,...pitches,origin,origin)});
  ok(z.ok&&z.grid.sx===pitches[0]&&z.grid.sy===pitches[1],'normal scale grid correctly recovered '+pitches.join('x')+' origin '+origin);
 }
}
console.log('coarse sampling sweep: '+JSON.stringify({accepted,rejected,bad}));
console.log('desktop calibration: '+n+' checks passed (pure model, NOT mixed-DPI Shell proof)');
