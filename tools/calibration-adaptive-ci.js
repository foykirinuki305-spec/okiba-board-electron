// Hosted-only research prototype. Production helper/calibration are not modified.
'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Hosted Windows CI only');
const {spawn}=require('child_process');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const {createShellHelperClient}=require('../lib/shellhelper');
const {planCalibration,inferCalibration}=require('../lib/desktop-calibration');
const {sameSnapshot}=require('../lib/safe-desktop');
const root=path.resolve(__dirname,'..'),desktop=path.resolve(process.argv[2]);
const report={scope:'known 100% hosted desktop; algorithm grid knowledge discarded; NOT mixed-DPI or lease recovery proof',passed:false,cleanupVerified:false,events:[],runs:[]};
const note=(phase,data)=>{report.events.push({phase,data});console.log(phase+' '+JSON.stringify(data));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),clone=x=>JSON.parse(JSON.stringify(x));
const snap=(q,g)=>g.o+Math.floor((q-g.o)/g.s+.5)*g.s;
const sig=s=>s.icons.map(i=>JSON.stringify([i.identity,i.path,i.x,i.y])).sort();
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-adaptive-ci-')),name='OkibaAdaptive-'+crypto.randomBytes(6).toString('hex')+'.txt',dest=path.join(desktop,name);
 let src=fs.readFileSync(path.join(root,'scripts/shell-helper.ps1'),'utf8');
 const command=String.raw`      'ciCalibrationSample' {
        if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'CI only'}
        $baseline=$req.snapshot;$probe=$req.probe;$patch=$req.plan.patch;$q=$req.point
        $desktop=[IO.Path]::GetFullPath([Environment]::GetFolderPath('DesktopDirectory'));$dest=[IO.Path]::GetFullPath([string]$probe.path)
        if([IO.Path]::GetDirectoryName($dest) -ine $desktop -or -not [IO.Path]::GetFileName($dest).StartsWith('OkibaAdaptive-') -or -not [IO.File]::Exists($dest)){throw 'not owned CI probe'}
        if(-not (Strict-PointValid $q) -or $q.x -lt $patch.left+$req.plan.maxSpacing.x -or $q.x -gt $patch.right-$req.plan.maxSpacing.x -or $q.y -lt $patch.top+$req.plan.maxSpacing.y -or $q.y -gt $patch.bottom-$req.plan.maxSpacing.y){throw 'unsafe sample point'}
        $clock=[Diagnostics.Stopwatch]::StartNew();$fresh=Get-StrictTransactionState $baseline (Get-StrictDesktopSnapshot) @($probe)
        if(-not $fresh.ok -or $fresh.new.Count -ne 1){$result=@{ok=$false;reason='sample-precondition';guard=$fresh}}else{
          $i=$fresh.new[0]
          [OkibaFolderView]::PositionNewItem([int]$i.index,$dest,[int]$i.x,[int]$i.y,[int]$q.x,[int]$q.y,[string]$i.identity)
          $after=Wait-CalibrationSettled $baseline $probe $patch $clock
          $result=@{ok=$after.ok;guard=$after;elapsedMs=$clock.Elapsed.TotalMilliseconds}
        }
        if($null -ne $result.guard.new){$wire=@{};foreach($key in $result.guard.new.Keys){$wire[[string]$key]=$result.guard.new[$key]};$result.guard.new=$wire}
      }
`;
 const anchor="      'resolveDrop'         {";assert(src.includes(anchor));src=src.replace(anchor,command+anchor).replace("@('resolveDrop','cursorState'","@('ciCalibrationSample','resolveDrop','cursorState'");
 const serializationCatch='  } catch { break }';assert(src.includes(serializationCatch));src=src.replace(serializationCatch,'  } catch { [Console]::Error.WriteLine("CI response serialization failed: "+$_.Exception.Message);break }');
 const helper=path.join(temp,'shell-helper.ps1');fs.writeFileSync(helper,src);fs.copyFileSync(path.join(root,'scripts/snap-lease.ps1'),path.join(temp,'snap-lease.ps1'));
 let helperStderr='';const captureSpawn=(command,args,options)=>{const child=spawn(command,args,{...options,stdio:['pipe','pipe','pipe']});child.stderr.on('data',chunk=>{helperStderr=(helperStderr+chunk.toString()).slice(-16000);});return child;};
 const c=createShellHelperClient({spawnFn:captureSpawn,command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],timeoutMs:100000});
 let original,unsafe=false,created=false;
 async function req(cmd,payload={}){const r=await c.request(cmd,payload,{timeoutMs:100000});if(!r.ok){if(!await c.stopAndWait(10000))unsafe=true;note('helper-failure',{cmd,result:r,stderr:helperStderr,stats:c.stats()});throw Error('transport '+JSON.stringify(r));}return r.result;}
 function guard(s){assert(s.ok);assert.equal(s.identityVersion,1);assert.equal(new Set(s.icons.map(i=>i.identity)).size,s.icons.length);if(original){for(const old of original.icons){const now=s.icons.find(i=>i.identity===old.identity);assert(now&&now.x===old.x&&now.y===old.y&&now.path===old.path,'old icon changed');}assert.equal(s.folderFlags,original.folderFlags);assert.equal(s.explorerPid,original.explorerPid);assert.equal(s.explorerStarted,original.explorerStarted);assert.equal(s.listviewHwnd,original.listviewHwnd);}}
 async function stable(phase){let previous;for(let n=0;n<60;n++){const s=await req('desktopSnapshot');note(phase,{snapshot:s});if(s.ok){guard(s);if(previous&&sameSnapshot(previous,s))return s;previous=s;}else{const cleanupTransient=phase==='cleanup'&&!fs.existsSync(dest)&&s.reason==='shell-snapshot-error'&&/ReadShellBatch/.test(s.detail||'')&&/E_FAIL|0x80004005|0x80070490/i.test(s.detail||'');assert(s.reason==='desktop-changing'||cleanupTransient,'fatal snapshot '+JSON.stringify(s));previous=null;}await sleep(100);}throw Error('unstable '+phase);}
 try{
  original=await stable('initial');assert(original.snap&&!original.autoArrange,'requires initial snap ON / auto OFF; no blind setup toggle');assert.equal(original.areas.length,1);assert.equal(original.areas[0].scale,100);const known=clone(original.areas[0].grid);assert(known);
  const unknown=clone(original);unknown.areas[0].grid=null;const maxSpacing={x:Math.ceil(original.sx*1.25),y:Math.ceil(original.sy*1.25)};
  const plan=planCalibration({snapshot:unknown,areaIndex:0,probeId:dest,maxSpacing});assert(plan.ok,JSON.stringify(plan));note('plan',{known,plan});
  fs.writeFileSync(dest,'owned adaptive calibration fixture',{flag:'wx'});created=true;
  let appeared;for(let n=0;n<60;n++){appeared=await stable('arrival');if(appeared.icons.some(i=>i.path&&path.resolve(i.path).toLowerCase()===dest.toLowerCase()))break;await sleep(100);}assert.equal(appeared.icons.length,original.icons.length+1);
  const metadata=await req('readHiddenFile',{path:dest});assert(metadata.ok);const hash=crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  for(const strategy of ['dense','adaptive','adaptive','dense']){
   const started=performance.now();let grid,samples=[];
   if(strategy==='dense'){
    const result=await req('calibrateDesktopGrid',{snapshot:unknown,probe:{path:dest,name},plan});note('dense-result',result);assert(result.ok);const inferred=inferCalibration({plan,samples:result.samples});assert(inferred.ok);grid=inferred.grid;samples=result.samples;guard(result.snapshot);
   }else{
    const center={x:Math.floor((plan.patch.left+plan.patch.right)/2),y:Math.floor((plan.patch.top+plan.patch.bottom)/2)};const axes={};
    for(const axis of ['x','y']){
     const max=maxSpacing[axis];let candidates=[];for(let pitch=8;pitch<=max;pitch++)for(let origin=0;origin<pitch;origin++)candidates.push({s:pitch,o:origin});
     let fixedOther=null;
     async function measure(value,pass){const q={...center,[axis]:value};assert(q.x>=plan.patch.left+maxSpacing.x&&q.x<=plan.patch.right-maxSpacing.x&&q.y>=plan.patch.top+maxSpacing.y&&q.y<=plan.patch.bottom-maxSpacing.y,'outside reserved request margin');note('adaptive-request',{axis,pass,request:q});const result=await req('ciCalibrationSample',{snapshot:unknown,probe:{path:dest,name},plan,point:q});note('adaptive-sample',{axis,pass,request:q,result});assert(result.ok,JSON.stringify(result));guard(result.guard.current);const observed=result.guard.new['0'];assert(observed);const other=axis==='x'?'y':'x';if(fixedOther===null)fixedOther=observed[other];else assert.equal(observed[other],fixedOther,'cross-axis movement');samples.push({axis,pass,request:q,observed:{x:observed.x,y:observed.y},elapsedMs:result.elapsedMs});return observed[axis];}
     for(let n=0;n<12&&candidates.length>1;n++){
      let best=center[axis],score=Infinity;const choices=n===0?[best]:Array.from({length:25},(_,i)=>center[axis]+Math.round((i-12)*max/8));
      for(const q of choices){const counts=new Map();for(const g of candidates){const v=snap(q,g);counts.set(v,(counts.get(v)||0)+1);}const worst=Math.max(...counts.values());if(worst<score){score=worst;best=q;}}
      const observed=await measure(best,'candidate');candidates=candidates.filter(g=>snap(best,g)===observed);assert(candidates.length,'non-model snap; reject rather than guessing');
     }
     assert.equal(candidates.length,1,'ambiguous grid');const g=candidates[0],cell=snap(center[axis],g),delta=Math.max(1,Math.floor(g.s/4)),near=cell>=center[axis]?cell-g.s:cell+g.s,far=cell>=center[axis]?cell+g.s:cell-g.s;
     const forward=[near-delta,near+delta,cell-delta,cell+delta,far].sort((a,b)=>a-b);const observedForward=[];
     for(const q of forward){const v=await measure(q,'forward');assert.equal(v,snap(q,g));observedForward.push(v);}
     for(const [index,q] of forward.slice().reverse().entries()){const v=await measure(q,'reverse');assert.equal(v,observedForward[forward.length-1-index]);}
     const cells=[...new Set(observedForward)];assert.equal(cells.length,3);assert.equal(cells[1]-cells[0],g.s);assert.equal(cells[2]-cells[1],g.s);assert.equal(cells.filter(v=>observedForward.filter(x=>x===v).length>=2).length,2);axes[axis]=g;
    }
    grid={sx:axes.x.s,sy:axes.y.s,gx:axes.x.o,gy:axes.y.o};
   }
   assert.deepEqual(grid,known,'algorithm differs from native known grid');const after=await stable('after-run');assert.equal(after.icons.length,original.icons.length+1);const current=await req('readHiddenFile',{path:dest});for(const key of ['identity','hidden','attributes','size','mtime'])assert.equal(current[key],metadata[key]);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'),hash);
   const run={strategy,elapsedMs:performance.now()-started,sampleCount:samples.length,grid,samples};report.runs.push(run);note('run',run);
  }
  report.passed=true;
 }finally{
  if(!await c.stopAndWait(10000))unsafe=true;
  if(!unsafe&&created){assert.equal(path.dirname(dest),desktop);assert(path.basename(dest).startsWith('OkibaAdaptive-'));if(fs.existsSync(dest))fs.unlinkSync(dest);}
  if(!unsafe&&original){try{let after,clean=false;const deadline=Date.now()+15000;do{after=await stable('cleanup');if(after.icons.length===original.icons.length){clean=true;break;}await sleep(100);}while(Date.now()<deadline);assert(clean,'probe remained visible after cleanup deadline');assert.deepEqual(sig(after),sig(original));assert.equal(after.folderFlags,original.folderFlags);report.cleanupVerified=true;}finally{if(!await c.stopAndWait(10000))unsafe=true;}}
  if(unsafe){report.passed=false;report.cleanupError='helper stop unconfirmed; no blind state restoration';}
  fs.writeFileSync(path.join(root,'calibration-adaptive-ci.json'),JSON.stringify(report,null,2));
  if(unsafe)throw Error(report.cleanupError);
  assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('okiba-adaptive-ci-'));fs.rmSync(temp,{recursive:true,force:true});
 }
}
main().catch(e=>{report.passed=false;report.error=e.stack;fs.writeFileSync(path.join(root,'calibration-adaptive-ci.json'),JSON.stringify(report,null,2));console.error(e);process.exitCode=1;});
