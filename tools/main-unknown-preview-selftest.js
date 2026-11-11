'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const policy=require('../lib/desktop-preview-policy'),calibration=require('../lib/desktop-calibration');
const clone=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 let checks=0;
 const input={enabled:true,snapshot:{ok:true,identityVersion:1,autoArrange:false,snap:true,sx:75,sy:107,viewDpi:96,origin:{x:0,y:0},areas:[{left:0,top:0,right:1920,bottom:1080,scale:150,grid:null}],icons:[]},items:[{path:'A',dest:'A',cell:[1,1],isLink:true,hidden:true,crossVolume:false,identity:{dev:1,ino:2}},{path:'B',dest:'B',cell:[3,2],isLink:true,hidden:true,crossVolume:false,identity:{dev:1,ino:3}}],payload:{automatic:false,anchorCell:[1,1]},point:{x:350,y:350},desktop:'desktop',metadataPath:'metadata'};
 const select=x=>policy.unknownCandidate({...x,calibration,samePath:(a,b)=>a.toLowerCase()===b.toLowerCase()});
 const candidate=select(input);assert(candidate&&candidate.kind==='samepath-hidden-unknown-grid');assert.equal(candidate.success.anchorPath,'A');assert.equal(candidate.success.anchorMode,'cursor-center');assert.deepEqual(candidate.success.items.map(i=>i.cell),[[1,1],[3,2]]);assert(!Object.hasOwn(candidate,'targets'));checks++;
 const original=JSON.stringify(input);select(input);assert.equal(JSON.stringify(input),original);checks++;
 for(const mutate of [x=>x.enabled=false,x=>x.enabled='1',x=>x.payload.automatic=true,x=>delete x.payload.automatic,x=>x.payload.anchorCell=[0,0],x=>x.items[1].cell=[1,1],x=>x.items[0].isLink=false,x=>x.items[0].hidden=false,x=>x.items[0].crossVolume=true,x=>x.items[0].dest='elsewhere',x=>x.items[0].identity=null,x=>x.items[0].cell=[NaN,1],x=>x.items=[],x=>x.items=Array(33).fill(x.items[0]),x=>x.point.x=Infinity,x=>x.point.x=-1,x=>x.snapshot.ok=false,x=>x.snapshot.snap=false,x=>x.snapshot.autoArrange=true,x=>x.snapshot.areas[0].grid={sx:1},x=>x.snapshot.areas.push({...x.snapshot.areas[0]}),x=>x.snapshot.areas[0].right=450]){const x=clone(input);mutate(x);assert.equal(select(x),null);checks++;}
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 const snapshotBody=source.slice(source.indexOf('  async function desktopSnapshot() {'),source.indexOf('  async function atomicDesktopMove('));
 let oldImport=0,oldRead=0,unknownRead=0;const snapshot={ok:true,sentinel:'same-client'};
 const base={unknownLeasePreview:()=>true,leasePreview:()=>true,process:{env:{}},leaseClient:()=>({ready:async()=>({ok:true}),unknown:async method=>{assert.equal(method,'sessionSnapshot');unknownRead++;return {ok:true,snapshot};}}),shellHelper:{request:async()=>{oldRead++;return {ok:true,result:{ok:true}};}},ensureCalibrationImported:async()=>{oldImport++;}};
 const read=vm.runInNewContext(snapshotBody+';desktopSnapshot',base);assert.strictEqual(await read(),snapshot);assert.equal(oldImport+oldRead,0);checks++;
 const fallback=vm.runInNewContext(snapshotBody+';desktopSnapshot',{...base,unknownLeasePreview:()=>false});assert((await fallback()).ok);assert.equal(oldRead,1);assert.equal(oldImport,1);checks++;
 const fail=vm.runInNewContext(snapshotBody+';desktopSnapshot',{...base,leaseClient:()=>({ready:async()=>({ok:false,reason:'not-ready'})})});assert(!(await fail()).ok);assert.equal(oldRead,1);checks++;
 const importBody=source.slice(source.indexOf('  async function ensureCalibrationImported(){'),source.indexOf('  async function persistCalibrationEvidence(){'));
 await vm.runInNewContext(importBody+';ensureCalibrationImported()',{unknownLeasePreview:()=>true});checks++; // Any old dependency access would throw.
 const factory=source.slice(source.indexOf('  function leaseClient(){'),source.indexOf('  const desktopCalibration ='));
 for(const flag of [false,true]){let captured;vm.runInNewContext(factory+';leaseClient();',{desktopLeaseClient:null,desktopLeasePending:false,leasePreview:()=>true,unknownLeasePreview:()=>flag,leaseOptIn:()=>true,desktopPreviewPolicy:policy,process:{env:{},pid:1},path,app:{getPath:()=>'/private',once(){}},bundledScriptPath:()=>'/bundled/helper',require:()=>({createDesktopLeaseClient:o=>{captured=o;return {};}})});assert.equal(captured.allowUnknownGrid,flag);checks++;}
 const tx=source.slice(source.indexOf('      let leaseTransaction=null;'),source.indexOf('      // Preview never falls back'));
 assert.equal((tx.match(/const commitFn=/g)||[]).length,1);assert.equal((tx.match(/commitLeaseMetadata\(/g)||[]).length,1);assert(tx.includes('unknownLeaseController.createUnknownAdapter(client,commitFn)'));assert(tx.includes('unknownLeaseController.runUnknownLease({scope,receipts,adapter:leaseAdapter})'));assert(tx.includes('beginLeaseVerification({result:leaseTransaction,adapter:leaseAdapter'));assert(source.includes('safeDesktopMove({...payload,automatic:false},target)'));checks++;
 console.log('main unknown preview '+checks+' pure/VM checks PASS; no Electron/Desktop');
})().catch(e=>{console.error(e);process.exitCode=1;});
