'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only; real user Desktop forbidden');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {execFile}=require('child_process'),{promisify}=require('util'),run=promisify(execFile);
const {createShellHelperClient}=require('../lib/shellhelper');
const {planDesktop,sameSnapshot}=require('../lib/safe-desktop');
const {createAttribRunner}=require('../lib/links');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),attrs=createAttribRunner();
const mode=process.argv[3]||'none';assert(['none','attributes','updateitem','attributes-then-updateitem'].includes(mode));
const poll=process.argv[4]||'strict';assert(['strict','inventory'].includes(poll));
const report={mode,poll,scope:'RESEARCH ONLY: temporary snap OFF on GitHub-hosted single-monitor Windows, AUTOARRANGE always OFF; no production change, NOT mixed-DPI proof',passed:false,events:[]};
const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const identityValid=s=>s.identityVersion===1&&s.icons.every(i=>typeof i.identity==='string'&&i.identity.length)&&new Set(s.icons.map(i=>i.identity)).size===s.icons.length;
const differences=(before,after)=>before.icons.filter(old=>!after.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y)).map(old=>({identity:old.identity,label:old.label,before:{x:old.x,y:old.y},after:after.icons.filter(i=>i.identity===old.identity).map(i=>({label:i.label,x:i.x,y:i.y}))}));
const matchesFile=(icon,name)=>typeof icon.path==='string'&&path.resolve(icon.path).toLowerCase()===path.join(desktop,name).toLowerCase();
async function main(){
 const tag='OkibaDense-'+crypto.randomBytes(5).toString('hex'),temp=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'okiba-dense-ci-'))),owned=[];
 const production=fs.readFileSync(path.join(root,'scripts/shell-helper.ps1'),'utf8');
 let helperSource=production;
 // CI-only extension of the handle-bound mutation; identical path for all modes.
 const coreSignature='static Snapshot SetRecordedCore(string path,string expectedIdentity,bool expectedHidden,bool hidden,string expectedSize,string expectedMtime,uint expectedOtherAttributes,bool notify){';
 assert(helperSource.includes(coreSignature),'Native identity-bound mutation anchor missing');
 helperSource=helperSource.replace(coreSignature,`public static Snapshot SetRecordedNotifyForCI(string path,Snapshot expected,uint events) {
  if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")throw new InvalidOperationException("CI only");
  string full=Path.GetFullPath(path),desktop=Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
  if(!String.Equals(Path.GetDirectoryName(full),desktop,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(full).StartsWith("OkibaDense-",StringComparison.Ordinal)||events>3||!expected.hidden)throw new InvalidOperationException("Invalid CI fixture mutation");
  return SetRecordedCore(full,expected.identity,true,false,expected.size,expected.mtime,expected.attributes,false,events);
 }
 static Snapshot SetRecordedCore(string path,string expectedIdentity,bool expectedHidden,bool hidden,string expectedSize,string expectedMtime,uint expectedOtherAttributes,bool notify,uint ciEvents=0){`);
 const notifyAnchor='if(notify&&before.hidden!=after.hidden)NotifyAttributes(0x800u,0x1005u,path,IntPtr.Zero);';
 assert(helperSource.includes(notifyAnchor),'Native notify anchor missing');
 helperSource=helperSource.replace(notifyAnchor,notifyAnchor+`
   if(before.hidden!=after.hidden){
    if((ciEvents&1)!=0)NotifyAttributes(0x800u,0x1005u,path,IntPtr.Zero);
    if((ciEvents&2)!=0)NotifyAttributes(0x2000u,0x1005u,path,IntPtr.Zero);
   }
   var checkedAfter=Capture(h);
   if(checkedAfter.identity!=after.identity||checkedAfter.attributes!=after.attributes||checkedAfter.size!=after.size||checkedAfter.mtime!=after.mtime)throw new InvalidOperationException("CI notification changed file identity or metadata");`);
 const attrsInjection=fs.readFileSync(path.join(__dirname,'hidden-attributes-injection-ci.cs'),'utf8');
 const attrsAnchor=' public static long[] ReadState()';assert(helperSource.includes(attrsAnchor),'Attribute injection anchor missing');helperSource=helperSource.replace(attrsAnchor,attrsInjection+'\n'+attrsAnchor);
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
 helperSource=helperSource.replace("      'resolveDrop'         {","      'ciUnhideAttributes' {\n        if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'}\n        $before=[OkibaFolderView]::ReadState();if(($before[0] -band 5) -ne 0 -or $before[1] -ne 0){throw 'snap and autoarrange must remain OFF'}\n        $w=[Diagnostics.Stopwatch]::StartNew();$changed=@();foreach($p in @($req.paths)){$prior=[OkibaFileAttributes]::Read([string]$p);$next=[OkibaFileAttributes]::SetRecordedNotifyForCI([string]$p,$prior,[uint32]$req.events);$changed+=@{path=$p;before=$prior;after=$next}};$w.Stop();$after=[OkibaFolderView]::ReadState();if(($before|ConvertTo-Json -Compress) -cne ($after|ConvertTo-Json -Compress)){throw 'attribute operation changed Shell flags'}\n        $result=@{ok=$true;nativeMs=$w.Elapsed.TotalMilliseconds;changes=$changed;flagsBefore=$before;flagsAfter=$after}\n      }\n"+ciCommand+"      'resolveDrop'         {");
 helperSource=helperSource.replace("@('resolveDrop','cursorState'","@('ciUnhideAttributes','ciSnapFlags','ciSnapPosition','resolveDrop','cursorState'");
 // Research-only observability. Never relax a failing geometry/identity guard.
 const txStart=helperSource.indexOf('function Get-StrictTransactionState('),txEnd=helperSource.indexOf('\n# One transaction-local proof',txStart);
 assert(txStart>=0&&txEnd>txStart,'Diagnostic transaction anchor missing');
 let txSource=helperSource.slice(txStart,txEnd).replace("return @{ok=$false;reason='desktop-changed'}","return @{ok=$false;reason='desktop-changed';baseline=$baseline;current=$current;baselineGeometry=(Strict-GeometryKey $baseline);currentGeometry=$(if($current.ok){Strict-GeometryKey $current}else{$null})}");
 txSource=txSource.replace("snapshotDetail=$current.detail}","snapshotDetail=$current.detail;baseline=$baseline;current=$current;baselineGeometry=(Strict-GeometryKey $baseline)}").replace("detailKind='physical-geometry-changed'}","detailKind='physical-geometry-changed';baseline=$baseline;current=$current;baselineGeometry=(Strict-GeometryKey $baseline);currentGeometry=(Strict-GeometryKey $current)}");
 helperSource=helperSource.slice(0,txStart)+txSource+helperSource.slice(txEnd);
 const stableStart=helperSource.includes('function Get-StrictDesktopSnapshotCore {')?helperSource.indexOf('function Get-StrictDesktopSnapshotCore {'):helperSource.indexOf('function Get-StrictDesktopSnapshot {'),stableEnd=helperSource.indexOf('function Strict-PointValid',stableStart);
 assert(stableStart>=0&&stableEnd>stableStart,'Diagnostic snapshot anchor missing');
 let stableSource=helperSource.slice(stableStart,stableEnd).replace("return @{ok=$false;reason='desktop-changing'}","return @{ok=$false;reason='desktop-changing';first=$a;second=$b;firstGeometry=(Strict-GeometryKey $a);secondGeometry=(Strict-GeometryKey $b)}").replace("return @{ok=$false;reason='snapshot-error'}","return @{ok=$false;reason='snapshot-error';detail=$_.Exception.Message}");
 helperSource=helperSource.slice(0,stableStart)+stableSource+helperSource.slice(stableEnd);
 // Research-only read path; inventory is a readiness hint, NEVER permission to position.
 helperSource=helperSource.replace("      'desktopSnapshot'     { $result = Get-StrictDesktopSnapshot }",String.raw`      'desktopSnapshot' {
        $priorPerf=$script:DesktopPerf;$script:DesktopPerf=@{metrics=@{}}
        try{$result=Get-StrictDesktopSnapshot;$result.researchPerf=@{inclusive=$true;metrics=$script:DesktopPerf.metrics}}finally{$script:DesktopPerf=$priorPerf}
      }
      'ciInventory' {
        if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'}
        $w=[Diagnostics.Stopwatch]::StartNew()
        try{$rows=@([OkibaFolderView]::ReadShellBatch('ci-arrival-inventory'));$result=@{ok=$true;icons=@($rows|ForEach-Object{@{identity=$_.identity;path=$_.path;x=$_.x;y=$_.y}})}}catch{$result=Get-ShellSnapshotFailure $_.Exception}
        $w.Stop();$result.nativeMs=$w.Elapsed.TotalMilliseconds
      }`);
 helperSource=helperSource.replace("@('ciUnhideAttributes'","@('ciInventory','ciUnhideAttributes'");
 const researchHelper=path.join(temp,'ci-only-snap-off-helper.ps1');fs.writeFileSync(researchHelper,helperSource,'utf8');
 const c=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',researchHelper],timeoutMs:100000});
 let unsafe=false,original,ownedDeletionVerified=false;
 async function req(cmd,args={}){const r=await c.request(cmd,args,{timeoutMs:100000});if(!r.ok){unsafe=!await c.stopAndWait(10000);throw Error('helper transport '+JSON.stringify(r));}return r.result;}
 const transientSince=new Map();
 async function observe(phase,guard){const readStart=performance.now();const s=await req('desktopSnapshot');const readMs=performance.now()-readStart;const guardStart=performance.now();if(!s.ok){note(phase+'-snapshot-not-ok',{snapshot:s});const removable=(phase.startsWith('rehide-')||phase==='cleanup')&&s.reason==='shell-snapshot-error'&&/0x80070490/i.test(s.detail||'');const cleanupEFail=phase==='cleanup'&&ownedDeletionVerified&&s.reason==='shell-snapshot-error'&&/ReadShellBatch/.test(s.detail||'')&&/\bE_FAIL\b|0x80004005/i.test(s.detail||'');if(cleanupEFail)note('cleanup-read-transient',{phase,reason:s.reason,detail:s.detail,ownedDeletionVerified,maxRetryMs:10000});if(s.reason!=='desktop-changing'&&!removable&&!cleanupEFail)throw Error('fatal snapshot '+JSON.stringify(s));const since=transientSince.get(phase)||Date.now();transientSince.set(phase,since);if(Date.now()-since>10000)throw Error('transient snapshot exceeded 10s '+JSON.stringify(s));}if(s.ok)transientSince.delete(phase);if(s.ok)assert(identityValid(s),'Missing or duplicate Shell identity during '+phase);if(s.ok&&guard){const diff=differences(guard,s);if(diff.length){note(phase,{before:guard,after:s,differences:diff});throw Error('EXISTING ICON SHIFT during '+phase);}}note('snapshot-cost',{phase,ok:s.ok,readMs,guardMs:performance.now()-guardStart,perf:s.researchPerf});return s;}
 async function stable(phase,guard){let previous;for(let n=0;n<80;n++){const s=await observe(phase,guard);if(s.ok&&previous&&sameSnapshot(previous,s))return s;previous=s.ok?s:null;await sleep(100);}throw Error('unstable '+phase);}
 async function visible(names,want,phase,guard){for(let n=0;n<100;n++){const s=await observe(phase,guard);if(s.ok&&names.every(name=>s.icons.some(i=>matchesFile(i,name))===want))return stable(phase,guard);await sleep(50);}throw Error('visibility timeout '+phase);}
 async function arrivalMeasured(names,phase,guard){
  const started=performance.now();let reads=0,readMs=0,sleepMs=0,firstVisibleMs=null;
  for(let n=0;n<100;n++){
   const begin=performance.now();const state=poll==='inventory'?await req('ciInventory'):await observe(phase,guard);const elapsed=performance.now()-begin;reads++;readMs+=elapsed;
   note('arrival-poll',{phase,poll,n,ok:state.ok,readMs:elapsed,nativeMs:state.nativeMs,reason:state.reason});
   if(!state.ok&&state.reason!=='desktop-changing')throw Error('fatal inventory '+JSON.stringify(state));
   if(state.ok){assert(identityValid({...state,identityVersion:1}),'inventory identity invalid');if(names.every(name=>state.icons.some(i=>matchesFile(i,name)))){firstVisibleMs=performance.now()-started;break;}}
   const pause=performance.now();await sleep(50);sleepMs+=performance.now()-pause;
  }
  assert.notEqual(firstVisibleMs,null,'arrival inventory timeout');
  // Both arms use identical full strict verification after the readiness result.
  const verifyStart=performance.now();const verified=await stable(phase+'-full-verification',guard);
  assert(names.every(name=>verified.icons.some(i=>matchesFile(i,name))),'items disappeared before verification');
  assert.equal(verified.folderFlags,guard.folderFlags&~4,'flags changed during arrival');
  const geometry=s=>JSON.stringify([s.explorerPid,s.explorerStarted,s.listviewHwnd,s.autoArrange,s.shellAutoArrange,s.origin.x,s.origin.y,s.sx,s.sy,s.viewDpi,s.areas&&s.areas.map(a=>[a.left,a.top,a.right,a.bottom,a.scale,a.monitorOrigin.x,a.monitorOrigin.y])]);
  assert.equal(geometry(verified),geometry(guard),'geometry changed during arrival');
  note('arrival-breakdown',{phase,poll,firstVisibleMs,reads,readMs,sleepMs,fullStrictVerificationMs:performance.now()-verifyStart,totalMs:performance.now()-started});
  return verified;
 }
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
  for(let cycle=0;cycle<3;cycle++){
   const before=await stable('cycle-before',remaining);note('before-unhide',{cycle,snapshot:before});
   const p=planDesktop({snapshot:before,items:selected,automatic:true});assert(p.ok,'No space for selected relative shape');
   let after;
   try {
    const off=await req('ciSnapFlags',{flags:0});assert(off.ok,'Could not switch snap OFF without enabling auto arrange');
    const offSnapshot=await stable('snap-off-'+cycle,before);assert(!offSnapshot.snap&&!offSnapshot.autoArrange);
    const arrivalStart=performance.now();const nativeStart=performance.now();
    const native=await req('ciUnhideAttributes',{paths:selected.map(i=>i.dest),events:({none:0,attributes:1,updateitem:2,'attributes-then-updateitem':3})[mode]});assert(native.ok,'native unhide/notification failed');
    const nativeRoundTripMs=performance.now()-nativeStart;
    const arrival=await arrivalMeasured(selected.map(i=>i.name),'snap-off-arrival-'+cycle,before);
    note('snap-off-arrival',{cycle,mode,unhideToArrivalMs:performance.now()-arrivalStart,nativeRoundTripMs,native,snapshot:arrival,differences:differences(before,arrival)});
    const batch=p.targets.map(t=>{const icon=arrival.icons.find(i=>matchesFile(i,t.name));assert(icon);return {identity:icon.identity,path:selected.find(i=>i.name===t.name).dest,oldX:icon.x,oldY:icon.y,x:t.x,y:t.y};});
    const placed=await req('ciSnapPosition',{items:batch});assert(placed.ok);
    after=await stable('snap-off-position-'+cycle,before);
    for(const t of p.targets){const i=after.icons.find(i=>matchesFile(i,t.name));assert(i&&i.x===t.x&&i.y===t.y,'snap OFF exact target failed');}
   }finally{
    const on=await req('ciSnapFlags',{flags:4});assert(on.ok,'snap ON restore failed');
   }
   after=await stable('snap-on-restored-'+cycle,before);assert(after.snap&&!after.autoArrange);assert.equal(after.folderFlags,before.folderFlags,'final snap ON restore changed other Shell flags');
   for(const t of p.targets){const i=after.icons.find(i=>matchesFile(i,t.name));assert(i&&i.x===t.x&&i.y===t.y,'snap ON changed target');}
   note('after-snap-on',{cycle,snapshot:after,differences:differences(before,after)});
   for(const item of selected){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.dest)).digest('hex'),hashes.get(item.dest));assert((await attrs.setHidden(item.dest,true)).ok);}
   const hidden=await visible(selected.map(i=>i.name),false,'rehide-'+cycle,before);assert.equal(hidden.icons.length,before.icons.length);
  }
  report.passed=true;note('RESEARCH_PASS_NOT_MIXED_DPI_PROOF',{denseShortcuts:42,hiddenPerCycle:6,oldCellGuards:3,cycles:3,oldIconsUnchanged:true});
 }finally{
  if(!await c.stopAndWait(10000))unsafe=true;
  if(!unsafe){for(const f of owned){assert.equal(path.dirname(f),desktop);assert(path.basename(f).startsWith(tag));if(fs.existsSync(f))fs.unlinkSync(f);}ownedDeletionVerified=owned.every(f=>!fs.existsSync(f));assert(ownedDeletionVerified,'owned files remain after cleanup');}
  else {report.passed=false;report.cleanupError='helper not stopped; cleanup withheld';}
  if(!unsafe&&original){try{for(let n=0;n<60;n++){const s=await observe('cleanup',original);if(s.ok&&s.icons.length===original.icons.length){assert.equal(s.folderFlags,original.folderFlags,'cleanup changed Shell flags');assert.equal(s.autoArrange,original.autoArrange);note('cleanup',{originalIconsUnchanged:true});break;}if(n===59)throw Error('fixture icons remain after cleanup');await sleep(100);}}finally{if(!await c.stopAndWait(10000))unsafe=true;}}
  if(!unsafe){const p=path.resolve(temp);assert(p.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep)&&path.basename(p).startsWith('okiba-dense-ci-'));fs.rmSync(p,{recursive:true,force:true});}
  fs.writeFileSync(path.join(root,'hidden-attributes-'+mode+'-'+poll+'-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupError);
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'hidden-attributes-'+mode+'-'+poll+'-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
