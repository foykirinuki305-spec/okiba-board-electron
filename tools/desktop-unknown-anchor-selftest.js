'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const {resolveAnchor,verifyTargets}=require('../lib/desktop-unknown-grid-model');
const {planDesktop}=require('../lib/safe-desktop');const {collectAdaptive}=require('../lib/desktop-unknown-adaptive-driver');
(async()=>{let checks=0;
 for(const g of [{sx:78,sy:98,gx:15,gy:2},{sx:113,sy:161,gx:20,gy:2},{sx:117,sy:147,gx:15,gy:2}])for(const origin of [{x:0,y:0},{x:-1920,y:-1080},{x:-2500,y:50}]){
  const area={left:origin.x,top:origin.y,right:origin.x+1920,bottom:origin.y+1080,grid:g};
  const xs=[area.left,area.left+1,area.left+g.sx,area.left+500,area.right-g.sx-1,area.right-1];
  // Include integer points directly around rounding/cell boundaries for odd pitches.
  for(const k of [-2,-1,0,1,2])for(const delta of [-1,0,1]){const x=g.gx+k*g.sx+delta;if(x>=area.left&&x<area.right)xs.push(x);}
  for(const x of xs)for(const y of [area.top,area.top+1,area.top+g.sy,area.top+400,area.bottom-1]){
   const point={x,y},anchor=resolveAnchor(point,g,'cursor-center'),items=[{path:'A',dest:'A',name:'A',offset:[0,0]}];
   const known=planDesktop({snapshot:{ok:true,identityVersion:1,autoArrange:false,snap:true,areas:[area],icons:[]},items,point});
   const targets=[{path:'A',...anchor}],unknown=verifyTargets({shape:[{path:'A',dx:0,dy:0}],targets,anchor,grid:g,area});
   assert.equal(unknown.ok,known.ok,JSON.stringify({g,area,point,known,unknown}));if(known.ok)assert.deepEqual(anchor,{x:known.targets[0].x,y:known.targets[0].y});checks++;
  }
 }
 const g={sx:113,sy:161,gx:20,gy:2},p={x:359,y:405};
 const old={x:g.gx+Math.floor((p.x-g.gx)/g.sx+.5)*g.sx,y:g.gy+Math.floor((p.y-g.gy)/g.sy+.5)*g.sy};
 for(const mode of [undefined,null,'top-left']){assert.deepEqual(resolveAnchor(p,g,mode),old);checks++;}
 for(const mode of ['',false,true,0,1,{},[],['cursor-center'],'Cursor-Center','cursor-centre']){assert.throws(()=>resolveAnchor(p,g,mode));checks++;}
 for(const point of [{x:NaN,y:0},{x:Infinity,y:0},{x:1.5,y:0},{x:0},null]){assert.throws(()=>resolveAnchor(point,g,'cursor-center'));checks++;}
 // Execute the actual fixed validator in Node only, with synthetic complete proof.
 const proof={binding:{token:'synthetic',probeId:'A',geometryKey:'geometry',iconsKey:'icons'},center:{x:500,y:500},patch:{left:0,top:0,right:1000,bottom:1000},maxSpacing:{x:180,y:180}};
 const snap=(q,s,o)=>o+Math.floor((q-o)/s+.5)*s;
 const measured=await collectAdaptive(proof,async q=>({ok:true,sample:{...proof.binding,id:q.sampleId,axis:q.axis,pass:q.pass,requestX:q.point.x,requestY:q.point.y,x:snap(q.point.x,g.sx,g.gx),y:snap(q.point.y,g.sy,g.gy)}}));proof.samples=measured.samples;
 const input={proof,items:[{path:'A',cell:[1,1]},{path:'B',cell:[3,2]}],anchorPath:'A',requestedAnchor:p,area:{left:0,top:0,right:1920,bottom:1080},old:[]};
 for(const mode of [undefined,'top-left','cursor-center','invalid']){
  const result=spawnSync(process.execPath,[path.join(__dirname,'../lib/desktop-unknown-grid-validator.js')],{input:JSON.stringify({...input,anchorMode:mode}),encoding:'utf8',windowsHide:true});assert.ifError(result.error);const output=JSON.parse(result.stdout);
  if(mode==='invalid'){assert.equal(output.ok,false);assert.notEqual(result.status,0);}else{assert.equal(result.status,0);assert(output.ok);assert.deepEqual(output.anchor,resolveAnchor(p,g,mode));assert.equal(output.targets[1].x-output.targets[0].x,2*g.sx);assert.equal(output.targets[1].y-output.targets[0].y,g.sy);}checks++;
 }
 const native=fs.readFileSync(path.join(__dirname,'../scripts/unknown-grid-success.ps1'),'utf8');assert(native.includes("$anchorMode -cnotin @('top-left','cursor-center')"));assert(native.includes('anchorMode=$anchorMode'));assert(native.includes('anchorMode=$r.success.anchorMode'));checks++;
 console.log('unknown cursor anchor parity '+checks+' checks PASS; synthetic only, no Desktop');
})().catch(e=>{console.error(e);process.exitCode=1;});
