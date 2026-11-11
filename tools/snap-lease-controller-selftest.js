'use strict';
const assert=require('assert/strict');
const {validateScope,runLease}=require('../lib/desktop-snap-lease-controller');
const {hash,validReceipts,classifyReceipt}=require('../lib/desktop-commit-receipt');
let count=0;const check=(value)=>{assert.ok(value);count++;};
const scope={kind:'samepath-hidden',desktop:'C:\\Desktop',items:[{path:'C:\\Desktop\\a.lnk',destination:'C:\\Desktop\\a.lnk',hidden:true,fileIdentity:'volume:file-id'}],metadataPaths:['C:\\Boards\\one\\.okiba-board.json'],targetAreaIndex:0,snapshot:{ok:true,identityVersion:1,autoArrange:false,snap:true,areas:[{left:0,top:0,right:1000,bottom:800,grid:{gx:0,gy:0,sx:100,sy:100}},{left:1000,top:0,right:2000,bottom:800,grid:null}],icons:[{identity:'old',x:100,y:100}]}};
const receipts=[{path:scope.metadataPaths[0],beforeHash:hash('before'),afterHash:hash('after')}];
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(fail){const calls=[];const adapter={};for(const name of ['prepare','revealAndPlace','restoreAndVerify','prepareCommit','commit','commitDone','release','abort','resolveCommit'])adapter[name]=async(...args)=>{calls.push(name);if(fail===name)throw Error('injected');return {ok:true,token:'token',permit:'permit',snapRestored:true,oldUnchanged:true,targetsExact:true};};return {calls,adapter};}
(async()=>{
check(validateScope(scope));check(validReceipts(receipts,scope.metadataPaths));
for(const mutate of [s=>s.kind='rename',s=>s.items[0].destination='D:\\a.lnk',s=>s.items[0].path='C:\\Desktop\\nested\\a.lnk',s=>s.items[0].hidden=false,s=>s.items[0].fileIdentity='',s=>s.items.push(clone(s.items[0])),s=>s.snapshot.icons[0].x=130,s=>s.snapshot.icons[0].x=101,s=>s.snapshot.icons[0].x=100.5,s=>s.snapshot.icons[0].x=NaN,s=>s.snapshot.icons.push({identity:'unknown',x:1100,y:0}),s=>s.snapshot.icons.push(clone(s.snapshot.icons[0])),s=>s.snapshot.autoArrange=true,s=>s.targetAreaIndex=1,s=>s.metadataPaths=['relative.json']]){const s=clone(scope);mutate(s);check(!validateScope(s));const f=fixture();check(!(await runLease({scope:s,receipts,adapter:f.adapter})).ok);check(f.calls.length===0);}
let f=fixture();check((await runLease({scope,receipts,adapter:f.adapter})).ok);assert.deepEqual(f.calls,['prepare','revealAndPlace','restoreAndVerify','prepareCommit','commit','commitDone','release']);count++;
for(const phase of ['prepare','revealAndPlace','restoreAndVerify','prepareCommit','commit','commitDone','release']){f=fixture(phase);check(!(await runLease({scope,receipts,adapter:f.adapter})).ok);check(!f.calls.includes('commit')||['commit','commitDone','release'].includes(phase));if(['prepareCommit','commit','commitDone','release'].includes(phase)){check(f.calls.includes('resolveCommit'));check(!f.calls.includes('abort'));}else if(phase!=='prepare')check(f.calls.includes('abort'));}
// Delayed successful reveal after watchdog invalidated its token cannot write metadata.
f=fixture();f.adapter.prepareCommit=async()=>{f.calls.push('prepareCommit');return {ok:false,reason:'token-invalidated'};};await runLease({scope,receipts,adapter:f.adapter});check(!f.calls.includes('commit'));check(f.calls.includes('resolveCommit'));
f=fixture();f.adapter.restoreAndVerify=async()=>({ok:true,snapRestored:true,oldUnchanged:false,targetsExact:true});await runLease({scope,receipts,adapter:f.adapter});check(!f.calls.includes('prepareCommit'));check(f.calls.includes('abort'));
const classify=(h,ownerExited=true)=>classifyReceipt({receipts,allowedPaths:scope.metadataPaths,current:[{path:receipts[0].path,hash:h}],ownerExited});
check(classify(receipts[0].beforeHash).action==='rollback-selected');check(classify(receipts[0].afterHash).action==='keep-visible');check(classify(hash('user edit')).action==='blocked');check(classify(receipts[0].beforeHash,false).action==='wait');check(classifyReceipt({receipts,allowedPaths:scope.metadataPaths,current:[{path:receipts[0].path,hash:receipts[0].afterHash}]}).action==='wait');
check(classifyReceipt({receipts,allowedPaths:scope.metadataPaths,current:[],ownerExited:false}).action==='wait');
check(classifyReceipt({receipts,allowedPaths:scope.metadataPaths,current:[],ownerExited:true}).action==='blocked');
check(!validReceipts([{...receipts[0],afterHash:receipts[0].beforeHash}],scope.metadataPaths));check(!validReceipts([{...receipts[0],path:'C:\\other.json'}],scope.metadataPaths));
const r2={...receipts[0],path:'C:\\Boards\\two\\.okiba-board.json'};
check(classifyReceipt({receipts:[...receipts,r2],allowedPaths:[receipts[0].path,r2.path],current:[{path:receipts[0].path,hash:receipts[0].afterHash},{path:r2.path,hash:r2.beforeHash}],ownerExited:true}).action==='blocked');
// Only the authoritative terminal response establishes recovered success.
const terminal={state:'committed',snapRestored:true,oldUnchanged:true,targetsExact:true,leaseReleased:true};
for(const failed of ['commitDone','release']){f=fixture(failed);f.adapter.resolveCommit=async()=>({...terminal});const r=await runLease({scope,receipts,adapter:f.adapter});check(r.ok&&r.recovered===true);check(!f.calls.includes('abort'));}
for(const field of Object.keys(terminal)){f=fixture('commitDone');f.adapter.resolveCommit=async()=>({...terminal,[field]:field==='state'?'pending':false});const r=await runLease({scope,receipts,adapter:f.adapter});check(!r.ok&&r.pendingVerification===true&&r.retrySafe===false);check(!f.calls.includes('abort'));}
f=fixture('commitDone');f.adapter.resolveCommit=async()=>({action:'keep-visible',ownerAlive:true,receiptStates:['after']});let uncertain=await runLease({scope,receipts,adapter:f.adapter});check(!uncertain.ok&&uncertain.pendingVerification&&uncertain.retrySafe===false);
f=fixture('commitDone');f.adapter.resolveCommit=async()=>{throw Error('transport lost');};uncertain=await runLease({scope,receipts,adapter:f.adapter});check(!uncertain.ok&&uncertain.pendingVerification&&uncertain.retrySafe===false);check(!f.calls.includes('abort'));
// No native/FS adapter, no method capable of old-coordinate or old-board writes.
check(!require('fs').readFileSync(require.resolve('../lib/desktop-snap-lease-controller'),'utf8').includes('writeFile'));
console.log(`snap lease controller ${count} checks PASS`);
})().catch(e=>{console.error(e);process.exitCode=1;});

