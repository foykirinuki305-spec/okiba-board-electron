'use strict';
if(process.platform!=='win32')throw Error('Windows process fixture required');
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{spawn,execFile}=require('child_process'),{promisify}=require('util');
const source=fs.readFileSync(path.join(__dirname,'desktop-legacy-native-ci.js'),'utf8');const start=source.indexOf(' async function nativeProcess('),end=source.indexOf('\n async function attributes',start);assert(start>=0&&end>start);
const nativeProcess=vm.runInNewContext(source.slice(start,end)+'\nnativeProcess',{run:promisify(execFile),process,JSON});
(async()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});try{
 const birth=await nativeProcess(c.pid);assert(/^\d+$/.test(birth));
 const wrong=await nativeProcess(c.pid,String(BigInt(birth)-1n));assert(wrong.stopConfirmed&&!wrong.killed&&wrong.state==='pid-reused-old-exited');assert.equal(c.exitCode,null);process.kill(c.pid,0);
 const stopped=await nativeProcess(c.pid,birth);assert(stopped.stopConfirmed&&stopped.state==='matching-process-stopped');
 const repeated=await nativeProcess(c.pid,birth);assert(repeated.stopConfirmed&&!repeated.killed&&repeated.state==='already-exited');
 console.log('PASS legacy fixture stop 3 checks: mismatched birth never killed / matched stop / already-exited');
}finally{if(c.exitCode===null&&c.signalCode===null)c.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
