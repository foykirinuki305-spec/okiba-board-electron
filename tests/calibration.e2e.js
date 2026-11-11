'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {_electron:electron}=require('playwright');const ROOT=path.join(__dirname,'..');
const assert=(v,m)=>{if(!v)throw Error(m);console.log('  ok - '+m)};
async function scenario(mode){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'okiba-calibration-'));const base=path.join(tmp,'boards'),old=path.join(tmp,'old'),desktop=path.join(tmp,'desktop'),board=path.join(base,'Calibration');
 for(const p of [base,old,desktop,board])fs.mkdirSync(p,{recursive:true});
 const names=['first.txt','second.txt','later.txt','restart.txt','stale.txt','blocked.txt'];const paths=names.map(n=>path.join(board,n));paths.forEach((p,i)=>fs.writeFileSync(p,'original-'+i));
 const sentinel=path.join(desktop,'sentinel.txt');fs.writeFileSync(sentinel,'untouched existing desktop fixture');const sentinelBefore=fs.statSync(sentinel).mtimeMs;
 const meta=path.join(board,'.okiba-board.json');fs.writeFileSync(meta,JSON.stringify({version:6,size_percent:100,positions:Object.fromEntries(names.map((n,i)=>[n,{col:i,row:1}])),links:[],notes:[]}));
 fs.writeFileSync(path.join(base,'.home.json'),JSON.stringify({appVersion:'2.2.6',positions:{Calibration:{col:0,row:0}},theme:'light'}));
 const before=fs.readFileSync(meta,'utf8'),log=path.join(tmp,'commands.jsonl');
 const snapshot={ok:true,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,viewDpi:96,origin:{x:0,y:0},areas:[{left:0,top:0,right:1800,bottom:1500,scale:100,grid:{sx:100,sy:100,gx:0,gy:0}},{left:2000,top:0,right:4000,bottom:1600,scale:100,grid:null}],icons:[{label:'sentinel.txt',x:100,y:100}]};
 const env={...process.env,OKIBA_BASE:base,OKIBA_OLD_BASE:old,OKIBA_SHORTCUT_DESKTOP:desktop,OKIBA_CLEANUP_DESKTOP:desktop,OKIBA_CLEANUP_DOWNLOADS:desktop,OKIBA_TEST_DESKTOP_DIR:desktop,OKIBA_TEST_HOOKS:'1',OKIBA_TEST_ATTRIB:'stub',OKIBA_TEST_HELPER:'fake',OKIBA_TEST_POSITIONER:'',OKIBA_TEST_RESOLVER_DIR:'',OKIBA_FAKE_LANDING:desktop,OKIBA_FAKE_TYPE:'desktop',OKIBA_TEST_DESKTOP_SNAPSHOT:JSON.stringify(snapshot),OKIBA_FAKE_CALIBRATION:'1',OKIBA_FAKE_COMMAND_LOG:log,OKIBA_FAKE_CALIBRATION_FAIL:mode==='calibration-fail'?'1':'0',OKIBA_FAKE_CALIBRATION_BAD_SAMPLE:mode==='bad-sample'?'1':'0',OKIBA_FAKE_PLAN_FAIL:mode==='position-fail'?'1':'0',ELECTRON_DISABLE_SECURITY_WARNINGS:'1'};
 let app;const launch=()=>electron.launch({args:[ROOT,'--no-sandbox','--user-data-dir='+path.join(tmp,'profile')],env,timeout:60000});
 const records=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 try {
  app=await launch();let page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');
  const drop=async(selected,x=2450,y=450)=>{const p=await app.evaluate(({screen},q)=>screen.screenToDipPoint(q),{x,y});return page.evaluate(({selected,p})=>window.okiba.resolveDropMove({boardName:'Calibration',paths:selected,linkedPaths:[],screenX:p.x,screenY:p.y}),{selected,p});};
  const result=await drop(paths.slice(0,2));const rec=records();const calibration=rec.find(r=>r.cmd==='calibrateDesktopGrid');
  assert(calibration,'unknown empty area requested calibration: '+mode);
  assert(calibration.files.includes('first.txt')&&!calibration.files.includes('second.txt'),'only selected first probe moved before calibration');
  assert(calibration.probe.path===path.join(desktop,'first.txt'),'probe is requested original, not extra dummy material');
  if(mode==='success'){
   assert(!result.error&&result.moved.length===2,'calibration completed and both files committed');
   const pos=rec.find(r=>r.cmd==='positionDesktopPlan');assert(pos&&pos.calibration?.token==='fake-evidence-token','final position uses calibrated evidence token');
   assert(pos.files.includes('first.txt')&&pos.files.includes('second.txt'),'remaining files moved only after calibration');
   assert(pos.targets[1].x-pos.targets[0].x===100&&pos.targets[1].y===pos.targets[0].y,'relative selected layout preserved');
   assert(paths.slice(0,2).every(p=>!fs.existsSync(p)),'original paths moved exactly once');
   assert(fs.readFileSync(path.join(desktop,'first.txt'),'utf8')==='original-0'&&fs.readFileSync(path.join(desktop,'second.txt'),'utf8')==='original-1','moved original bytes retained');
   const next=await drop([paths[2]],2850,450);assert(!next.error&&next.moved.length===1,'same helper session subsequent return succeeds');
   assert(records().filter(r=>r.cmd==='calibrateDesktopGrid').length===1,'same-session evidence avoids second calibration');
   await app.close();app=null;
   const cacheFile=path.join(tmp,'profile','desktop-calibration-cache.json');assert(fs.existsSync(cacheFile),'calibration evidence persisted in isolated userData');
   const validCache=fs.readFileSync(cacheFile,'utf8');assert(JSON.parse(validCache).entries.length===1,'one calibration cache evidence entry saved');
   const metaRestart=fs.readFileSync(meta,'utf8'),historyRestart=fs.readFileSync(path.join(base,'.move-history.json'),'utf8');
   app=await launch();page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');
   const restart=await drop([paths[3]],3250,450);assert(!restart.error&&restart.moved.length===1,'app restart imports evidence and nonempty right monitor return succeeds');
   assert(records().some(r=>r.cmd==='importDesktopCalibration'),'restart imported saved evidence through helper');
   assert(records().filter(r=>r.cmd==='calibrateDesktopGrid').length===1,'restart uses validated evidence without new probe');
   await app.close();app=null;
   {const bad=JSON.parse(validCache);bad.entries[0].fakeShellIdentity='different-explorer-session';fs.writeFileSync(cacheFile,JSON.stringify(bad));}
   app=await launch();page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');
   const recalibrated=await drop([paths[4]],3550,450);assert(!recalibrated.error&&recalibrated.moved.length===1,'stale evidence with free guarded patch recalibrates safely');
   assert(records().filter(r=>r.cmd==='calibrateDesktopGrid').length===2,'nonempty unknown monitor uses new probe proof, not stale evidence');
   await app.close();app=null;
   const crowded=JSON.parse(JSON.stringify(snapshot));for(let x=2000;x<4000;x+=200)for(let y=0;y<1600;y+=200)crowded.icons.push({label:'existing-'+x+'-'+y,x,y});
   env.OKIBA_TEST_DESKTOP_SNAPSHOT=JSON.stringify(crowded);
   for(const invalid of ['stale','corrupt']){
    if(invalid==='stale'){const bad=JSON.parse(validCache);bad.entries[0].fakeShellIdentity='different-explorer-session';fs.writeFileSync(cacheFile,JSON.stringify(bad));}else fs.writeFileSync(cacheFile,'{not-json');
    const metaBefore=fs.readFileSync(meta,'utf8'),historyBefore=fs.readFileSync(path.join(base,'.move-history.json'),'utf8');const count=records().filter(r=>r.cmd==='importDesktopCalibration').length;const moves=records().filter(r=>r.cmd==='moveNoReplace').length;
    app=await launch();page=await app.firstWindow();await page.waitForSelector('#boardGrid .board-card');
    const blocked=await drop([paths[5]],3550,450);assert(blocked.error&&blocked.moved.length===0,invalid+' cache and no safe patch block before moving');
    assert(fs.readFileSync(meta,'utf8')===metaBefore&&fs.readFileSync(path.join(base,'.move-history.json'),'utf8')===historyBefore,invalid+' cache failure preserves board metadata and history');
    assert(fs.readFileSync(paths[5],'utf8')==='original-5'&&!fs.existsSync(path.join(desktop,'blocked.txt')),invalid+' cache leaves source original untouched');
    assert(records().filter(r=>r.cmd==='moveNoReplace').length===moves,'no-safe-patch failure occurs before any move');
    if(invalid==='corrupt')assert(records().filter(r=>r.cmd==='importDesktopCalibration').length===count,'corrupt JSON rejected before helper import');
    await app.close();app=null;
   }
  } else {
   assert(result.error&&result.moved.length===0,'failure returns no committed files: '+mode);
   assert(paths.every((p,i)=>fs.readFileSync(p,'utf8')==='original-'+i),'all original files restored with original bytes');
   assert(!names.some(n=>fs.existsSync(path.join(desktop,n))),'no selected files left at destination after rollback');
   assert(fs.readFileSync(meta,'utf8')===before,'failure preserves board metadata bytes');
   assert(!fs.existsSync(path.join(base,'.move-history.json')),'failure creates no success history');
  }
  assert(fs.readFileSync(sentinel,'utf8')==='untouched existing desktop fixture'&&fs.statSync(sentinel).mtimeMs===sentinelBefore,'existing unrelated fixture unchanged');
 } finally {if(app)await app.close();fs.rmSync(tmp,{recursive:true,force:true});}
}
async function run(){for(const mode of ['success','calibration-fail','bad-sample','position-fail'])await scenario(mode);console.log('CALIBRATION E2E PASSED');}
module.exports=run;if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1});
