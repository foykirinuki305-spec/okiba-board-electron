'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only; real user Desktop forbidden');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {execFile}=require('child_process'),{promisify}=require('util'),run=promisify(execFile);
const {createShellHelperClient}=require('../lib/shellhelper');
const {planDesktop,sameSnapshot}=require('../lib/safe-desktop');
const {createAttribRunner}=require('../lib/links');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]),attrs=createAttribRunner();
const report={scope:'RESEARCH ONLY: temporary snap OFF on GitHub-hosted single-monitor Windows, AUTOARRANGE always OFF; no production change, NOT mixed-DPI proof',passed:false,events:[]};
const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const identityValid=s=>s.identityVersion===1&&s.icons.every(i=>typeof i.identity==='string'&&i.identity.length)&&new Set(s.icons.map(i=>i.identity)).size===s.icons.length;
const differences=(before,after)=>before.icons.filter(old=>!after.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y)).map(old=>({identity:old.identity,label:old.label,before:{x:old.x,y:old.y},after:after.icons.filter(i=>i.identity===old.identity).map(i=>({label:i.label,x:i.x,y:i.y}))}));
const matchesFile=(icon,name)=>typeof icon.path==='string'&&path.resolve(icon.path).toLowerCase()===path.join(desktop,name).toLowerCase();
async function main(){
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
 const researchHelper=path.join(temp,'ci-only-snap-off-helper.ps1');fs.writeFileSync(researchHelper,helperSource,'utf8');
 const c=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',researchHelper],timeoutMs:100000});
 let unsafe=false,original;
 async function req(cmd,args={}){const r=await c.request(cmd,args,{timeoutMs:100000});if(!r.ok){unsafe=!await c.stopAndWait(10000);throw Error('helper transport '+JSON.stringify(r));}return r.result;}
 async function observe(phase,guard){const s=await req('desktopSnapshot');if(!s.ok)note(phase+'-snapshot-not-ok',{snapshot:s});if(s.ok)assert(identityValid(s),'Missing or duplicate Shell identity during '+phase);if(s.ok&&guard){const diff=differences(guard,s);if(diff.length){note(phase,{before:guard,after:s,differences:diff});throw Error('EXISTING ICON SHIFT during '+phase);}}return s;}
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
  for(let cycle=0;cycle<3;cycle++){
   const before=await stable('cycle-before',remaining);note('before-unhide',{cycle,snapshot:before});
   const p=planDesktop({snapshot:before,items:selected,automatic:true});assert(p.ok,'No space for selected relative shape');
   let after;
   try {
    const off=await req('ciSnapFlags',{flags:0});assert(off.ok,'Could not switch snap OFF without enabling auto arrange');
    const offSnapshot=await stable('snap-off-'+cycle,before);assert(!offSnapshot.snap&&!offSnapshot.autoArrange);
    for(const item of selected){assert((await attrs.setHidden(item.dest,false)).ok);await observe('snap-off-unhide-'+cycle,before);}
    const arrival=await visible(selected.map(i=>i.name),true,'snap-off-arrival-'+cycle,before);
    note('snap-off-arrival',{cycle,snapshot:arrival,differences:differences(before,arrival)});
    const batch=p.targets.map(t=>{const icon=arrival.icons.find(i=>matchesFile(i,t.name));assert(icon);return {identity:icon.identity,path:selected.find(i=>i.name===t.name).dest,oldX:icon.x,oldY:icon.y,x:t.x,y:t.y};});
    const placed=await req('ciSnapPosition',{items:batch});assert(placed.ok);
    after=await stable('snap-off-position-'+cycle,before);
    for(const t of p.targets){const i=after.icons.find(i=>matchesFile(i,t.name));assert(i&&i.x===t.x&&i.y===t.y,'snap OFF exact target failed');}
   }finally{
    const on=await req('ciSnapFlags',{flags:4});assert(on.ok,'snap ON restore failed');
   }
   after=await stable('snap-on-restored-'+cycle,before);assert(after.snap&&!after.autoArrange);
   for(const t of p.targets){const i=after.icons.find(i=>matchesFile(i,t.name));assert(i&&i.x===t.x&&i.y===t.y,'snap ON changed target');}
   note('after-snap-on',{cycle,snapshot:after,differences:differences(before,after)});
   for(const item of selected){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(item.dest)).digest('hex'),hashes.get(item.dest));assert((await attrs.setHidden(item.dest,true)).ok);}
   const hidden=await visible(selected.map(i=>i.name),false,'rehide-'+cycle,before);assert.equal(hidden.icons.length,before.icons.length);
  }
  // Research the ON transition with one deliberately off-grid, self-owned icon.
  // Every other icon remains protected. No old coordinates are ever restored.
  const protectedBefore=await stable('offgrid-probe-before',remaining);
  const probeName=tag+'-offgrid-probe.txt',probePath=path.join(desktop,probeName);
  const shape=[[0,0],[1,0],[0,1],[1,1]].map((offset,i)=>({name:i?tag+'-reserved-'+i+'.txt':probeName,path:path.join(temp,i?'reserved-'+i:probeName),dest:i?path.join(desktop,tag+'-reserved-'+i+'.txt'):probePath,offset}));
  const probePlan=planDesktop({snapshot:protectedBefore,items:shape,automatic:true});assert(probePlan.ok,'No safe empty 2x2 patch for off-grid probe');
  const target=probePlan.targets[0],area=protectedBefore.areas.find(a=>target.x>=a.left&&target.x<a.right&&target.y>=a.top&&target.y<a.bottom),grid=area.grid;
  const offTarget={x:target.x+Math.max(2,Math.floor(grid.sx/3)),y:target.y+Math.max(2,Math.floor(grid.sy/3))};
  owned.push(probePath);fs.writeFileSync(shape[0].path,'CI-owned off-grid research fixture');
  let offgridBefore;
  try {
    assert((await req('ciSnapFlags',{flags:0})).ok);
    await stable('offgrid-toggle-off',protectedBefore);
    await move(shape[0].path,probePath);
    const arrived=await visible([probeName],true,'offgrid-probe-arrival',protectedBefore),item=arrived.icons.find(i=>matchesFile(i,probeName));assert(item);
    assert((await req('ciSnapPosition',{items:[{identity:item.identity,path:probePath,oldX:item.x,oldY:item.y,...offTarget}]})).ok);
    const placed=await stable('offgrid-probe-placed',protectedBefore);offgridBefore=placed.icons.find(i=>matchesFile(i,probeName));
    assert(offgridBefore.x===offTarget.x&&offgridBefore.y===offTarget.y,'Could not create the intended off-grid test condition');
    assert((offgridBefore.x-grid.gx)%grid.sx!==0||(offgridBefore.y-grid.gy)%grid.sy!==0,'Fixture accidentally remained on grid');
    note('offgrid-before-snap-on',{probe:offgridBefore,grid});
  }finally{assert((await req('ciSnapFlags',{flags:4})).ok,'off-grid case could not restore snap');}
  const restored=await stable('offgrid-snap-on',protectedBefore),offgridAfter=restored.icons.find(i=>matchesFile(i,probeName));assert(offgridAfter,'Research probe disappeared');
  assert(restored.snap&&!restored.autoArrange);assert.equal(fs.readFileSync(probePath,'utf8'),'CI-owned off-grid research fixture');
  report.offgridObservation={before:{x:offgridBefore.x,y:offgridBefore.y},after:{x:offgridAfter.x,y:offgridAfter.y},moved:offgridBefore.x!==offgridAfter.x||offgridBefore.y!==offgridAfter.y,allOtherIconsUnchanged:differences(protectedBefore,restored).length===0,scope:'One deliberately off-grid CI-owned icon, not mixed-DPI proof'};
  note('OFFGRID_SNAP_ON_OBSERVATION',report.offgridObservation);
  report.passed=true;note('RESEARCH_PASS_NOT_MIXED_DPI_PROOF',{denseShortcuts:42,hiddenPerCycle:6,oldCellGuards:3,cycles:3,oldIconsUnchanged:true});
 }finally{
  if(!await c.stopAndWait(10000))unsafe=true;
  if(!unsafe){for(const f of owned){assert.equal(path.dirname(f),desktop);assert(path.basename(f).startsWith(tag));if(fs.existsSync(f))fs.unlinkSync(f);}}
  else {report.passed=false;report.cleanupError='helper not stopped; cleanup withheld';}
  if(!unsafe&&original){try{for(let n=0;n<60;n++){const s=await observe('cleanup',original);if(s.ok&&s.icons.length===original.icons.length){note('cleanup',{originalIconsUnchanged:true});break;}if(n===59)throw Error('fixture icons remain after cleanup');await sleep(100);}}finally{if(!await c.stopAndWait(10000))unsafe=true;}}
  if(!unsafe){const p=path.resolve(temp);assert(p.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep)&&path.basename(p).startsWith('okiba-dense-ci-'));fs.rmSync(p,{recursive:true,force:true});}
  fs.writeFileSync(path.join(root,'hidden-snap-offgrid-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupError);
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'hidden-snap-offgrid-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
