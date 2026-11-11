'use strict';
const fs=require('fs');
// Retry only one already-fsynced payload. No temporary or destination is deleted.
function durableRename(tmp,dest,options={}){
 const io=options.fs||fs,platform=options.platform||process.platform;
 const wait=options.wait||((ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms));
 const delays=[20,40,80,160];
 function observe(p){
  let s;try{s=io.lstatSync(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}
  try{
   if(!s.isFile()||s.isSymbolicLink())throw Error('durable-rename-not-regular');
   const bytes=io.readFileSync(p),end=io.lstatSync(p,{bigint:true});
   const norm=t=>({dev:BigInt(t.dev),ino:BigInt(t.ino),size:BigInt(t.size),mtime:t.mtimeNs!==undefined?BigInt(t.mtimeNs):BigInt(Math.round(Number(t.mtimeMs)*1e6))});
   const first=norm(s),last=norm(end);
   if(!end.isFile()||end.isSymbolicLink()||Object.keys(first).some(k=>first[k]!==last[k])||BigInt(bytes.length)!==last.size)throw Error('durable-rename-observation-changed');
   return {...last,bytes};
  }catch(e){if(e.code==='ENOENT')throw Error('durable-rename-observation-changed');throw e;}
 }

 const equal=(a,b)=>a===null||b===null?a===b:a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtime===b.mtime&&a.bytes.equals(b.bytes);
 const payload=observe(tmp),before=observe(dest);if(!payload)throw Error('durable-rename-temp-missing');
 for(let attempt=0;;attempt++){
  if(!equal(observe(tmp),payload)||!equal(observe(dest),before))throw Error('durable-rename-foreign-change');
  try{io.renameSync(tmp,dest);}catch(e){
   const remaining=observe(tmp),current=observe(dest);
   // A failed reply may follow a completed rename. Identity AND bytes prove it.
   if(remaining===null&&equal(current,payload))return {recovered:true,attempts:attempt+1};
   if(!equal(remaining,payload)||!equal(current,before))throw Error('durable-rename-effect-unconfirmed');
   if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=delays.length)throw e;
   wait(delays[attempt]);continue;
  }
  if(observe(tmp)!==null||!equal(observe(dest),payload))throw Error('durable-rename-postcondition-changed');
  return {recovered:false,attempts:attempt+1};
 }
}
module.exports={durableRename};
