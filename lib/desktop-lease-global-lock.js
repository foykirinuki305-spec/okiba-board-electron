'use strict';
const {durableRename}=require('./durable-rename');
// Node owns this pipe for the entire Desktop lease, including helper restarts.
// A durable global pointer survives watchdog death. Never auto-clear a stale one.
const fs=require('fs'),path=require('path'),net=require('net'),crypto=require('crypto');
function createDesktopLeaseLock({desktop,sessionId,localAppData,onLost=()=>{}}){
 if(!Number.isSafeInteger(sessionId)||sessionId<0||!path.isAbsolute(desktop)||!path.isAbsolute(localAppData))throw Error('invalid-global-lease-location');
 const canonical=fs.realpathSync.native(desktop).toLowerCase();const key=crypto.createHash('sha256').update(canonical+'\n'+sessionId).digest('hex');
 const dir=path.join(localAppData,'OkibaBoard','DesktopLeases');const pointer=path.join(dir,key+'.json');
 const pipe=process.platform==='win32'?'\\\\.\\pipe\\OkibaDesktopLease-'+key:path.join(dir,key+'.sock');
 let server=null,token=null,intentionalClose=false;
 function stale(){if(!fs.existsSync(dir))return false;const names=fs.readdirSync(dir);return names.some(n=>n===key+'.json'||n.startsWith(key+'.')&&n.endsWith('.tmp'));}
 function current(){return JSON.parse(fs.readFileSync(pointer,'utf8'));}
 function atomic(value){const tmp=path.join(dir,key+'.'+crypto.randomBytes(8).toString('hex')+'.tmp'),fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}durableRename(tmp,pointer);}
 async function closePipe(){if(!server)return;intentionalClose=true;const s=server;server=null;await new Promise(resolve=>s.close(()=>resolve()));}
 async function bind(){
  if(server)throw Error('global-lease-already-owned');intentionalClose=false;
  const s=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{const failed=e=>{s.removeListener('listening',listening);try{s.close();}catch{}reject(Error('desktop-lease-busy:'+e.code));};const listening=()=>{s.removeListener('error',failed);resolve();};s.once('error',failed);s.once('listening',listening);s.listen(pipe);});
  server=s;s.on('error',()=>{if(!intentionalClose)onLost('global-lock-error');});s.on('close',()=>{if(!intentionalClose)onLost('global-lock-closed');});
 }
 return {key,pointer,pipe,desktop:canonical,sessionId,hasUnresolved:stale,
  async begin(record){if(!/^[a-f0-9]{32}$/.test(record.token))throw Error('invalid-global-token');fs.mkdirSync(dir,{recursive:true});await bind();try{if(stale())throw Error('unresolved-global-desktop-lease');token=record.token;atomic({...record,version:1,key,desktop:canonical,sessionId});}catch(e){token=null;await closePipe();throw e;}},
  update(record){if(!server||!token||record.token!==token||current().token!==token)throw Error('global-lease-ownership-lost');atomic({...record,version:1,key,desktop:canonical,sessionId});},
  async release(expected){if(!server||token!==expected||current().token!==expected)throw Error('global-lease-ownership-lost');fs.unlinkSync(pointer);token=null;await closePipe();},
  async abandonReadOnly(){if(token)throw Error('active-global-pointer');await closePipe();},
  owned:()=>!!server&&!!token
 };
}
module.exports={createDesktopLeaseLock};
