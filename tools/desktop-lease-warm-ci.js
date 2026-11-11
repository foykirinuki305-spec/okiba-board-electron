'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only; real user Desktop forbidden');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {execFile,spawn,fork}=require('child_process'),{promisify}=require('util'),run=promisify(execFile);
const {createShellHelperClient}=require('../lib/shellhelper');
const {planDesktop,sameSnapshot}=require('../lib/safe-desktop');
const {createAttribRunner}=require('../lib/links');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),attrs=createAttribRunner();
const sourceRoot=path.resolve(process.argv[3]);assert(fs.existsSync(path.join(sourceRoot,'scripts/snap-lease.ps1')));
const report={sourceRoot,sourceRef:process.argv[4],samples:[],prePermitUnexpectedFailure:'Blocked journal only; automatic recovery not proven by this commit study',scope:'CI-only warm success performance comparison; exact source checkout unmodified; fault six-case suite retained separately; mixed DPI not proven',passed:false,events:[]};
const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const identityValid=s=>s.identityVersion===1&&s.icons.every(i=>typeof i.identity==='string'&&i.identity.length)&&new Set(s.icons.map(i=>i.identity)).size===s.icons.length;
const differences=(before,after)=>before.icons.filter(old=>!after.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y)).map(old=>({identity:old.identity,label:old.label,before:{x:old.x,y:old.y},after:after.icons.filter(i=>i.identity===old.identity).map(i=>({label:i.label,x:i.x,y:i.y}))}));
const matchesFile=(icon,name)=>typeof icon.path==='string'&&path.resolve(icon.path).toLowerCase()===path.join(desktop,name).toLowerCase();
async function main(){
 const actualRef=(await run('git',['-C',sourceRoot,'rev-parse','HEAD'])).stdout.trim();assert.equal(actualRef,report.sourceRef,'source checkout differs from pinned SHA');assert.equal((await run('git',['-C',sourceRoot,'status','--porcelain'])).stdout.trim(),'','source checkout dirty before benchmark');
 const tag='OkibaDense-'+crypto.randomBytes(5).toString('hex'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-dense-ci-'))),owned=[];
 const production=fs.readFileSync(path.join(root,'scripts/shell-helper.ps1'),'utf8');
 let helperSource=production;
 const batchStart=helperSource.indexOf(' public static void PositionNewItems('),batchEnd=helperSource.indexOf(' // Never exposed through the normal helper protocol.',batchStart);
 assert(batchStart>=0&&batchEnd>batchStart,'CI injection anchors missing');
 let batch=helperSource.slice(batchStart,batchEnd).replace('int[] newY) {','int[] newY,bool ciSnapOff=false) {');
 batch=batch.replace('  int count=', '  if(ciSnapOff && (Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true" || Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows" || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted"))throw new InvalidOperationException("CI-only snap-off research");\n  int count=');
 batch=batch.replaceAll('(flags&4)==0','(!ciSnapOff&&(flags&4)==0)');
 helperSource=helperSource.slice(0,batchStart)+batch+helperSource.slice(batchEnd);
 const ciCommand=String.raw`      'ciSnapFlags' {
        if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI-only'}
        $state=[OkibaFolderView]::ReadState();if(($state[0] -band 1) -ne 0 -or $state[1] -ne 0){throw 'auto-arrange-must-stay-off'}
        [OkibaFolderView]::SetFlagsForCI([uint32]4,[uint32]$req.flags)
        $state=[OkibaFolderView]::ReadState();$result=@{ok=(($state[0] -band 5) -eq [int]$req.flags -and $state[1] -eq 0);flags=$state[0]}
      }
      'ciSnapPosition' {
        if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI-only'}
        $a=@($req.items)
        [OkibaFolderView]::PositionNewItems([string[]]@($a|ForEach-Object{$_.identity}),[string[]]@($a|ForEach-Object{$_.path}),[int[]]@($a|ForEach-Object{$_.oldX}),[int[]]@($a|ForEach-Object{$_.oldY}),[int[]]@($a|ForEach-Object{$_.x}),[int[]]@($a|ForEach-Object{$_.y}),$true)
        $result=@{ok=$true}
      }
`;
 helperSource=helperSource.replace("      'resolveDrop'         {",ciCommand+"      'resolveDrop'         {");
 helperSource=helperSource.replace("@('resolveDrop','cursorState'","@('ciSnapFlags','ciSnapPosition','resolveDrop','cursorState'");
 // Research-only observability. Never relax a failing geometry/identity guard.
 const txStart=helperSource.indexOf('function Get-StrictTransactionState('),txEnd=helperSource.indexOf('\n# One transaction-local proof',txStart);
 assert(txStart>=0&&txEnd>txStart,'Diagnostic transaction anchor missing');
 let txSource=helperSource.slice(txStart,txEnd).replace("return @{ok=$false;reason='desktop-changed'}","return @{ok=$false;reason='desktop-changed';baseline=$baseline;current=$current;baselineGeometry=(Strict-GeometryKey $baseline);currentGeometry=$(if($current.ok){Strict-GeometryKey $current}else{$null})}");
 helperSource=helperSource.slice(0,txStart)+txSource+helperSource.slice(txEnd);
 const stableStart=helperSource.indexOf('function Get-StrictDesktopSnapshot {'),stableEnd=helperSource.indexOf('function Strict-PointValid',stableStart);
 assert(stableStart>=0&&stableEnd>stableStart,'Diagnostic snapshot anchor missing');
 let stableSource=helperSource.slice(stableStart,stableEnd).replace("return @{ok=$false;reason='desktop-changing'}","return @{ok=$false;reason='desktop-changing';first=$a;second=$b;firstGeometry=(Strict-GeometryKey $a);secondGeometry=(Strict-GeometryKey $b)}").replace("return @{ok=$false;reason='snapshot-error'}","return @{ok=$false;reason='snapshot-error';detail=$_.Exception.Message}");
 helperSource=helperSource.slice(0,stableStart)+stableSource+helperSource.slice(stableEnd);
 const researchHelper=path.join(temp,'ci-only-snap-off-helper.ps1');fs.writeFileSync(researchHelper,helperSource,'utf8');fs.copyFileSync(path.join(root,'scripts','snap-lease.ps1'),path.join(temp,'snap-lease.ps1'));
 const c=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',researchHelper],timeoutMs:100000});
 const children=[];let unsafe=false,original;
 async function req(cmd,args={}){const r=await c.request(cmd,args,{timeoutMs:100000});if(!r.ok){unsafe=!await c.stopAndWait(10000);throw Error('helper transport '+JSON.stringify(r));}return r.result;}
 const retrySince=new Map();
 async function observe(phase,guard){const s=await req('desktopSnapshot');if(!s.ok){note(phase+'-snapshot-not-ok',{snapshot:s});const known=s.reason==='desktop-changing'||(phase==='warm-rehide'&&s.reason==='shell-snapshot-error'&&/0x80070490/i.test(s.detail||''))||(phase==='warm-cleanup'&&owned.every(f=>!fs.existsSync(f))&&s.reason==='shell-snapshot-error'&&/ReadShellBatch/.test(s.detail||'')&&/E_FAIL|0x80004005|0x80070490/i.test(s.detail||''));assert(known,'fatal snapshot '+JSON.stringify(s));if(!retrySince.has(phase))retrySince.set(phase,Date.now());assert(Date.now()-retrySince.get(phase)<10000,'transient exceeds 10s');}else retrySince.delete(phase);if(s.ok)assert(identityValid(s),'Missing or duplicate Shell identity during '+phase);if(s.ok&&guard){const diff=differences(guard,s);if(diff.length){note(phase,{before:guard,after:s,differences:diff});throw Error('EXISTING ICON SHIFT during '+phase);}}return s;}
 async function stable(phase,guard){let previous;for(let n=0;n<80;n++){const s=await observe(phase,guard);if(s.ok&&previous&&sameSnapshot(previous,s))return s;previous=s.ok?s:null;await sleep(100);}throw Error('unstable '+phase);}
 async function visible(names,want,phase,guard){for(let n=0;n<100;n++){const s=await observe(phase,guard);if(s.ok&&names.every(name=>s.icons.some(i=>matchesFile(i,name))===want))return stable(phase,guard);await sleep(50);}throw Error('visibility timeout '+phase);}
 async function move(from,to){assert(fs.existsSync(from),'Fixture source missing before move: '+from);const r=await req('moveNoReplace',{source:from,destination:to});assert(r.ok,JSON.stringify({result:r,source:from,destination:to,sourceExists:fs.existsSync(from),destinationExists:fs.existsSync(to)}));}
 async function position(before,items,plan,phase){note(phase+'-input',{baseline:before,items,plan});const r=await req('positionDesktopPlan',{snapshot:before,targets:plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest})),buffer:plan.buffer});note(phase+'-result',{result:r});assert(r.ok,phase+' '+JSON.stringify(r));const s=await stable(phase,before);for(const t of plan.targets){const i=s.icons.find(i=>matchesFile(i,t.name));assert(i&&Math.abs(i.x-t.x)<=1&&Math.abs(i.y-t.y)<=1,phase+' target not exact');}return s;}
 try{
  original=await stable('initial');assert(original.ok&&!original.autoArrange&&original.snap);
  const dense=Array.from({length:42},(_,i)=>{const name=tag+'-'+String(i).padStart(2,'0')+(i%7===0?'-\u65e5\u672c\u8a9e':'')+'.lnk';return {name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[Math.floor(i/6),i%6]};});
  note('shortcut-fixture-start',{temp,tempExists:fs.existsSync(temp),tempBase:os.tmpdir(),firstSource:dense[0].path});
  const asciiPaths=dense.map((_,i)=>path.join(temp,'fixture-'+i+'.lnk'));
  const ps="$ErrorActionPreference='Stop';$w=New-Object -ComObject WScript.Shell;foreach($p in (ConvertFrom-Json $env:OKIBA_CI_LINK_PATHS)){$s=$w.CreateShortcut($p);$s.TargetPath=Join-Path $env:WINDIR 'System32\\notepad.exe';$s.Save()}";
  const created=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:30000,env:{...process.env,OKIBA_CI_LINK_PATHS:JSON.stringify(asciiPaths)}});
  for(let i=0;i<dense.length;i++){assert(fs.existsSync(asciiPaths[i]),'ASCII shortcut missing: '+asciiPaths[i]);const bytes=fs.readFileSync(asciiPaths[i]);assert(bytes.length>76&&bytes.readUInt32LE(0)===76,'Invalid shortcut header');assert.equal(bytes.subarray(4,20).toString('hex'),'0114020000000000c000000000000046','Invalid Shell Link CLSID');fs.renameSync(asciiPaths[i],dense[i].path);assert(fs.readFileSync(dense[i].path).equals(bytes),'Renaming changed shortcut contents');}
  const missing=dense.filter(i=>!fs.existsSync(i.path));note('shortcut-fixture-created',{expected:dense.length,files:fs.readdirSync(temp),stderr:created.stderr,missing:missing.map(i=>i.path)});assert.equal(missing.length,0,'Shortcut creation incomplete; no Desktop mutation attempted');
  const densePlan=planDesktop({snapshot:original,items:dense,automatic:true});assert(densePlan.ok,'Runner cannot fit required dense 42-shortcut fixture: '+JSON.stringify(densePlan));
  for(const i of dense){owned.push(i.dest);await move(i.path,i.dest);}
  const seeded=await position(original,dense,densePlan,'dense-seed');note('dense-seeded',{created:42,originalCount:original.icons.length,total:seeded.icons.length});
  const selected=[6,7,8,12,13,14].map(n=>({...dense[n]}));
  selected.forEach((i,n)=>i.offset=[Math.floor(n/3),n%3]);
  const hashes=new Map(selected.map(i=>[i.dest,crypto.createHash('sha256').update(fs.readFileSync(i.dest)).digest('hex')]));
  const remaining={...seeded,icons:seeded.icons.filter(i=>!selected.some(t=>matchesFile(i,t.name)))};
  for(const i of selected)assert((await attrs.setHidden(i.dest,true)).ok);
  await visible(selected.map(i=>i.name),false,'hide-initial',remaining);
  // Occupy three previous cached cells; do not move any old icon to create space.
  for(const victim of selected.slice(0,3)){
   const before=await stable('guard-before',remaining),old=densePlan.targets.find(t=>t.name===victim.name),name=victim.name+'.guard.txt';
   const item={name,path:path.join(temp,name),dest:path.join(desktop,name),offset:[0,0]};fs.writeFileSync(item.path,'old-cell guard');owned.push(item.dest);
   const area=before.areas.find(a=>old.x>=a.left&&old.x<a.right&&old.y>=a.top&&old.y<a.bottom),g=area.grid;
   const p=planDesktop({snapshot:before,items:[item],point:{x:old.x+g.sx/2,y:old.y+g.sy/2}});assert(p.ok);assert.equal(p.targets[0].x,old.x);assert.equal(p.targets[0].y,old.y);
   await move(item.path,item.dest);await position(before,[item],p,'guard-position');
  }


  const journalDir=path.join(temp,'warm-journal');let owner=null;
  async function message(child,timeout=120000){return new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.off('message',f);reject(Error('owner timeout'));},timeout);function f(m){clearTimeout(t);child.off('message',f);if(m.phase==='error')reject(Error(m.error));else resolve(m);}child.on('message',f);});}
  async function send(cmd,spec){const p=message(owner);owner.send({cmd,spec});return p;}
  async function metadata(file){const m=await req('readHiddenFile',{path:file});assert(m.ok,JSON.stringify(m));return m;}
  const fileProof=new Map();for(const file of owned)fileProof.set(file,{...await metadata(file),hash:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  try{
   owner=fork(path.join(root,'tools/desktop-lease-warm-host-ci.js'),[sourceRoot],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push({child:owner,kind:'warm-owner'});
   for(let round=0;round<6;round++)for(const count of [3,6]){
    const items=selected.slice(0,count),name='n'+count+'-r'+round,caseDir=path.join(temp,name);fs.mkdirSync(caseDir);
    const before=await stable('warm-before',remaining);assert.equal(before.icons.length,remaining.icons.length+3);
    const plan=planDesktop({snapshot:before,items,automatic:true});assert(plan.ok);
    const targets=plan.targets.map(t=>({...t,path:items.find(i=>i.name===t.name).dest}));
    const targetAreaIndex=before.areas.findIndex(a=>targets.every(t=>t.x>=a.left&&t.x<a.right&&t.y>=a.top&&t.y<a.bottom));assert(targetAreaIndex>=0);
    const p=path.join(caseDir,'board.json'),beforeText=JSON.stringify({links:items.map(i=>i.name)}),afterText=JSON.stringify({links:[]});fs.writeFileSync(p,beforeText);
    const receipts=[{path:p,beforeHash:crypto.createHash('sha256').update(beforeText).digest('hex'),afterHash:crypto.createHash('sha256').update(afterText).digest('hex'),afterText}];
    const spec={desktop,caseDir,journalDir,helperPath:path.join(sourceRoot,'scripts/shell-helper.ps1'),baseline:before,selected:items.map(i=>({path:i.dest})),targets,targetAreaIndex,receipts};
    const started=performance.now();const answer=await send('run',spec);const ownerRoundTripMs=performance.now()-started;note('warm-result',{count,round,...answer});assert(answer.result.ok,JSON.stringify(answer));assert.equal(answer.status.helper.spawns,1,'warm helper restarted');assert.equal(answer.status.helper.cumulativeRestartCount,0);assert.equal(answer.status.phase,'released');
    const verifyStart=performance.now();const final=await stable('warm-final',before);assert.equal(final.icons.length,before.icons.length+count);assert.equal(final.folderFlags,before.folderFlags);assert(final.snap&&!final.autoArrange);
    for(const t of targets){const actual=final.icons.find(i=>matchesFile(i,t.name));assert(actual&&actual.x===t.x&&actual.y===t.y,'exact target mismatch');}
    for(const [file,originalFile] of fileProof){const now=await metadata(file);for(const key of ['identity','size','mtime','directory'])assert.equal(now[key],originalFile[key],key+' changed');assert.equal(now.attributes&~130,originalFile.attributes&~130,'other attribute bits changed');assert.equal(now.hidden,selected.some(i=>i.dest===file)&&!items.some(i=>i.dest===file));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),originalFile.hash,'fixture bytes changed');}
    assert.equal(fs.readFileSync(p,'utf8'),afterText,'metadata receipt mismatch');
    const verificationMs=performance.now()-verifyStart;note('warm-verified',{count,round,before,after:final,allOwnedMetadataAndBytesUnchanged:true,receipt:receipts[0],flagsUnchanged:true});
    const timing=answer.nativeTimings;const sum=metric=>timing.reduce((v,t)=>v+(t.perf?.metrics?.[metric]?.ms||0),0);
    report.samples.push({count,round,warmup:round===0,ownerRoundTripMs,wholeMs:answer.wholeMs,prepareScopeMs:answer.prepareScopeMs,transactionMs:answer.transactionMs,verificationMs,arrivalMs:sum('arrival'),snapshotMs:sum('snapshot'),nativePositionMs:sum('nativePosition'),nativeTimings:timing,inclusiveMetrics:true});
    for(const i of items)assert((await attrs.setHidden(i.dest,true)).ok);await visible(items.map(i=>i.name),false,'warm-rehide',before);
   }
   const closed=await send('close');assert(closed.result.ok,'warm owner close failed');await Promise.race([new Promise(r=>owner.once('exit',r)),sleep(5000)]);assert(owner.exitCode!==null||owner.signalCode!==null,'owner exit unconfirmed');
  }catch(e){
   if(owner?.connected){try{const closed=await send('close');if(!closed.result?.ok)unsafe=true;}catch{unsafe=true;}}else unsafe=true;
   throw e;
  }
  const percentile=(values,p)=>{const a=values.slice().sort((a,b)=>a-b);return p===0.5?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:a[Math.ceil(p*a.length)-1];};
  report.summary=[3,6].map(count=>{const rows=report.samples.filter(s=>s.count===count&&!s.warmup);const metrics={};for(const key of ['wholeMs','prepareScopeMs','transactionMs','arrivalMs','snapshotMs','nativePositionMs','verificationMs'])metrics[key]={median:percentile(rows.map(s=>s[key]),.5),p90:percentile(rows.map(s=>s[key]),.9)};return {count,n:rows.length,metrics};});
  note('warm-summary',{sourceRef:report.sourceRef,summary:report.summary});assert.equal((await run('git',['-C',sourceRoot,'status','--porcelain'])).stdout.trim(),'','benchmark modified source checkout');report.passed=true;
 }finally{
  for(const entry of children){if(entry.child.exitCode===null&&entry.child.signalCode===null){entry.child.kill();await Promise.race([new Promise(r=>entry.child.once('exit',r)),sleep(5000)]);if(entry.child.exitCode===null&&entry.child.signalCode===null)unsafe=true;}}
  if(!unsafe){for(const f of owned){assert.equal(path.dirname(f),desktop);assert(path.basename(f).startsWith(tag));if(fs.existsSync(f))fs.unlinkSync(f);}}
  if(original&&!unsafe){let cleaned=false;for(let n=0;n<100;n++){const state=await observe('warm-cleanup',original);if(state.ok&&state.icons.length===original.icons.length){assert.equal(state.folderFlags,original.folderFlags);cleaned=true;break;}await sleep(100);}assert(cleaned,'fixture cleanup failed');report.cleanupVerified=true;}
  if(!await c.stopAndWait(10000))unsafe=true;
  const evidence=path.join(root,'desktop-lease-warm-journals');fs.mkdirSync(evidence,{recursive:true});const journalSource=path.join(temp,'warm-journal');if(fs.existsSync(journalSource))fs.cpSync(journalSource,evidence,{recursive:true});
  if(unsafe){report.passed=false;report.cleanupBlocked='owned processes not confirmed stopped';}
  fs.writeFileSync(path.join(root,'desktop-lease-warm-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupBlocked);
  const resolved=path.resolve(temp);assert(resolved.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('okiba-dense-ci-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'desktop-lease-warm-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
