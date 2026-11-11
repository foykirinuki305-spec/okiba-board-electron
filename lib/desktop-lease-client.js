'use strict';
const path=require('path');const {fork}=require('child_process');
function createDesktopLeaseClient(options){
 let child=null,seq=0,readyPromise=null,connected=true;const pending=new Map();
 function start(){if(child)return;child=fork(path.join(__dirname,'desktop-lease-watchdog.js'),[],{execPath:process.execPath,detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  child.on('message',m=>{const p=pending.get(m?.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);p.resolve(m.result);});
  const gone=()=>{connected=false;for(const p of pending.values()){clearTimeout(p.timer);p.resolve({ok:false,reason:'watchdog-disconnected',pendingVerification:true,retrySafe:false});}pending.clear();};
  child.on('exit',gone);child.on('error',gone);child.on('disconnect',gone);child.unref();
 }
 function request(method,args=[]){start();if(!connected||!child.connected)return Promise.resolve({ok:false,reason:'watchdog-disconnected',pendingVerification:true,retrySafe:false});const id=++seq;return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(id);resolve({ok:false,reason:'watchdog-timeout',pendingVerification:true,retrySafe:false});},options.timeoutMs||120000);pending.set(id,{resolve,timer});const sendFailed=()=>{const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.resolve({ok:false,reason:'watchdog-send-failed',pendingVerification:true,retrySafe:false});}};try{child.send({id,method,args},e=>{if(e)sendFailed();});}catch{sendFailed();}});}
 function ready(){if(!readyPromise)readyPromise=request('init',[{...options,owner:{pid:process.pid,...options.owner}}]).then(r=>{if(!r.ok&&child?.connected)child.disconnect();return r;});return readyPromise;}
 async function invoke(method,args){const r=await ready();if(!r.ok)return r;return request(method,args);}
 return {ready,prepareScope:async s=>{const r=await invoke('prepareScope',[s]);if(!r.ok)throw Error(r.reason);return r.scope;},
  adapter(commit){if(typeof commit!=='function')throw Error('commit callback required');const a={commit};for(const name of ['prepare','revealAndPlace','restoreAndVerify','prepareCommit','commitDone','release','abort','resolveCommit'])a[name]=(...args)=>invoke(name,args);return a;},
  reserveLegacy:scope=>invoke('reserveLegacy',[scope]),releaseLegacy:(token,proof)=>invoke('releaseLegacy',[token,proof]),desktopState:()=>invoke('desktopState',[]),status:()=>invoke('status',[]),close:()=>invoke('close',[]),disconnect(){if(child?.connected)child.disconnect();},
  // diagnostics exposes PID only, never an API that kills a pending watchdog.
  diagnostics:()=>({pid:child?.pid||null,connected})};
}
module.exports={createDesktopLeaseClient};
