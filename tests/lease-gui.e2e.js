// Legacy Desktop-placement regression; normal folder-return is tested separately.
'use strict';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('GUI lease test is hosted Windows CI only; no real user Desktop');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {_electron:electron}=require('playwright');const ROOT=path.resolve(__dirname,'..');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;console.log('ok '+m);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=Date.now()+25000;while(Date.now()<end){try{if(await fn())return;}catch{}await sleep(100);}throw Error('timeout: '+label);}
async function stableCardBox(locator,label){
 let previous=null,box=null,stable=0;
 await wait(async()=>{
  box=await locator.boundingBox();
  if(!box){previous=null;stable=0;return false;}
  const key=JSON.stringify(box);stable=key===previous?stable+1:1;previous=key;
  return stable>=3;
 },label+' connected and stable after refresh');
 return box;
}
async function scenario(mode){
 const isDrag=mode.startsWith('drag-'),isResident=mode.startsWith('resident-');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-lease-gui-'));const base=path.join(temp,'boards'),board=path.join(base,'Lease'),desktop=path.join(temp,'desktop'),old=path.join(temp,'old'),profile=path.join(temp,'profile');for(const p of [board,desktop,old])fs.mkdirSync(p,{recursive:true});
 const files=['first.txt','second.txt'].map(n=>path.join(isResident?board:desktop,n));files.forEach((p,i)=>fs.writeFileSync(p,'selected-'+i));
 const keep=path.join(board,'keep.txt');fs.writeFileSync(keep,'unchanged resident');const sentinel=path.join(desktop,'sentinel.txt');fs.writeFileSync(sentinel,'untouched');const sentinelStat=fs.statSync(sentinel);
 const meta=path.join(board,'.okiba-board.json');fs.writeFileSync(meta,JSON.stringify({version:6,positions:{'keep.txt':{col:1,row:1},...(isResident?{'first.txt':{col:3,row:1},'second.txt':{col:3,row:2}}:{})},notes:[],links:[],size_percent:100}));
 fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({appVersion:require('../package.json').version,positions:{Lease:{col:0,row:0}},theme:'light'}));
 const log=path.join(temp,'lease.jsonl');const records=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const snapshot={ok:true,identityVersion:1,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,origin:{x:0,y:0},areas:[{left:0,top:0,right:3000,bottom:2000,grid:{gx:0,gy:0,sx:100,sy:100}}],icons:[{identity:'old-sentinel',label:'sentinel.txt',path:sentinel,x:2000,y:1000}]};
 if(mode==='drag-occupied')snapshot.icons.push({identity:'occupied-second-cell',label:'guard.txt',path:path.join(desktop,'guard.txt'),x:500,y:600});
 const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_SHORTCUT_DESKTOP:desktop,OKIBA_CLEANUP_DESKTOP:desktop,OKIBA_CLEANUP_DOWNLOADS:desktop,OKIBA_TEST_DESKTOP_DIR:desktop,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_RETURN_MODE:'legacy',OKIBA_TEST_ATTRIB:'stub',OKIBA_TEST_HELPER:'fake',OKIBA_TEST_SNAP_LEASE:'1',OKIBA_TEST_POSITIONER:'',OKIBA_TEST_RESOLVER_DIR:'',OKIBA_FAKE_LANDING:desktop,OKIBA_FAKE_TYPE:'desktop',OKIBA_TEST_DESKTOP_SNAPSHOT:JSON.stringify(snapshot),OKIBA_FAKE_LEASE:'1',OKIBA_FAKE_LEASE_ROOT:temp,OKIBA_FAKE_LEASE_LOG:log,OKIBA_FAKE_LEASE_MODE:isDrag?'success':mode,ELECTRON_DISABLE_SECURITY_WARNINGS:'1'};
 if(isResident)env.OKIBA_TEST_RESIDENT_LEASE='1';
 if(mode==='legacy-abort')env.OKIBA_FAKE_PLAN_FAIL='1';
 if(mode==='legacy-concurrent')env.OKIBA_FAKE_POSITION_DELAY_MS='2500';
 let app,clean=false,afterForCleanup=null;
 try{
  app=await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+profile],env,timeout:60000});let page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await page.click('#boardGrid .board-card[data-name="Lease"]');
  if(!isResident)await page.evaluate(paths=>window.okiba.linkFiles('Lease',paths,{anchor:[3,1],offsets:[[0,0],[0,1]]}),files);
  const card=n=>page.locator('.item').filter({has:page.locator('.name',{hasText:n})}).first();
  await wait(async()=>(await page.locator('.item .name').allTextContents()).includes('first.txt'),'linked cards');await sleep(500);
  // Install a future-version field after normal intake, so the tested commit must retain it.
  const data=JSON.parse(fs.readFileSync(meta,'utf8'));data.future={untouched:['value',17]};fs.writeFileSync(meta,JSON.stringify(data));await sleep(500);
  const before=fs.readFileSync(meta,'utf8'),beforeData=JSON.parse(before);afterForCleanup=JSON.stringify({...beforeData,links:beforeData.links.filter(l=>l.path!==files[0])},null,2);const keptBox=await stableCardBox(card('keep.txt'),'initial keep card');
  if(isResident){
   const result=await page.evaluate(paths=>window.okiba.safeTakeout({boardName:'Lease',paths,linkedPaths:[]}),files);
   check(records().some(r=>r.cmd==='leaseReadResidentFiles'),'resident native classification requested');
   const after=JSON.parse(fs.readFileSync(meta,'utf8'));
   if(mode==='resident-reveal-fail'){
    check(!!result.error&&!result.pendingVerification,'resident failure is verified rollback');check(fs.readFileSync(meta,'utf8')===before,'resident rollback metadata bytes unchanged');check(!fs.existsSync(path.join(base,'.move-history.json')),'resident rollback no success history');
    for(const p of files)check(fs.existsSync(p)&&!fs.existsSync(path.join(desktop,path.basename(p))),'resident rollback source restored');
   }else{
    if(mode==='resident-pending'){
     check(result.pendingVerification===true&&result.retrySafe===false,'resident postcommit pending blocks unsafe retry');const count=records().filter(r=>r.cmd==='leasePrepare').length;
     const retry=await page.evaluate(p=>window.okiba.safeTakeout({boardName:'Lease',paths:[p],linkedPaths:[]}),keep);check(retry.pendingVerification===true&&retry.retrySafe===false,'resident pending refuses another resident request');check(records().filter(r=>r.cmd==='leasePrepare').length===count,'resident pending starts no new lease');check(!fs.existsSync(path.join(base,'.move-history.json')),'unverified resident never claims history success');
    }else check(result.metadataCommitted===true&&!result.error,'resident commit result explicit');
    for(const k of Object.keys(beforeData).filter(k=>k!=='positions'))check(JSON.stringify(after[k])===JSON.stringify(beforeData[k]),'resident preserves '+k);
    check(JSON.stringify(after.positions)===JSON.stringify({'keep.txt':beforeData.positions['keep.txt']}),'only selected resident cells removed');
    if(mode!=='resident-pending'){const history=JSON.parse(fs.readFileSync(path.join(base,'.move-history.json'),'utf8'));check(history[0].items.length===2&&history[0].items.every(i=>i.kind==='resident'),'resident group history correct');}
    for(const p of files)check(!fs.existsSync(p)&&fs.existsSync(path.join(desktop,path.basename(p))),'resident material moved to selected destination');
   }
   for(let i=0;i<files.length;i++)check(fs.readFileSync(mode==='resident-reveal-fail'?files[i]:path.join(desktop,path.basename(files[i])),'utf8')==='selected-'+i,'resident bytes preserved');
   const finalKeep=await stableCardBox(card('keep.txt'),'resident keep card');check(finalKeep.x===keptBox.x&&finalKeep.y===keptBox.y,'resident operation keeps unrelated cell');check(fs.statSync(sentinel).mtimeMs===sentinelStat.mtimeMs,'resident does not touch desktop sentinel');
   return;
  }
  if(mode==='legacy-abort'||mode==='legacy-concurrent'){
   const operation=page.evaluate(p=>window.okiba.safeTakeout({boardName:'Lease',paths:[p],linkedPaths:[]}),keep);
   if(mode==='legacy-concurrent'){
    await wait(()=>fs.existsSync(path.join(desktop,'keep.txt')),'legacy operation is holding its reservation');
    const {createDesktopLeaseClient}=require('../lib/desktop-lease-client');
    const contender=createDesktopLeaseClient({journalDir:path.join(temp,'contender-journals'),helper:{command:process.execPath,args:[path.join(ROOT,'tools/fake-helper.js')],env:{...env,ELECTRON_RUN_AS_NODE:'1'}},owner:{pid:process.pid}});
    try{check((await contender.ready()).ok,'contender ready read-only');const denied=await contender.reserveLegacy({desktop});check(!denied.ok,'simultaneous process cannot reserve active legacy Desktop');}
    finally{await contender.close();}
   }
   const result=await operation;
   check(fs.readFileSync(meta,'utf8')===before,'legacy return preserves metadata unknown fields and positions');
   if(mode==='legacy-abort'){check(!!result.error&&!result.pendingVerification,'verified rollback is not pending');check(fs.existsSync(keep)&&!fs.existsSync(path.join(desktop,'keep.txt')),'failed positioning returns own original');}
   else check(!result.error&&result.moved.includes(keep),'reserved legacy return completes');
   const lock=require('../lib/desktop-lease-global-lock').createDesktopLeaseLock({desktop,sessionId:0,localAppData:path.join(temp,'localAppData')});
   check(!fs.existsSync(lock.pointer),'confirmed legacy terminal releases shared pointer');
   return;
  }
  if(mode==='restart-global'||mode==='restart-journal'){
   await app.close();app=null;
   await wait(()=>[...new Set(records().filter(r=>r.cmd==='fake-start').flatMap(r=>[r.pid,r.parent]))].every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'first app and watchdog stopped');
   let marker;
   if(mode==='restart-global'){
    const lock=require('../lib/desktop-lease-global-lock').createDesktopLeaseLock({desktop,sessionId:0,localAppData:path.join(temp,'localAppData')});marker=lock.pointer;
   }else marker=path.join(profile,'desktop-lease-journals','a'.repeat(32)+'.json');
   fs.mkdirSync(path.dirname(marker),{recursive:true});fs.writeFileSync(marker,JSON.stringify({version:1,token:'a'.repeat(32),phase:'blocked',fixture:true}));
   app=await electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+profile],env,timeout:60000});page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await page.click('#boardGrid .board-card[data-name="Lease"]');
   const blocked=await page.evaluate(p=>window.okiba.safeTakeout({boardName:'Lease',paths:[p],linkedPaths:[]}),keep);
   check(blocked.leaseBlocked===true&&blocked.retrySafe===false,'restart unresolved state blocks legacy resident return');
   check(fs.existsSync(keep)&&!fs.existsSync(path.join(desktop,'keep.txt')),'unresolved preflight performs no file move');check(fs.readFileSync(meta,'utf8')===before,'unresolved preflight preserves metadata bytes');
   check(!records().some(r=>r.cmd==='leasePrepare'),'unresolved preflight opens no new lease');
   // Fixture operator resolves its own marker. The app must not delete it itself.
   check(fs.existsSync(marker),'app preserved unresolved marker');fs.unlinkSync(marker);await sleep(500);
   const unblocked=await page.evaluate(p=>window.okiba.safeTakeout({boardName:'Lease',paths:[p],linkedPaths:[]}),keep);
   check(!unblocked.error&&unblocked.moved.includes(keep),'legacy path still works after authoritative fixture resolution');
   check(fs.readFileSync(path.join(desktop,'keep.txt'),'utf8')==='unchanged resident','legacy original bytes preserved');
   return;
  }
  if(isDrag){
   await card('first.txt').click();await card('second.txt').click({modifiers:['Control']});
   check(await page.locator('.item.selected').count()===2,'pointer group has both selected links');
   const firstCell=beforeData.links.find(l=>l.path===files[0]),secondCell=beforeData.links.find(l=>l.path===files[1]);
   check(firstCell.col===secondCell.col&&secondCell.row-firstCell.row===1,'fixture is a vertical two-item group');
   const physical={x:550,y:mode==='drag-outside'?1950:550};
   const dip=await app.evaluate(({screen},p)=>screen.screenToDipPoint(p),physical);
   const box=await card('first.txt').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+30,box.y+box.height/2,{steps:5});
   await card('first.txt').evaluate((el,p)=>el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:1,clientX:-80,clientY:120,screenX:p.x,screenY:p.y})),dip);await page.mouse.up();
   await wait(async()=>(await page.evaluate(()=>window.okiba.dropLog())).some(r=>r.kind==='safe-desktop'),'pointer drag IPC result');
   if(mode==='drag-success'){
    await wait(async()=>!(await page.locator('.item .name').allTextContents()).includes('first.txt'),'drag first card removed');
    await wait(async()=>!(await page.locator('.item .name').allTextContents()).includes('second.txt'),'drag second card removed');
    const targets=records().find(r=>r.cmd==='leasePrepare').targets;check(targets.length===2,'one lease receives complete selected group');
    const a=targets.find(t=>t.path===files[0]),b=targets.find(t=>t.path===files[1]);check(a.x===500&&a.y===500&&b.x===500&&b.y===600,'drop point and vertical relative shape exact');
    await sleep(300);const final=JSON.parse(fs.readFileSync(meta,'utf8'));for(const k of Object.keys(beforeData).filter(k=>k!=='links'))check(JSON.stringify(final[k])===JSON.stringify(beforeData[k]),'drag preserves '+k+' without renderer resave');check(final.links.length===0,'both selected links committed once');
   }else{
    await wait(async()=>(await page.locator('.item .name').allTextContents()).includes('second.txt'),'cancelled group returns to board');
    check(!records().some(r=>r.cmd==='leasePrepare'),'invalid complete shape cancelled before revealing');check(fs.readFileSync(meta,'utf8')===before,'cancel retains metadata exactly');check(!fs.existsSync(path.join(base,'.move-history.json')),'cancel creates no history');
    const names=await page.locator('.item .name').allTextContents();check(names.includes('first.txt')&&names.includes('second.txt'),'both cancelled cards present');
   }
   const finalKeep=await stableCardBox(card('keep.txt'),'drag keep card');check(finalKeep.x===keptBox.x&&finalKeep.y===keptBox.y,'drag leaves existing card position unchanged');
   for(let i=0;i<files.length;i++)check(fs.readFileSync(files[i],'utf8')==='selected-'+i,'drag keeps original bytes');
   return;
  }
  await card('first.txt').click({button:'right'});await page.getByText('デスクトップへ移動',{exact:true}).click();
  await wait(()=>records().some(r=>r.cmd==='leasePrepare'),'real Node watchdog reached fake helper');
  if(mode==='reveal-fail'){
   await wait(()=>records().some(r=>r.cmd==='fake-terminal'&&r.visible===false),'rollback terminal');await wait(async()=>(await page.locator('.item .name').allTextContents()).includes('first.txt'),'failure card restored');
   check(fs.readFileSync(meta,'utf8')===before,'failed lease retains full metadata bytes');check(!fs.existsSync(path.join(base,'.move-history.json')),'failed lease no history');check(await card('first.txt').count()===1,'failed item remains visible on board');
  }else{
   await wait(()=>JSON.parse(fs.readFileSync(meta,'utf8')).links.length===1,'selected metadata commit');await wait(async()=>!(await page.locator('.item .name').allTextContents()).includes('first.txt'),'committed card gone');
   const after=JSON.parse(fs.readFileSync(meta,'utf8'));for(const k of Object.keys(beforeData).filter(k=>k!=='links'&&!(mode==='foreign-change'&&k==='future')))check(JSON.stringify(after[k])===JSON.stringify(beforeData[k]),'preserved '+k);if(mode==='foreign-change')check(after.future.externalEdit===true,'foreign edit retained, never overwritten by recovery');
   if(['pending','retry-native','foreign-change'].includes(mode)){
    await wait(async()=>(await page.locator('#toast').innerText()).includes('まだ確認'),'pending message');
    const prepares=records().filter(r=>r.cmd==='leasePrepare').length;
    const retry=await page.evaluate(p=>window.okiba.safeTakeout({boardName:'Lease',paths:[],linkedPaths:[p]}),files[1]);
    check(retry.pendingVerification===true&&retry.retrySafe===false,'pending retry is explicitly blocked');check(records().filter(r=>r.cmd==='leasePrepare').length===prepares,'pending retry starts no new lease');check(!fs.existsSync(path.join(base,'.move-history.json')),'pending does not claim history success');
    if(mode==='retry-native'){
     await wait(()=>fs.existsSync(path.join(base,'.move-history.json')),'authoritative retry resolves live-owner pending');
     await wait(async()=>(await page.locator('#toast').innerText()).includes('完了を確認しました'),'recovered completion is shown');
     check(records().filter(r=>r.cmd==='leasePrepare').length===1,'recovery never starts a second transaction');
    }else{
     await wait(async()=>(await page.locator('#toast').innerText()).includes('確認できませんでした'),'unresolved state explicitly reported after bounded retries');
     check(!fs.existsSync(path.join(base,'.move-history.json')),'permanent/foreign failure never claims success');
     if(mode==='foreign-change')check(JSON.parse(fs.readFileSync(meta,'utf8')).future.externalEdit===true,'foreign metadata survives all retries');
    }
   }else{
    await wait(()=>fs.existsSync(path.join(base,'.move-history.json')),'success history');check(records().some(r=>r.cmd==='fake-terminal'&&r.visible===true),'success visible terminal');
    await card('second.txt').click({button:'right'});await page.getByText('デスクトップへ移動',{exact:true}).click();await wait(()=>JSON.parse(fs.readFileSync(meta,'utf8')).links.length===0,'second warm transaction');
    check(new Set(records().filter(r=>r.cmd==='leasePrepare').map(r=>r.pid)).size===1,'two transactions reuse dedicated helper');
   }
  }
  const afterBox=await stableCardBox(card('keep.txt'),'final keep card');check(keptBox.x===afterBox.x&&keptBox.y===afterBox.y,'existing resident card stays at same position');check(fs.readFileSync(keep,'utf8')==='unchanged resident','resident original bytes unchanged');check(fs.statSync(sentinel).mtimeMs===sentinelStat.mtimeMs&&fs.readFileSync(sentinel,'utf8')==='untouched','unrelated desktop fixture unchanged');
  for(let i=0;i<files.length;i++)check(fs.readFileSync(files[i],'utf8')==='selected-'+i,'selected original file bytes unchanged');
 }catch(e){
  // Preserve non-hidden evidence: upload-artifact excludes dotfiles by default.
  const diagnostic={mode,error:String(e.stack||e),metadata:fs.existsSync(meta)?fs.readFileSync(meta,'utf8'):null,keepExists:fs.existsSync(keep)};
  if(app){try{const page=await app.firstWindow();diagnostic.dom=await page.evaluate(()=>({names:[...document.querySelectorAll('.item .name')].map(e=>e.textContent),boardHidden:document.getElementById('boardView')?.hidden,toast:document.getElementById('toast')?.textContent}));await page.screenshot({path:path.join(temp,'failure.png')});}catch(x){diagnostic.inspectError=String(x);}}
  fs.writeFileSync(path.join(temp,'failure.json'),JSON.stringify(diagnostic,null,2));throw e;
 }finally{
  if(fs.existsSync(meta))fs.copyFileSync(meta,path.join(temp,'final-board-metadata.json'));
  // Test-owned foreign edit is restored only by this cleanup, never by the app.
  // This lets the independent fake watchdog terminate after owner exit.
  if(mode==='foreign-change'&&afterForCleanup)fs.writeFileSync(meta,afterForCleanup);
  if(app)await app.close();
  const pids=[...new Set(records().filter(r=>r.cmd==='fake-start').flatMap(r=>[r.pid,r.parent]))];
  await wait(()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'owned helper/watchdog termination');clean=true;
  const evidence=path.join(ROOT,'lease-gui-evidence');fs.mkdirSync(evidence,{recursive:true});fs.cpSync(temp,path.join(evidence,mode),{recursive:true});
  if(clean){const resolved=path.resolve(temp);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('okiba-lease-gui-'));fs.rmSync(resolved,{recursive:true,force:true});}
 }
}
(async()=>{for(const mode of ['success','reveal-fail','pending','transient-native','retry-native','release-fail','foreign-change','restart-global','restart-journal','legacy-abort','legacy-concurrent','drag-success','drag-occupied','drag-outside','resident-success','resident-reveal-fail','resident-pending'])await scenario(mode);console.log('LEASE GUI '+checks+' checks PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
