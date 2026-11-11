'use strict';
// Executes the actual main.js transaction function in a VM, with in-memory FS and
// watchdog adapters only. Never imports Electron or touches user board/Desktop.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const metadata=src.split('// BEGIN tested-lease-metadata')[1].split('// END tested-lease-metadata')[0];
const body=src.slice(src.indexOf('  async function safeDesktopMove(payload,target) {'),src.indexOf("  ipcMain.handle('safe-takeout'"));
const controller=require('../lib/desktop-snap-lease-controller'),receipt=require('../lib/desktop-commit-receipt'),safe=require('../lib/safe-desktop');
const winPath=path.win32;let checks=0;const check=x=>{assert.ok(x);checks++;};
async function scenario(mode){
 const desktop='C:\\Desktop',folder='C:\\Boards\\one',file=desktop+'\\a.lnk',meta=folder+'\\.okiba-board.json';
 const original={version:6,positions:{other:[9,17]},links:[{path:file,col:3,row:8,wasHidden:false},{path:'D:\\keep.mp4',col:12,row:19}],notes:[{text:'keep'}],future:{field:42}};
 const before=JSON.stringify(original),files=new Map([[meta,before]]),calls=[],snap={ok:true,identityVersion:1,autoArrange:false,snap:true,origin:{x:0,y:0},areas:[{left:0,top:0,right:1000,bottom:1000,grid:{gx:0,gy:0,sx:100,sy:100}}],icons:[{identity:'old',label:'old',path:'C:\\Desktop\\old.txt',x:900,y:900}]};
 const adapter={prepare:async()=>{calls.push('prepare');return {ok:true,token:'t'};},revealAndPlace:async()=>{calls.push('reveal');return {ok:true};},restoreAndVerify:async()=>({ok:true,snapRestored:true,oldUnchanged:true,targetsExact:true}),prepareCommit:async()=>{calls.push('permit');check(files.get(meta)===before);if(mode==='reject')return {ok:false,reason:'expired'};return {ok:true,permit:'p'};},commitDone:async()=>{calls.push('done');if(mode==='acklost')throw Error('lost');return {ok:true};},release:async()=>({ok:true}),resolveCommit:async()=>mode==='acklost'?{state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true}:{state:'pending'},abort:async()=>({state:'aborted'})};
 const ctx={console,process:{pid:123,env:{}},Date,Math,Number,JSON,Map,Set,path:winPath,BASE:'C:\\Boards',desktopUnsafe:false,desktopLeasePending:false,desktopBusy:false,win:null,
 fs:{statSync:p=>({dev:1,ino:p===meta?2:1,isDirectory:()=>p===desktop,isFile:()=>p!==desktop}),readFileSync:p=>{if(!files.has(p)){const e=Error('missing');e.code='ENOENT';throw e;}return files.get(p);},writeFileSync:(p,v)=>{files.set(p,v);if(mode==='edit-during-temp')files.set(meta,'external-edit');},renameSync:(a,b)=>{calls.push('replace');files.set(b,files.get(a));files.delete(a);},existsSync:p=>files.has(p),unlinkSync:p=>files.delete(p),appendFileSync:()=>{}},
 bf:{loadBoard:()=>original},guardBoard:()=>folder,ln:{samePath:(a,b)=>a.toLowerCase()===b.toLowerCase()},attrib:{readHidden:async()=>({ok:true,hidden:true})},safeDesk:{...safe,executeDesktop:async()=>{throw Error('legacy unexpectedly called');}},desktopCalibration:{},screen:{getAllDisplays:()=>[]},desktopSnapshot:async()=>snap,leaseOptIn:()=>true,leaseController:controller,leaseReceipt:receipt,
 leaseClient:()=>({ready:async()=>({ok:true}),prepareScope:async s=>s,adapter:commit=>({...adapter,commit:async(...args)=>{calls.push('commit');return commit(...args);}})}),desktopBlocked:(reason,recovery)=>({error:reason,recovery}),pendingLeaseResult:reason=>({pendingVerification:true,retrySafe:false,reason}),recordHistory:()=>calls.push('history')};
 const run=vm.runInNewContext(metadata+'\n'+body+';safeDesktopMove',ctx);
 const result=await run({boardName:'one',paths:[],linkedPaths:[file],automatic:true},{path:desktop});
 if(mode==='normal'||mode==='acklost'){check(!result.error);check(result.metadataCommitted===true);check(calls.indexOf('permit')<calls.indexOf('commit'));check(calls.indexOf('replace')<calls.indexOf('history'));const after=JSON.parse(files.get(meta));for(const k of Object.keys(original).filter(k=>k!=='links'))check(JSON.stringify(after[k])===JSON.stringify(original[k]));check(after.links.length===1&&after.links[0].path==='D:\\keep.mp4');}
 else {check(result.pendingVerification&&result.retrySafe===false);check(!calls.includes('history'));check(!calls.includes('replace'));check(files.get(meta)===(mode==='edit-during-temp'?'external-edit':before));}
}
(async()=>{for(const m of ['normal','acklost','reject','edit-during-temp'])await scenario(m);console.log('main lease integration '+checks+' checks PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
