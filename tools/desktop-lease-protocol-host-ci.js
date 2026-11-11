'use strict';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted CI only');
const fs=require('fs'),path=require('path');
const {createDesktopLeaseClient}=require('../lib/desktop-lease-client');
const {runLease}=require('../lib/desktop-snap-lease-controller');
let client,chain=Promise.resolve();
const send=m=>{try{if(process.connected)process.send(m,()=>{});}catch{}};
async function ensureClient(spec){
 if(!client){client=createDesktopLeaseClient({journalDir:spec.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',spec.helperPath]},helperTimeoutMs:spec.commitCase==='helper-hang'?4000:15000,timeoutMs:120000});const r=await client.ready();if(!r.ok)throw Error(JSON.stringify(r));}
}
async function run(spec){
 await ensureClient(spec);
 let scope={kind:'samepath-hidden',desktop:spec.desktop,items:spec.selected.map(i=>({path:i.path,destination:i.path,hidden:true})),snapshot:spec.baseline,targetAreaIndex:spec.targetAreaIndex,targets:spec.targets,metadataPaths:spec.receipts.map(r=>r.path)};
 scope=await client.prepareScope(scope);
 const commit=async(permit,receipts)=>{for(const r of receipts){const saved=spec.receipts.find(x=>x.path===r.path),tmp=r.path+'.write';const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,saved.afterText);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,r.path);}};
 const adapter=client.adapter(commit);const started=Date.now();
 if(spec.commitCase==='success'||spec.commitCase==='helper-hang'){
  const result=await runLease({scope,receipts:spec.receipts,adapter});send({phase:'done',result,ms:Date.now()-started,status:await client.status(),watchdog:client.diagnostics()});return;
 }
 const p=await adapter.prepare(scope);if(!p.ok)throw Error(JSON.stringify(p));const token=p.token;
 let r=await adapter.revealAndPlace(token);if(!r.ok)throw Error(JSON.stringify(r));
 if(spec.commitCase==='kill-reveal'){send({phase:'revealed',token,watchdog:client.diagnostics()});return;}
 r=await adapter.restoreAndVerify(token);if(!r.ok)throw Error(JSON.stringify(r));const g=await adapter.prepareCommit(token,spec.receipts);if(!g.ok)throw Error(JSON.stringify(g));
 if(spec.commitCase==='disconnect-alive'){client.disconnect();send({phase:'disconnected-live',token,watchdog:client.diagnostics()});return;}
 await commit(g.permit,spec.receipts);send({phase:'written-no-ack',token,watchdog:client.diagnostics()});
}
process.on('message',m=>{chain=chain.then(async()=>{if(m.cmd==='run')await run(m.spec);if(m.cmd==='legacy'){await ensureClient(m.spec);send({phase:'legacy',result:await client.reserveLegacy({desktop:m.spec.desktop}),status:await client.status(),watchdog:client.diagnostics()});}if(m.cmd==='legacyRelease')send({phase:'legacy-release',result:await client.releaseLegacy(m.token,m.proof),status:await client.status()});if(m.cmd==='close'){const r=await client.close();send({phase:'closed',result:r});if(r.ok)process.exit(0);}}).catch(e=>send({phase:'error',error:String(e.stack||e)}));});
setInterval(()=>{},1000);
