'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict'),{fork}=require('child_process');const {build,verify}=require('./formal-unknown-copy-ci');const {ownedTempDirectory}=require('./unknown-grid-lease-copy-ci');const {createShellHelperClient}=require('../lib/shellhelper');const {planCalibration,searchBounds}=require('../lib/desktop-calibration');const {sameSnapshot}=require('../lib/safe-desktop');
const {assertCalibrationResult}=require('./unknown-grid-result-assert-ci');
const {retryableSnapshotRead}=require('./unknown-grid-recovery-policy-ci');
const config=require('./unknown-grid-run-config-ci').readConfig(process.env);
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),report={passed:false,cleanupVerified:false,scope:'CI-only N3 sparse success/duplicate/no-fit; single actual monitor, not mixed-DPI proof or transport reply loss',expectedScale:config.expectedScale,cases:config.cases,events:[]};const sleep=ms=>new Promise(r=>setTimeout(r,ms));const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function main(){const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-unknown-ci-')),copy=path.join(temp,'okiba-unknown-ci-copy');fs.mkdirSync(copy);report.productCopy=build(root,copy);let unsafe=false,baseline;const owned=[],children=[];
 const observer=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(copy,'scripts/shell-helper.ps1')],env:{...process.env,OKIBA_SNAP_LEASE:'1',OKIBA_UNKNOWN_GRID_CI:'1'},timeoutMs:15000});
 const request=async(cmd,data={})=>{const r=await observer.request(cmd,data,{timeoutMs:cmd==='leaseUnknownFixtureHideCleanup'?30000:15000});assert(r.ok,JSON.stringify(r));return r.result;};
 async function stable(phase){let previous;const deadline=Date.now()+15000;do{const s=await request('desktopSnapshot');if(s.ok){if(baseline){assert.equal(s.folderFlags,baseline.folderFlags);for(const old of baseline.icons){const i=s.icons.find(i=>i.identity===old.identity);assert(i&&i.x===old.x&&i.y===old.y,'old changed');}}if(previous&&sameSnapshot(previous,s)){note(phase,s);return s;}previous=s;}else{assert.equal(s.reason,'desktop-changing');previous=null;}await sleep(100);}while(Date.now()<deadline);throw Error('snapshot deadline');}
 const receive=(child,timeout=120000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',on);reject(Error('owner timeout'));},timeout);function on(m){clearTimeout(timer);child.off('message',on);resolve(m);}child.on('message',on);});
 const stop=async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([ended,sleep(5000)]);assert(child.exitCode!==null||child.signalCode!==null);};
 try{baseline=await stable('baseline');assert(baseline.snap&&!baseline.autoArrange);assert.equal(baseline.areas.length,1);assert.equal(baseline.areas[0].scale,config.expectedScale,'actual native monitor DPI must match requested test scale');report.actualScale=baseline.areas[0].scale;
 for(const scenario of config.cases){
  const commits=scenario!=='no-fit';
  const caseDir=path.join(temp,scenario);fs.mkdirSync(caseDir);const selected=[];for(const [index,cell] of [[0,0],[2,0],[1,2]].entries()){
   const name='OkibaUnknown-'+crypto.randomBytes(6).toString('hex')+'.txt',source=path.join(caseDir,name),dest=path.join(desktop,name);fs.writeFileSync(source,'owned sparse fixture '+index);const n=await request('readHiddenFile',{path:source});assert(n.ok);assert((await request('setHiddenFile',{path:source,expectedIdentity:n.identity,expectedHidden:false,hidden:true})).ok);assert((await request('moveNoReplace',{source,destination:dest})).ok);owned.push(dest);const attrs=await request('readHiddenFile',{path:dest});assert(attrs.ok&&attrs.hidden);selected.push({path:dest,destination:dest,hidden:true,fileIdentity:attrs.identity,cell,attrs,hash:hash(dest)});
  }
  const before=await stable('before-case');const bounds=searchBounds(before,0);assert(bounds.ok,JSON.stringify(bounds));const plan=planCalibration({snapshot:before,areaIndex:0,probeId:selected[0].path,maxSpacing:bounds.maxSpacing});assert(plan.ok,JSON.stringify(plan));
  const metadata=path.join(caseDir,'board.json');fs.writeFileSync(metadata,'{"unchanged":true}');const area=before.areas[0],requestedAnchor=scenario==='no-fit'?{x:area.right+1000,y:area.bottom+1000}:{x:plan.patch.left+before.sx,y:plan.patch.top+before.sy};
  const scope={version:2,kind:'samepath-hidden-unknown-grid',desktop,snapshot:before,targetAreaIndex:0,plan,items:selected.map(({path,destination,hidden,fileIdentity})=>({path,destination,hidden,fileIdentity})),metadataPaths:[metadata],success:{items:selected.map(({path,cell})=>({path,cell})),anchorPath:selected[0].path,requestedAnchor}};
  const journalDir=path.join(caseDir,'journal'),owner=fork(path.join(root,'tools/formal-unknown-success-host-ci.js'),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,OKIBA_UNKNOWN_GRID_CI:'1'}});children.push(owner);
  let recoveredCase=false;try{const pending=receive(owner);owner.send({cmd:'run',spec:{copy,scope,scenario,journalDir}});const response=await pending;note('result',{scenario,response});
   if(response.phase==='error'){
    report.primaryError=response.error;
    if(response.recovery?.ok&&response.recovery.state==='aborted'&&response.closed?.ok){
     await stop(owner);const journalFiles=fs.readdirSync(journalDir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n));assert.equal(journalFiles.length,1);const terminal=JSON.parse(fs.readFileSync(path.join(journalDir,journalFiles[0]),'utf8'));assert.equal(terminal.phase,'aborted');note('error-recovery-terminal',terminal);const recovered=await stable('error-recovered');assert.equal(recovered.icons.length,before.icons.length);
     for(const item of selected){const n=await request('readHiddenFile',{path:item.path});for(const k of ['identity','size','mtime','hidden','attributes'])assert.equal(n[k],item.attrs[k]);assert.equal(hash(item.path),item.hash);}
     assert.equal(fs.readFileSync(metadata,'utf8'),'{"unchanged":true}');recoveredCase=true;report.failureRecoveryVerified=true;
    }
    throw Error(response.error);
   }
   assert.equal(response.phase,'done',response.error);assert.equal(response.outcome,commits?'committed':'aborted');
   if(scenario==='duplicate-requests')assert.deepEqual(response.duplicateChecks,{samePermit:true,resolveCommitted:true,commitDoneCommitted:true});
   const after=await stable('after-case');assert.equal(after.icons.length,before.icons.length+(commits?3:0));
   if(commits){assertCalibrationResult({before,after,response,selected});assert.equal(fs.readFileSync(metadata,'utf8'),'{"committed":true}');for(const t of response.resolved.targets){const icon=after.icons.find(i=>i.path&&path.resolve(i.path).toLowerCase()===t.path.toLowerCase());assert(icon&&icon.x===t.x&&icon.y===t.y);}}
   else assert.equal(fs.readFileSync(metadata,'utf8'),'{"unchanged":true}');
   for(const item of selected){const n=await request('readHiddenFile',{path:item.path});for(const key of ['identity','size','mtime'])assert.equal(n[key],item.attrs[key]);assert.equal(n.hidden,!commits);assert.equal(n.attributes,commits?item.attrs.attributes&~2:item.attrs.attributes);assert.equal(hash(item.path),item.hash);}
   const closing=receive(owner,90000);owner.send({cmd:'close'});assert((await closing).result.ok);await stop(owner);
   // Owning watchdog/helper are confirmed stopped. Hide these exact owned files
   // with truthful ATTRIBUTES notification, then verify complete absence before unlink.
   if(commits){
    // Separate fixture cleanup process, only after owner/watchdog/helpers have stopped.
    const output=await require('util').promisify(require('child_process').execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'formal-unknown-cleanup-ci.ps1')],{windowsHide:true,timeout:30000,env:{...process.env,OKIBA_PREVIEW_TERMINAL:'confirmed',OKIBA_PREVIEW_RECORDS:JSON.stringify(selected.map(item=>({...item.attrs,path:item.path})))}});
    const hidden=JSON.parse(output.stdout);assert(hidden.ok);note('owned-cleanup-hide',hidden);
    const absent=await stable('cleanup-hidden');assert.deepEqual(absent.icons.map(i=>[i.identity,i.x,i.y]).sort(),baseline.icons.map(i=>[i.identity,i.x,i.y]).sort());
   }
   for(const item of selected){assert.equal(path.dirname(item.path),desktop);assert(path.basename(item.path).startsWith('OkibaUnknown-'));fs.unlinkSync(item.path);}
   const cleanup=await stable('case-cleanup');assert.deepEqual(cleanup.icons.map(i=>[i.identity,i.x,i.y]).sort(),baseline.icons.map(i=>[i.identity,i.x,i.y]).sort());
  }catch(e){if(!report.primaryError)report.primaryError=e.stack;if(!recoveredCase)unsafe=true;throw e;}
 }
 report.passed=true;
 }finally{for(const child of children){if(child.exitCode===null&&child.signalCode===null){try{await stop(child);}catch{unsafe=true;}}}if(!unsafe){for(const file of owned){assert.equal(path.dirname(file),desktop);assert(path.basename(file).startsWith('OkibaUnknown-'));if(fs.existsSync(file))fs.unlinkSync(file);}const end=await stable('cleanup');assert.deepEqual(end.icons.map(i=>[i.identity,i.x,i.y]).sort(),baseline.icons.map(i=>[i.identity,i.x,i.y]).sort());report.cleanupVerified=true;}if(!await observer.stopAndWait(10000))unsafe=true;
  report.finalProductCopy=verify(root,copy);const out=path.join(root,'formal-unknown-success-journals');fs.mkdirSync(out,{recursive:true});for(const scenario of config.cases){const source=path.join(temp,scenario,'journal');if(fs.existsSync(source))fs.cpSync(source,path.join(out,scenario),{recursive:true});}
  if(unsafe){report.passed=false;report.cleanupError='watchdog recovery unverified; no blind cleanup or flags restoration';}fs.writeFileSync(path.join(root,'formal-unknown-success-ci.json'),JSON.stringify(report,null,2));if(unsafe)throw Error(report.cleanupError);fs.rmSync(ownedTempDirectory(temp),{recursive:true,force:true});
 }
}
main().catch(e=>{report.passed=false;report.error=report.primaryError||e.stack;fs.writeFileSync(path.join(root,'formal-unknown-success-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
