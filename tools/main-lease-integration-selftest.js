'use strict';
// Executes the actual main.js transaction function in a VM, with in-memory FS and
// watchdog adapters only. Never imports Electron or touches user board/Desktop.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const metadata=src.split('// BEGIN tested-lease-metadata')[1].split('// END tested-lease-metadata')[0];
const proof=src.split('// BEGIN tested-legacy-reservation-proof')[1].split('// END tested-legacy-reservation-proof')[0];
const body=src.slice(src.indexOf('  async function safeDesktopMove(payload,target) {'),src.indexOf("  ipcMain.handle('safe-takeout'"));
const controller=require('../lib/desktop-snap-lease-controller'),receipt=require('../lib/desktop-commit-receipt'),safe=require('../lib/safe-desktop');
const winPath=path.win32;let checks=0;const check=x=>{assert.ok(x);checks++;};
async function scenario(mode){
 const legacy=mode.startsWith('legacy-'), preview=mode.startsWith('preview-');
 const desktop='C:\\Desktop',folder='C:\\Boards\\one',file=desktop+'\\a.lnk',meta=folder+'\\.okiba-board.json';
 const original={version:6,positions:{other:[9,17],'resident.txt':[4,8]},links:[{path:file,col:3,row:8,wasHidden:false},{path:'D:\\keep.mp4',col:12,row:19}],notes:[{text:'keep'}],future:{field:42}};
 const before=JSON.stringify(original),files=new Map([[meta,before]]),calls=[],snap={ok:true,identityVersion:1,autoArrange:false,snap:true,origin:{x:0,y:0},areas:[{left:0,top:0,right:1000,bottom:1000,grid:{gx:0,gy:0,sx:100,sy:100}}],icons:[{identity:'old',label:'old',path:'C:\\Desktop\\old.txt',x:900,y:900}]};
 const adapter={prepare:async()=>{calls.push('prepare');return {ok:true,token:'t'};},revealAndPlace:async()=>{calls.push('reveal');return {ok:true};},restoreAndVerify:async()=>({ok:true,snapRestored:true,oldUnchanged:true,targetsExact:true}),prepareCommit:async()=>{calls.push('permit');check(files.get(meta)===before);if(mode==='reject')return {ok:false,reason:'expired'};return {ok:true,permit:'p'};},commitDone:async()=>{calls.push('done');if(mode==='acklost'||mode==='preview-mixed-acklost')throw Error('lost');return {ok:true};},release:async()=>({ok:true}),resolveCommit:async()=>['acklost','preview-mixed-acklost'].includes(mode)?{state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true}:{state:'pending'},abort:async()=>({state:'aborted'})};
 const ctx={legacyHelperState:null,console,process:{pid:123,env:{}},Date,Math,Number,JSON,Map,Set,path:winPath,BASE:'C:\\Boards',desktopUnsafe:false,desktopLeasePending:false,desktopBusy:false,desktopLeasePreflight:async()=>mode==='shared-unresolved'?{ok:false,blocked:true,reason:'unresolved-existing-journal'}:{ok:true,blocked:false},win:null,beginLeaseVerification:()=>{ctx.desktopLeasePending=true;},
 fs:{statSync:p=>({dev:1,ino:p===meta?2:p.endsWith('resident.txt')?3:1,isDirectory:()=>p===desktop,isFile:()=>p!==desktop}),readFileSync:p=>{if(!files.has(p)){const e=Error('missing');e.code='ENOENT';throw e;}return files.get(p);},writeFileSync:(p,v)=>{files.set(p,v);if(mode==='edit-during-temp'||mode==='preview-mixed-external-edit')files.set(meta,'external-edit');},renameSync:(a,b)=>{calls.push('replace');files.set(b,files.get(a));files.delete(a);},existsSync:p=>files.has(p),unlinkSync:p=>files.delete(p),appendFileSync:()=>{}},
 bf:{loadBoard:()=>original,uniqueDestination:(d,n)=>winPath.join(d,n)},guardBoard:()=>folder,ln:{samePath:(a,b)=>a.toLowerCase()===b.toLowerCase()},attrib:{readHidden:async()=>({ok:true,hidden:true})},safeDesk:{...safe,executeDesktop:async()=>{if(!legacy)throw Error('legacy unexpectedly called');calls.push('legacy-mutate');return mode==='legacy-rollback'?{ok:false,blocked:false,reason:'test-abort',recovery:[]}:{ok:true,recovery:[]};}},desktopCalibration:{},screen:{getAllDisplays:()=>[]},desktopSnapshot:async()=>mode==='legacy-old-changed'&&calls.includes('legacy-mutate')?{...snap,icons:[{...snap.icons[0],x:800}]}:snap,leasePreview:()=>preview,residentSelection:require('../lib/desktop-resident-selection'),leaseOptIn:()=>true,leaseController:controller,leaseReceipt:receipt,
 leaseClient:()=>({reserveLegacy:async()=>{calls.push('reserve');return mode==='legacy-race'?{ok:false,reason:'busy'}:{ok:true,token:'legacy'};},releaseLegacy:async(token,p)=>{calls.push('release-legacy');check(token==='legacy');check(p.helper.allRequestsCompleted===true);return p.oldUnchanged&&p.metadataSettled&&p.mutationsSettled&&mode!=='legacy-release-fail'?{ok:true,leaseReleased:true}:{ok:false};},ready:async()=>({ok:true}),prepareScope:async s=>s,adapter:commit=>({...adapter,commit:async(...args)=>{calls.push('commit');return commit(...args);}})}),desktopBlocked:(reason,recovery)=>({error:reason,recovery}),pendingLeaseResult:reason=>({pendingVerification:true,retrySafe:false,reason}),recordHistory:()=>calls.push('history')};
 let payload={boardName:'one',paths:mode==='shared-unresolved'||legacy?[folder+'\\resident.txt']:[],linkedPaths:mode==='shared-unresolved'||legacy?[]:[file],automatic:true};
 if(preview){
  const resident=folder+'\\resident.txt';
  if(mode==='preview-resident'||mode==='preview-cross')payload={...payload,paths:[resident],linkedPaths:[]};
  if(mode.startsWith('preview-mixed'))payload={...payload,paths:[resident],linkedPaths:[file]};
  if(mode==='preview-unknown')ctx.desktopSnapshot=async()=>({...snap,areas:[{...snap.areas[0],grid:null}]});
  if(mode==='preview-visible')ctx.attrib.readHidden=async()=>({ok:true,hidden:false});
  if(mode==='preview-cross'){const originalStat=ctx.fs.statSync;ctx.fs.statSync=p=>({...originalStat(p),dev:p===resident?2:1});}
  const originalClient=ctx.leaseClient;
  ctx.leaseClient=()=>({...originalClient(),prepareScope:async s=>{calls.push('read-native');if(mode==='preview-mixed-prepare-reject')throw Error('native-read-refused');return {...s,items:s.items.map((i,n)=>({...i,fileIdentity:mode==='preview-mixed-native-duplicate'?'same-id':'native:'+n,...(mode==='preview-mixed-native-missing'&&i.mode==='hidden-link'?{}:{nativeFile:{regularFile:true,reparse:false,linkCount:1,attributes:i.mode==='hidden-link'?34:32}})}))};}});
 }
 const run=vm.runInNewContext(metadata+'\n'+proof+'\n'+body+';safeDesktopMove',ctx);
 const result=await run(payload,{path:desktop});
 if(preview){
  if(['preview-normal','preview-resident','preview-mixed','preview-mixed-acklost'].includes(mode)){check(!result.error);check(result.metadataCommitted===true);check(calls.includes('reveal')&&calls.includes('commit'));if(mode.startsWith('preview-mixed')){const after=JSON.parse(files.get(meta));check(!Object.hasOwn(after.positions,'resident.txt'));check(JSON.stringify(after.positions.other)===JSON.stringify(original.positions.other));check(after.links.length===1&&after.links[0].path==='D:\\keep.mp4');check(JSON.stringify(after.future)===JSON.stringify(original.future));check(JSON.stringify(after.notes)===JSON.stringify(original.notes));check(calls.indexOf('permit')<calls.indexOf('commit'));check(calls.includes('history'));}}
  else if(mode==='preview-mixed-external-edit'){check(result.pendingVerification===true);check(files.get(meta)==='external-edit');check(!calls.includes('replace')&&!calls.includes('history'));}
  else {check(!!result.error);check(files.get(meta)===before);check(!calls.includes('prepare')&&!calls.includes('reveal')&&!calls.includes('commit'));}
  check(!calls.includes('legacy-mutate')&&!calls.includes('reserve'));return;
 }
 if(legacy){check(files.get(meta)===before);check(!calls.includes('commit'));if(mode==='legacy-race'){check(!calls.includes('legacy-mutate'));check(!calls.includes('release-legacy'));check(result.leaseBlocked);}else{check(calls.indexOf('reserve')<calls.indexOf('legacy-mutate'));check(calls.indexOf('legacy-mutate')<calls.indexOf('release-legacy'));if(['legacy-old-changed','legacy-release-fail'].includes(mode)){check(result.pendingVerification&&ctx.desktopLeasePending);check(!calls.includes('history'));}else check(!ctx.desktopLeasePending);}return;}
 if(mode==='shared-unresolved'){check(result.leaseBlocked&&result.retrySafe===false);check(calls.length===0);check(files.get(meta)===before);return;}
 if(mode==='normal'||mode==='acklost'){check(!result.error);check(result.metadataCommitted===true);check(calls.indexOf('permit')<calls.indexOf('commit'));check(calls.indexOf('replace')<calls.indexOf('history'));const after=JSON.parse(files.get(meta));for(const k of Object.keys(original).filter(k=>k!=='links'))check(JSON.stringify(after[k])===JSON.stringify(original[k]));check(after.links.length===1&&after.links[0].path==='D:\\keep.mp4');}
 else {check(result.pendingVerification&&result.retrySafe===false);check(!calls.includes('history'));check(!calls.includes('replace'));check(files.get(meta)===(mode==='edit-during-temp'?'external-edit':before));}
}

function proofChecks(){
 const unchanged=vm.runInNewContext(proof+';legacyOldUnchanged',{Map,Set,Number,Object,JSON,Array});
 const a={ok:true,identityVersion:1,autoArrange:false,snap:true,sx:100,sy:100,origin:{x:0,y:0},areas:[{left:0,top:0,right:1000,bottom:1000,grid:{gx:0,gy:0}}],icons:[{identity:'A',x:0,y:0},{identity:'B',x:100,y:0}]};
 check(unchanged(a,{...a,icons:[...a.icons,{identity:'new',x:200,y:0}]}));
 check(!unchanged(a,{...a,icons:[{identity:'A',x:100,y:0},{identity:'B',x:0,y:0}]}));
 check(!unchanged(a,{...a,icons:[a.icons[0]]}));
 check(!unchanged(a,{...a,icons:[...a.icons,a.icons[0]]}));
 check(!unchanged(a,{...a,origin:{x:1,y:0}}));
 check(!unchanged(a,{...a,snap:false}));
 check(!unchanged(a,{...a,icons:[{identity:'A',x:NaN,y:0},a.icons[1]]}));
 check(unchanged(a,{...a,areas:[{bottom:1000,right:1000,top:0,left:0,grid:{gx:5,gy:5}}]}));
}

(async()=>{proofChecks();for(const m of ['normal','acklost','reject','edit-during-temp','shared-unresolved','legacy-ok','legacy-race','legacy-rollback','legacy-old-changed','legacy-release-fail','preview-normal','preview-resident','preview-cross','preview-mixed','preview-mixed-native-missing','preview-mixed-native-duplicate','preview-mixed-prepare-reject','preview-mixed-external-edit','preview-mixed-acklost','preview-unknown','preview-visible'])await scenario(m);console.log('main lease integration '+checks+' checks PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
