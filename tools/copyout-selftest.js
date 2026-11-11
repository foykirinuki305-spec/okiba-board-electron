 'use strict';
const fs=require('fs'),fsp=fs.promises,path=require('path'),os=require('os'),assert=require('assert'),crypto=require('crypto'),cp=require('child_process'),{copyFilesOut}=require('../lib/copyout');
let checks=0;function ok(x,msg){assert(x,msg);checks++;}const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function attrib(file,flag){let args=flag?[flag,file]:[file];const r=cp.spawnSync('attrib.exe',args,{encoding:'utf8',windowsHide:true});assert.equal(r.status,0);return r.stdout.slice(0,20).trim();}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-copyout-test-'));const dest=path.join(root,'dest'),srcdir=path.join(root,'source');fs.mkdirSync(dest);fs.mkdirSync(srcdir);
 try{
  const src=path.join(srcdir,'日本語 空白 🧪.bin');fs.writeFileSync(src,crypto.randomBytes(1024*1024));attrib(src,'+H');
  const meta=path.join(root,'board.json'),metabytes=JSON.stringify({links:[{path:src,wasHidden:false}],positions:{retain:[2,3]},unknown:true});fs.writeFileSync(meta,metabytes);
  const before={hash:hash(src),ino:fs.statSync(src).ino,attrs:attrib(src)};
  let captured=Buffer.alloc(0);const captureSpawn=(...args)=>{const child=cp.spawn(...args);child.stdout.on('data',b=>{captured=Buffer.concat([captured,b]);});return child;};
  let heartbeat=false;const timer=setTimeout(()=>heartbeat=true,5);const r=await copyFilesOut({sources:[src],destDir:dest,spawnImpl:captureSpawn});clearTimeout(timer);
  if(!r.copied.length){let decoded;try{decoded=JSON.parse(captured.toString('utf8'));}catch{};console.error(JSON.stringify({fixtureOnlyWireDiagnostic:true,rawHexPrefix:captured.subarray(0,512).toString('hex'),requestedSrcCodepoints:[...src].map(c=>c.codePointAt(0)),returned:decoded?.results?.map(x=>({srcCodepoints:[...String(x.src)].map(c=>c.codePointAt(0)),destCodepoints:[...String(x.dest)].map(c=>c.codePointAt(0)),copied:x.copied,skipped:x.skipped,cleanupVerified:x.cleanupVerified,hash:x.sha256,reason:x.reason}))}));}
  ok([...captured].every(b=>b<128),'native response JSON is ASCII-only including non-BMP source');
  ok(heartbeat,'copy worker does not block event loop');ok(r.copied.length===1,JSON.stringify(r));ok(r.failed.length===0&&r.partial.length===0,'no failure');
  const out=path.join(dest,path.basename(src));ok(hash(out)===before.hash,'copy bytes match');ok(fs.statSync(out).ino!==before.ino,'independent destination ID');ok(!attrib(out).includes('H'),'destination visible');
  ok(hash(src)===before.hash&&fs.statSync(src).ino===before.ino&&attrib(src)===before.attrs,'source bytes ID attrs unchanged');ok(fs.readFileSync(meta,'utf8')===metabytes,'board untouched');
  const again=await copyFilesOut({sources:[src],destDir:dest});ok(again.skipped[0].reason==='destination-exists','collision skipped');ok(hash(out)===before.hash,'collision does not overwrite');
  const self=await copyFilesOut({sources:[src],destDir:srcdir});ok(self.skipped[0].reason==='same-path','same path skipped');
  const missing=await copyFilesOut({sources:[path.join(srcdir,'missing.bin')],destDir:dest});ok(missing.failed.length===1&&!missing.partial.length,'missing source clean failure');
  const dir=await copyFilesOut({sources:[srcdir],destDir:dest});ok(dir.failed.length===1,'directory refused');
  const hard=path.join(srcdir,'hard.bin');fs.linkSync(src,hard);const h=await copyFilesOut({sources:[hard],destDir:dest});ok(h.failed.length===1,'multiple hardlinks refused');fs.unlinkSync(hard);
  const junction=path.join(root,'junction');fs.symlinkSync(srcdir,junction,'junction');const j=await copyFilesOut({sources:[path.join(junction,path.basename(src))],destDir:dest});ok(j.failed.length===1,'reparse ancestor refused');fs.unlinkSync(junction);
  const lockDest=path.join(root,'lock-dest');fs.mkdirSync(lockDest);
  const lock=await fsp.open(src,'r+');try{
   const locked=await copyFilesOut({sources:[src],destDir:lockDest});
   ok(locked.failed.length===1&&locked.failed[0].reason.includes('resident-open'),'write-open source rejected by native share guard');
   ok(locked.copied.length===0&&locked.partial.length===0&&fs.readdirSync(lockDest).length===0,'write-open failure creates no destination');
   ok(hash(src)===before.hash&&fs.statSync(src).ino===before.ino&&attrib(src)===before.attrs,'write-open failure leaves original unchanged');
  }finally{await lock.close();}
  const unlocked=await copyFilesOut({sources:[src],destDir:lockDest});ok(unlocked.copied.length===1,'same existing destination accepts copy after write handle closes');
  const readOnly=path.join(srcdir,'readonly.bin');fs.writeFileSync(readOnly,'test');attrib(readOnly,'+R');const ro=await copyFilesOut({sources:[readOnly],destDir:dest});ok(ro.failed.length===1,'unsupported attributes refused');attrib(readOnly,'-R');
  ok(fs.readdirSync(dest).length===1,'no partials from validation failures');ok(hash(src)===before.hash&&attrib(src)===before.attrs,'all failures preserve original');
  await assert.rejects(()=>copyFilesOut({sources:[src,src],destDir:dest}),/duplicate/);checks++;
  const fresh=path.join(srcdir,'batch-fresh.bin');fs.writeFileSync(fresh,'batch bytes');const freshBefore={ino:fs.statSync(fresh).ino,hash:hash(fresh),attrs:attrib(fresh)};
  const mixed=await copyFilesOut({sources:[fresh,src,path.join(srcdir,'batch-missing.bin'),srcdir],destDir:dest});
  ok(mixed.copied.length===1&&mixed.copied[0].src===fresh,'mixed batch retains individual success');
  ok(mixed.skipped.length===1&&mixed.skipped[0].src===src,'mixed batch retains collision skip');
  ok(mixed.failed.length===2&&mixed.partial.length===0&&!mixed.unresolved,'mixed batch reports missing and directory failures');
  ok(hash(fresh)===freshBefore.hash&&fs.statSync(fresh).ino===freshBefore.ino&&attrib(fresh)===freshBefore.attrs,'mixed batch original unchanged');
  ok(hash(out)===before.hash&&fs.readFileSync(meta,'utf8')===metabytes,'mixed batch existing destination and board unchanged');
  const large=path.join(srcdir,'synthetic-128MiB.bin'),block=crypto.randomBytes(1024*1024),fd=fs.openSync(large,'wx');try{for(let i=0;i<128;i++)fs.writeSync(fd,block);}finally{fs.closeSync(fd);}
  const largeBefore={ino:fs.statSync(large).ino,hash:hash(large),attrs:attrib(large)};
  const started=performance.now();const largeResult=await copyFilesOut({sources:[large],destDir:dest});const workerRoundTripMs=performance.now()-started;
  ok(largeResult.copied.length===1&&!largeResult.partial.length,'128MiB complete verified copy');
  const lr=largeResult.copied[0];ok(lr.sha256.toLowerCase()===largeBefore.hash&&hash(lr.dest)===largeBefore.hash,'128MiB worker hash and independent destination hash match');
  ok(hash(large)===largeBefore.hash&&fs.statSync(large).ino===largeBefore.ino&&attrib(large)===largeBefore.attrs,'128MiB original bytes ID attrs unchanged');
  ok(fs.statSync(lr.dest).ino!==largeBefore.ino&&!attrib(lr.dest).includes('H'),'128MiB independent visible copy');
  console.log(JSON.stringify({measurement:'one synthetic warm-cache local-volume sample, not general video throughput',bytes:128*1024*1024,nativeCopyIncludingHashesMs:lr.copyMs,workerRoundTripIncludingStartupMs:workerRoundTripMs}));
  console.log(`copyout: ${checks} checks PASS (own TEMP only)`);
 }finally{if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('okiba-copyout-test-'))throw Error('cleanup scope');fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
