'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),{spawnSync}=require('child_process');
const {nativeCall,warmNative}=require('../lib/folder-return');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-folder-worker-')),dest=path.join(root,'dest'),script=path.resolve(__dirname,'../scripts/folder-return.ps1');fs.mkdirSync(dest);
 const elapsed=async fn=>{const t=Date.now();await fn();return Date.now()-t;};
 try{
  const cold=await elapsed(()=>warmNative(script));const times=[];
  for(let n=0;n<2;n++){
   const src=path.join(root,'test-'+n+'.txt');fs.writeFileSync(src,'generated TEMP fixture '+n);
   let p;const prepare=await elapsed(async()=>{p=await nativeCall(script,{action:'prepare',sources:[src],destDir:dest});});assert.equal(p.items.length,1);
   const execute=await elapsed(async()=>{const r=await nativeCall(script,{action:'execute',items:p.items});assert(r.results[0].moved&&r.results[0].visible);});
   assert(!fs.existsSync(src));assert(fs.existsSync(path.join(dest,path.basename(src))));times.push({prepare,execute});
  }
  const ping=await Promise.all(Array.from({length:5},()=>warmNative(script)));assert(ping.every(r=>r.ready));
  await assert.rejects(()=>nativeCall(script,{action:'bad-action'}));assert((await warmNative(script)).ready);
  const one=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{input:'{"action":"ping"}\n',encoding:'utf8',windowsHide:true});assert.equal(one.status,0);assert(JSON.parse(one.stdout).ready);
  console.log('PASS folder-return-worker cold='+cold+'ms warm='+JSON.stringify(times)+' queued ping + error recovery + one-shot');
 }finally{assert(root.startsWith(path.join(os.tmpdir(),'okiba-folder-worker-')));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
