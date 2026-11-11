// Hosted-only owner process for the abort-only v2 slice.
'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.OKIBA_UNKNOWN_GRID_CI!=='1')throw Error('Hosted unknown CI only');
const path=require('path'),run=require('util').promisify(require('child_process').execFile);let client,token;
const {retryableSnapshotRead}=require('./unknown-grid-recovery-policy-ci');
const send=m=>{if(process.connected)process.send(m);};
async function closeVerified(){
 const status=await client.status(),pid=client.diagnostics().pid;
 const birth=(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','$p=[Diagnostics.Process]::GetProcessById([int]$env:OKIBA_CHILD_PID);$null=$p.Handle;$p.StartTime.ToUniversalTime().Ticks.ToString()'],{windowsHide:true,timeout:15000,env:{...process.env,OKIBA_CHILD_PID:String(pid)}})).stdout.trim();
 if(!/^\d+$/.test(birth))throw Error('watchdog-birth-unverified');
 const children=[{pid,started:birth},...status.helper.history],closed=await client.close();if(!closed.ok)return closed;
 const proof=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'wait-owned-processes-ci.ps1')],{windowsHide:true,timeout:60000,env:{...process.env,OKIBA_CHILDREN:JSON.stringify(children)}})).stdout);
 if(!proof.ok||proof.processes.length!==children.length||!proof.processes.every(p=>p.stopConfirmed))throw Error('watchdog-helper-stop-unverified');return {ok:true,proof};
}
process.on('message',async m=>{try{
 if(m.cmd==='close'){const r=await closeVerified();send({phase:'closed',result:r});if(r.ok)setTimeout(()=>process.exit(0),50);return;}
 if(m.cmd!=='run')return;const s=m.spec;
 const {createDesktopLeaseClient}=require(path.join(s.copy,'lib/desktop-lease-client'));
 client=createDesktopLeaseClient({journalDir:s.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(s.copy,'scripts/shell-helper.ps1')],env:{OKIBA_UNKNOWN_GRID_CI:'1',OKIBA_UNKNOWN_DROP_REPLY:s.scenario==='reply-loss'?'1':'0',OKIBA_UNKNOWN_HIDE_FAULT:s.scenario==='hide-reply-loss'?s.hideFaultMarker:''}},helperTimeoutMs:['reply-loss','hide-reply-loss'].includes(s.scenario)?4000:15000,timeoutMs:60000});
 const ready=await client.ready();if(!ready.ok)throw Error(JSON.stringify(ready));
 const scope=await client.prepareScope(s.scope);const p=await client.unknown('prepare',scope);if(!p.ok)throw Error(JSON.stringify(p));token=p.token;
 const revealed=await client.unknown('revealProbe',token);if(!revealed.ok)throw Error(JSON.stringify(revealed));
 if(s.scenario==='owner-death-probe'){send({phase:'kill-owner',status:await client.status(),watchdog:client.diagnostics()});return;}
 if(s.scenario==='hide-reply-loss'){
  const interrupted=await client.unknown('abort',token);if(interrupted.ok)throw Error('hide fault did not interrupt');
  const aborted=await client.unknown('abort',token);if(!aborted.ok)throw Error(JSON.stringify({operation:'abort',result:aborted}));send({phase:'done',aborted,status:await client.status(),hideLoss:interrupted});return;
 }
 const begun=await client.unknown('beginCalibration',token);
 if(s.scenario==='reply-loss'){
  if(begun.ok)throw Error('reply-loss injection did not fail');const aborted=await client.unknown('abort',token);if(!aborted.ok)throw Error(JSON.stringify({operation:'abort',result:aborted}));send({phase:'done',aborted,status:await client.status(),replyLoss:begun});return;
 }
 if(!begun.ok)throw Error(JSON.stringify(begun));let previous=begun.probe;const samples=[];
 for(const q of s.scope.plan.requests.slice(0,3)){const r=await client.unknown('calibrationSample',token,{point:{x:q.x,y:q.y},previous:{x:previous.x,y:previous.y}});if(!r.ok)throw Error(JSON.stringify(r));previous=r.probe;samples.push(r);}
 if(s.scenario==='owner-death-sample'){send({phase:'kill-owner',samples,status:await client.status(),watchdog:client.diagnostics()});return;}
 const aborted=await client.unknown('abort',token);if(!aborted.ok)throw Error(JSON.stringify({operation:'abort',result:aborted}));send({phase:'done',aborted,samples,status:await client.status()});
 }catch(e){const primaryError=String(e.stack||e);let status=null,recovery=null,closed=null,recoveryError=null;const attempts=[];try{
 status=client?await client.status():null;
 const transient=retryableSnapshotRead;
 if(client&&token&&(!status?.lastNativeError||transient(status.lastNativeError))){
  const deadline=Date.now()+20000;for(let n=0;n<3;n++){recovery=await client.unknown('abort',token);attempts.push(recovery);if(recovery.ok||!transient(recovery.nativeDetail)||Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,150));}
  if(recovery.ok&&recovery.state==='aborted')closed=await closeVerified();
 }else recovery={ok:false,state:'blocked',reason:'nontransient-native-guard-not-retried'};
 }catch(x){recoveryError=x.stack;}send({phase:'error',error:primaryError,status,recovery,closed,recoveryError,attempts});}});
setInterval(()=>{},1000);
