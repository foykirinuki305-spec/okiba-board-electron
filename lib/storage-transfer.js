'use strict';
// Storage-board transfers. This engine never touches Desktop icon placement.
// Pure-Node path/identity checks do not replace native ancestor-handle locking.
const fs=require('fs'), fsp=fs.promises, path=require('path'), crypto=require('crypto');
const key=p=>path.resolve(p).toLowerCase();
const fail=m=>{throw Error(m);};
const identity=s=>[String(s.dev),String(s.ino)];
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exists=async p=>{try{return await fsp.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const within=(p,r)=>{const s=path.relative(r,p);return !s||(!s.startsWith('..'+path.sep)&&s!=='..'&&!path.isAbsolute(s));};
const overlaps=(a,b)=>within(a,b)||within(b,a);
async function ordinaryAncestors(p){
 p=path.resolve(p);if(process.platform==='win32'&&p.startsWith('\\\\'))fail('network-path-refused');
 const parts=[];let q=p;for(;;){parts.unshift(q);const next=path.dirname(q);if(next===q)break;q=next;}
 const out=[];for(const part of parts){const s=await fsp.lstat(part);if(s.isSymbolicLink()||!s.isDirectory())fail('ancestor-reparse-or-not-directory');out.push({path:part,id:identity(s)});}
 return out;
}
async function verifyAncestors(before){for(const a of before){const s=await fsp.lstat(a.path);if(s.isSymbolicLink()||!s.isDirectory()||!eq(identity(s),a.id))fail('ancestor-changed');}}
async function digest(p,onProgress,phase){const h=crypto.createHash('sha256');let bytes=0;for await(const b of fs.createReadStream(p)){h.update(b);bytes+=b.length;onProgress({phase,path:p,bytes});}return h.digest('hex');}
async function inspect(root,onProgress=()=>{}){
 await ordinaryAncestors(path.dirname(root));const out=[];let dev;
 async function walk(p,rel){const a=await fsp.lstat(p);if(a.isSymbolicLink()||(!a.isFile()&&!a.isDirectory())||(a.isFile()&&a.nlink!==1))fail('reparse-special-or-hardlinked-file');if(dev===undefined)dev=a.dev;if(a.dev!==dev)fail('nested-volume');
 const e={rel,type:a.isDirectory()?'dir':'file',id:identity(a),size:a.isFile()?a.size:0,mtime:a.mtimeMs};out.push(e);
 if(a.isFile())e.hash=await digest(p,onProgress,'verify');else{const names=(await fsp.readdir(p)).sort();for(const n of names)await walk(path.join(p,n),path.join(rel,n));if(!eq(names,(await fsp.readdir(p)).sort()))fail('source-changed');}
 const z=await fsp.lstat(p);if(!eq(identity(z),e.id)||z.mtimeMs!==a.mtimeMs||z.size!==a.size)fail('source-changed');
 }await walk(root,'');return out;
}
const content=t=>t.map(e=>[e.rel,e.type,e.size,e.hash||null]);
const sameOriginal=(a,b)=>eq(content(a),content(b))&&a.every((e,i)=>eq(e.id,b[i].id)&&e.mtime===b[i].mtime);
async function atomic(file,value){const tmp=file+'.tmp-'+crypto.randomBytes(8).toString('hex');const h=await fsp.open(tmp,'wx');try{await h.writeFile(JSON.stringify(value,null,2));await h.sync();}finally{await h.close();}await fsp.rename(tmp,file);}
async function copyExclusive(src,dest,tree,onProgress){
 for(const e of tree){const a=path.join(src,e.rel),b=path.join(dest,e.rel);if(e.type==='dir'){await fsp.mkdir(b);continue;}
 const input=await fsp.open(a,'r');let output;try{output=await fsp.open(b,'wx');const buffer=Buffer.alloc(1024*1024);let bytes=0;for(;;){const n=await input.read(buffer,0,buffer.length,null);if(!n.bytesRead)break;let offset=0;while(offset<n.bytesRead){const w=await output.write(buffer,offset,n.bytesRead-offset,null);offset+=w.bytesWritten;}bytes+=n.bytesRead;onProgress({phase:'copy',path:a,destination:b,bytes,total:e.size});}await output.sync();}finally{await input.close();if(output)await output.close();}
 }
}
function validateJournal(j,journalDir){
 if(!j||j.version!==1||!/^[a-f0-9]{32}$/.test(j.id)||!Array.isArray(j.items)||!j.items.length||!['prepared','copied','staging','staged','committed','complete'].includes(j.phase))fail('invalid-journal');
 if(!eq(path.resolve(j.journalDir),path.resolve(journalDir)))fail('journal-root-mismatch');
 const seen=new Set();for(const i of j.items){for(const p of [i.source,i.destination,i.backupDir,i.backup])if(typeof p!=='string'||!path.isAbsolute(p))fail('invalid-journal-path');if(i.src!==i.source||i.dest!==i.destination||path.dirname(i.backupDir)!==i.backupParent||path.basename(i.backupDir)!=='.okiba-transfer-'+j.id+'-'+i.index||i.backup!==path.join(i.backupDir,'original')||path.basename(i.source)!==path.basename(i.destination)||!Array.isArray(i.baseline))fail('invalid-journal-layout');if(seen.has(key(i.source)))fail('duplicate-journal-source');seen.add(key(i.source));}
 return j;
}
function createStorageTransfer({journalDir,onProgress=()=>{},checkpoint=async()=>{},stagingRootForSource=()=>fs.realpathSync.native(require('os').tmpdir())}){
 journalDir=path.resolve(journalDir);let busy=false;
 const file=id=>path.join(journalDir,id+'.json');
 async function save(j){await atomic(file(j.id),j);await checkpoint(j.phase,JSON.parse(JSON.stringify(j)));}
 function result(j,error){return {ok:!error,operationId:j?.id,phase:j?.phase,error:error?String(error.message||error):undefined,blocked:!!error,metadata:j?.metadata,items:(j?.items||[]).map(i=>({src:i.source,dest:i.destination,source:i.source,destination:i.destination,backup:i.backup})),recoveryPaths:(j?.items||[]).flatMap(i=>[i.source,i.destination,i.backup]).concat(j?[file(j.id)]:[]),journal:j?file(j.id):undefined};}
 async function lock(){await fsp.mkdir(journalDir,{recursive:true});await ordinaryAncestors(journalDir);const p=path.join(journalDir,'.writer-lock');let h;try{h=await fsp.open(p,'wx');}catch(e){if(e.code!=='EEXIST')throw e;const before=await fsp.lstat(p);const old=JSON.parse(await fsp.readFile(p,'utf8'));if(!Number.isSafeInteger(old.pid)||old.pid<=0)fail('invalid-transfer-lock');let alive=true;try{process.kill(old.pid,0);}catch(x){if(x.code==='ESRCH')alive=false;else throw x;}if(alive)fail('transfer-busy-or-live-lock');const after=await fsp.lstat(p);if(!eq(identity(before),identity(after)))fail('lock-changed');await fsp.unlink(p);h=await fsp.open(p,'wx');}await h.writeFile(JSON.stringify({pid:process.pid}));await h.sync();return async()=>{await h.close();await fsp.unlink(p);};}
 async function verifiedDestination(i){await verifyAncestors(i.destAncestors);if(!i.destinationId)fail('destination-identity-unrecorded');const s=await fsp.lstat(i.destination);if(!eq(identity(s),i.destinationId))fail('destination-replaced');if(!eq(content(await inspect(i.destination,onProgress)),content(i.baseline)))fail('destination-changed');}
 async function sourceState(i){await verifyAncestors(i.sourceAncestors);await verifyAncestors(i.backupAncestors);const s=await exists(i.source),b=await exists(i.backup);if(s&&b)fail('both-source-and-backup-present');if(s){if(!sameOriginal(i.baseline,await inspect(i.source,onProgress)))fail('source-changed');return 'source';}if(b){if(!sameOriginal(i.baseline,await inspect(i.backup,onProgress)))fail('backup-changed');return 'backup';}return 'missing';}
 async function finish(j,callbacks){
 validateJournal(j,journalDir);
 if(!['copied','staging','staged','committed','complete'].includes(j.phase))fail('partial-copy-preserved-review-required');
 if(j.phase==='complete')return result(j);
 for(const i of j.items)await verifiedDestination(i);
 let metadata=await callbacks.inspectCommit(j);if(!['committed','pending','conflict'].includes(metadata))fail('invalid-metadata-status');if(metadata==='conflict')fail('metadata-conflict');if(j.phase==='committed'&&metadata!=='committed')fail('committed-metadata-lost');
 if(metadata!=='committed'){
  for(const i of j.items)if(await sourceState(i)==='missing')fail('source-and-backup-missing');
  j.phase='staging';await save(j);
  for(const i of j.items){const state=await sourceState(i);if(state==='source'){
   if(!await exists(i.backupDir)){await fsp.mkdir(i.backupDir);i.backupDirId=identity(await fsp.lstat(i.backupDir));await save(j);}else if(!i.backupDirId||!eq(identity(await fsp.lstat(i.backupDir)),i.backupDirId))fail('backup-directory-unverified');
   await verifyAncestors(i.sourceAncestors);if(await exists(i.backup))fail('backup-occupied');await fsp.rename(i.source,i.backup);await save(j);
  }}
  j.phase='staged';await save(j);for(const i of j.items){await verifiedDestination(i);if(await sourceState(i)!=='backup')fail('staged-original-unverified');}await callbacks.commit(j);metadata=await callbacks.inspectCommit(j);if(metadata!=='committed')fail('metadata-commit-unverified');
 }
 j.phase='committed';await save(j);
 for(const i of j.items){await verifiedDestination(i);const state=await sourceState(i);if(state==='source')fail('metadata-committed-source-still-present');if(state==='backup'){
  if(!i.backupDirId||!eq(identity(await fsp.lstat(i.backupDir)),i.backupDirId))fail('backup-directory-replaced');
  await fsp.rm(i.backup,{recursive:i.baseline[0].type==='dir'});i.cleaned=true;await save(j);
 }else if(!i.cleaned){ // Only a committed operation may have died after deletion and before journal update.
  i.cleaned=true;await save(j);
 }
 if(await exists(i.backupDir)){if(!i.backupDirId||!eq(identity(await fsp.lstat(i.backupDir)),i.backupDirId))fail('backup-directory-replaced');await fsp.rmdir(i.backupDir);}
 }
 j.phase='complete';await save(j);return result(j);
 }
 async function guarded(work){if(busy)return {ok:false,blocked:true,error:'transfer-busy'};busy=true;let release;try{release=await lock();return await work();}catch(e){return result(null,e);}finally{if(release)await release();busy=false;}}
 function requireCallbacks(c){if(typeof c?.commit!=='function'||typeof c?.inspectCommit!=='function')fail('metadata-callbacks-required');}
 return {
 async run({sources,destDir,metadata},callbacks){return guarded(async()=>{let j;try{
  requireCallbacks(callbacks);for(const n of await fsp.readdir(journalDir)){if(!/^[a-f0-9]{32}\.json$/.test(n))continue;const old=validateJournal(JSON.parse(await fsp.readFile(path.join(journalDir,n),'utf8')),journalDir);if(old.phase!=='complete')fail('unfinished-transfer-recovery-required');}if(!Array.isArray(sources)||!sources.length||sources.length>1000)fail('invalid-selection');sources=sources.map(p=>{if(typeof p!=='string'||!path.isAbsolute(p))fail('absolute-source-required');const absolute=path.resolve(p);if(absolute===path.parse(absolute).root)fail('drive-root-source-refused');return absolute;});destDir=path.resolve(destDir);const da=await ordinaryAncestors(destDir);
  for(let a=0;a<sources.length;a++){if(overlaps(sources[a],destDir)||overlaps(sources[a],journalDir))fail('overlapping-transfer');for(let z=0;z<a;z++)if(overlaps(sources[a],sources[z]))fail('nested-or-duplicate-selection');}
  const names=new Set();j={version:1,id:crypto.randomBytes(16).toString('hex'),journalDir,phase:'prepared',metadata,items:[]};
  for(const [index,source]of sources.entries()){const destination=path.join(destDir,path.basename(source));if(names.has(key(destination))||await exists(destination))fail('destination-occupied');names.add(key(destination));const baseline=await inspect(source,onProgress);const backupParent=path.resolve(await stagingRootForSource(source));if(path.basename(backupParent).toLowerCase()==='desktop')fail('desktop-staging-refused');if(within(backupParent,source)||within(backupParent,destination))fail('overlapping-staging');const backupAncestors=await ordinaryAncestors(backupParent);if((await fsp.stat(backupParent)).dev!==(await fsp.lstat(source)).dev)fail('staging-must-share-source-volume');const backupDir=path.join(backupParent,'.okiba-transfer-'+j.id+'-'+index);j.items.push({index,src:source,dest:destination,source,destination,backupParent,backupAncestors,backupDir,backup:path.join(backupDir,'original'),baseline,sourceAncestors:await ordinaryAncestors(path.dirname(source)),destAncestors:da});}
  await save(j);
  for(const i of j.items){await verifyAncestors(i.sourceAncestors);await verifyAncestors(i.destAncestors);await copyExclusive(i.source,i.destination,i.baseline,onProgress);i.destinationId=identity(await fsp.lstat(i.destination));await save(j);await verifiedDestination(i);if(!sameOriginal(i.baseline,await inspect(i.source,onProgress)))fail('source-changed-during-copy');}
  j.phase='copied';await save(j);return await finish(j,callbacks);
 }catch(e){return result(j,e);}});},
 async recoverAll(callbacks){return guarded(async()=>{requireCallbacks(callbacks);const out=[];for(const name of (await fsp.readdir(journalDir)).filter(n=>/^[a-f0-9]{32}\.json$/.test(n))){let j;try{j=validateJournal(JSON.parse(await fsp.readFile(path.join(journalDir,name),'utf8')),journalDir);if(name!==j.id+'.json')fail('journal-id-mismatch');out.push(await finish(j,callbacks));}catch(e){out.push({...result(j,e),journal:path.join(journalDir,name)});}}return {ok:out.every(r=>r.ok),results:out};});},
 async status(){const out=[];if(!await exists(journalDir))return out;for(const n of await fsp.readdir(journalDir)){if(!/^[a-f0-9]{32}\.json$/.test(n))continue;try{const j=validateJournal(JSON.parse(await fsp.readFile(path.join(journalDir,n),'utf8')),journalDir);out.push(result(j));}catch(e){out.push({ok:false,blocked:true,error:String(e.message),journal:path.join(journalDir,n)});}}return out;}
 };
}
module.exports={createStorageTransfer,inspect,content,sameOriginal,ordinaryAncestors,verifyAncestors,validateJournal};
