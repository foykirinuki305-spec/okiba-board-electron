'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{fork,spawn}=require('child_process');
const {createDesktopLeaseLock}=require('../lib/desktop-lease-global-lock');
if(process.argv[2]==='worker'){
 let lock;process.on('message',async m=>{try{if(m.cmd==='begin'){lock=createDesktopLeaseLock(m.scope);await lock.begin(m.record);process.send({ok:true,pointer:lock.pointer,key:lock.key});}else if(m.cmd==='release'){await lock.release(m.token);process.send({ok:true});}}catch(e){process.send({ok:false,reason:String(e.message||e)});}});setInterval(()=>{},1000);
}else{
 (async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-global-lock-test-')),desktop=path.join(root,'desktop'),localAppData=path.join(root,'appdata');fs.mkdirSync(desktop);fs.mkdirSync(localAppData);const children=[];let checks=0;
 const scope={desktop,localAppData,sessionId:12345};const token='a'.repeat(32);
 const child=()=>{const env={...process.env};delete env.NODE_PENDING_PIPE_INSTANCES;const c=fork(__filename,['worker'],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env});children.push(c);return c;};
 const ask=(c,m)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('worker timeout')),10000);c.once('message',r=>{clearTimeout(t);resolve(r);});c.send(m);});
 async function stop(c){if(c.exitCode!==null||c.signalCode!==null)return;const exit=new Promise(r=>c.once('exit',r));c.kill();await exit;}
 try{
  const a=child(),b=child();const record={token,journalPath:path.join(root,'baseA','journal.json'),phase:'prepared'};
  const first=await ask(a,{cmd:'begin',scope,record});assert(first.ok);checks++;
  let second=await ask(b,{cmd:'begin',scope,record:{...record,token:'b'.repeat(32),journalPath:path.join(root,'baseB','journal.json')}});assert(!second.ok&&second.reason.startsWith('desktop-lease-busy'));checks++;
  const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});children.push(helper);await stop(helper);
  second=await ask(b,{cmd:'begin',scope,record:{...record,token:'b'.repeat(32)}});assert(!second.ok&&second.reason.startsWith('desktop-lease-busy'));checks++;
  assert((await ask(a,{cmd:'release',token})).ok);assert((await ask(b,{cmd:'begin',scope,record:{...record,token:'b'.repeat(32)}})).ok);assert((await ask(b,{cmd:'release',token:'b'.repeat(32)})).ok);checks++;
  assert((await ask(a,{cmd:'begin',scope,record})).ok);const orphan=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});children.push(orphan);await stop(a);assert.equal(orphan.exitCode,null);
  second=await ask(b,{cmd:'begin',scope,record:{...record,token:'c'.repeat(32),journalPath:path.join(root,'baseC','journal.json')}});assert(!second.ok&&second.reason==='unresolved-global-desktop-lease');assert(fs.existsSync(first.pointer));checks++;
  const saved=JSON.parse(fs.readFileSync(first.pointer,'utf8'));assert.equal(saved.token,token);assert.equal(saved.journalPath,record.journalPath);checks++;
  console.log('PASS global Desktop lock '+checks+' checks: 2 processes / different BASE / helper death / watchdog death + live orphan');
 }finally{for(const c of children)await stop(c);assert(path.basename(root).startsWith('okiba-global-lock-test-'));fs.rmSync(root,{recursive:true,force:true});}
 })().catch(e=>{console.error(e);process.exitCode=1});
}
