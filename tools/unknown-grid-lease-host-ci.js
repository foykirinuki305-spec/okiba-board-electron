// Hosted-only owner process for the abort-only v2 slice.
'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.OKIBA_UNKNOWN_GRID_CI!=='1')throw Error('Hosted unknown CI only');
const path=require('path');let client;
const send=m=>{if(process.connected)process.send(m);};
process.on('message',async m=>{try{
 if(m.cmd==='close'){const r=await client.close();send({phase:'closed',result:r});if(r.ok)setTimeout(()=>process.exit(0),50);return;}
 if(m.cmd!=='run')return;const s=m.spec;
 const {createDesktopLeaseClient}=require(path.join(s.copy,'lib/desktop-lease-client'));
 client=createDesktopLeaseClient({journalDir:s.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(s.copy,'scripts/shell-helper.ps1')],env:{OKIBA_UNKNOWN_GRID_CI:'1',OKIBA_UNKNOWN_DROP_REPLY:s.scenario==='reply-loss'?'1':'0',OKIBA_UNKNOWN_HIDE_FAULT:s.scenario==='hide-reply-loss'?s.hideFaultMarker:''}},helperTimeoutMs:['reply-loss','hide-reply-loss'].includes(s.scenario)?4000:15000,timeoutMs:60000});
 const ready=await client.ready();if(!ready.ok)throw Error(JSON.stringify(ready));
 const scope=await client.prepareScope(s.scope);const p=await client.unknown('prepare',scope);if(!p.ok)throw Error(JSON.stringify(p));const token=p.token;
 const revealed=await client.unknown('revealProbe',token);if(!revealed.ok)throw Error(JSON.stringify(revealed));
 if(s.scenario==='owner-death-probe'){send({phase:'kill-owner',status:await client.status(),watchdog:client.diagnostics()});return;}
 if(s.scenario==='hide-reply-loss'){
  const interrupted=await client.unknown('abort',token);if(interrupted.ok)throw Error('hide fault did not interrupt');
  const aborted=await client.unknown('abort',token);send({phase:'done',aborted,status:await client.status(),hideLoss:interrupted});return;
 }
 const begun=await client.unknown('beginCalibration',token);
 if(s.scenario==='reply-loss'){
  if(begun.ok)throw Error('reply-loss injection did not fail');const aborted=await client.unknown('abort',token);send({phase:'done',aborted,status:await client.status(),replyLoss:begun});return;
 }
 if(!begun.ok)throw Error(JSON.stringify(begun));let previous=begun.probe;const samples=[];
 for(const q of s.scope.plan.requests.slice(0,3)){const r=await client.unknown('calibrationSample',token,{point:{x:q.x,y:q.y},previous:{x:previous.x,y:previous.y}});if(!r.ok)throw Error(JSON.stringify(r));previous=r.probe;samples.push(r);}
 if(s.scenario==='owner-death-sample'){send({phase:'kill-owner',samples,status:await client.status(),watchdog:client.diagnostics()});return;}
 const aborted=await client.unknown('abort',token);send({phase:'done',aborted,samples,status:await client.status()});
 }catch(e){send({phase:'error',error:String(e.stack||e),status:client?await client.status():null});}});
setInterval(()=>{},1000);
