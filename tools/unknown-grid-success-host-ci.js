'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.OKIBA_UNKNOWN_GRID_CI!=='1')throw Error('Hosted unknown success CI only');
const fs=require('fs'),path=require('path'),crypto=require('crypto');const {collectAdaptive}=require('./unknown-grid-adaptive-driver-ci');let client;
const send=m=>{if(process.connected)process.send(m);};const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
process.on('message',async m=>{try{
 if(m.cmd==='close'){const r=await client.close();send({phase:'closed',result:r});if(r.ok)setTimeout(()=>process.exit(0),50);return;}
 if(m.cmd!=='run')return;const s=m.spec,{createDesktopLeaseClient}=require(path.join(s.copy,'lib/desktop-lease-client'));
 client=createDesktopLeaseClient({journalDir:s.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(s.copy,'scripts/shell-helper.ps1')],env:{OKIBA_UNKNOWN_GRID_CI:'1',OKIBA_UNKNOWN_NODE_EXE:process.execPath}},helperTimeoutMs:15000,timeoutMs:60000});
 const checked=async(name,...args)=>{const r=await client.unknown(name,...args);if(!r?.ok)throw Error(JSON.stringify({name,result:r}));return r;};
 if(!(await client.ready()).ok)throw Error('client-init');const scope=await client.prepareScope(s.scope);const {token}=await checked('prepare',scope);await checked('revealProbe',token);const begun=await checked('beginCalibration',token);let previous=begun.probe;
 const r=begun.recovery,patch=r.plan.patch,proof={binding:r.success.binding,maxSpacing:r.plan.maxSpacing,patch,center:{x:Math.floor((patch.left+patch.right)/2),y:Math.floor((patch.top+patch.bottom)/2)}};
 const observed=await collectAdaptive(proof,async query=>{const v=await checked('calibrationSample',token,{...query,previous:{x:previous.x,y:previous.y}});previous=v.probe;return v;});
 const resolved=await client.unknown('resolveTargets',token);
 if(s.scenario==='no-fit'){if(resolved.ok)throw Error('no-fit unexpectedly accepted');const aborted=await checked('abort',token);send({phase:'done',outcome:'aborted',aborted,observed,resolved,status:await client.status()});return;}
 if(!resolved.ok)throw Error(JSON.stringify(resolved));await checked('revealResolvedAndPlace',token);await checked('restoreResolvedAndVerify',token);
 const file=scope.metadataPaths[0],before=fs.readFileSync(file),after=Buffer.from('{"committed":true}');const receipts=[{path:file,beforeHash:hash(before),afterHash:hash(after)}];
 const gate=await checked('prepareCommit',token,receipts);fs.writeFileSync(file,after);const committed=await checked('commitDone',token,gate.permit);
 send({phase:'done',outcome:'committed',committed,observed,resolved:resolved.resolved,status:await client.status()});
}catch(e){send({phase:'error',error:e.stack,status:client?await client.status():null});}});setInterval(()=>{},1000);
