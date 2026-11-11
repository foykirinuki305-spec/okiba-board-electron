'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.OKIBA_UNKNOWN_GRID_CI!=='1')throw Error('Hosted unknown success CI only');
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),run=require('util').promisify(require('child_process').execFile);let client,token,gateRequested=false;
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
 if(m.cmd!=='run')return;const s=m.spec,{createDesktopLeaseClient}=require(path.join(s.copy,'lib/desktop-lease-client'));const {collectAdaptive}=require(path.join(s.copy,'lib/desktop-unknown-adaptive-driver'));
 const clientSetupStarted=Date.now();client=createDesktopLeaseClient({allowUnknownGrid:true,journalDir:s.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(s.copy,'scripts/shell-helper.ps1')]},helperTimeoutMs:15000,timeoutMs:60000});
 const checked=async(name,...args)=>{const r=await client.unknown(name,...args);if(!r?.ok)throw Error(JSON.stringify({name,request:name==='calibrationSample'?args[1]:undefined,result:r}));return r;};
 if(!(await client.ready()).ok)throw Error('client-init');const clientSetupElapsedMs=Date.now()-clientSetupStarted,firstUnknownStarted=Date.now();const scope=await client.prepareScope(s.scope);const prepared=await checked('prepare',scope);token=prepared.token;await checked('revealProbe',token);const begun=await checked('beginCalibration',token);let previous=begun.probe;
 const r=begun.recovery,patch=r.plan.patch,proof={binding:r.success.binding,maxSpacing:r.plan.maxSpacing,patch,center:{x:Math.floor((patch.left+patch.right)/2),y:Math.floor((patch.top+patch.bottom)/2)}};
 const observed=await collectAdaptive(proof,async query=>{const v=await checked('calibrationSample',token,{...query,previous:{x:previous.x,y:previous.y}});previous=v.probe;return v;});
 const resolved=await client.unknown('resolveTargets',token);
 if(s.scenario==='no-fit'){if(resolved.ok)throw Error('no-fit unexpectedly accepted');const aborted=await checked('abort',token);send({phase:'done',outcome:'aborted',aborted,observed,resolved,status:await client.status()});return;}
 if(!resolved.ok)throw Error(JSON.stringify(resolved));await checked('revealResolvedAndPlace',token);await checked('restoreResolvedAndVerify',token);
 const file=scope.metadataPaths[0],before=fs.readFileSync(file),after=Buffer.from('{"committed":true}');const receipts=[{path:file,beforeHash:hash(before),afterHash:hash(after)}];
 gateRequested=true;const gate=await checked('prepareCommit',token,receipts);const duplicateChecks={};
 if(s.scenario==='duplicate-requests'){
  const duplicateGate=await checked('prepareCommit',token,receipts);assert.equal(duplicateGate.permit,gate.permit,'duplicate gate must return the original durable permit');assert.deepEqual(fs.readFileSync(file),before,'duplicate gate must not write metadata');duplicateChecks.samePermit=true;
 }
 fs.writeFileSync(file,after);const committed=await checked('commitDone',token,gate.permit);const firstUnknownElapsedMs=Date.now()-firstUnknownStarted;
 if(s.scenario==='duplicate-requests'){
  const duplicateResolve=await checked('resolveCommit',token);assert.equal(duplicateResolve.state,'committed');assert.deepEqual(fs.readFileSync(file),after);const duplicateDone=await checked('commitDone',token,gate.permit);assert.equal(duplicateDone.state,'committed');duplicateChecks.resolveCommitted=true;duplicateChecks.commitDoneCommitted=true;
 }
 const cacheStatus=await client.status();assert.equal(cacheStatus.calibrationCache?.ok,true,'first terminal must publish native session cache');
 const snapResult=await checked('sessionSnapshot');assert.equal(snapResult.sessionCalibrationCount,1);const fresh=snapResult.snapshot;assert(fresh?.ok&&fresh.areas[0].grid,'fresh same-helper session grid missing');
 const firstIcons=resolved.resolved.targets.map(t=>{const i=fresh.icons.find(i=>i.path&&i.path.toLowerCase()===t.path.toLowerCase());assert(i&&i.x===t.x&&i.y===t.y);return i;});
 const {planDesktop}=require(path.join(s.copy,'lib/safe-desktop')),{runLease}=require(path.join(s.copy,'lib/desktop-snap-lease-controller'));
 const items=s.secondItems.map(i=>({path:i.path,name:path.basename(i.path),offset:i.cell}));
 const beforeNoFit=await client.status();const noFit=planDesktop({snapshot:fresh,items,point:{x:fresh.areas[0].right+1000,y:fresh.areas[0].bottom+1000}});assert(!noFit.ok);const afterNoFit=await client.status();assert.equal(afterNoFit.helper.requests,beforeNoFit.helper.requests,'no-fit must make no helper request');
 const knownPlan=planDesktop({snapshot:fresh,items,automatic:true});assert(knownPlan.ok,JSON.stringify(knownPlan));
 const knownScope=await client.prepareScope({version:1,kind:'samepath-hidden',desktop:s.scope.desktop,snapshot:fresh,targetAreaIndex:0,targets:knownPlan.targets,items:s.secondItems.map(i=>({path:i.path,destination:i.path,hidden:true,fileIdentity:i.fileIdentity})),metadataPaths:[s.secondMetadata]});
 const before2=fs.readFileSync(s.secondMetadata),after2=Buffer.from('{"committed":true}');
 const beforeKnown=await client.status(),secondKnownStarted=Date.now();const known=await runLease({scope:knownScope,receipts:[{path:s.secondMetadata,beforeHash:hash(before2),afterHash:hash(after2)}],adapter:client.adapter(async()=>{assert.deepEqual(fs.readFileSync(s.secondMetadata),before2);fs.writeFileSync(s.secondMetadata,after2);})});
 const secondKnownElapsedMs=Date.now()-secondKnownStarted;assert(known.ok,JSON.stringify(known));const status=await client.status();
 assert.equal(status.helper.generation,cacheStatus.helper.generation);assert.deepEqual(status.helper.history,cacheStatus.helper.history,'same dedicated helper must be retained');
 const requestDelta=status.helper.requests-beforeKnown.helper.requests;assert(requestDelta>0&&requestDelta<=status.nativeTimings.length);const calibrationCallsAfter=status.nativeTimings.slice(-requestDelta).filter(x=>/leaseUnknown(CalibrationSample|BeginCalibration|Prepare)/.test(x.command)).length;assert.equal(calibrationCallsAfter,0,'known transaction must not recalibrate');
 const afterSnap=(await checked('sessionSnapshot')).snapshot;assert(afterSnap?.ok);
 for(const old of fresh.icons){const i=afterSnap.icons.find(i=>i.identity===old.identity);assert(i&&i.x===old.x&&i.y===old.y,'first group or baseline moved');}
 for(const t of knownPlan.targets){const i=afterSnap.icons.find(i=>i.path&&i.path.toLowerCase()===t.path.toLowerCase());assert(i&&i.x===t.x&&i.y===t.y);}
 const previousStop=await closeVerified();assert(previousStop.ok);
 client=createDesktopLeaseClient({allowUnknownGrid:true,journalDir:path.join(s.journalDir,'new-client'),helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(s.copy,'scripts/shell-helper.ps1')]},helperTimeoutMs:15000,timeoutMs:60000});
 assert((await client.ready()).ok);const restartedSnapshot=await checked('sessionSnapshot');assert.equal(restartedSnapshot.sessionCalibrationCount,0,'new helper must not inherit session calibration');
 for(const old of afterSnap.icons){const i=restartedSnapshot.snapshot.icons.find(i=>i.identity===old.identity);assert(i&&i.x===old.x&&i.y===old.y);}
 send({phase:'done',outcome:'committed',committed,duplicateChecks,observed,resolved:resolved.resolved,reuse:{clientSetupElapsedMs,firstUnknownElapsedMs,secondKnownElapsedMs,previousStop,newHelperCalibrationCount:restartedSnapshot.sessionCalibrationCount,cacheStatus,noFit,known,targets:knownPlan.targets,firstIcons,calibrationCallsAfter},status});
}catch(e){const primaryError=e.stack;let status=null,recovery=null,closed=null,recoveryError=null;try{status=client?await client.status():null;if(client&&token){recovery=await client.unknown(gateRequested?'resolveCommit':'abort',token);if(recovery.ok&&['aborted','committed'].includes(recovery.state))closed=await closeVerified();}}catch(cleanupError){recoveryError=cleanupError.stack;}send({phase:'error',error:primaryError,status,recovery,closed,recoveryError});}});setInterval(()=>{},1000);
