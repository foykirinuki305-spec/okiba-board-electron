'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
const part=source.split('// BEGIN tested-desktop-rollback')[1].split('// END tested-desktop-rollback')[0];
const rollback=vm.runInNewContext(part+';rollbackDesktopFile');
function setup({renamed=true,sourceIdentity=null,destIdentity=1,moveMode='ok'}={}) {
 const files=new Map();if(sourceIdentity!==null)files.set('source',{dev:1,ino:sourceIdentity});if(destIdentity!==null)files.set('dest',{dev:1,ino:destIdentity});
 const item={path:'source',dest:'dest',identity:{dev:1,ino:1},renamed,recoveryPath:renamed?'dest':'source',hidden:true,visibilityChanged:true};
 let attrs=0,moves=0;
 const io={exists:p=>files.has(p),stat:p=>{if(!files.has(p))throw Error('ENOENT');return files.get(p);},setHidden:async()=>{attrs++;return {ok:true};},move:async(from,to)=>{moves++;if(moveMode==='unsafe'){const e=Error('unknown');e.unsafe=true;throw e;}if(moveMode==='failed')throw Error('move-failed');files.set(to,files.get(from));files.delete(from);if(moveMode==='lost')throw Error('response-lost');}};
 return {item,io,files,get attrs(){return attrs;},get moves(){return moves;}};
}
(async()=>{
 let n=0;const check=(name,fn)=>Promise.resolve().then(fn).then(()=>{n++;console.log('ok - '+name);});
 await check('ordinary restore updates recovery path and original Hidden',async()=>{const f=setup();await rollback(f.item,f.io);assert.equal(f.item.recoveryPath,'source');assert.equal(f.attrs,1);assert.equal(f.item.renamed,false);});
 await check('stopped helper late success is verified and restores Hidden',async()=>{const f=setup({moveMode:'lost'});await rollback(f.item,f.io);assert.equal(f.item.recoveryPath,'source');assert.equal(f.attrs,1);assert.equal(f.moves,1);});
 await check('unconfirmed helper exit never retries or changes attributes',async()=>{const f=setup({moveMode:'unsafe'});await assert.rejects(rollback(f.item,f.io),e=>e.unsafe);assert.equal(f.attrs,0);assert.equal(f.moves,1);assert.equal(f.item.recoveryPath,'dest');});
 await check('failed move does not claim restore',async()=>{const f=setup({moveMode:'failed'});await assert.rejects(rollback(f.item,f.io),/move-failed/);assert.equal(f.attrs,0);assert.equal(f.item.renamed,true);});
 await check('occupied original never overwritten',async()=>{const f=setup({sourceIdentity:2});await assert.rejects(rollback(f.item,f.io),/original-path-occupied/);assert.equal(f.moves,0);assert.equal(f.attrs,0);});
 await check('changed destination never moved',async()=>{const f=setup({destIdentity:2});await assert.rejects(rollback(f.item,f.io),/destination-changed/);assert.equal(f.moves,0);assert.equal(f.attrs,0);});
 await check('replaced original never gets Hidden restoration',async()=>{const f=setup({renamed:false,sourceIdentity:2,destIdentity:null});await assert.rejects(rollback(f.item,f.io),/source-changed-before-attribute-restore/);assert.equal(f.attrs,0);});
 await check('cross-volume restored original identity permits attribute restore',async()=>{const f=setup({renamed:false,sourceIdentity:1,destIdentity:null});await rollback(f.item,f.io);assert.equal(f.attrs,1);assert.equal(f.moves,0);});
 await check('missing original never gets attribute restore',async()=>{const f=setup({renamed:false,destIdentity:null});await assert.rejects(rollback(f.item,f.io),/ENOENT/);assert.equal(f.attrs,0);});
 await check('late success with different identity remains failure',async()=>{const f=setup();f.io.move=async()=>{f.files.set('source',{dev:1,ino:9});f.files.delete('dest');throw Error('response-lost');};await assert.rejects(rollback(f.item,f.io),/response-lost/);assert.equal(f.attrs,0);});
 console.log('desktop rollback review: '+n+' checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
