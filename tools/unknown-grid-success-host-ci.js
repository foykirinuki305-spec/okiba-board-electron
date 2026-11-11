'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.OKIBA_UNKNOWN_GRID_CI!=='1')throw Error('Hosted unknown success CI only');
const fs=require('fs'),path=require('path'),crypto=require('crypto'),run=require('util').promisify(require('child_process').execFile);const {collectAdaptive}=require('./unknown-grid-adaptive-driver-ci');let client,token,gateRequested=false;
const send=m=>{if(process.connected)process.send(m);};const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
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
 if(m.cmd!=='run')return;const s=m.spec,{createDesktopLeaseClient}=require(path.join(s.copy,'lib/desktop-lease-client'));
 client=createDesktopLeaseClient({journalDir:s.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(s.copy,'scripts/shell-helper.ps1')],env:{OKIBA_UNKNOWN_GRID_CI:'1',OKIBA_UNKNOWN_NODE_EXE:process.execPath}},helperTimeoutMs:15000,timeoutMs:60000});
 const checked=async(name,...args)=>{const r=await client.unknown(name,...args);if(!r?.ok)throw Error(JSON.stringify({name,request:name==='calibrationSample'?args[1]:undefined,result:r}));return r;};
 if(!(await client.ready()).ok)throw Error('client-init');const scope=await client.prepareScope(s.scope);const prepared=await checked('prepare',scope);token=prepared.token;await checked('revealProbe',token);const begun=await checked('beginCalibration',token);let previous=begun.probe;
 const r=begun.recovery,patch=r.plan.patch,proof={binding:r.success.binding,maxSpacing:r.plan.maxSpacing,patch,center:{x:Math.floor((patch.left+patch.right)/2),y:Math.floor((patch.top+patch.bottom)/2)}};
 const observed=await collectAdaptive(proof,async query=>{const v=await checked('calibrationSample',token,{...query,previous:{x:previous.x,y:previous.y}});previous=v.probe;return v;});
 const resolved=await client.unknown('resolveTargets',token);
 if(s.scenario==='no-fit'){if(resolved.ok)throw Error('no-fit unexpectedly accepted');const aborted=await checked('abort',token);send({phase:'done',outcome:'aborted',aborted,observed,resolved,status:await client.status()});return;}
 if(!resolved.ok)throw Error(JSON.stringify(resolved));await checked('revealResolvedAndPlace',token);await checked('restoreResolvedAndVerify',token);
 const file=scope.metadataPaths[0],before=fs.readFileSync(file),after=Buffer.from('{"committed":true}');const receipts=[{path:file,beforeHash:hash(before),afterHash:hash(after)}];
 gateRequested=true;const gate=await checked('prepareCommit',token,receipts);fs.writeFileSync(file,after);const committed=await checked('commitDone',token,gate.permit);
 send({phase:'done',outcome:'committed',committed,observed,resolved:resolved.resolved,status:await client.status()});
}catch(e){const primaryError=e.stack;let status=null,recovery=null,closed=null,recoveryError=null;try{status=client?await client.status():null;if(client&&token){recovery=await client.unknown(gateRequested?'resolveCommit':'abort',token);if(recovery.ok&&['aborted','committed'].includes(recovery.state))closed=await closeVerified();}}catch(cleanupError){recoveryError=cleanupError.stack;}send({phase:'error',error:primaryError,status,recovery,closed,recoveryError});}});setInterval(()=>{},1000);
