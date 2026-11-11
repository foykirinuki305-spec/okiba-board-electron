 'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted CI only');
const fs=require('fs'),path=require('path');const sourceRoot=path.resolve(process.argv[2]);
const {createDesktopLeaseClient}=require(path.join(sourceRoot,'lib/desktop-lease-client'));
const {runLease}=require(path.join(sourceRoot,'lib/desktop-snap-lease-controller'));
let client,chain=Promise.resolve();const send=m=>{if(process.connected)process.send(m);};
async function run(spec){
 if(!client){client=createDesktopLeaseClient({journalDir:spec.journalDir,helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',spec.helperPath]},helperTimeoutMs:15000,timeoutMs:120000});const ready=await client.ready();if(!ready.ok)throw Error(JSON.stringify(ready));}
 const started=performance.now();let scope={kind:'samepath-hidden',desktop:spec.desktop,items:spec.selected.map(i=>({path:i.path,destination:i.path,hidden:true})),snapshot:spec.baseline,targetAreaIndex:spec.targetAreaIndex,targets:spec.targets,metadataPaths:spec.receipts.map(r=>r.path)};
 scope=await client.prepareScope(scope);const prepareScopeMs=performance.now()-started;
 const adapter=client.adapter(async(permit,receipts)=>{for(const receipt of receipts){const saved=spec.receipts.find(r=>r.path===receipt.path),tmp=receipt.path+'.write';const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,saved.afterText);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,receipt.path);}});
 const begin=performance.now();const result=await runLease({scope,receipts:spec.receipts,adapter});const transactionMs=performance.now()-begin,wholeMs=performance.now()-started;
 const status=await client.status();const index=status.nativeTimings.map(t=>t.command).lastIndexOf('leaseReadFiles');if(index<0||!status.nativeTimings.slice(index).some(t=>t.command==='leasePrepare'))throw Error('Missing current scope/transaction timings');
 send({phase:'done',result,status,wholeMs,prepareScopeMs,transactionMs,nativeTimings:status.nativeTimings.slice(index)});
}
process.on('message',m=>{chain=chain.then(async()=>{if(m.cmd==='run')await run(m.spec);else if(m.cmd==='close'){const result=await client.close();send({phase:'closed',result});if(result.ok)process.exit(0);}}).catch(e=>send({phase:'error',error:String(e.stack||e)}));});setInterval(()=>{},1000);
