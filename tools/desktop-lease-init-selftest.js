'use strict';
// Own temporary files and fake helper only. Never opens the Windows Desktop.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{fork}=require('child_process');
if(process.argv[2]==='helper'){
 fs.writeFileSync(process.argv[3],String(process.pid));
 process.stdout.write(JSON.stringify({ready:true})+'\n');
 require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({id:q.id,result:{ok:false,reason:'intentional-init-failure'}})+'\n'),process.argv[4]==='slow'?250:0);});
 setInterval(()=>{},1000);
}else (async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-init-exit-'));let checks=0;const owned=[];
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 try{
 for(const mode of ['journal','journal','native','native','during-init']){
  const dir=path.join(root,String(checks));fs.mkdirSync(dir);const journalDir=path.join(dir,'journal');fs.mkdirSync(journalDir);
  if(mode==='journal')fs.writeFileSync(path.join(journalDir,'a'.repeat(32)+'.json'),JSON.stringify({token:'a'.repeat(32),phase:'prepared'}));
  const pidfile=path.join(dir,'helper.pid');const c=fork(path.join(__dirname,'../lib/desktop-lease-watchdog.js'),[],{windowsHide:true,stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});owned.push(c);
  const ended=new Promise(resolve=>c.once('exit',(code,signal)=>resolve({code,signal})));
  const reply=new Promise(resolve=>c.once('message',resolve));
  c.send({id:1,method:'init',args:[{journalDir,owner:{pid:process.pid},helper:{command:process.execPath,args:[__filename,'helper',pidfile,mode==='during-init'?'slow':'fast']},helperTimeoutMs:1000}]});
  if(mode==='during-init'){
   const until=Date.now()+5000;while(!fs.existsSync(pidfile)&&Date.now()<until)await sleep(10);assert(fs.existsSync(pidfile));c.disconnect();
  }else{const r=await reply;assert.equal(r.result.ok,false);c.disconnect();}
  let timer;const result=await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('watchdog leaked: '+mode)),6000);})]);clearTimeout(timer);assert.equal(result.code,0);
  if(fs.existsSync(pidfile)){const pid=Number(fs.readFileSync(pidfile));let live=true;try{process.kill(pid,0);}catch(e){assert.equal(e.code,'ESRCH');live=false;}assert.equal(live,false,'owned helper must stop before watchdog exits');}
  if(mode==='journal')assert(fs.existsSync(path.join(journalDir,'a'.repeat(32)+'.json')),'unresolved journal preserved');checks++;
 }
 console.log('PASS watchdog initialization cleanup '+checks+' checks (two retries per failure + disconnect during init)');
 }finally{for(const c of owned){if(c.exitCode===null&&c.signalCode===null){c.kill();await new Promise(r=>c.once('exit',r));}}assert(path.basename(root).startsWith('okiba-init-exit-'));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
