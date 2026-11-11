'use strict';
// Copy/verify transaction. Original bytes survive until UI placement and metadata commit.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const exists = async p => {try {await fsp.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const id = s => [s.dev,s.ino];
const sameId = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const within = (p,root) => {const r=path.relative(root,p);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
async function digest(file) {
  const h=crypto.createHash('sha256');
  for await(const data of fs.createReadStream(file))h.update(data);
  return h.digest('hex');
}
async function inspect(root) {
  const entries=[]; let rootDev=null;
  async function walk(p,rel) {
    const before=await fsp.lstat(p);
    if(rootDev===null)rootDev=before.dev;else if(before.dev!==rootDev)throw Error('nested-volume-mount-unsupported');
    if(before.isSymbolicLink()||(!before.isFile()&&!before.isDirectory()))throw Error('unsupported-reparse-or-special-file');
    const entry={rel,type:before.isDirectory()?'dir':'file',identity:id(before),size:before.size,mtime:before.mtimeMs};
    if(before.isFile())entry.hash=await digest(p);
    else {
      const names=(await fsp.readdir(p)).sort();
      entries.push(entry);
      for(const name of names)await walk(path.join(p,name),path.join(rel,name));
      if(JSON.stringify(names)!==JSON.stringify((await fsp.readdir(p)).sort()))throw Error('source-changed-during-read');
    }
    const after=await fsp.lstat(p);
    if(!sameId(id(before),id(after))||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('source-changed-during-read');
    if(before.isFile())entries.push(entry);
  }
  await walk(root,'');
  return entries;
}
const content = entries => JSON.stringify(entries.map(e=>[e.rel,e.type,e.type==='file'?e.size:null,e.hash||null]));
const unchanged = (a,b) => content(a)===content(b)&&a.every((e,i)=>sameId(e.identity,b[i].identity)&&e.mtime===b[i].mtime);
async function copyTree(source,dest,entries) {
  for(const e of entries) {
    const from=path.join(source,e.rel),to=path.join(dest,e.rel);
    if(e.type==='dir')await fsp.mkdir(to); // exclusive, never merge existing material
    else {
      await fsp.copyFile(from,to,fs.constants.COPYFILE_EXCL);
      const st=await fsp.stat(from);await fsp.utimes(to,st.atime,st.mtime);
    }
  }
}
async function moveNoReplace(from,to,isDirectory=true) {
  if(await exists(to))throw Error('original-path-occupied');
  if(process.platform==='win32') {
    const script="$ErrorActionPreference='Stop'; if($env:OKIBA_TRANSFER_KIND -eq 'directory'){[IO.Directory]::Move($env:OKIBA_TRANSFER_FROM,$env:OKIBA_TRANSFER_TO)}else{[IO.File]::Move($env:OKIBA_TRANSFER_FROM,$env:OKIBA_TRANSFER_TO)}";
    await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,env:{...process.env,OKIBA_TRANSFER_FROM:from,OKIBA_TRANSFER_TO:to,OKIBA_TRANSFER_KIND:isDirectory?'directory':'file'}},e=>e?reject(e):resolve()));
  } else if(isDirectory) await fsp.rename(from,to); else {await fsp.link(from,to);await fsp.unlink(from);}
}
function createCrossVolumeMove(source,destination,options={}) {
  source=path.resolve(source);destination=path.resolve(destination);
  if(within(destination,source)||within(source,destination))throw Error('overlapping-transfer-paths');
  let baseline=null, destinationId=null, destinationVerified=false, staged=false, container=null, backup=null;
  const move=options.moveNoReplace || moveNoReplace;
  const timings={};
  const journal=()=>container&&path.join(container,'transfer.json');
  async function save(state) {if(container)await fsp.writeFile(journal(),JSON.stringify({version:1,source,destination,backup,state},null,2));}
  async function validateDestination() {
    if(!destinationVerified||!destinationId||!sameId(id(await fsp.lstat(destination)),destinationId)||content(await inspect(destination))!==content(baseline))throw Error('destination-changed-or-unverified');
  }
  async function makeContainer() {
    const st=await fsp.lstat(source);
    const explicit=!!options.stagingParent;
    const candidates=explicit?[options.stagingParent]:[os.tmpdir(),...(options.stagingParents||[]),path.parse(source).root];
    const excluded=[source,destination,...(options.stagingExcludedRoots||[])].map(p=>path.resolve(p));
    const realExcluded=await Promise.all(excluded.map(async p=>{try{return await fsp.realpath(p);}catch{return p;}}));
    const seen=new Set();let lastError;
    for(const candidate of candidates) {
      const parent=path.resolve(candidate),key=process.platform==='win32'?parent.toLowerCase():parent;
      if(seen.has(key))continue;seen.add(key);
      try {
        const realParent=await fsp.realpath(parent),parentStat=await fsp.stat(parent);
        if(!parentStat.isDirectory()||parentStat.dev!==st.dev||excluded.some(p=>within(parent,p))||realExcluded.some(p=>within(realParent,p)))throw Error('invalid-staging-volume-or-excluded-path');
        container=await fsp.mkdtemp(path.join(parent,'okiba-transfer-'));
        break;
      }catch(error){lastError=error;if(explicit)throw error;}
    }
    if(!container){const error=Error('staging-unavailable: '+(lastError?.message||'no-safe-candidate'));error.cause=lastError;throw error;}
    backup=path.join(container,'original');
    await save('prepared-original-retained');
  }
  async function removeContainer() {
    if(!container)return;
    if(await exists(backup))throw Error('backup-still-present');
    if(await exists(journal()))await fsp.unlink(journal());
    await fsp.rmdir(container);container=null;
  }
  const transaction={
    get timings(){return {...timings};},
    get source(){return source;},get destination(){return destination;},get dest(){return destination;},get backupPath(){return backup;},
    get recoveryPaths(){return [source,destination,backup,journal()].filter(Boolean);},
    async prepare() {
      if(baseline)throw Error('transfer-already-started');
      if(await exists(destination))throw Error('destination-occupied');
      baseline=await inspect(source);
      await makeContainer();
      await copyTree(source,destination,baseline);
      destinationId=id(await fsp.lstat(destination));
      if(content(await inspect(destination))!==content(baseline)||!unchanged(baseline,await inspect(source)))throw Error('copy-verification-failed');
      destinationVerified=true;await save('copy-verified-original-retained');
    },
    async stageSource() {
      await validateDestination();
      if(!unchanged(baseline,await inspect(source)))throw Error('source-changed-before-commit');
      try {await move(source,backup,baseline[0].type==='dir');staged=true;}
      catch(error) {
        if(error.unsafe)throw error;
        // A timed-out but stopped helper may already have completed the rename.
        if(!(await exists(source)) && await exists(backup) && sameId(id(await fsp.lstat(backup)),baseline[0].identity))staged=true;
        throw error;
      }
      await save('original-staged-awaiting-metadata');
    },
    async rollback() {
      if(staged) {
        if(await exists(source))throw Error('original-path-occupied');
        if(!unchanged(baseline,await inspect(backup)))throw Error('backup-changed');
        try {await move(backup,source,baseline[0].type==='dir');staged=false;}
        catch(error) {
          if(error.unsafe)throw error;
          if(await exists(source) && !(await exists(backup)) && sameId(id(await fsp.lstat(source)),baseline[0].identity))staged=false;
          else throw error;
        }
      }
      if(await exists(destination)) {
        await validateDestination();
        // Only our verified, unchanged copy is removed; original is intact.
        if(!unchanged(baseline,await inspect(source)))throw Error('source-changed-before-rollback-cleanup');
        await fsp.rm(destination,{recursive:baseline[0].type==='dir'});
      }
      await removeContainer();
    },
    async cleanup() {
      // Invoke ONLY after metadata commit. Failure retains original and journal.
      try {
        if(!staged)throw Error('original-not-staged');
        await validateDestination();
        if(!unchanged(baseline,await inspect(backup)))throw Error('backup-changed');
        await fsp.rm(backup,{recursive:baseline[0].type==='dir'});staged=false;
        await removeContainer();return {ok:true,recovery:[]};
      } catch(e){return {ok:false,error:String(e.message||e),warning:String(e.message||e),backupPath:backup,recovery:[source,destination,backup,journal()].filter(Boolean)};}
    }
  };
  for(const name of ['prepare','stageSource','rollback','cleanup']) {
    const operation=transaction[name];
    transaction[name]=async(...args)=>{const started=Date.now();try{return await operation.apply(transaction,args);}finally{timings[name+'Ms']=(timings[name+'Ms']||0)+Date.now()-started;}};
  }
  return transaction;
}
module.exports={createCrossVolumeMove,inspect,content,moveNoReplace};





