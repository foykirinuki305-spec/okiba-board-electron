'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process'),assert=require('assert/strict'),{promisify}=require('util');
const policy=require('./packaged-preview-policy-ci');policy.hosted(process.env,process.platform);
const {_electron:electron}=require('playwright'),{createShellHelperClient}=require('../lib/shellhelper'),{stableSnapshot}=require('./stable-snapshot-ci'),{sameSnapshot}=require('../lib/safe-desktop'),{createDesktopLeaseLock}=require('../lib/desktop-lease-global-lock');
const root=path.resolve(__dirname,'..');let temp=null,base=null,profile=null,old=null,folder=null;
const report={passed:false,cleanupVerified:false,scope:'packaged actual OS pointer drag unknown3, no-fit3, same-helper known3 reuse; hosted single150; 51 existing icons protected during final3 real drag; seed48 via two 24-item real drags',temp},sleep=ms=>new Promise(r=>setTimeout(r,ms)),run=promisify(cp.execFile),tag='OkibaPreview-'+crypto.randomBytes(12).toString('hex');let app,observer,baseline,files=[],env,desktop,closed=false,terminal=false,ownedProcesses=[];
async function support(action,extra={}){const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'packaged-unknown-dense-support-ci.ps1'),'-Action',action],{windowsHide:true,env:{...process.env,...extra}});return JSON.parse(r.stdout);}
async function request(cmd,payload={}){const r=await observer.request(cmd,payload);assert(r.ok&&r.result?.ok,JSON.stringify(r));return r.result;}
function guard(s){if(!baseline)return;assert.equal(s.folderFlags,baseline.folderFlags);for(const i of baseline.icons)assert(s.icons.some(n=>n.identity===i.identity&&n.x===i.x&&n.y===i.y),'old icon changed');}
async function snapshot(cleanup=false){return stableSnapshot({read:()=>observer.request('desktopSnapshot'),guard,same:sameSnapshot,sleep,cleanupEvidence:cleanup?{phase:'terminal-owned-removal',terminalConfirmed:terminal&&closed,record:e=>(report.cleanupReadRetries??=[]).push(e)}:null});}
async function capture(){const all=await support('processes',{OKIBA_PREVIEW_ROOT_PID:String(app.process().pid)}),ids=new Set([app.process().pid]);let changed=true;while(changed){changed=false;for(const p of all)if(ids.has(p.parent)&&!ids.has(p.pid)){ids.add(p.pid);changed=true;}}ownedProcesses=all.filter(p=>ids.has(p.pid));report.processes=ownedProcesses;}
async function stop(){if(!app)return;await capture();await app.close();app=null;const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'wait-owned-processes-ci.ps1')],{windowsHide:true,timeout:120000,env:{...process.env,OKIBA_CHILDREN:JSON.stringify(ownedProcesses)}});report.processExit=JSON.parse(r.stdout);assert(report.processExit.ok);closed=true;}
(async()=>{try{
 const host=await support('environment');desktop=host.desktop;
 const tempParent=fs.realpathSync.native(path.join(host.localAppData,'Temp'));temp=fs.mkdtempSync(path.join(tempParent,'okiba-packaged-preview-'));temp=fs.realpathSync.native(temp);assert.equal(path.dirname(temp),tempParent);report.temp=temp;
 base=path.join(temp,'boards');profile=path.join(temp,'profile');old=path.join(temp,'old');folder=path.join(base,'Preview');
 observer=createShellHelperClient({command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/shell-helper.ps1')],env:policy.cleanEnv(process.env,base,old)});
 baseline=await snapshot();assert.equal(baseline.areas.length,1);assert.equal(baseline.areas[0].scale,150);assert.equal(baseline.icons.length,0);assert.equal(baseline.areas[0].grid,null);assert(baseline.snap&&!baseline.autoArrange);report.baseline=baseline;report.actualScale=150;
 const lock=createDesktopLeaseLock(host);assert(!lock.hasUnresolved(),'unresolved desktop reservation');
 for(const d of [folder,profile,old])fs.mkdirSync(d,{recursive:true});
 const positions={},links=[];for(let n=0;n<54;n++){const name=tag+'-'+(n+1)+'.txt',src=path.join(folder,name),dest=path.join(desktop,name);fs.writeFileSync(src,'preview own content '+n,{flag:'wx'});const rec=await request('readHiddenFile',{path:src});assert.equal(rec.attributes,32);await request('setHiddenFile',{path:src,expectedIdentity:rec.identity,expectedHidden:false,hidden:true});await request('moveNoReplace',{source:src,destination:dest});const record=await request('readHiddenFile',{path:dest});assert(record.hidden&&record.attributes===34);files.push({src,path:dest,name,record,bytes:fs.readFileSync(dest).toString('base64')});links.push({path:dest,col:n<6?(n<3?0:2):4+Math.floor((n-6)/6),row:n<6?n%3:(n-6)%6,wasHidden:false,future:{keep:n}});}
 const meta={version:6,size_percent:100,positions,links,notes:[],future:{fixture:tag,keep:['unchanged']}},metaPath=path.join(folder,'.okiba-board.json');fs.writeFileSync(metaPath,JSON.stringify(meta));fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({positions:{Preview:{col:0,row:0}},appVersion:require('../package.json').version}));
 env={...policy.cleanEnv(process.env,base,old),OKIBA_DESKTOP_UNKNOWN_PREVIEW:'1'};app=await electron.launch({executablePath:path.join(root,'dist/win-unpacked/OkibaBoard.exe'),args:['--no-sandbox','--user-data-dir='+profile],env,timeout:60000});
 const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,profile:app.getPath('userData'),pid:process.pid,execPath:process.execPath}));assert(runtime.packaged);assert.equal(path.resolve(runtime.profile),profile);report.runtime=runtime;
 const page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');await page.locator('#boardGrid .board-card').first().dblclick();await page.waitForSelector('#boardArea .item');
 await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],a=screen.getPrimaryDisplay().workArea;w.setBounds({x:a.x+Math.floor(a.width*.55),y:a.y+20,width:Math.floor(a.width*.45)-10,height:a.height-40});w.show();w.focus();});await page.bringToFront();await capture();
 await page.evaluate(()=>{window.__dragEvidence=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{window.__dragEvidence.push({type,trusted:e.isTrusted,x:e.screenX,y:e.screenY});},{capture:true});});
 const jd=path.join(profile,'desktop-lease-journals'),journals=()=>fs.existsSync(jd)?fs.readdirSync(jd).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(jd,n)))):[];
 const logPath=path.join(base,'okiba.log'),timings=()=>fs.existsSync(logPath)?fs.readFileSync(logPath,'utf8').split('\n').filter(l=>l.includes(' dragout ms')):[];
 async function waitDone(test,ms=120000){const deadline=Date.now()+ms;while(!test()){assert(Date.now()<deadline,'drag transaction timeout');await sleep(150);}}
 async function drag(group,target){
  const sourceRaw=fs.readFileSync(metaPath),sourceMeta=JSON.parse(sourceRaw),sourceCells=group.map(f=>{const matches=sourceMeta.links.filter(l=>l.path===f.path);assert.equal(matches.length,1);const expected=links.find(l=>l.path===f.path);assert.deepEqual(matches[0],expected);return {path:f.path,col:expected.col,row:expected.row};});
  const styleProof=await page.evaluate(paths=>paths.map(p=>{const el=[...document.querySelectorAll('.item')].find(el=>el.dataset.key==='link:'+p);if(!el)throw Error('source item absent');return {key:el.dataset.key,left:el.style.left,top:el.style.top};}),group.map(f=>f.path));
  await page.locator('#boardArea').click({position:{x:5,y:5}});
  const item=f=>page.locator('[data-key='+JSON.stringify('link:'+f.path)+']');
  for(const f of group){assert.equal(await item(f).count(),1);await item(f).click({modifiers:['Control']});}
  assert.equal(await page.locator('.item.selected').count(),group.length);
  await item(group[0]).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.item.selected').count(),group.length);
  assert.deepEqual(fs.readFileSync(metaPath),sourceRaw,'selection/scroll changed metadata');
  assert.deepEqual(await page.evaluate(paths=>paths.map(p=>{const el=[...document.querySelectorAll('.item')].find(el=>el.dataset.key==='link:'+p);return {key:el.dataset.key,left:el.style.left,top:el.style.top};}),group.map(f=>f.path)),styleProof,'selection/scroll changed source layout');
  const box=await item(group[0]).boundingBox();assert(box);
  const start=await app.evaluate(({BrowserWindow,screen},p)=>{const b=BrowserWindow.getAllWindows()[0].getContentBounds();return screen.dipToScreenPoint({x:Math.round(b.x+p.x),y:Math.round(b.y+p.y)});},{x:box.x+box.width/2,y:box.y+box.height/2});
  const before=await snapshot();const area=before.areas[0],oldIcons=before.icons;const proc=require('./packaged-unknown-process-ci').selectMain(runtime,ownedProcesses,path.join(root,'dist/win-unpacked/OkibaBoard.exe'));report.inputProcess={launcherPid:app.process().pid,mainPid:proc.pid,mainBirth:proc.started,execPath:runtime.execPath};
  const spec={pid:proc.pid,started:proc.started,base,tag,paths:group.map(f=>f.path),start,target,area,old:oldIcons,guardX:Math.max(before.sx,120),guardY:Math.max(before.sy,120)};
  const eventStart=await page.evaluate(()=>window.__dragEvidence.length);
  const out=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'packaged-unknown-dense-input-ci.ps1')],{windowsHide:true,timeout:30000,env:{...process.env,OKIBA_DRAG_SPEC:JSON.stringify(spec)}});assert(JSON.parse(out.stdout).ok);await page.waitForFunction(n=>window.__dragEvidence.slice(n).some(e=>e.type==='pointerup'&&e.trusted),eventStart,{timeout:10000});const events=await page.evaluate(n=>window.__dragEvidence.slice(n),eventStart);assert(events.some(e=>e.type==='pointerdown'&&e.trusted));assert(events.some(e=>e.type==='pointerup'&&e.trusted));(report.gestures??=[]).push({target,events,count:group.length,sourceCells,sourceLayoutUnchanged:true});return before;
 }
 const area=baseline.areas[0],firstTarget={x:area.left+Math.round((area.right-area.left)*.12),y:area.top+Math.round((area.bottom-area.top)*.2)},secondTarget={x:area.left+Math.round((area.right-area.left)*.34),y:firstTarget.y};
 await drag(files.slice(0,3),firstTarget);await waitDone(()=>JSON.parse(fs.readFileSync(metaPath)).links.length===51&&journals().some(j=>j.phase==='released')&&timings().length>=1);
 const first=await snapshot(),firstJournal=journals().find(j=>j.mode==='unknown-grid');assert(firstJournal&&firstJournal.phase==='released');assert.equal(firstJournal.recovery.success.anchorMode,'cursor-center');const grid=firstJournal.recovery.success.resolved.grid;assert(grid);report.firstJournal=firstJournal;
 assert.deepEqual(JSON.parse(fs.readFileSync(metaPath)),{...meta,links:links.slice(3)});report.firstCalibrationTimings=timings().slice();const plan=require('./packaged-unknown-dense-plan-ci').densePlan(area,grid,firstTarget,secondTarget);report.capacity=plan.capacity;
 // Fixture preparation: two additional real pointer drags; reported separately from final three.
 await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],a=screen.getPrimaryDisplay().workArea;w.setBounds({x:a.x+10,y:a.y+20,width:Math.floor(a.width*.45)-10,height:a.height-40});});
 report.seed=[];
 let seeded=first;
 for(let batch=0;batch<2;batch++){
  const group=files.slice(6+batch*24,30+batch*24),positions=plan.groups[batch],anchor=links[6+batch*24];
  const target={x:Math.round(positions[0].x+grid.sx/2),y:Math.round(positions[0].y+grid.sy/2)};
  const beforeTiming=timings().length,expected=links.filter((l,n)=>n>=3&&!(n>=6&&n<30+batch*24));
  await drag(group,target);
  await waitDone(()=>JSON.parse(fs.readFileSync(metaPath)).links.length===expected.length&&journals().filter(j=>j.phase==='released').length===2+batch);
  const next=await snapshot();for(const old of seeded.icons)assert(next.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y),'seed shifted old icon');
  for(let n=0;n<24;n++){const f=group[n],i=next.icons.find(i=>i.path?.toLowerCase()===f.path.toLowerCase());assert(i&&i.x===positions[n].x&&i.y===positions[n].y);const r=await request('readHiddenFile',{path:f.path});assert.equal(r.identity,f.record.identity);assert.equal(r.attributes,32);assert.equal(fs.readFileSync(f.path).toString('base64'),f.bytes);}
  assert.deepEqual(JSON.parse(fs.readFileSync(metaPath)),{...meta,links:expected});
  assert.equal(journals().filter(j=>j.phase==='released'&&j.permitDurable).length,2+batch);assert(!lock.hasUnresolved());
  report.seed.push({scope:'fixture 24-item real pointer drag',count:24,timings:timings().slice(beforeTiming)});seeded=next;
 }
 assert.equal(seeded.icons.length,51);report.protectedBaseline=seeded;
 baseline=seeded; // Monotonic test guard: all 51 own existing identities now protected.
 await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],a=screen.getPrimaryDisplay().workArea;w.setBounds({x:a.x+Math.floor(a.width*.55),y:a.y+20,width:Math.floor(a.width*.45)-10,height:a.height-40});w.focus();});
 const firstRaw=fs.readFileSync(metaPath),beforeNoFit=timings().length;
 await drag(files.slice(3,6),{x:secondTarget.x,y:area.bottom-5});await waitDone(()=>timings().length>beforeNoFit);assert.deepEqual(fs.readFileSync(metaPath),firstRaw);const nofit=await snapshot();assert(sameSnapshot(seeded,nofit));assert.equal(journals().filter(j=>j.phase==='released').length,3);report.noFitVerified=true;
 await drag(files.slice(3,6),secondTarget);await waitDone(()=>JSON.parse(fs.readFileSync(metaPath)).links.length===0&&journals().filter(j=>j.phase==='released').length===4);
 const after=await snapshot();for(const old of seeded.icons)assert(after.icons.some(i=>i.identity===old.identity&&i.x===old.x&&i.y===old.y));
 for(const [index,group] of [files.slice(0,3),files.slice(3,6)].entries()){const icons=group.map(f=>after.icons.find(i=>i.path?.toLowerCase()===f.path.toLowerCase()));assert(icons.every(Boolean));const target=index===0?firstTarget:secondTarget;const expectedAnchor={x:grid.gx+Math.floor((target.x-grid.sx/2-grid.gx)/grid.sx+.5)*grid.sx,y:grid.gy+Math.floor((target.y-grid.sy/2-grid.gy)/grid.sy+.5)*grid.sy};assert.equal(icons[0].x,expectedAnchor.x,'requested pointer center x');assert.equal(icons[0].y,expectedAnchor.y,'requested pointer center y');assert(icons.every(i=>i.x===icons[0].x));assert.equal(icons[1].y-icons[0].y,grid.sy);assert.equal(icons[2].y-icons[0].y,2*grid.sy);}
 assert.deepEqual(JSON.parse(fs.readFileSync(metaPath)),{...meta,links:[]});report.journals=journals();assert.equal(report.journals.filter(j=>j.mode==='unknown-grid').length,1);assert(report.journals.some(j=>j.scope.kind==='samepath-hidden'));assert(report.journals.every(j=>j.phase==='released'&&j.permitDurable));
 report.pointerEvents=await page.evaluate(()=>window.__dragEvidence);assert(report.pointerEvents.filter(e=>e.type==='pointerup'&&e.trusted).length>=5);report.dragTimings=timings();report.finalActualTimings=timings().slice(beforeNoFit);assert(report.dragTimings.length>=5);assert(!lock.hasUnresolved());terminal=true;
 for(const f of files){const r=await request('readHiddenFile',{path:f.path});assert.equal(r.identity,f.record.identity);assert.equal(r.size,f.record.size);assert.equal(r.mtime,f.record.mtime);assert.equal(r.attributes,32);assert.equal(fs.readFileSync(f.path).toString('base64'),f.bytes);}
 await stop();await snapshot();assert(!lock.hasUnresolved());
 // End guarded test only after terminal proof and process stop. Cleanup checks own records before each removal.
 baseline=report.baseline;
 for(const group of Array.from({length:18},(_,n)=>files.slice(n*3,n*3+3)))await support('hide',{OKIBA_PREVIEW_TERMINAL:'confirmed',OKIBA_PREVIEW_RECORDS:JSON.stringify(group.map(f=>({path:f.path,...f.record,attributes:32,hidden:false})))});
 let invisible=false;for(let n=0;n<100;n++){const s=await snapshot(true);if(s.icons.length===baseline.icons.length){invisible=true;break;}await sleep(100);}assert(invisible,'owned files not invisible');
 for(const f of files){const r=await request('readHiddenFile',{path:f.path});assert.equal(r.identity,f.record.identity);assert(r.hidden);assert.equal(path.dirname(f.path),desktop);assert(path.basename(f.path).startsWith(tag+'-'));fs.unlinkSync(f.path);}
 const final=await snapshot(true);assert.equal(final.icons.length,baseline.icons.length);report.cleanupVerified=true;report.passed=true;
 }catch(e){report.error=e.stack;
  if(app)try{const images=await app.evaluate(async({desktopCapturer,screen})=>{const size=screen.getPrimaryDisplay().size;const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.ceil(size.width*2),height:Math.ceil(size.height*2)}});return sources.map(s=>({name:s.name,png:s.thumbnail.toPNG().toString('base64')}));});const out=path.join(root,'packaged-unknown-dense-evidence');fs.mkdirSync(out,{recursive:true});report.failureScreenshots=[];for(const [n,img]of images.entries()){const name='failure-full-screen-'+n+'.png';fs.writeFileSync(path.join(out,name),Buffer.from(img.png,'base64'));report.failureScreenshots.push(name);}}catch(captureError){report.screenshotError=captureError.message;}
  throw e;}finally{
  // Evidence is read-only and unconditional, including pending/native prepare failure.
  const out=path.join(root,'packaged-unknown-dense-evidence');fs.mkdirSync(out,{recursive:true});
  function collectJournals(stage){const dir=profile&&path.join(profile,'desktop-lease-journals');const entries=[];if(dir&&fs.existsSync(dir)){const target=path.join(out,'journals-'+stage);fs.mkdirSync(target,{recursive:true});for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){try{const raw=fs.readFileSync(path.join(dir,name));fs.writeFileSync(path.join(target,name),raw);try{entries.push({name,data:JSON.parse(raw)});}catch(e){entries.push({name,parseError:e.message});}}catch(e){entries.push({name,error:e.message});}}}report['journals_'+stage]=entries;}
  collectJournals('before-stop');report.finalFileObservations=[];
  if(observer)for(const f of files)for(const location of ['src','path']){const item={location,path:f[location]};try{item.exists=fs.existsSync(item.path);if(item.exists)item.native=await observer.request('readHiddenFile',{path:item.path});}catch(e){item.error=e.message;}report.finalFileObservations.push(item);}
  // Fail closed: never delete Desktop items or restore settings on uncertain results.
  if(app)try{await stop();}catch(e){report.stopError=e.stack;}
  collectJournals('after-stop');
  if(observer)try{report.observerStopped=await observer.stopAndWait(15000);}catch(e){report.observerStopError=e.stack;}
  for(const [src,name] of [[base&&path.join(base,'okiba.log'),'okiba.log'],[folder&&path.join(folder,'.okiba-board.json'),'board.json']])if(src&&fs.existsSync(src))fs.copyFileSync(src,path.join(out,name));
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));  if(!report.observerStopped)process.exitCode=1;
 }} )().catch(e=>{console.error(e);process.exitCode=1;});
